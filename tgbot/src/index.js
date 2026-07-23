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
//  - Fail-proof HTML parsing mode across all handlers
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
import { escapeHtml, truncate, formatBytes, statusEmoji, progressBar } from './utils.js';
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
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    params: {
      timeout: 10,
    },
  },
});
bot.deleteWebHook().catch(() => {});
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

  // Clear any pending input state when running a slash command
  if (msg.text?.startsWith('/')) {
    sessions.delete(userId);
  }

  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId, `🚫 <b>Access Denied</b>\n\nThis bot is restricted.\nContact the bot admin to request access.`, { parse_mode: 'HTML' });
    return;
  }
  if (!hasApiKey(userId)) {
    bot.sendMessage(chatId,
      '🔑 <b>API Key Required</b>\n\nSet your TorBox API key first:\n<code>/setkey YOUR_API_KEY</code>\n\nGet your key at: https://torbox.app/settings',
      { parse_mode: 'HTML' }
    );
    return;
  }
  ensurePlanCached(userId).catch(() => {});
  callback();
}

// ── Sync user's items from TorBox into SQLite DB ──────────────
async function syncUserDownloadsToDb(userId, apiKey) {
  try {
    const api = createApiClient(apiKey);
    const plan = getCachedPlan(userId);

    const [tRes, uRes, wRes] = await Promise.all([
      api.getTorrentList(true).catch(() => ({ data: [] })),
      (plan === null || plan >= 1) ? api.getUsenetList(true).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
      (plan === null || plan >= 1) ? api.getWebDlList(true).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
    ]);

    for (const t of (tRes?.data || [])) if (t.id) trackDownload(userId, t.id, 'torrent', t.name);
    for (const u of (uRes?.data || [])) if (u.id) trackDownload(userId, u.id, 'usenet', u.name);
    for (const w of (wRes?.data || [])) if (w.id) trackDownload(userId, w.id, 'webdl', w.name);
  } catch (_) {}
}

