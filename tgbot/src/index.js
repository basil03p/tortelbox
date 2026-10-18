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
  getUserApiKey, setUserApiKey, removeUserApiKey, hasApiKey, hasPersonalApiKey, sessions,
  setPrivateChatId, getPrivateChatId, setCachedPlan, getCachedPlan,
  isUserAllowed, isUserAllowedMain, addAllowedUser, removeAllowedUser, listAllowedUsers, isOpenAccess,
  checkPlanFeature,
} from './session.js';

import {
  upsertUser, trackDownload, isItemOwnedByUser, getAllRegisteredUsers, getUserDetailedInfo,
  getUserTrackedItemIds, clearUserTracked, deleteTrackedDownload,
} from './db.js';
import { createApiClient, extractHashFromMagnet, isInfohash, extractNameFromMagnet } from './api.js';
import {
  escapeHtml, truncate, formatBytes, statusEmoji, progressBar, extractDownloadUrl, getDownloadStateInfo,
  resolveCleanDownloadName, isHashString,
} from './utils.js';
import { startMonitor } from './monitor.js';
import { streamUrlToGofile } from './gofile.js';

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
import { handleGofileUpload, handleMyGofile } from './handlers/gofile.js';
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

function sendNoApiKeyMessage(chatId, userId) {
  bot.sendMessage(
    chatId,
    `🔑 <b>TorBox API Key Required</b>\n\n` +
    `Please set your TorBox API key to use the bot:\n` +
    `<code>/setkey YOUR_API_KEY</code>\n\n` +
    `Get your key at: https://torbox.app/settings`,
    { parse_mode: 'HTML' }
  );
}

// ── Auth middleware ────────────────────────────────────────────
function requireAuth(msg, callback) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (msg.chat.type === 'private' && userId) {
    upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
    setPrivateChatId(userId, chatId);
  }

  // Clear any pending input state when running a slash command
  if (msg.text?.startsWith('/')) {
    sessions.delete(userId);
  }

  if (!isUserAllowed(userId)) {
    bot.sendMessage(
      chatId,
      `🚫 <b>Access Denied</b>\n\n` +
      `Your Telegram ID: <code>${userId}</code>\n\n` +
      `This bot is restricted to authorized users.\n` +
      `Please contact the bot administrator with your ID to request access.`,
      { parse_mode: 'HTML' }
    );
    return;
  }
  if (!hasApiKey(userId)) {
    sendNoApiKeyMessage(chatId, userId);
    return;
  }
  ensurePlanCached(userId).catch(() => {});
  callback();
}

