// ============================================================
// TorBox Telegram Bot — Main Entry Point
// Features:
//  - SQLite persistence (users, API keys, plans, tracked downloads)
//  - Background monitor: auto-DMs when download is ready
//  - Fresh link on demand via /getlink (links never stored)
//  - Access control: ALLOWED_USERS env + /adduser /removeuser
//  - Plan-gated features (Free / Essential / Pro / Ultimate)
//  - Private DM for all download links
//  - Password-protected web admin panel
// ============================================================
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';

import {
  getUserApiKey, setUserApiKey, hasApiKey, sessions,
  setPrivateChatId, getPrivateChatId, setCachedPlan, getCachedPlan,
  isUserAllowed, addAllowedUser, removeAllowedUser, listAllowedUsers, isOpenAccess,
  checkPlanFeature,
} from './session.js';

import { upsertUser, trackDownload } from './db.js';
import { createApiClient, extractHashFromMagnet, isInfohash } from './api.js';
import { escapeMarkdown, truncate, formatBytes, statusEmoji, progressBar } from './utils.js';
import { startMonitor } from './monitor.js';
import { startAdminServer } from './admin.js';

import {
  handleTorrentList, handleTorrentInfo, handleTorrentFiles,
  handleTorrentControl, handleTorrentDelete, handleTorrentDl,
  handleAddMagnet, handleAddTorrentFile, handleCheckCached, handleAddCached,
} from './handlers/torrents.js';
import {
  handleUsenetList, handleUsenetInfo, handleUsenetControl, handleUsenetDelete,
  handleUsenetDl, handleAddNzbLink, handleAddNzbFile,
} from './handlers/usenet.js';
import {
  handleWebDlList, handleWebDlInfo, handleWebDlControl, handleWebDlDelete,
  handleWebDlDl, handleAddWebDl,
} from './handlers/webdl.js';
import {
  handleMe, handleStats, handleSubscriptions, handleTransactions,
  handleGlobalStats, handleSetKey,
} from './handlers/user.js';
import {
  handleSearch, handleNotifications, handleClearNotifications,
  handleQueued, handleRssFeeds, handleAddRss, handleRssControl,
} from './handlers/misc.js';

// ── Env validation ─────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN not set.'); process.exit(1); }

const BOT_ADMIN_ID = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
if (!BOT_ADMIN_ID) console.warn('⚠️  BOT_ADMIN_ID not set — admin commands disabled.');
if (!process.env.TORBOX_API_KEY) console.warn('⚠️  TORBOX_API_KEY not set — users must /setkey.');

// ── Bot ───────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 TorBox Bot starting…');

// ── Helpers ────────────────────────────────────────────────────
const isAdmin = (userId) => BOT_ADMIN_ID && String(userId) === BOT_ADMIN_ID;

async function downloadTelegramFile(fileId) {
  const file = await bot.getFile(fileId);
  const { default: axios } = await import('axios');
  const r = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, {
    responseType: 'arraybuffer', timeout: 30000,
  });
  return Buffer.from(r.data);
}

async function ensurePlanCached(userId) {
  if (getCachedPlan(userId) !== null) return;
  const key = getUserApiKey(userId);
  if (!key) return;
  try {
    const api = createApiClient(key);
    const r = await api.getMe();
    if (r?.data?.plan != null) setCachedPlan(userId, r.data.plan);
  } catch (_) {}
}