// ── /getlink — fresh link on demand ────────────────────────────
async function handleGetLink(bot, chatId, userId, type, itemId) {
  const apiKey = getUserApiKey(userId);
  const privateChatId = getPrivateChatId(userId);

  const isGroup = chatId !== userId && privateChatId && privateChatId !== String(chatId);
  if (isGroup) {
    await bot.sendMessage(chatId, '🔐 Sending your download link privately — check your DMs!');
  }
  const targetChat = privateChatId || String(chatId);
  const loading = await bot.sendMessage(targetChat, '🔗 Generating fresh download link…');

  try {
    const api = createApiClient(apiKey);
    let result;
    if (type === 'torrent') {
      const details = await api.getTorrentById(Number(itemId)).catch(() => null);
      const items = details?.data;
      const t = Array.isArray(items) ? items.find((x) => String(x.id) === String(itemId)) : items;
      const files = Array.isArray(t?.files) ? t.files : [];
      if (files.length === 1) {
        result = await api.requestTorrentDl(Number(itemId), files[0]?.id ?? 0, false);
      } else if (files.length > 1) {
        result = await api.requestTorrentDl(Number(itemId), null, true);
      } else {
        result = await api.requestTorrentDl(Number(itemId), null, false).catch(() => api.requestTorrentDl(Number(itemId), null, true));
      }
    } else if (type === 'usenet') {
      result = await api.requestUsenetDl(Number(itemId), null, false).catch(() => api.requestUsenetDl(Number(itemId), null, true));
    } else if (type === 'webdl') {
      result = await api.requestWebDlDl(Number(itemId), null, false).catch(() => api.requestWebDlDl(Number(itemId), null, true));
    } else {
      await bot.editMessageText('❌ Unknown type.', { chat_id: targetChat, message_id: loading.message_id });
      return;
    }

    const link = result?.data;
    if (link && typeof link === 'string') {
      const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[type] || '📦';
      await bot.editMessageText(
        `${typeEmoji} <b>Fresh Download Link</b>\n\n` +
        `⚠️ <i>This link is for YOU only. Do not share it.</i>\n\n` +
        `${escapeHtml(link)}\n\n` +
        `🕐 <i>Expires in ~1 hour</i>\n` +
        `<i>Tap the button below to get a new link anytime.</i>`,
        {
          chat_id: targetChat,
          message_id: loading.message_id,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔄 Get Fresh Link Again', callback_data: `getlink:${type}:${itemId}` }]],
          },
        }
      );
    } else {
      const reason = result?.detail || result?.error || 'Could not generate link. Content may not be ready yet.';
      await bot.editMessageText(`❌ ${escapeHtml(reason)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

// ── /mydownloads ──────────────────────────────────────────────
async function handleMyDownloads(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const { getUserDownloads } = await import('./db.js');

  // Sync latest list from TorBox first
  await syncUserDownloadsToDb(userId, apiKey);

  const items = getUserDownloads(userId);

  if (!items.length) {
    await bot.sendMessage(chatId, '📭 <b>No tracked downloads yet.</b>\n\nAdd a torrent, NZB, or web link and the bot will monitor it automatically.', { parse_mode: 'HTML' });
    return;
  }

  let text = `📥 <b>My Downloads</b> (${items.length})\n\n`;
  const btns = [];

  for (const item of items.slice(0, 10)) {
    const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[item.type] || '📦';
    const name = truncate(item.name || `#${item.item_id}`, 35);
    const status = item.last_status || 'tracking…';
    const isDone = item.is_done === 1;

    text += `${typeEmoji} ${isDone ? '✅' : '⏳'} <b>${escapeHtml(name)}</b>\n`;
    text += `  ${escapeHtml(status)} | ID: <code>${item.item_id}</code>\n\n`;

    if (isDone) {
      btns.push([{ text: `🔗 Get Link: ${truncate(name, 20)}`, callback_data: `getlink:${item.type}:${item.item_id}` }]);
    }
  }

  if (items.length > 10) text += `<i>…and ${items.length - 10} more (showing latest 10)</i>\n`;
  text += `\n💡 <i>Links expire in ~1 hour. Press button anytime for a fresh one.</i>`;

  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: btns.length ? { inline_keyboard: btns } : undefined });
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

    // Track all in DB while checking status
    for (const t of torrents) if (t.id) trackDownload(userId, t.id, 'torrent', t.name);
    for (const u of usenets)  if (u.id) trackDownload(userId, u.id, 'usenet', u.name);
    for (const w of webdls)   if (w.id) trackDownload(userId, w.id, 'webdl', w.name);

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
        '🟢 <b>No Active Downloads</b>\n\n' +
        'All your downloads are either finished or idle.\n' +
        'Use /mydownloads or /torrents to view completed items.',
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
      );
      return;
    }

    let text = `⚡ <b>Active Downloads Status</b> (${totalActive} active)\n\n`;

    if (activeTorrents.length) {
      text += `<b>🧲 Active Torrents (${activeTorrents.length})</b>\n`;
      for (const t of activeTorrents) {
        const pct = t.progress != null ? t.progress * 100 : 0;
        const status = t.download_state || t.status || 'downloading';
        text += `• <b>${escapeHtml(truncate(t.name, 32))}</b>\n`;
        text += `  🆔 <code>${t.id}</code> | ${escapeHtml(status)} | ${escapeHtml(formatBytes(t.size))}\n`;
        text += `  <code>${progressBar(pct)}</code>\n`;
        if (t.download_speed) text += `  ⬇ ${escapeHtml(formatBytes(t.download_speed))}/s`;
        if (t.eta) text += ` | ⏱ ${escapeHtml(String(t.eta))}s`;
        text += '\n\n';
      }
    }

    if (activeUsenets.length) {
      text += `<b>📰 Active Usenet (${activeUsenets.length})</b>\n`;
      for (const u of activeUsenets) {
        const pct = u.progress != null ? u.progress * 100 : 0;
        const status = u.download_state || u.status || 'downloading';
        text += `• <b>${escapeHtml(truncate(u.name, 32))}</b>\n`;
        text += `  🆔 <code>${u.id}</code> | ${escapeHtml(status)} | ${escapeHtml(formatBytes(u.size))}\n`;
        text += `  <code>${progressBar(pct)}</code>\n\n`;
      }
    }

    if (activeWebdls.length) {
      text += `<b>🌐 Active Web Downloads (${activeWebdls.length})</b>\n`;
      for (const w of activeWebdls) {
        const pct = w.progress != null ? w.progress * 100 : 0;
        const status = w.download_state || w.status || 'downloading';
        text += `• <b>${escapeHtml(truncate(w.name, 32))}</b>\n`;
        text += `  🆔 <code>${w.id}</code> | ${escapeHtml(status)} | ${escapeHtml(formatBytes(w.size))}\n`;
        text += `  <code>${progressBar(pct)}</code>\n\n`;
      }
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

// ── /debrid — Add debrid/web download link ───────────────────────────
async function handleDebrid(bot, chatId, url, userId) {
  const plan = getCachedPlan(userId);
  const planErr = checkPlanFeature(plan, 'webdl');
  if (planErr) { bot.sendMessage(chatId, planErr, { parse_mode: 'HTML' }); return; }

  if (!url) {
    bot.sendMessage(chatId,
      '🌐 <b>TorBox Debrid / Web Downloader</b>\n\n' +
      'Paste any premium hoster or file link to unrestrict and download via TorBox.\n\n' +
      'Usage: <code>/debrid &lt;url&gt;</code>\n\n' +
      '<b>Supported Hosters Include:</b>\n' +
      '• 1Fichier, Rapidgator, DDownload, Mega, Google Drive\n' +
      '• Pixeldrain, Mediafire, Katfile, Filefactory, and more!',
      { parse_mode: 'HTML' }
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

  if (userId) {
    upsertUser(userId, { username: msg.from?.username, firstName });
    if (msg.chat.type === 'private') setPrivateChatId(userId, chatId);
    sessions.delete(userId);
  }

  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId,
      `👋 Hi <b>${escapeHtml(firstName)}</b>!\n\n` +
      `This bot is <b>access-restricted</b>.\n\n` +
      `Your Telegram ID: <code>${userId}</code>\n` +
      `Send this to the bot admin to request access.`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const hasKey = hasApiKey(userId);
  const plan   = getCachedPlan(userId);
  const PLAN_LABEL = { 0: '🆓 Free', 1: '🥈 Essential', 2: '🥇 Pro', 3: '💎 Ultimate' };

  await bot.sendMessage(chatId,
    `👋 <b>Welcome, ${escapeHtml(firstName)}!</b>\n\n` +
    `🆔 <b>Your Telegram ID:</b> <code>${userId}</code>\n` +
    `🚀 <b>TorBox Manager Bot</b>\n` +
    (plan !== null ? `🏷 Plan: <b>${escapeHtml(PLAN_LABEL[plan] || `Plan ${plan}`)}</b>\n` : '') +
    '\n' +
    (hasKey
      ? `✅ API key is set!\n\n`
      : `⚠️ <b>First: set your API key</b>\n<code>/setkey YOUR_API_KEY</code>\n\n`) +
    `<b>📦 Torrents</b>\n` +
    `/torrents — List all\n` +
    `/addmagnet — Add magnet (auto-notifies when ready)\n` +
    `/addcached — Add only if cached ⚡\n` +
    `/checkcached — Check cache status\n` +
    `/mydownloads — My downloads + get links\n` +
    `/getlink — Get fresh download link\n\n` +
    (plan === null || plan >= 1
      ? `<b>📰 Usenet</b> (Essential+)\n/usenet — List | /addnzb — Add NZB\n\n<b>🌐 Web Downloads & Debrid</b> (Essential+)\n/webdl — List | /debrid — Add URL\n\n`
      : `<b>📰 Usenet & 🌐 WebDL</b> — Requires Essential plan\n\n`) +
    `<b>🔍 Search</b> — /search\n\n` +
    `<b>👤 Account</b> — /me | /stats | /subscriptions\n\n` +
    `⚙️ /setkey — Set API key | /help — Full commands\n\n` +
    `🔐 <b>Download links are sent privately to you only.</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/help/, (msg) => {
  if (msg.from?.id) sessions.delete(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `📖 <b>TorBox Bot — Commands</b>\n\n` +
    `<b>🧲 Torrents</b>\n` +
    `/torrents — List (paginated)\n` +
    `/addmagnet &lt;magnet&gt; — Add torrent\n` +
    `/addcached &lt;hash|magnet&gt; — Add ⚡ cached only\n` +
    `/checkcached &lt;hash|magnet&gt; — Check cache\n` +
    `/torrent &lt;id&gt; — Details + controls\n` +
    `<i>Send .torrent file directly to upload</i>\n\n` +
    `<b>📥 My Downloads</b>\n` +
    `/mydownloads — All tracked downloads + status\n` +
    `/getlink &lt;type&gt; &lt;id&gt; — Get fresh download link anytime\n\n` +
    `<b>📰 Usenet (Essential+)</b>\n` +
    `/usenet — List | /addnzb &lt;url&gt; — Add NZB\n` +
    `/nzb &lt;id&gt; — Details + controls\n` +
    `<i>Send .nzb file directly</i>\n\n` +
    `<b>🌐 Web Downloads & Debrid (Essential+)</b>\n` +
    `/webdl — List | /debrid &lt;url&gt; — Add URL\n` +
    `/wdl &lt;id&gt; — Details + controls\n\n` +
    `<b>🔍 Search</b> — /search &lt;query&gt;\n\n` +
    `<b>📡 RSS (Essential+)</b> — /rss | /addrss &lt;url&gt;\n\n` +
    `<b>📋 Queue</b> — /queued\n\n` +
    `<b>🔔 Notifications (Essential+)</b> — /notifications\n\n` +
    `<b>👤 Account</b>\n` +
    `/me — Profile & plan | /stats | /subscriptions\n` +
    `/transactions | /globalstats\n\n` +
    `<b>⚙️ Settings</b>\n` +
    `/setkey &lt;key&gt; — Set API key\n` +
    `/mykey — Show key (masked)\n\n` +
    `<b>🔐 Link Privacy</b>\n` +
    `All download links → private DM only.\n` +
    `Links expire in ~1 hour — use /getlink or buttons to refresh.`,
    { parse_mode: 'HTML' }
  );
});

// ── /setkey ───────────────────────────────────────────────────
bot.onText(/\/setkey(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const userId = msg.from?.id || msg.chat.id;
    upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
    const key = match?.[1]?.trim();
    if (!key) { bot.sendMessage(msg.chat.id, '🔑 Usage: <code>/setkey YOUR_API_KEY</code>', { parse_mode: 'HTML' }); return; }
    await handleSetKey(bot, msg, key);
  });
});

// ── /mykey ────────────────────────────────────────────────────
bot.onText(/\/mykey/, (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  if (!isUserAllowed(userId)) return;
  const key = getUserApiKey(userId);
  if (!key) { bot.sendMessage(msg.chat.id, '❌ No API key set. Use <code>/setkey YOUR_KEY</code>', { parse_mode: 'HTML' }); return; }
  const masked = `${key.substring(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
  const plan = getCachedPlan(userId);
  const PLAN = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };
  bot.sendMessage(msg.chat.id, `🔑 API key: <code>${masked}</code>${plan !== null ? `\n🏷 Plan: <b>${PLAN[plan] || `Plan ${plan}`}</b>` : ''}`, { parse_mode: 'HTML' });
});

// ── /getlink <type> <id> ──────────────────────────────────────
bot.onText(/\/getlink(?:\s+(\w+))?(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const userId = msg.from?.id || msg.chat.id;
    const chatId = msg.chat.id;
    const type = match?.[1]?.toLowerCase();
    const id   = match?.[2];

    if (!type || !id) {
      const apiKey = getUserApiKey(userId);
      await syncUserDownloadsToDb(userId, apiKey);

      const { getUserDownloads } = await import('./db.js');
      const items = getUserDownloads(userId).filter(i => i.is_done === 1);

      if (!items.length) {
        bot.sendMessage(chatId,
          '📭 <b>No completed downloads tracked yet</b>\n\n' +
          'Usage: <code>/getlink torrent 12345</code>\n' +
          'Or use /mydownloads to see your downloads.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const btns = items.slice(0, 10).map(i => [{
        text: `${{ torrent: '🧲', usenet: '📰', webdl: '🌐' }[i.type]} ${truncate(i.name || `#${i.item_id}`, 28)}`,
        callback_data: `getlink:${i.type}:${i.item_id}`,
      }]);

      bot.sendMessage(chatId, '🔗 <b>Get Download Link</b>\n\nSelect which download:', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: btns },
      });
      return;
    }

    await handleGetLink(bot, chatId, userId, type, id);
  });
});