// ── /getlink — fresh link on demand ────────────────────────────
export async function handleGetLink(bot, chatId, userId, type, itemId, isExplicitZip = false) {
  const apiKey = getUserApiKey(userId);
  const privateChatId = getPrivateChatId(userId);

  const isGroup = chatId !== userId && privateChatId && privateChatId !== String(chatId);
  if (isGroup) {
    await bot.sendMessage(chatId, '🔐 Sending your download link privately — check your DMs!');
  }
  const targetChat = privateChatId || String(chatId);
  const loading = await bot.sendMessage(targetChat, '🔗 Generating fresh download link(s)…');

  try {
    const api = createApiClient(apiKey);

    if (type === 'torrent') {
      const details = await api.getTorrentById(Number(itemId)).catch(() => null);
      const items = details?.data;
      const t = Array.isArray(items) ? items.find((x) => String(x.id) === String(itemId)) : items;
      const files = Array.isArray(t?.files) ? t.files : [];
      const name = t?.name || `Torrent #${itemId}`;

      // User explicitly requested ZIP archive
      if (isExplicitZip) {
        const zipRes = await api.requestTorrentDl(Number(itemId), null, true).catch(() => null);
        const zipLink = extractDownloadUrl(zipRes);
        if (zipLink) {
          let text = `📦 <b>ZIP Archive Download Link</b>\n\n`;
          text += `📋 <b>Name:</b> ${escapeHtml(truncate(name, 40))}\n\n`;
          text += `${escapeHtml(zipLink)}\n\n`;
          text += `⚠️ <i>This ZIP packages all ${files.length || 'multiple'} files together.</i>\n`;
          text += `🕐 <i>Expires in ~1 hour</i>`;

          await bot.editMessageText(text, {
            chat_id: targetChat, message_id: loading.message_id,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '📄 Direct File Links', callback_data: `getlink:torrent:${itemId}` },
                  { text: '📁 All Files List', callback_data: `torrent_files:${itemId}` },
                ],
                [{ text: '🔄 Refresh ZIP Link', callback_data: `getlink:torrent:${itemId}:zip` }],
              ],
            },
          });
          return;
        }
      }

      if (files.length > 1) {
        // Multi-file: generate direct file links ONLY (NO ZIP link in text)
        const topFiles = files.slice(0, 5);
        const fileLinkPromises = topFiles.map((f) =>
          api.requestTorrentDl(Number(itemId), f.id, false).catch(() => null)
        );
        const fileLinkResults = await Promise.all(fileLinkPromises);

        let text = `📂 <b>Multiple Files Detected (${files.length} Files)</b>\n`;
        text += `📋 <b>Torrent:</b> ${escapeHtml(truncate(name, 40))}\n\n`;

        text += `📄 <b>Individual Direct File Links:</b>\n`;
        topFiles.forEach((f, idx) => {
          const flink = extractDownloadUrl(fileLinkResults[idx]);
          const fname = truncate(f.name || f.short_name || `File ${idx + 1}`, 35);
          const fsize = formatBytes(f.size);
          text += `<b>${idx + 1}. ${escapeHtml(fname)}</b> (${escapeHtml(fsize)})\n`;
          if (flink) {
            text += `${escapeHtml(flink)}\n\n`;
          } else {
            text += `<i>(Use file list to fetch)</i>\n\n`;
          }
        });

        if (files.length > 5) {
          text += `<i>…and ${files.length - 5} more files. Tap "📁 All Files List" below.</i>\n\n`;
        }

        text += `🕐 <i>Links expire in ~1 hour</i>`;

        const keyboard = {
          inline_keyboard: [
            [
              { text: '📦 Request ZIP Archive', callback_data: `getlink:torrent:${itemId}:zip` },
              { text: '📁 All Files List', callback_data: `torrent_files:${itemId}` },
            ],
            [{ text: '🔄 Refresh Direct Links', callback_data: `getlink:torrent:${itemId}` }],
          ],
        };

        await bot.editMessageText(text, {
          chat_id: targetChat, message_id: loading.message_id,
          parse_mode: 'HTML', reply_markup: keyboard,
        });
        return;
      } else if (files.length === 1) {
        const f = files[0];
        const res = await api.requestTorrentDl(Number(itemId), f?.id ?? 0, false).catch(() => null);
        const link = extractDownloadUrl(res);

        if (link) {
          let text = `🧲 <b>Single File Download Link</b>\n\n`;
          text += `📄 <b>File:</b> ${escapeHtml(f?.name || name)} (${escapeHtml(formatBytes(f?.size || t?.size))})\n\n`;
          text += `${escapeHtml(link)}\n\n`;
          text += `🕐 <i>Expires in ~1 hour</i>`;

          await bot.editMessageText(text, {
            chat_id: targetChat, message_id: loading.message_id,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: '🔄 Refresh Link', callback_data: `getlink:torrent:${itemId}` }]],
            },
          });
          return;
        }
      }
    }

    if (type === 'usenet') {
      const details = await api.getUsenetById(Number(itemId)).catch(() => null);
      const items = details?.data;
      const u = Array.isArray(items) ? items.find((x) => String(x.id) === String(itemId)) : items;
      const files = Array.isArray(u?.files) ? u.files : [];
      const name = u?.name || `Usenet #${itemId}`;

      // User explicitly requested ZIP archive
      if (isExplicitZip) {
        const zipRes = await api.requestUsenetDl(Number(itemId), null, true).catch(() => null);
        const zipLink = extractDownloadUrl(zipRes);
        if (zipLink) {
          let text = `📦 <b>ZIP Archive Download Link</b>\n\n`;
          text += `📋 <b>Name:</b> ${escapeHtml(truncate(name, 40))}\n\n`;
          text += `${escapeHtml(zipLink)}\n\n`;
          text += `⚠️ <i>This ZIP packages all files together.</i>\n`;
          text += `🕐 <i>Expires in ~1 hour</i>`;

          await bot.editMessageText(text, {
            chat_id: targetChat, message_id: loading.message_id,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Refresh ZIP Link', callback_data: `getlink:usenet:${itemId}:zip` }],
                [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:usenet:${itemId}` }],
              ],
            },
          });
          return;
        }
      }

      if (files.length > 1) {
        // Multi-file Usenet: generate direct file links
        const topFiles = files.slice(0, 5);
        const fileLinkPromises = topFiles.map((f) =>
          api.requestUsenetDl(Number(itemId), f.id, false).catch(() => null)
        );
        const fileLinkResults = await Promise.all(fileLinkPromises);

        let text = `📂 <b>Multiple Files Detected (${files.length} Files)</b>\n`;
        text += `📋 <b>Usenet:</b> ${escapeHtml(truncate(name, 40))}\n\n`;

        text += `📄 <b>Individual Direct File Links:</b>\n`;
        topFiles.forEach((f, idx) => {
          const flink = extractDownloadUrl(fileLinkResults[idx]);
          const fname = truncate(f.name || f.short_name || `File ${idx + 1}`, 35);
          const fsize = formatBytes(f.size);
          text += `<b>${idx + 1}. ${escapeHtml(fname)}</b> (${escapeHtml(fsize)})\n`;
          if (flink) {
            text += `${escapeHtml(flink)}\n\n`;
          } else {
            text += `<i>(Generating link…)</i>\n\n`;
          }
        });

        if (files.length > 5) {
          text += `<i>…and ${files.length - 5} more files.</i>\n\n`;
        }

        text += `🕐 <i>Links expire in ~1 hour</i>`;

        const keyboard = {
          inline_keyboard: [
            [{ text: '📦 Request ZIP Archive', callback_data: `getlink:usenet:${itemId}:zip` }],
            [{ text: '🔄 Refresh Direct Links', callback_data: `getlink:usenet:${itemId}` }],
            [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:usenet:${itemId}` }],
          ],
        };

        await bot.editMessageText(text, {
          chat_id: targetChat, message_id: loading.message_id,
          parse_mode: 'HTML', reply_markup: keyboard,
        });
        return;
      } else if (files.length === 1) {
        const f = files[0];
        const res = await api.requestUsenetDl(Number(itemId), f?.id ?? 0, false).catch(() => null);
        const link = extractDownloadUrl(res);

        if (link) {
          let text = `📰 <b>Single File Download Link</b>\n\n`;
          text += `📄 <b>File:</b> ${escapeHtml(f?.name || name)} (${escapeHtml(formatBytes(f?.size || u?.size))})\n\n`;
          text += `${escapeHtml(link)}\n\n`;
          text += `🕐 <i>Expires in ~1 hour</i>`;

          await bot.editMessageText(text, {
            chat_id: targetChat, message_id: loading.message_id,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Refresh Link', callback_data: `getlink:usenet:${itemId}` }],
                [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:usenet:${itemId}` }],
              ],
            },
          });
          return;
        }
      }
    }

    // Default fallback link request
    let result;
    if (type === 'torrent') result = await api.requestTorrentDl(Number(itemId), null, true);
    else if (type === 'usenet') result = await api.requestUsenetDl(Number(itemId), null, true);
    else if (type === 'webdl') result = await api.requestWebDlDl(Number(itemId), null, true);

    const link = extractDownloadUrl(result);
    if (link) {
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
            inline_keyboard: [
              [{ text: '🔄 Get Fresh Link Again', callback_data: `getlink:${type}:${itemId}` }],
              [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:${type}:${itemId}` }],
            ],
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
  const { getUserDownloads } = await import('./db.js');

  const items = await getUserDownloads(userId);

  if (!items.length) {
    await bot.sendMessage(chatId, '📭 <b>No tracked downloads yet.</b>\n\nAdd a torrent, NZB, or web link and the bot will monitor it automatically.', { parse_mode: 'HTML' });
    return;
  }

  let text = `📥 <b>My Downloads</b> (${items.length})\n\n`;
  const btns = [];

  for (const item of items.slice(0, 10)) {
    const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[item.type] || '📦';
    const cleanName = resolveCleanDownloadName(item, item.name || `#${item.item_id}`);
    const name = truncate(cleanName, 35);
    const status = item.last_status || 'tracking…';
    const isDone = item.is_done === 1;

    text += `${typeEmoji} ${isDone ? '✅' : '⏳'} <b>${escapeHtml(name)}</b>\n`;
    text += `  ${escapeHtml(status)} | ID: <code>${item.item_id}</code>\n\n`;

    if (isDone) {
      btns.push([{ text: `🔗 Get Link: ${truncate(cleanName, 20)}`, callback_data: `getlink:${item.type}:${item.item_id}` }]);
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

    const [torrentRes, usenetRes, webdlRes, userTorrents, userUsenets, userWebdls] = await Promise.all([
      api.getTorrentList(true).catch(() => ({ data: [] })),
      (plan === null || plan >= 1) ? api.getUsenetList(true).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
      (plan === null || plan >= 1) ? api.getWebDlList(true).catch(() => ({ data: [] })) : Promise.resolve({ data: [] }),
      getUserTrackedItemIds(userId, 'torrent'),
      getUserTrackedItemIds(userId, 'usenet'),
      getUserTrackedItemIds(userId, 'webdl'),
    ]);

    // STRICT: Only match downloads tracked for this specific user in MongoDB/SQLite
    const torrents = (torrentRes?.data || []).filter(t => userTorrents.has(String(t.id)) || (t.hash && userTorrents.has(String(t.hash).toLowerCase())));
    const usenets  = (usenetRes?.data || []).filter(u => userUsenets.has(String(u.id)) || (u.hash && userUsenets.has(String(u.hash).toLowerCase())));
    const webdls   = (webdlRes?.data || []).filter(w => userWebdls.has(String(w.id)));

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
        'All your tracked downloads are either finished or idle.\n' +
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
        const cleanName = resolveCleanDownloadName(t, t.name);
        text += `• <b>${escapeHtml(truncate(cleanName, 32))}</b>\n`;
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
        const cleanName = resolveCleanDownloadName(u, u.name);
        text += `• <b>${escapeHtml(truncate(cleanName, 32))}</b>\n`;
        text += `  🆔 <code>${u.id}</code> | ${escapeHtml(status)} | ${escapeHtml(formatBytes(u.size))}\n`;
        text += `  <code>${progressBar(pct)}</code>\n\n`;
      }
    }

    if (activeWebdls.length) {
      text += `<b>🌐 Active Web Downloads (${activeWebdls.length})</b>\n`;
      for (const w of activeWebdls) {
        const pct = w.progress != null ? w.progress * 100 : 0;
        const status = w.download_state || w.status || 'downloading';
        const cleanName = resolveCleanDownloadName(w, w.name);
        text += `• <b>${escapeHtml(truncate(cleanName, 32))}</b>\n`;
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
  const hasPersonal = hasPersonalApiKey(userId);
  const hasMain = isUserAllowedMain(userId);
  const PLAN_LABEL = { 0: '🆓 Free', 1: '🥈 Essential', 2: '🥇 Pro', 3: '💎 Ultimate' };

  let keyStatusStr = '';
  if (hasPersonal) {
    keyStatusStr = '🔑 Key Status: <b>Active (Personal Key)</b>\n\n';
  } else if (hasMain) {
    keyStatusStr = '🔑 Key Status: <b>Active (Shared Main Account)</b>\n\n';
  } else if (hasKey) {
    keyStatusStr = '🔑 Key Status: <b>Active & Ready to use</b>\n\n';
  } else {
    keyStatusStr = '🔑 Key Status: ⚠️ <b>No API key set</b>\n👉 Run <code>/setkey YOUR_API_KEY</code> to connect your TorBox account.\n\n';
  }

  await bot.sendMessage(chatId,
    `👋 <b>Welcome, ${escapeHtml(firstName)}!</b>\n\n` +
    `🆔 <b>Your Telegram ID:</b> <code>${userId}</code>\n` +
    `🚀 <b>TorBox Manager Bot</b>\n` +
    (plan !== null ? `🏷 Plan: <b>${escapeHtml(PLAN_LABEL[plan] || `Plan ${plan}`)}</b>\n` : '') +
    keyStatusStr +
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
    `⚙️ /setkey — Set TorBox API key | /mykey — View key\n` +
    `📖 /help — Full command guide\n\n` +
    `🔐 <b>Download links are sent privately to you only.</b>`,
    { parse_mode: 'HTML' }
  );
});

bot.onText(/\/help/, (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  if (msg.from?.id) sessions.delete(msg.from.id);
  const isUserAdmin = isAdmin(userId);

  let helpText =
    `📖 <b>TorBox Bot — Command Guide</b>\n\n` +
    `<b>🧲 Torrents</b>\n` +
    `/torrents — List (paginated)\n` +
    `/addmagnet &lt;magnet&gt; — Add torrent\n` +
    `/addcached &lt;hash|magnet&gt; — Add ⚡ cached only\n` +
    `/checkcached &lt;hash|magnet&gt; — Check cache\n` +
    `/torrent &lt;id&gt; — Details + controls\n` +
    `<i>Send .torrent file directly to upload</i>\n\n` +
    `<b>📥 My Downloads</b>\n` +
    `/mydownloads — All tracked downloads + status\n` +
    `/status — Active downloads in progress\n` +
    `/getlink &lt;type&gt; &lt;id&gt; — Get fresh download link anytime\n` +
    `/cleartracked [all] — Clear completed or all history from database\n` +
    `/untrack &lt;id&gt; — Untrack an item from database\n\n` +
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
    `<b>👤 Account & Settings</b>\n` +
    `/me — Profile & plan info | /stats\n` +
    `/setkey &lt;key&gt; — Set personal TorBox API key\n` +
    `/mykey — View current key status & plan\n` +
    `/delkey — Remove personal API key\n\n`;

  if (isUserAdmin) {
    helpText +=
      `<b>🛡️ Admin Commands (Admin Only)</b>\n` +
      `/allow &lt;user_id&gt; [main] — Grant user access ('main' shares owner API key securely)\n` +
      `/remove &lt;user_id&gt; — Revoke user access (or reply to message)\n` +
      `/listusers — List authorized users & plans\n` +
      `/setapikey &lt;user_id&gt; &lt;key&gt; — Set user's TorBox API key\n` +
      `/getkey &lt;user_id&gt; — View user's API key\n` +
      `/delkey &lt;user_id&gt; — Delete user API key\n` +
      `/userinfo &lt;user_id&gt; — User breakdown & stats\n` +
      `/regusers — List all registered users in database\n` +
      `/broadcast &lt;message&gt; — Send message to all users\n` +
      `/adminpanel — Web admin panel link\n\n`;
  }

  helpText +=
    `<b>🔐 Link Privacy</b>\n` +
    `All download links are sent privately to you only.\n` +
    `Links expire in ~1 hour — use /getlink or buttons to refresh.`;

  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
});

// ── /setkey ───────────────────────────────────────────────────
bot.onText(/\/setkey(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (msg.chat.type === 'private' && userId) {
    upsertUser(userId, { username: msg.from?.username, firstName: msg.from?.first_name });
    setPrivateChatId(userId, chatId);
  }

  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId, `🚫 <b>Access Denied</b>\n\nYour Telegram ID: <code>${userId}</code>\nContact the bot admin to request access.`, { parse_mode: 'HTML' });
    return;
  }

  const key = match?.[1]?.trim();
  if (!key) {
    sessions.set(userId, { awaitingInput: 'setkey' });
    bot.sendMessage(chatId,
      `🔑 <b>Set TorBox API Key</b>\n\n` +
      `Please send your TorBox API key now as a message, or use:\n` +
      `<code>/setkey YOUR_API_KEY</code>\n\n` +
      `Get your key at: https://torbox.app/settings`,
      { parse_mode: 'HTML', reply_markup: { force_reply: true } }
    );
    return;
  }

  await handleSetKey(bot, msg, key);
});

// ── /mykey ────────────────────────────────────────────────────
bot.onText(/\/mykey/, (msg) => {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (!isUserAllowed(userId)) {
    bot.sendMessage(chatId, `🚫 <b>Access Denied</b>\n\nYour Telegram ID: <code>${userId}</code>`, { parse_mode: 'HTML' });
    return;
  }

  const key = getUserApiKey(userId);
  if (!key) {
    sendNoApiKeyMessage(chatId, userId);
    return;
  }

  const plan = getCachedPlan(userId);
  const PLAN = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };
  const planStr = plan !== null ? (PLAN[plan] || `Plan ${plan}`) : 'Default';

  // If user has shared main access (and is not bot admin and has no personal key)
  if (!isAdmin(userId) && !hasPersonalApiKey(userId) && isUserAllowedMain(userId)) {
    bot.sendMessage(chatId,
      `🔑 <b>TorBox Access:</b> <code>[Protected — Main Account]</code>\n` +
      `🏷 Plan: <b>${planStr}</b>\n` +
      `🛡️ Access: <b>Shared Bot Access</b>\n\n` +
      `<i>The main TorBox account key is managed securely by the bot owner and hidden from view.</i>\n\n` +
      `💡 <i>To link your personal TorBox account instead, use <code>/setkey YOUR_KEY</code>.</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const masked = `${key.substring(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
  const isPersonal = hasPersonalApiKey(userId);
  const label = isPersonal ? 'Personal' : (isAdmin(userId) ? 'Admin' : 'Inherited');

  bot.sendMessage(chatId,
    `🔑 <b>${label} API Key:</b> <code>${masked}</code>\n` +
    (plan !== null ? `🏷 Plan: <b>${planStr}</b>\n\n` : '\n') +
    `💡 <i>Use <code>/setkey &lt;new_key&gt;</code> to update or <code>/delkey</code> to remove.</i>`,
    { parse_mode: 'HTML' }
  );
});

// ── /delkey ───────────────────────────────────────────────────
bot.onText(/\/delkey(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (!isUserAllowed(userId)) return;
  const targetId = match?.[1];

  if (targetId && isAdmin(userId)) {
    removeUserApiKey(targetId);
    bot.sendMessage(chatId, `🗑 API key removed for user <code>${targetId}</code>.`, { parse_mode: 'HTML' });
    return;
  }

  if (hasPersonalApiKey(userId)) {
    removeUserApiKey(userId);
    bot.sendMessage(chatId, `🗑 Your personal TorBox API key has been removed.`, { parse_mode: 'HTML' });
  } else if (isAdmin(userId)) {
    removeUserApiKey(userId);
    bot.sendMessage(chatId, `🗑 Admin API key removed.`, { parse_mode: 'HTML' });
  } else {
    bot.sendMessage(chatId, `ℹ️ You do not have a personal API key set.`, { parse_mode: 'HTML' });
  }
});

// ── /getlink <type> <id> ──────────────────────────────────────
bot.onText(/\/getlink(?:\s+(\w+))?(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const userId = msg.from?.id || msg.chat.id;
    const chatId = msg.chat.id;
    const type = match?.[1]?.toLowerCase();
    const id   = match?.[2];

    if (!type || !id) {
      const { getUserDownloads } = await import('./db.js');
      const items = (await getUserDownloads(userId)).filter(i => i.is_done === 1);

      if (!items.length) {
        bot.sendMessage(chatId,
          '📭 <b>No completed downloads tracked yet</b>\n\n' +
          'Usage: <code>/getlink torrent 12345</code>\n' +
          'Or use /mydownloads to see your downloads.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      const btns = items.slice(0, 10).map(i => {
        const cleanName = resolveCleanDownloadName(i, i.name || `#${i.item_id}`);
        return [{
          text: `${{ torrent: '🧲', usenet: '📰', webdl: '🌐' }[i.type]} ${truncate(cleanName, 28)}`,
          callback_data: `getlink:${i.type}:${i.item_id}`,
        }];
      });

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

// ── /cleartracked [all] — Clear tracked downloads history from DB ───────
bot.onText(/\/cleartracked(?:\s+(all))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const userId = msg.from?.id || msg.chat.id;
    const isAll = match?.[1]?.toLowerCase() === 'all';
    const deletedCount = await clearUserTracked(userId, !isAll);
    if (isAll) {
      bot.sendMessage(msg.chat.id, `🗑 <b>Cleared All Tracked Downloads</b>\n\nRemoved ${deletedCount} record(s) from your database history.`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(msg.chat.id, `🧹 <b>Cleaned Completed Downloads</b>\n\nRemoved ${deletedCount} completed record(s) from your database history.\n\n<i>To clear both active & completed items:</i> <code>/cleartracked all</code>`, { parse_mode: 'HTML' });
    }
  });
});

// ── /untrack <id> — Remove a specific item from tracked database ───────
bot.onText(/\/untrack(?:\s+(\w+))?(?:\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const userId = msg.from?.id || msg.chat.id;
    let type = match?.[1]?.toLowerCase();
    let id = match?.[2];

    if (type && !id && /^\d+$/.test(type)) {
      id = type;
      type = null;
    }

    if (!id) {
      bot.sendMessage(msg.chat.id, 'Usage: <code>/untrack [torrent|usenet|webdl] &lt;id&gt;</code>\nExample: <code>/untrack 12345</code>', { parse_mode: 'HTML' });
      return;
    }

    let deleted = 0;
    if (type) {
      deleted = await deleteTrackedDownload(userId, id, type);
    } else {
      const d1 = await deleteTrackedDownload(userId, id, 'torrent');
      const d2 = await deleteTrackedDownload(userId, id, 'usenet');
      const d3 = await deleteTrackedDownload(userId, id, 'webdl');
      deleted = d1 + d2 + d3;
    }

    if (deleted > 0) {
      bot.sendMessage(msg.chat.id, `✅ Untracked download <code>${id}</code> from your database.`, { parse_mode: 'HTML' });
    } else {
      bot.sendMessage(msg.chat.id, `ℹ️ Item <code>${id}</code> was not found in your tracked downloads.`, { parse_mode: 'HTML' });
    }
  });
});

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

bot.onText(/\/mygofile/, (msg) => requireAuth(msg, () => handleMyGofile(bot, msg)));
bot.onText(/\/gofile(?:\s+([a-z]+)\s+(\d+))?/, async (msg, match) => {
  requireAuth(msg, async () => {
    const type = match?.[1];
    const id = match?.[2];
    if (type && id) {
      await handleGofileUpload(bot, msg.chat.id, msg.from?.id || msg.chat.id, type, id);
    } else {
      await handleMyGofile(bot, msg);
    }
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

bot.onText(/\/regusers/, async (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const users = await getAllRegisteredUsers();
  if (!users.length) {
    bot.sendMessage(chatId, '📭 No registered users found in MongoDB database.', { parse_mode: 'HTML' });
    return;
  }

  const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };

  let text = `👥 <b>Registered Users (Admin Only)</b> (${users.length})\n\n`;
  for (const u of users) {
    const statusStr = u.is_allowed ? '✅ Allowed' : '🚫 Revoked';
    const planStr = PLAN_NAMES[u.plan] || (u.plan != null ? `Plan ${u.plan}` : 'Default');
    const maskedKey = u.api_key ? `<code>${u.api_key.slice(0, 6)}...${u.api_key.slice(-4)}</code>` : '<i>None</i>';
    const nameStr = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || 'Anonymous');

    text += `• <b>ID:</b> <code>${u.user_id}</code> (${nameStr})\n`;
    text += `  └ Status: ${statusStr} | Plan: ${planStr}\n`;
    text += `  └ API Key: ${maskedKey}\n\n`;
  }

  text += `💡 <i>Use <code>/getkey &lt;user_id&gt;</code> to view full API key.</i>\n`;
  text += `💡 <i>Use <code>/userinfo &lt;user_id&gt;</code> for full user breakdown.</i>`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

bot.onText(/\/getkey(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  if (!targetId) {
    bot.sendMessage(chatId, '❌ Usage: <code>/getkey &lt;telegram_id&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const key = getUserApiKey(targetId);
  if (!key) {
    bot.sendMessage(chatId, `📭 No API key found for user <code>${targetId}</code>.`, { parse_mode: 'HTML' });
    return;
  }
  bot.sendMessage(chatId, `🔑 <b>API Key for User <code>${targetId}</code> (Admin Only):</b>\n\n<code>${key}</code>`, { parse_mode: 'HTML' });
});

bot.onText(/\/userinfo(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  if (!targetId) {
    bot.sendMessage(chatId, '❌ Usage: <code>/userinfo &lt;telegram_id&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  const info = await getUserDetailedInfo(targetId);
  const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };
  const planStr = PLAN_NAMES[info.plan] || (info.plan != null ? `Plan ${info.plan}` : 'Default');
  const statusStr = info.is_allowed ? '✅ Allowed' : '🚫 Revoked';
  const nameStr = info.username ? `@${escapeHtml(info.username)}` : escapeHtml(info.first_name || 'N/A');

  let text = `👤 <b>User Info: <code>${info.user_id}</code></b>\n\n`;
  text += `• <b>Name:</b> ${nameStr}\n`;
  text += `• <b>Status:</b> ${statusStr}\n`;
  text += `• <b>Plan:</b> ${planStr}\n`;
  text += `• <b>API Key:</b> ${info.api_key ? `<code>${info.api_key}</code>` : '<i>Not Set</i>'}\n`;
  text += `• <b>Total Downloads Tracked:</b> ${info.trackedCount} (${info.activeTracked} active, ${info.doneTracked} done)\n`;
  text += `• <b>Gofile Uploads:</b> ${info.gofileCount}\n`;

  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

bot.onText(/\/setapikey(?:\s+(\d+)\s+(.+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  const apiKey = match?.[2]?.trim();
  if (!targetId || !apiKey) {
    bot.sendMessage(chatId, '❌ Usage: <code>/setapikey &lt;user_id&gt; &lt;api_key&gt;</code>', { parse_mode: 'HTML' });
    return;
  }

  const loading = await bot.sendMessage(chatId, `🔑 Validating and setting API key for user <code>${targetId}</code>…`, { parse_mode: 'HTML' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.getMe();
    const plan = result?.data?.plan ?? null;

    // Overwrite previous API key in MongoDB / cache and save new key
    setUserApiKey(targetId, apiKey, plan);
    if (plan != null) setCachedPlan(targetId, plan);
    addAllowedUser(targetId, userId);

    const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };
    const planLabel = PLAN_NAMES[plan] || (plan != null ? `Plan ${plan}` : 'Default');

    await bot.editMessageText(
      `✅ <b>API Key Updated for User <code>${targetId}</code></b>\n\n` +
      `🗑 <i>Previous API key removed from MongoDB.</i>\n` +
      `🔑 <i>New API key set & saved to MongoDB.</i>\n` +
      `🏷 Plan: <b>${escapeHtml(planLabel)}</b>\n` +
      `👥 User whitelist status: <b>Allowed</b>`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
    );
  } catch (err) {
    // Overwrite previous key even if API check fails
    setUserApiKey(targetId, apiKey);
    addAllowedUser(targetId, userId);
    await bot.editMessageText(
      `✅ API key set for user <code>${targetId}</code> in MongoDB (Previous key replaced).`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
    );
  }
});

bot.onText(/\/delkey(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  const targetId = match?.[1];
  if (!targetId) {
    bot.sendMessage(chatId, '❌ Usage: <code>/delkey &lt;telegram_id&gt;</code>', { parse_mode: 'HTML' });
    return;
  }
  removeUserApiKey(targetId);
  bot.sendMessage(chatId, `🗑 API key completely removed for user <code>${targetId}</code> in MongoDB.`, { parse_mode: 'HTML' });
});

bot.onText(/\/(?:allow|adduser)(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }

  const raw = match?.[1]?.trim() || '';
  const tokens = raw ? raw.split(/\s+/) : [];

  let targetId = null;
  let allowMain = false;

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      targetId = token;
    } else if (token.toLowerCase() === 'main') {
      allowMain = true;
    }
  }

  if (!targetId && msg.reply_to_message?.from?.id) {
    targetId = String(msg.reply_to_message.from.id);
  }

  if (!targetId) {
    bot.sendMessage(chatId,
      '❌ <b>Usage:</b>\n' +
      '• <code>/allow &lt;telegram_id&gt;</code> — User uses their own API key via <code>/setkey</code>\n' +
      '• <code>/allow &lt;telegram_id&gt; main</code> — User gets shared access to main TorBox API (hidden from them)\n\n' +
      '<i>Or reply to any user message with <code>/allow</code> or <code>/allow main</code></i>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  addAllowedUser(targetId, userId, allowMain);
  upsertUser(targetId, {
    username: msg.reply_to_message?.from?.username,
    firstName: msg.reply_to_message?.from?.first_name,
    isAllowed: true,
    allowMain,
  });

  if (allowMain) {
    bot.sendMessage(chatId,
      `✅ <b>User <code>${targetId}</code> granted access with MAIN API KEY!</b>\n\n` +
      `🔑 <b>Access Mode:</b> Main / Owner Account (Shared)\n` +
      `🛡️ <b>Security:</b> API key is protected and will <b>never</b> be shown to this user.\n` +
      `🚀 <b>Ready:</b> They can use the bot immediately without entering an API key.`,
      { parse_mode: 'HTML' }
    );

    const targetChat = getPrivateChatId(targetId) || targetId;
    bot.sendMessage(targetChat,
      `🎉 <b>Access Granted!</b>\n\n` +
      `You have been granted access to this TorBox Bot with shared access to the main account.\n\n` +
      `🚀 <b>The bot is active and ready to use!</b>\n` +
      `Try sending a magnet link or use /help to view all features.\n\n` +
      `🔐 <i>All your downloads and notifications remain private to your Telegram account.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } else {
    bot.sendMessage(chatId,
      `✅ <b>User <code>${targetId}</code> granted access (Personal Key Required).</b>\n\n` +
      `They must connect their own TorBox API key using <code>/setkey YOUR_API_KEY</code> before downloading.`,
      { parse_mode: 'HTML' }
    );

    const targetChat = getPrivateChatId(targetId) || targetId;
    bot.sendMessage(targetChat,
      `🎉 <b>Access Granted!</b>\n\n` +
      `You have been authorized by the bot owner.\n\n` +
      `To connect your TorBox account, please run:\n` +
      `<code>/setkey YOUR_API_KEY</code>\n\n` +
      `Get your key at: https://torbox.app/settings`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

bot.onText(/\/(?:remove|removeuser|revoke)(?:\s+(\d+))?/, async (msg, match) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }

  let targetId = match?.[1];
  if (!targetId && msg.reply_to_message?.from?.id) {
    targetId = String(msg.reply_to_message.from.id);
  }

  if (!targetId) {
    bot.sendMessage(chatId, '❌ Usage: <code>/remove &lt;telegram_id&gt;</code> (or reply with <code>/remove</code>)', { parse_mode: 'HTML' });
    return;
  }

  removeAllowedUser(targetId);
  upsertUser(targetId, { isAllowed: false, allowMain: false });
  bot.sendMessage(chatId, `🚫 <b>User <code>${targetId}</code> access revoked.</b>`, { parse_mode: 'HTML' });

  const targetChat = getPrivateChatId(targetId) || targetId;
  bot.sendMessage(targetChat, `⚠️ <b>Your access to this bot has been revoked by the administrator.</b>`, { parse_mode: 'HTML' }).catch(() => {});
});

bot.onText(/\/(?:listusers|allowed|users)/, (msg) => {
  const userId = msg.from?.id;
  const chatId = msg.chat.id;
  if (!isAdmin(userId)) { bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  if (isOpenAccess()) { bot.sendMessage(chatId, '🌍 <b>Open access mode</b> — no users in whitelist yet.', { parse_mode: 'HTML' }); return; }
  const users = listAllowedUsers();
  if (!users.length) {
    bot.sendMessage(chatId, '📭 Whitelist is empty.', { parse_mode: 'HTML' });
    return;
  }

  const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };
  let text = `👥 <b>Allowed Users</b> (${users.length})\n\n`;
  for (const u of users) {
    const hasOwnKey = hasPersonalApiKey(u.user_id);
    const hasMain = isUserAllowedMain(u.user_id);
    const plan = getCachedPlan(u.user_id);
    const planStr = plan !== null ? (PLAN_NAMES[plan] || `Plan ${plan}`) : 'Default';
    const keyTag = hasOwnKey ? '🔑 Personal Key' : (hasMain ? '🌟 Main Account Access (Key Hidden)' : '⏳ Key Required');
    const nameStr = u.username ? `@${escapeHtml(u.username)}` : escapeHtml(u.first_name || 'User');
    text += `• <code>${u.user_id}</code> (${nameStr})\n  └ ${keyTag} | Plan: ${planStr}\n`;
  }
  text += `\n💡 <i>Use <code>/allow &lt;id&gt; main</code> or <code>/allow &lt;id&gt;</code> to change access mode.</i>`;
  text += `\n💡 <i>Use <code>/remove &lt;id&gt;</code> to revoke access.</i>`;
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
  if (!hasApiKey(userId)) { sendNoApiKeyMessage(chatId, userId); return; }

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
    if (!hasApiKey(userId)) { sendNoApiKeyMessage(chatId, userId); return; }
    await handleAddMagnet(bot, chatId, text, userId);
    return;
  }

  // 40-char infohash → auto cache check
  if (isInfohash(text)) {
    if (!hasApiKey(userId)) { sendNoApiKeyMessage(chatId, userId); return; }
    await handleCheckCached(bot, chatId, text, userId);
    return;
  }

  // HTTP/HTTPS URL → ask type
  if ((text.startsWith('http://') || text.startsWith('https://')) && !text.includes('torbox.app')) {
    if (!hasApiKey(userId)) { sendNoApiKeyMessage(chatId, userId); return; }
    const plan = getCachedPlan(userId);
    const showUsenet = plan === null || plan >= 1;
    const showWebDl  = plan === null || plan >= 1;

    // Store pending URL in session to avoid Telegram 64-byte callback_data limit
    sessions.update(userId, { pendingUrl: text });

    const btns = [];
    if (showWebDl)  btns.push({ text: '🌐 Web Download / Debrid', callback_data: 'add_webdl_confirm' });
    if (showUsenet) btns.push({ text: '📰 Usenet NZB',           callback_data: 'add_nzb_confirm' });
    btns.push({ text: '❌ Cancel', callback_data: 'cancel' });

    await bot.sendMessage(chatId,
      `🔗 <b>URL Detected</b>\n<code>${escapeHtml(truncate(text, 80))}</code>\n\nWhat type of download is this?`,
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

  // Auto-detect direct paste of TorBox API key (UUID format)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_REGEX.test(text)) {
    await handleSetKey(bot, msg, text);
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

  if (data === 'mydownloads') {
    await handleMyDownloads(bot, fakeMsg);
    return;
  }

  if (data.startsWith('getlink:')) {
    const parts = data.split(':');
    const isExplicitZip = parts[3] === 'zip';
    await handleGetLink(bot, chatId, userId, parts[1], parts[2], isExplicitZip);
    return;
  }

  if (data.startsWith('gofile:')) {
    const parts = data.split(':');
    await handleGofileUpload(bot, chatId, userId, parts[1], parts[2]);
    return;
  }
  if (data === 'mygofile') {
    await handleMyGofile(bot, fakeMsg);
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
  if (data === 'add_webdl_confirm' || data.startsWith('add_webdl_confirm:')) {
    const session = sessions.get(userId);
    const url = session?.pendingUrl || (data.includes(':') ? decodeURIComponent(data.replace('add_webdl_confirm:', '')) : null);
    if (!url) {
      await bot.sendMessage(chatId, '❌ No URL found. Please send the link again.');
      return;
    }
    await handleAddWebDl(bot, chatId, url, userId);
    return;
  }
  if (data === 'add_nzb_confirm' || data.startsWith('add_nzb_confirm:')) {
    const session = sessions.get(userId);
    const url = session?.pendingUrl || (data.includes(':') ? decodeURIComponent(data.replace('add_nzb_confirm:', '')) : null);
    if (!url) {
      await bot.sendMessage(chatId, '❌ No NZB URL found. Please send the link again.');
      return;
    }
    await handleAddNzbLink(bot, chatId, url, userId);
    return;
  }
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
  { command: 'setkey',        description: '🔑 Set personal TorBox API key' },
  { command: 'mykey',         description: '🔑 View current API key & plan' },
  { command: 'gofile',        description: '📤 Upload item to Gofile.io' },
  { command: 'mygofile',      description: '📤 View my Gofile upload history' },
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
  { command: 'help',          description: '📖 Full command list' },
]).then(() => console.log('✅ Bot commands registered.')).catch(console.error);

startMonitor(bot);

// ── Native Health Check Server for Render ─────────────────────
import http from 'http';
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 TorBox Telegram Bot is active and running 24/7\n');
}).listen(PORT, () => {
  console.log(`🌐 Health server listening on port ${PORT}`);
});

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