// ── Auth middleware ────────────────────────────────────────────
function requireAuth(msg, callback) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId, `🚫 *Access Denied*\n\nThis bot is restricted\\.\nContact the bot admin to request access\\.`, { parse_mode: 'MarkdownV2' });
    return;
  }
  if (!hasApiKey(userId)) {
    bot.sendMessage(chatId,
      '🔑 *API Key Required*\n\nSet your TorBox API key first:\n`/setkey YOUR_API_KEY`\n\nGet your key at: https://torbox.app/settings',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  ensurePlanCached(userId).catch(() => {});
  callback();
}

// ── /getlink — fresh link on demand (the most important feature!) ─
async function handleGetLink(bot, chatId, userId, type, itemId) {
  const apiKey = getUserApiKey(userId);
  const privateChatId = getPrivateChatId(userId);

  // Always send to private chat
  const isGroup = chatId !== userId && privateChatId && privateChatId !== String(chatId);
  if (isGroup) {
    await bot.sendMessage(chatId, '🔐 Sending your download link privately — check your DMs\\!', { parse_mode: 'MarkdownV2' });
  }
  const targetChat = privateChatId || String(chatId);
  const loading = await bot.sendMessage(targetChat, '🔗 Generating fresh download link…');

  try {
    const api = createApiClient(apiKey);
    let result;
    if (type === 'torrent') result = await api.requestTorrentDl(Number(itemId), null, false);
    else if (type === 'usenet') result = await api.requestUsenetDl(Number(itemId), null, false);
    else if (type === 'webdl') result = await api.requestWebDlDl(Number(itemId), null, false);
    else { await bot.editMessageText('❌ Unknown type\\.', { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' }); return; }

    const link = result?.data;
    if (link && typeof link === 'string') {
      const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[type] || '📦';
      await bot.editMessageText(
        `${typeEmoji} *Fresh Download Link*\n\n` +
        `⚠️ _This link is for YOU only\\. Do not share it\\._\n\n` +
        `${link}\n\n` +
        `🕐 _Expires in ~1 hour_\n` +
        `_Tap the button below to get a new link anytime\\._`,
        {
          chat_id: targetChat,
          message_id: loading.message_id,
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Get Fresh Link Again', callback_data: `getlink:${type}:${itemId}` }]],
          },
        }
      );
    } else {
      const reason = result?.detail || result?.error || 'Could not generate link\\. Content may not be ready yet\\.';
      await bot.editMessageText(`❌ ${escapeMarkdown(reason)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeMarkdown(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  }
}

// ── /mydownloads ──────────────────────────────────────────────
async function handleMyDownloads(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const { getUserDownloads } = await import('./db.js');
  const items = getUserDownloads(userId);

  if (!items.length) {
    await bot.sendMessage(chatId, '📭 No tracked downloads yet\\.\n\nAdd a torrent, NZB, or web link and the bot will monitor it automatically\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  let text = `📥 *My Downloads* \\(${items.length}\\)\n\n`;
  const btns = [];

  for (const item of items.slice(0, 10)) {
    const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[item.type] || '📦';
    const name = truncate(item.name || `#${item.item_id}`, 35);
    const status = item.last_status || 'tracking…';
    const isDone = item.is_done === 1;

    text += `${typeEmoji} ${isDone ? '✅' : '⏳'} *${escapeMarkdown(name)}*\n`;
    text += `  ${escapeMarkdown(status)} \\| ID: \`${item.item_id}\`\n\n`;

    if (isDone) {
      btns.push([{ text: `🔗 Get Link: ${truncate(name, 20)}`, callback_data: `getlink:${item.type}:${item.item_id}` }]);
    }
  }

  if (items.length > 10) text += `_…and ${items.length - 10} more \\(showing latest 10\\)_\n`;
  text += `\n💡 _Links expire in ~1 hour\\. Press button anytime for a fresh one\\._`;

  await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: btns.length ? { inline_keyboard: btns } : undefined });
}

// ── /status — Find active/in-progress downloads across all types ─────
async function handleStatus(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '⚡ Checking active downloads across TorBox…');

  try {
    const api = createApiClient(apiKey);
    const plan = getCachedPlan(userId);

    const [torrentRes, usenetRes, webdlRes] = await Promise.all([
      api.getTorrentList(true).catch(() => ({ data: [] })),
      (plan === null || plan >= 1) ? api.getUsenetList(true).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
      (plan === null || plan >= 1) ? api.getWebDlList(true).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
    ]);

    const torrents = torrentRes?.data || [];
    const usenets  = usenetRes?.data || [];
    const webdls   = webdlRes?.data || [];

    const activeTorrents = torrents.filter(t => {
      const s = (t.download_state || t.status || '').toLowerCase();
      return s.includes('download') || s.includes('queue') || s.includes('meta') || s.includes('check');
    });

    const activeUsenets = usenets.filter(u => {
      const s = (u.download_state || u.status || '').toLowerCase();
      return s.includes('download') || s.includes('queue') || s.includes('grab') || s.includes('extract');
    });

    const activeWebdls = webdls.filter(w => {
      const s = (w.download_state || w.status || '').toLowerCase();
      return s.includes('download') || s.includes('queue') || s.includes('process');
    });

    const totalActive = activeTorrents.length + activeUsenets.length + activeWebdls.length;

    if (totalActive === 0) {
      await bot.editMessageText(
        '🟢 *No Active Downloads*\n\n' +
        'All your downloads are either finished or idle\\.\n' +
        'Use `/mydownloads` or `/torrents` to view completed items\\.',
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
      );
      return;
    }

    let text = `⚡ *Active Downloads Status* \\(${totalActive} active\\)\n\n`;

    if (activeTorrents.length) {
      text += `*🧲 Active Torrents \\(${activeTorrents.length}\\)*\n`;
      for (const t of activeTorrents) {
        const pct = t.progress != null ? t.progress * 100 : 0;
        const status = t.download_state || t.status || 'downloading';
        text += `• *${escapeMarkdown(truncate(t.name, 32))}*\n`;
        text += `  🆔 \`${t.id}\` \\| ${escapeMarkdown(status)} \\| ${escapeMarkdown(formatBytes(t.size))}\n`;
        text += `  ${progressBar(pct)}\n`;
        if (t.download_speed) text += `  ⬇ ${escapeMarkdown(formatBytes(t.download_speed))}/s`;
        if (t.eta) text += ` \\| ⏱ ${escapeMarkdown(String(t.eta))}s`;
        text += '\n\n';
      }
    }

    if (activeUsenets.length) {
      text += `*📰 Active Usenet \\(${activeUsenets.length}\\)*\n`;
      for (const u of activeUsenets) {
        const pct = u.progress != null ? u.progress * 100 : 0;
        const status = u.download_state || u.status || 'downloading';
        text += `• *${escapeMarkdown(truncate(u.name, 32))}*\n`;
        text += `  🆔 \`${u.id}\` \\| ${escapeMarkdown(status)} \\| ${escapeMarkdown(formatBytes(u.size))}\n`;
        text += `  ${progressBar(pct)}\n\n`;
      }
    }

    if (activeWebdls.length) {
      text += `*🌐 Active Web Downloads \\(${activeWebdls.length}\\)*\n`;
      for (const w of activeWebdls) {
        const pct = w.progress != null ? w.progress * 100 : 0;
        const status = w.download_state || w.status || 'downloading';
        text += `• *${escapeMarkdown(truncate(w.name, 32))}*\n`;
        text += `  🆔 \`${w.id}\` \\| ${escapeMarkdown(status)} \\| ${escapeMarkdown(formatBytes(w.size))}\n`;
        text += `  ${progressBar(pct)}\n\n`;
      }
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeMarkdown(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  }
}

// ── /debrid — Add debrid/web download link ───────────────────────────
async function handleDebrid(bot, chatId, url, userId) {
  const plan = getCachedPlan(userId);
  const planErr = checkPlanFeature(plan, 'webdl');
  if (planErr) { bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }

  if (!url) {
    bot.sendMessage(chatId,
      '🌐 *TorBox Debrid / Web Downloader*\n\n' +
      'Paste any premium hoster or file link to unrestrict and download via TorBox\\.\n\n' +
      'Usage: `/debrid <url>`\n\n' +
      '*Supported Hosters Include:*\n' +
      '• 1Fichier, Rapidgator, DDownload, Mega, Google Drive\n' +
      '• Pixeldrain, Mediafire, Katfile, Filefactory, and more\\!',
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  await handleAddWebDl(bot, chatId, url, userId);
}

// =============================================================
// COMMANDS
// =============================================================

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'there';

  // Register user + private chat ID
  if (userId) {
    upsertUser(userId, { username: msg.from?.username, firstName });
    if (msg.chat.type === 'private') setPrivateChatId(userId, chatId);
  }

  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId,
      `👋 Hi *${escapeMarkdown(firstName)}*\\!\n\n` +
      `This bot is *access\\-restricted*\\.\n\n` +
      `Your Telegram ID: \`${userId}\`\n` +
      `Send this to the bot admin to request access\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const hasKey = hasApiKey(userId);
  const plan   = getCachedPlan(userId);
  const PLAN_LABEL = { 0: '🆓 Free', 1: '🥈 Essential', 2: '🥇 Pro', 3: '💎 Ultimate' };

  await bot.sendMessage(chatId,
    `👋 *Welcome, ${escapeMarkdown(firstName)}\\!*\n` +
    `🚀 *TorBox Manager Bot*\n` +
    (plan !== null ? `🏷 Plan: *${escapeMarkdown(PLAN_LABEL[plan] || `Plan ${plan}`)}*\n` : '') +
    '\n' +
    (hasKey
      ? `✅ API key is set\\!\n\n`
      : `⚠️ *First: set your API key*\n\`/setkey YOUR\\_API\\_KEY\`\n\n`) +
    `*📦 Torrents*\n` +
    `/torrents — List all\n` +
    `/addmagnet — Add magnet \\(auto\\-notifies when ready\\)\n` +
    `/addcached — Add only if cached ⚡\n` +
    `/checkcached — Check cache status\n` +
    `/mydownloads — My downloads \\+ get links\n` +
    `/getlink — Get fresh download link\n\n` +
    (plan === null || plan >= 1
      ? `*📰 Usenet* \\(Essential\\+\\)\n/usenet — List \\| /addnzb — Add NZB\n\n*🌐 Web Downloads* \\(Essential\\+\\)\n/webdl — List \\| /addwebdl — Add URL\n\n`
      : `*📰 Usenet & 🌐 WebDL* — Requires Essential plan\n\n`) +
    `*🔍 Search* — /search\n\n` +
    `*👤 Account* — /me \\| /stats \\| /subscriptions\n\n` +
    `⚙️ /setkey — Set API key \\| /help — Full commands\n\n` +
    `🔐 *Download links are sent privately to you only\\.*`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📖 *TorBox Bot — Commands*\n\n` +
    `*🧲 Torrents*\n` +
    `/torrents — List \\(paginated\\)\n` +
    `/addmagnet \\<magnet\\> — Add torrent\n` +
    `/addcached \\<hash\\|magnet\\> — Add ⚡ cached only\n` +
    `/checkcached \\<hash\\|magnet\\> — Check cache\n` +
    `/torrent \\<id\\> — Details \\+ controls\n` +
    `_Send .torrent file directly to upload_\n\n` +
    `*📥 My Downloads*\n` +
    `/mydownloads — All tracked downloads \\+ status\n` +
    `/getlink \\<type\\> \\<id\\> — Get fresh download link anytime\n\n` +
    `*📰 Usenet \\(Essential\\+\\)*\n` +
    `/usenet — List \\| /addnzb \\<url\\> — Add NZB\n` +
    `/nzb \\<id\\> — Details \\+ controls\n` +
    `_Send .nzb file directly_\n\n` +
    `*🌐 Web Downloads \\(Essential\\+\\)*\n` +
    `/webdl — List \\| /addwebdl \\<url\\> — Add\n` +
    `/wdl \\<id\\> — Details \\+ controls\n\n` +
    `*🔍 Search* — /search \\<query\\>\n\n` +
    `*📡 RSS \\(Essential\\+\\)* — /rss \\| /addrss \\<url\\>\n\n` +
    `*📋 Queue* — /queued\n\n` +
    `*🔔 Notifications \\(Essential\\+\\)* — /notifications\n\n` +
    `*👤 Account*\n` +
    `/me — Profile \\& plan \\| /stats \\| /subscriptions\n` +
    `/transactions \\| /globalstats\n\n` +
    `*⚙️ Settings*\n` +
    `/setkey \\<key\\> — Set API key\n` +
    `/mykey — Show key \\(masked\\)\n\n` +
    `*🔐 Link Privacy*\n` +
    `All download links → private DM only\\.\n` +
    `Links expire in ~1 hour — use /getlink or buttons to refresh\\.`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ── /setkey ───────────────────────────────────────────────────
bot.onText(/\/setkey(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from?.id || msg.chat.id;
  if (!isUserAllowed(userId)) return;
  upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
  const key = match?.[1]?.trim();
  if (!key) { bot.sendMessage(msg.chat.id, '🔑 Usage: `/setkey YOUR_API_KEY`', { parse_mode: 'Markdown' }); return; }
  await handleSetKey(bot, msg, key);
});

// ── /mykey ────────────────────────────────────────────────────
bot.onText(/\/mykey/, (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  if (!isUserAllowed(userId)) return;
  const key = getUserApiKey(userId);
  if (!key) { bot.sendMessage(msg.chat.id, '❌ No API key set. Use `/setkey YOUR_KEY`', { parse_mode: 'Markdown' }); return; }
  const masked = `${key.substring(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
  const plan = getCachedPlan(userId);
  const PLAN = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };
  bot.sendMessage(msg.chat.id, `🔑 API key: \`${masked}\`${plan !== null ? `\n🏷 Plan: *${PLAN[plan] || `Plan ${plan}`}*` : ''}`, { parse_mode: 'Markdown' });
});

// ── /getlink <type> <id> ──────────────────────────────────────
bot.onText(/\/getlink(?:\s+(\w+))?(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const userId = msg.from?.id || msg.chat.id;
    const chatId = msg.chat.id;
    const type = match?.[1]?.toLowerCase();
    const id   = match?.[2];

    if (!type || !id) {
      // Show list of tracked completed downloads to pick from
      const { getUserDownloads } = await import('./db.js');
      const items = getUserDownloads(userId).filter(i => i.is_done === 1);

      if (!items.length) {
        bot.sendMessage(chatId,
          '📭 *No completed downloads tracked yet*\n\n' +
          'Usage: `/getlink torrent 12345`\n' +
          'Or use `/mydownloads` to see your downloads\\.',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const btns = items.slice(0, 10).map(i => [{
        text: `${{ torrent: '🧲', usenet: '📰', webdl: '🌐' }[i.type]} ${truncate(i.name || `#${i.item_id}`, 28)}`,
        callback_data: `getlink:${i.type}:${i.item_id}`,
      }]);

      bot.sendMessage(chatId, '🔗 *Get Download Link*\n\nSelect which download:', {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: btns },
      });
      return;
    }

    await handleGetLink(bot, chatId, userId, type, id);
  });
});

// ── /mydownloads ──────────────────────────────────────────────
bot.onText(/\/mydownloads/, (msg) => requireAuth(msg, () => handleMyDownloads(bot, msg)));

// =============================================================
// TORRENT COMMANDS
// =============================================================

bot.onText(/\/torrents/, (msg) => requireAuth(msg, () => handleTorrentList(bot, msg, 0)));

bot.onText(/\/addmagnet(?:\s+(.+))?/s, async (msg, match) => {
  requireAuth(msg, async () => {
    const magnet = match?.[1]?.trim();
    if (!magnet) { bot.sendMessage(msg.chat.id, '🧲 Usage: `/addmagnet magnet:?xt=urn:btih:…`\nOr paste magnet link directly.', { parse_mode: 'Markdown' }); return; }
    await handleAddMagnet(bot, msg.chat.id, magnet, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/addcached(?:\s+(.+))?/s, async (msg, match) => {
  requireAuth(msg, async () => {
    const input = match?.[1]?.trim();
    if (!input) {
      bot.sendMessage(msg.chat.id,
        '⚡ *Add Cached Torrent Only*\n\nUsage: `/addcached <infohash|magnet>`\n\nOnly adds if already cached on TorBox \\(instant\\!\\)\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    await handleAddCached(bot, msg.chat.id, input, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/checkcached(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const input = match?.[1]?.trim();
    if (!input) { bot.sendMessage(msg.chat.id, '🔍 Usage: `/checkcached <infohash|magnet>`', { parse_mode: 'Markdown' }); return; }
    await handleCheckCached(bot, msg.chat.id, input, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/torrent(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const id = match?.[1];
    if (!id) { bot.sendMessage(msg.chat.id, '📋 Usage: `/torrent <id>`', { parse_mode: 'Markdown' }); return; }
    await handleTorrentInfo(bot, msg.chat.id, id, msg.from?.id || msg.chat.id);
  });
});

// =============================================================
// USENET COMMANDS
// =============================================================

bot.onText(/\/usenet/, (msg) => requireAuth(msg, () => handleUsenetList(bot, msg, 0)));

bot.onText(/\/addnzb(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const url = match?.[1]?.trim();
    if (!url) { bot.sendMessage(msg.chat.id, '📰 Usage: `/addnzb <nzb_url>`\nOr send an .nzb file.', { parse_mode: 'Markdown' }); return; }
    await handleAddNzbLink(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/nzb(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const id = match?.[1];
    if (!id) { bot.sendMessage(msg.chat.id, '📋 Usage: `/nzb <id>`', { parse_mode: 'Markdown' }); return; }
    await handleUsenetInfo(bot, msg.chat.id, id, msg.from?.id || msg.chat.id);
  });
});

// =============================================================
// WEBDL COMMANDS
// =============================================================

bot.onText(/\/webdl/, (msg) => requireAuth(msg, () => handleWebDlList(bot, msg, 0)));

bot.onText(/\/addwebdl(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const url = match?.[1]?.trim();
    if (!url) { bot.sendMessage(msg.chat.id, '🌐 Usage: `/addwebdl <url>`', { parse_mode: 'Markdown' }); return; }
    await handleAddWebDl(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/wdl(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const id = match?.[1];
    if (!id) { bot.sendMessage(msg.chat.id, '📋 Usage: `/wdl <id>`', { parse_mode: 'Markdown' }); return; }
    await handleWebDlInfo(bot, msg.chat.id, id, msg.from?.id || msg.chat.id);
  });
});

// =============================================================
// ACCOUNT COMMANDS
// =============================================================

bot.onText(/\/me/, (msg) => requireAuth(msg, () => handleMe(bot, msg)));
bot.onText(/\/stats/, (msg) => requireAuth(msg, () => handleStats(bot, msg)));
bot.onText(/\/subscriptions/, (msg) => requireAuth(msg, () => handleSubscriptions(bot, msg)));
bot.onText(/\/transactions/, (msg) => requireAuth(msg, () => handleTransactions(bot, msg)));
bot.onText(/\/globalstats/, (msg) => requireAuth(msg, () => handleGlobalStats(bot, msg)));

// =============================================================
// SEARCH, RSS, QUEUE, NOTIFICATIONS
// =============================================================

bot.onText(/\/(?:search|s)(?:\s+(.+))?/s, async (msg, match) => {
  requireAuth(msg, async () => {
    const query = match?.[1]?.trim();
    if (!query) {
      sessions.set(msg.from?.id || msg.chat.id, { awaitingInput: 'search' });
      bot.sendMessage(msg.chat.id, '🔍 Send me your search query:', { reply_markup: { force_reply: true } });
      return;
    }
    await handleSearch(bot, msg.chat.id, query, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/queued/, (msg) => requireAuth(msg, () => handleQueued(bot, msg, 'torrent')));
bot.onText(/\/rss/, (msg) => requireAuth(msg, () => handleRssFeeds(bot, msg)));
bot.onText(/\/addrss(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const url = match?.[1]?.trim();
    if (!url) { bot.sendMessage(msg.chat.id, '📡 Usage: `/addrss <feed_url>`', { parse_mode: 'Markdown' }); return; }
    await handleAddRss(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});
bot.onText(/\/notifications/, (msg) => requireAuth(msg, () => handleNotifications(bot, msg)));
bot.onText(/\/clearnotifs/, async (msg) => requireAuth(msg, async () => handleClearNotifications(bot, msg.chat.id, msg.from?.id || msg.chat.id)));

// =============================================================
// ADMIN COMMANDS (BOT_ADMIN_ID only)
// =============================================================

bot.onText(/\/adduser(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  if (!targetId) { bot.sendMessage(chatId, '❌ Usage: `/adduser <telegram_id>`', { parse_mode: 'Markdown' }); return; }
  addAllowedUser(targetId, userId);
  bot.sendMessage(chatId, `✅ User \`${targetId}\` added to whitelist\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/removeuser(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  if (!targetId) { bot.sendMessage(chatId, '❌ Usage: `/removeuser <telegram_id>`', { parse_mode: 'Markdown' }); return; }
  removeAllowedUser(targetId);
  bot.sendMessage(chatId, `✅ User \`${targetId}\` removed from whitelist\\.`, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/listusers/, (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  if (isOpenAccess()) { bot.sendMessage(chatId, '🌍 *Open access mode* — no users in whitelist yet\\.', { parse_mode: 'MarkdownV2' }); return; }
  const users = listAllowedUsers();
  const text = users.length
    ? `👥 *Allowed Users* \\(${users.length}\\)\n\n` + users.map(u => `• \`${u.user_id}\` ${u.username ? `@${escapeMarkdown(u.username)}` : escapeMarkdown(u.first_name || '')}`).join('\n')
    : '📭 Whitelist is empty\\.';
  bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/broadcast(?:\s+(.+))?/s, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const text = match?.[1];
  if (!text) { bot.sendMessage(chatId, '❌ Usage: `/broadcast <message>`', { parse_mode: 'Markdown' }); return; }
  const users = listAllowedUsers();
  let sent = 0, failed = 0;
  for (const u of users) {
    const target = getPrivateChatId(u.user_id) || u.user_id;
    try { await bot.sendMessage(target, `📢 *Broadcast*\n\n${text}`, { parse_mode: 'Markdown' }); sent++; }
    catch (_) { failed++; }
  }
  bot.sendMessage(chatId, `✅ Broadcast: ${sent} sent, ${failed} failed.`);
});

bot.onText(/\/adminpanel/, (msg) => {
  const userId = msg.from?.id;
  if (!isAdmin(userId)) return;
  const PORT = process.env.PORT || '3001';
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  bot.sendMessage(msg.chat.id,
    `🌐 *Web Admin Panel*\n\n` +
    `URL: ${escapeMarkdown(publicUrl)}/admin\n` +
    `Password: \\[set in ADMIN\\_WEB\\_PASSWORD env var\\]`,
    { parse_mode: 'MarkdownV2' }
  );
});

// =============================================================
// FILE UPLOADS
// =============================================================

bot.on('document', async (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  if (!isUserAllowed(userId)) return;
  if (!hasApiKey(userId)) { bot.sendMessage(chatId, '🔑 Set your API key first: `/setkey YOUR_KEY`', { parse_mode: 'Markdown' }); return; }

  upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
  if (msg.chat.type === 'private') setPrivateChatId(userId, chatId);

  const doc = msg.document;
  if (!doc) return;
  const name = doc.file_name || 'upload';
  const ext  = name.split('.').pop()?.toLowerCase();

  if (ext === 'torrent') {
    const loading = await bot.sendMessage(chatId, `📤 .torrent detected: *${escapeMarkdown(name)}*\nDownloading…`, { parse_mode: 'MarkdownV2' });
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await bot.editMessageText('📤 Uploading to TorBox…', { chat_id: chatId, message_id: loading.message_id });
      await handleAddTorrentFile(bot, chatId, buf, name, userId);
    } catch (err) {
      bot.editMessageText(`❌ ${err.message}`, { chat_id: chatId, message_id: loading.message_id });
    }
    return;
  }

  if (ext === 'nzb') {
    const plan = getCachedPlan(userId);
    const planErr = checkPlanFeature(plan, 'usenet');
    if (planErr) { bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }
    const loading = await bot.sendMessage(chatId, `📤 .nzb detected: *${escapeMarkdown(name)}*\nUploading…`, { parse_mode: 'MarkdownV2' });
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await handleAddNzbFile(bot, chatId, buf, name, userId);
      bot.deleteMessage(chatId, loading.message_id).catch(() => {});
    } catch (err) {
      bot.editMessageText(`❌ ${err.message}`, { chat_id: chatId, message_id: loading.message_id });
    }
    return;
  }

  bot.sendMessage(chatId, `ℹ️ Unsupported file: .${ext}\nSupported: .torrent, .nzb`);
});

// =============================================================
// TEXT MESSAGES (magnet / hash / URL / session input)
// =============================================================

bot.on('text', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || '';

  if (!isUserAllowed(userId)) return;

  // Register user and private chat on every private message
  if (msg.chat.type === 'private' && userId) {
    upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
    setPrivateChatId(userId, chatId);
  }

  // Magnet link
  if (text.startsWith('magnet:')) {
    if (!hasApiKey(userId)) { bot.sendMessage(chatId, '🔑 Set your API key first: `/setkey YOUR_KEY`', { parse_mode: 'Markdown' }); return; }
    await handleAddMagnet(bot, chatId, text, userId);
    return;
  }

  // 40-char infohash → auto cache check
  if (isInfohash(text)) {
    if (!hasApiKey(userId)) { bot.sendMessage(chatId, '🔑 Set your API key first.'); return; }
    await handleCheckCached(bot, chatId, text, userId);
    return;
  }

  // HTTP/HTTPS URL → ask type
  if ((text.startsWith('http://') || text.startsWith('https://')) && !text.includes('torbox.app')) {
    if (!hasApiKey(userId)) { bot.sendMessage(chatId, '🔑 Set your API key first.'); return; }
    const plan = getCachedPlan(userId);
    const showUsenet = plan === null || plan >= 1;
    const showWebDl  = plan === null || plan >= 1;
    const btns = [];
    if (showWebDl)  btns.push({ text: '🌐 Web Download', callback_data: `add_webdl_confirm:${encodeURIComponent(text.substring(0, 200))}` });
    if (showUsenet) btns.push({ text: '📰 Usenet NZB',   callback_data: `add_nzb_confirm:${encodeURIComponent(text.substring(0, 200))}` });
    btns.push({ text: '❌ Cancel', callback_data: 'cancel' });

    await bot.sendMessage(chatId,
      `🔗 *URL Detected*\n\`${escapeMarkdown(text.substring(0, 80))}${text.length > 80 ? '…' : ''}\`\n\nWhat type of download is this?`,
      { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [btns.slice(0, 2), [btns[btns.length - 1]]] } }
    );
    return;
  }

  // Session input
  const session = sessions.get(userId);
  if (session?.awaitingInput === 'search' && hasApiKey(userId)) {
    sessions.delete(userId);
    await handleSearch(bot, chatId, text, userId);
    return;
  }
  if (session?.awaitingInput === 'setkey') {
    sessions.delete(userId);
    await handleSetKey(bot, msg, text);
    return;
  }
  if (session?.awaitingInput === 'addcached' && hasApiKey(userId)) {
    sessions.delete(userId);
    await handleAddCached(bot, chatId, text, userId);
    return;
  }
});

// =============================================================
// CALLBACK QUERIES
// =============================================================

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const userId = query.from?.id;
  const data   = query.data || '';
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (!isUserAllowed(userId)) return;

  const fakeMsg = { chat: { id: chatId }, from: { id: userId } };

  // ── Get Download Link (fresh, on demand) ──────────────────
  if (data.startsWith('getlink:')) {
    const parts = data.split(':');
    await handleGetLink(bot, chatId, userId, parts[1], parts[2]);
    return;
  }

  // ── Torrents ──────────────────────────────────────────────
  if (data.startsWith('torrent_list:'))    { await handleTorrentList(bot, fakeMsg, parseInt(data.split(':')[1]) || 0); return; }
  if (data.startsWith('torrent_info:'))    { await handleTorrentInfo(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('torrent_files:'))   { await handleTorrentFiles(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('torrent_ctrl:'))    { const [, id, op] = data.split(':'); await handleTorrentControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('torrent_del:')) {
    const [, id, step] = data.split(':');
    if (step === 'confirm') {
      await bot.sendMessage(chatId, `⚠️ *Delete torrent \`${id}\`?* This cannot be undone.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '✅ Yes, delete', callback_data: `torrent_del:${id}:do` }, { text: '❌ Cancel', callback_data: 'cancel' }]] },
      });
    } else if (step === 'do') await handleTorrentDelete(bot, chatId, id, userId);
    return;
  }
  if (data.startsWith('torrent_dl:'))     { const p = data.split(':'); await handleTorrentDl(bot, chatId, p[1], p[2] || 'zip', userId); return; }
  if (data.startsWith('addcached:'))      { await handleAddCached(bot, chatId, data.replace('addcached:', ''), userId); return; }

  // ── Usenet ────────────────────────────────────────────────
  if (data.startsWith('usenet_list:'))    { await handleUsenetList(bot, fakeMsg, parseInt(data.split(':')[1]) || 0); return; }
  if (data.startsWith('usenet_info:'))    { await handleUsenetInfo(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('usenet_ctrl:'))    { const [, id, op] = data.split(':'); await handleUsenetControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('usenet_del:')) {
    const [, id, step] = data.split(':');
    if (step === 'confirm') {
      await bot.sendMessage(chatId, `⚠️ *Delete usenet \`${id}\`?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Delete', callback_data: `usenet_del:${id}:do` }, { text: '❌ Cancel', callback_data: 'cancel' }]] } });
    } else if (step === 'do') await handleUsenetDelete(bot, chatId, id, userId);
    return;
  }
  if (data.startsWith('usenet_dl:'))      { const p = data.split(':'); await handleUsenetDl(bot, chatId, p[1], p[2] || 'zip', userId); return; }

  // ── WebDL ─────────────────────────────────────────────────
  if (data.startsWith('webdl_list:'))     { await handleWebDlList(bot, fakeMsg, parseInt(data.split(':')[1]) || 0); return; }
  if (data.startsWith('webdl_info:'))     { await handleWebDlInfo(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('webdl_ctrl:'))     { const [, id, op] = data.split(':'); await handleWebDlControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('webdl_del:')) {
    const [, id, step] = data.split(':');
    if (step === 'confirm') {
      await bot.sendMessage(chatId, `⚠️ *Delete web download \`${id}\`?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '✅ Delete', callback_data: `webdl_del:${id}:do` }, { text: '❌ Cancel', callback_data: 'cancel' }]] } });
    } else if (step === 'do') await handleWebDlDelete(bot, chatId, id, userId);
    return;
  }
  if (data.startsWith('webdl_dl:'))       { const p = data.split(':'); await handleWebDlDl(bot, chatId, p[1], p[2] || 'zip', userId); return; }

  // ── Misc ──────────────────────────────────────────────────
  if (data.startsWith('queued:'))         { await handleQueued(bot, fakeMsg, data.split(':')[1]); return; }
  if (data === 'notif_clear')             { await handleClearNotifications(bot, chatId, userId); return; }
  if (data.startsWith('rss_ctrl:'))       { const [, id, op] = data.split(':'); await handleRssControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('add_webdl_confirm:')) { await handleAddWebDl(bot, chatId, decodeURIComponent(data.replace('add_webdl_confirm:', '')), userId); return; }
  if (data.startsWith('add_nzb_confirm:'))   { await handleAddNzbLink(bot, chatId, decodeURIComponent(data.replace('add_nzb_confirm:', '')), userId); return; }
  if (data === 'cancel')                  { await bot.sendMessage(chatId, '❌ Cancelled.'); return; }
});

bot.onText(/\/status/, (msg) => requireAuth(msg, () => handleStatus(bot, msg)));

bot.onText(/\/debrid(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const url = match?.[1]?.trim();
    await handleDebrid(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});

// =============================================================
// BOT COMMANDS MENU
// =============================================================

bot.setMyCommands([
  { command: 'start',         description: '🚀 Start / show menu' },
  { command: 'status',        description: '⚡ Active downloads status' },
  { command: 'debrid',        description: '🌐 Add debrid / web link' },
  { command: 'mydownloads',   description: '📥 My downloads + get links' },
  { command: 'getlink',       description: '🔗 Get fresh download link anytime' },
  { command: 'torrents',      description: '🧲 List torrents' },
  { command: 'addmagnet',     description: '➕ Add magnet (auto-notifies when ready)' },
  { command: 'addcached',     description: '⚡ Add torrent (cached only)' },
  { command: 'checkcached',   description: '🔍 Check if hash is cached' },
  { command: 'usenet',        description: '📰 List usenet (Essential+)' },
  { command: 'addnzb',        description: '➕ Add NZB (Essential+)' },
  { command: 'webdl',         description: '🌐 List web downloads (Essential+)' },
  { command: 'addwebdl',      description: '➕ Add web/debrid link (Essential+)' },
  { command: 'queued',        description: '🔜 View queued items' },
  { command: 'search',        description: '🔍 Search TorBox' },
  { command: 'rss',           description: '📡 RSS feeds (Essential+)' },
  { command: 'notifications', description: '🔔 Notifications (Essential+)' },
  { command: 'me',            description: '👤 Profile & plan info' },
  { command: 'stats',         description: '📊 Your stats' },
  { command: 'setkey',        description: '🔑 Set TorBox API key' },
  { command: 'help',          description: '📖 Full command list' },
]).then(() => console.log('✅ Bot commands registered.')).catch(console.error);

// =============================================================
// START MONITOR + ADMIN PANEL
// =============================================================

startMonitor(bot);
startAdminServer();

// =============================================================
// ERROR + SHUTDOWN
// =============================================================

bot.on('polling_error', (err) => console.error('❌ Polling error:', err.message));
bot.on('error',         (err) => console.error('❌ Bot error:', err.message));

process.on('SIGINT',  async () => { console.log('\n🛑 Shutting down…'); await bot.stopPolling(); process.exit(0); });
process.on('SIGTERM', async () => { console.log('\n🛑 SIGTERM…');        await bot.stopPolling(); process.exit(0); });

console.log('✅ TorBox Bot is live!');