// ── /mydownloads ──────────────────────────────────────────────
bot.onText(/\/mydownloads/, (msg) => requireAuth(msg, () => handleMyDownloads(bot, msg)));
bot.onText(/\/status/, (msg) => requireAuth(msg, () => handleStatus(bot, msg)));

bot.onText(/\/debrid(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const url = match?.[1]?.trim();
    await handleDebrid(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});

// =============================================================
// TORRENT COMMANDS
// =============================================================

bot.onText(/\/torrents/, (msg) => requireAuth(msg, () => handleTorrentList(bot, msg, 0)));

bot.onText(/\/addmagnet(?:\s+(.+))?/s, async (msg, match) => {
  requireAuth(msg, async () => {
    const magnet = match?.[1]?.trim();
    if (!magnet) { bot.sendMessage(msg.chat.id, '🧲 Usage: <code>/addmagnet magnet:?xt=urn:btih:…</code>\nOr paste magnet link directly.', { parse_mode: 'HTML' }); return; }
    await handleAddMagnet(bot, msg.chat.id, magnet, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/addcached(?:\s+(.+))?/s, async (msg, match) => {
  requireAuth(msg, async () => {
    const input = match?.[1]?.trim();
    if (!input) {
      bot.sendMessage(msg.chat.id,
        '⚡ <b>Add Cached Torrent Only</b>\n\nUsage: <code>/addcached &lt;infohash|magnet&gt;</code>\n\nOnly adds if already cached on TorBox (instant!).', { parse_mode: 'HTML' });
      return;
    }
    await handleAddCached(bot, msg.chat.id, input, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/checkcached(?:\s+(.+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const input = match?.[1]?.trim();
    if (!input) { bot.sendMessage(msg.chat.id, '🔍 Usage: <code>/checkcached &lt;infohash|magnet&gt;</code>', { parse_mode: 'HTML' }); return; }
    await handleCheckCached(bot, msg.chat.id, input, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/torrent(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const id = match?.[1];
    if (!id) { bot.sendMessage(msg.chat.id, '📋 Usage: <code>/torrent &lt;id&gt;</code>', { parse_mode: 'HTML' }); return; }
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
    if (!url) { bot.sendMessage(msg.chat.id, '📰 Usage: <code>/addnzb &lt;nzb_url&gt;</code>\nOr send an .nzb file.', { parse_mode: 'HTML' }); return; }
    await handleAddNzbLink(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/nzb(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const id = match?.[1];
    if (!id) { bot.sendMessage(msg.chat.id, '📋 Usage: <code>/nzb &lt;id&gt;</code>', { parse_mode: 'HTML' }); return; }
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
    if (!url) { bot.sendMessage(msg.chat.id, '🌐 Usage: <code>/addwebdl &lt;url&gt;</code>', { parse_mode: 'HTML' }); return; }
    await handleAddWebDl(bot, msg.chat.id, url, msg.from?.id || msg.chat.id);
  });
});

bot.onText(/\/wdl(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const id = match?.[1];
    if (!id) { bot.sendMessage(msg.chat.id, '📋 Usage: <code>/wdl &lt;id&gt;</code>', { parse_mode: 'HTML' }); return; }
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
    if (!url) { bot.sendMessage(msg.chat.id, '📡 Usage: <code>/addrss &lt;feed_url&gt;</code>', { parse_mode: 'HTML' }); return; }
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
  if (!targetId) { bot.sendMessage(chatId, '❌ Usage: <code>/adduser &lt;telegram_id&gt;</code>', { parse_mode: 'HTML' }); return; }
  addAllowedUser(targetId, userId);
  bot.sendMessage(chatId, `✅ User <code>${targetId}</code> added to whitelist.`, { parse_mode: 'HTML' });
});

bot.onText(/\/removeuser(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  if (!targetId) { bot.sendMessage(chatId, '❌ Usage: <code>/removeuser &lt;telegram_id&gt;</code>', { parse_mode: 'HTML' }); return; }
  removeAllowedUser(targetId);
  bot.sendMessage(chatId, `✅ User <code>${targetId}</code> removed from whitelist.`, { parse_mode: 'HTML' });
});

bot.onText(/\/listusers/, (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  if (isOpenAccess()) { bot.sendMessage(chatId, '🌍 <b>Open access mode</b> — no users in whitelist yet.', { parse_mode: 'HTML' }); return; }
  const users = listAllowedUsers();
  const text = users.length
    ? `👥 <b>Allowed Users</b> (${users.length})\n\n` + users.map(u => `• <code>${u.user_id}</code> ${u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || '')}`).join('\n')
    : '📭 Whitelist is empty.';
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

bot.onText(/\/broadcast(?:\s+(.+))?/s, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const text = match?.[1];
  if (!text) { bot.sendMessage(chatId, '❌ Usage: <code>/broadcast &lt;message&gt;</code>', { parse_mode: 'HTML' }); return; }
  const users = listAllowedUsers();
  let sent = 0, failed = 0;
  for (const u of users) {
    const target = getPrivateChatId(u.user_id) || u.user_id;
    try { await bot.sendMessage(target, `📢 <b>Broadcast</b>\n\n${escapeHtml(text)}`, { parse_mode: 'HTML' }); sent++; }
    catch (_) { failed++; }
  }
  bot.sendMessage(chatId, `✅ Broadcast: ${sent} sent, ${failed} failed.`);
});

bot.onText(/\/adminpanel/, (msg) => {
  const userId = msg.from?.id;
  if (!isAdmin(userId)) return;
  const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.ADMIN_PORT || '3001'}`;
  bot.sendMessage(msg.chat.id,
    `🌐 <b>Web Admin Panel</b>\n\n` +
    `URL: ${escapeHtml(publicUrl)}/admin\n` +
    `Credentials set in ADMIN_WEB_USERNAME & ADMIN_WEB_PASSWORD`,
    { parse_mode: 'HTML' }
  );
});

// =============================================================
// FILE UPLOADS
// =============================================================

bot.on('document', async (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  if (!isUserAllowed(userId)) return;
  if (!hasApiKey(userId)) { bot.sendMessage(chatId, '🔑 Set your API key first: <code>/setkey YOUR_KEY</code>', { parse_mode: 'HTML' }); return; }

  upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
  if (msg.chat.type === 'private') setPrivateChatId(userId, chatId);

  const doc = msg.document;
  if (!doc) return;
  const name = doc.file_name || 'upload';
  const ext  = name.split('.').pop()?.toLowerCase();

  if (ext === 'torrent') {
    const loading = await bot.sendMessage(chatId, `📤 .torrent detected: <b>${escapeHtml(name)}</b>\nDownloading…`, { parse_mode: 'HTML' });
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await bot.editMessageText('📤 Uploading to TorBox…', { chat_id: chatId, message_id: loading.message_id });
      await handleAddTorrentFile(bot, chatId, buf, name, userId);
    } catch (err) {
      bot.editMessageText(`❌ ${escapeHtml(err.message)}`, { chat_id: chatId, message_id: loading.message_id });
    }
    return;
  }

  if (ext === 'nzb') {
    const plan = getCachedPlan(userId);
    const planErr = checkPlanFeature(plan, 'usenet');
    if (planErr) { bot.sendMessage(chatId, planErr, { parse_mode: 'HTML' }); return; }
    const loading = await bot.sendMessage(chatId, `📤 .nzb detected: <b>${escapeHtml(name)}</b>\nUploading…`, { parse_mode: 'HTML' });
    try {
      const buf = await downloadTelegramFile(doc.file_id);
      await handleAddNzbFile(bot, chatId, buf, name, userId);
      bot.deleteMessage(chatId, loading.message_id).catch(() => {});
    } catch (err) {
      bot.editMessageText(`❌ ${escapeHtml(err.message)}`, { chat_id: chatId, message_id: loading.message_id });
    }
    return;
  }

  bot.sendMessage(chatId, `ℹ️ Unsupported file: .${ext}\nSupported: .torrent, .nzb`);
});

// =============================================================
// TEXT MESSAGES (magnet / hash / URL / session input)
// =============================================================

bot.on('text', async (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || '';

  // Cancel any awaiting input if user typed a slash command
  if (text.startsWith('/')) {
    sessions.delete(userId);
    return;
  }

  if (!isUserAllowed(userId)) return;

  if (msg.chat.type === 'private' && userId) {
    upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
    setPrivateChatId(userId, chatId);
  }

  // Magnet link
  if (text.startsWith('magnet:')) {
    if (!hasApiKey(userId)) { bot.sendMessage(chatId, '🔑 Set your API key first: <code>/setkey YOUR_KEY</code>', { parse_mode: 'HTML' }); return; }
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
    if (showWebDl)  btns.push({ text: '🌐 Web Download / Debrid', callback_data: `add_webdl_confirm:${encodeURIComponent(text.substring(0, 200))}` });
    if (showUsenet) btns.push({ text: '📰 Usenet NZB',           callback_data: `add_nzb_confirm:${encodeURIComponent(text.substring(0, 200))}` });
    btns.push({ text: '❌ Cancel', callback_data: 'cancel' });

    await bot.sendMessage(chatId,
      `🔗 <b>URL Detected</b>\n<code>${escapeHtml(text.substring(0, 80))}${text.length > 80 ? '…' : ''}</code>\n\nWhat type of download is this?`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [btns.slice(0, 2), [btns[btns.length - 1]]] } }
    );
    return;
  }

  // Interactive session input
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

  if (data.startsWith('getlink:')) {
    const parts = data.split(':');
    await handleGetLink(bot, chatId, userId, parts[1], parts[2]);
    return;
  }

  if (data.startsWith('torrent_list:'))    { await handleTorrentList(bot, fakeMsg, parseInt(data.split(':')[1]) || 0); return; }
  if (data.startsWith('torrent_info:'))    { await handleTorrentInfo(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('torrent_files:'))   { await handleTorrentFiles(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('torrent_ctrl:'))    { const [, id, op] = data.split(':'); await handleTorrentControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('torrent_del:')) {
    const [, id, step] = data.split(':');
    if (step === 'confirm') {
      await bot.sendMessage(chatId, `⚠️ <b>Delete torrent <code>${id}</code>?</b> This cannot be undone.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ Yes, delete', callback_data: `torrent_del:${id}:do` }, { text: '❌ Cancel', callback_data: 'cancel' }]] },
      });
    } else if (step === 'do') await handleTorrentDelete(bot, chatId, id, userId);
    return;
  }
  if (data.startsWith('torrent_dl:'))     { const p = data.split(':'); await handleTorrentDl(bot, chatId, p[1], p[2] || 'zip', userId); return; }
  if (data.startsWith('addcached:'))      { await handleAddCached(bot, chatId, data.replace('addcached:', ''), userId); return; }

  if (data.startsWith('usenet_list:'))    { await handleUsenetList(bot, fakeMsg, parseInt(data.split(':')[1]) || 0); return; }
  if (data.startsWith('usenet_info:'))    { await handleUsenetInfo(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('usenet_ctrl:'))    { const [, id, op] = data.split(':'); await handleUsenetControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('usenet_del:')) {
    const [, id, step] = data.split(':');
    if (step === 'confirm') {
      await bot.sendMessage(chatId, `⚠️ <b>Delete usenet <code>${id}</code>?</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Delete', callback_data: `usenet_del:${id}:do` }, { text: '❌ Cancel', callback_data: 'cancel' }]] } });
    } else if (step === 'do') await handleUsenetDelete(bot, chatId, id, userId);
    return;
  }
  if (data.startsWith('usenet_dl:'))      { const p = data.split(':'); await handleUsenetDl(bot, chatId, p[1], p[2] || 'zip', userId); return; }

  if (data.startsWith('webdl_list:'))     { await handleWebDlList(bot, fakeMsg, parseInt(data.split(':')[1]) || 0); return; }
  if (data.startsWith('webdl_info:'))     { await handleWebDlInfo(bot, chatId, data.split(':')[1], userId); return; }
  if (data.startsWith('webdl_ctrl:'))     { const [, id, op] = data.split(':'); await handleWebDlControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('webdl_del:')) {
    const [, id, step] = data.split(':');
    if (step === 'confirm') {
      await bot.sendMessage(chatId, `⚠️ <b>Delete web download <code>${id}</code>?</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Delete', callback_data: `webdl_del:${id}:do` }, { text: '❌ Cancel', callback_data: 'cancel' }]] } });
    } else if (step === 'do') await handleWebDlDelete(bot, chatId, id, userId);
    return;
  }
  if (data.startsWith('webdl_dl:'))       { const p = data.split(':'); await handleWebDlDl(bot, chatId, p[1], p[2] || 'zip', userId); return; }

  if (data.startsWith('queued:'))         { await handleQueued(bot, fakeMsg, data.split(':')[1]); return; }
  if (data === 'notif_clear')             { await handleClearNotifications(bot, chatId, userId); return; }
  if (data.startsWith('rss_ctrl:'))       { const [, id, op] = data.split(':'); await handleRssControl(bot, chatId, id, op, userId); return; }
  if (data.startsWith('add_webdl_confirm:')) { await handleAddWebDl(bot, chatId, decodeURIComponent(data.replace('add_webdl_confirm:', '')), userId); return; }
  if (data.startsWith('add_nzb_confirm:'))   { await handleAddNzbLink(bot, chatId, decodeURIComponent(data.replace('add_nzb_confirm:', '')), userId); return; }
  if (data === 'cancel')                  { await bot.sendMessage(chatId, '❌ Cancelled.'); return; }
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
// ERROR + SHUTDOWN HANDLING
// =============================================================

function formatError(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.response?.body?.description) return err.response.body.description;
  if (err.response?.data?.detail) return err.response.data.detail;
  if (err.message) return err.message;
  if (err.code) return `Error code: ${err.code}`;
  return String(err);
}

let isConflictCoolingDown = false;
bot.on('polling_error', (err) => {
  const msg = formatError(err);
  if (msg.includes('409 Conflict')) {
    if (!isConflictCoolingDown) {
      isConflictCoolingDown = true;
      console.warn('⚠️ Telegram Polling Conflict (409): Another bot instance is running with this token. (If running locally, stop your local bot or use a separate test bot token).');
      setTimeout(() => { isConflictCoolingDown = false; }, 15000);
    }
  } else if (msg.includes('ETIMEDOUT') || msg.includes('EFATAL') || msg.includes('ECONNRESET')) {
    console.warn(`⚠️ Telegram network glitch (${msg}). Bot will auto-retry…`);
  } else {
    console.error('❌ Telegram Polling error:', msg);
  }
});

bot.on('error', (err) => {
  console.error('❌ Telegram Bot error:', formatError(err));
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Intercepted Unhandled Promise Rejection:', formatError(reason));
});

process.on('uncaughtException', (err) => {
  console.error('💥 Intercepted Uncaught Exception:', formatError(err));
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down TorBox Telegram Bot…');
  try { await bot.stopPolling(); } catch (_) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received — shutting down…');
  try { await bot.stopPolling(); } catch (_) {}
  process.exit(0);
});

console.log('✅ TorBox Bot is live!');
