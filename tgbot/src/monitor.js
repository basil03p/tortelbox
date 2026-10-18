// ============================================================
// Background Download Monitor
// Polls TorBox every MONITOR_INTERVAL_MS (default 60s).
// When a tracked item completes → auto-DMs the user
// with an inline button to get a fresh download link.
// ============================================================
import { createApiClient } from './api.js';
import {
  getActiveTracked, getPendingNotifications,
  updateDownloadStatus, markNotified, getPrivateChatId, getUserApiKey,
  clearOldPendingNotifications, updateTrackedItemId, updateTrackedName,
} from './db.js';
import { escapeHtml, getDownloadStateInfo, resolveCleanDownloadName, isHashString } from './utils.js';

const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '10000', 10);

let bot = null;
let monitorTimer = null;

export async function startMonitor(botInstance) {
  bot = botInstance;
  console.log(`🔄 Download monitor started (interval: ${INTERVAL_MS / 1000}s)`);
  await clearOldPendingNotifications().catch(console.error);
  runCycle(); // run immediately on start
  monitorTimer = setInterval(runCycle, INTERVAL_MS);
}

export function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
}

async function runCycle() {
  try {
    await checkActiveDownloads();
    await sendPendingNotifications();
  } catch (err) {
    console.error('❌ Monitor cycle error:', err.message);
  }
}

// ── Step 1: Poll TorBox for all active tracked downloads ───────
async function checkActiveDownloads() {
  const active = await getActiveTracked();
  if (!active || !active.length) return;

  // Group by user_id + api_key to minimise API calls
  const byUser = new Map();
  for (const row of active) {
    const key = row.api_key || getUserApiKey(row.user_id);
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, { api_key: key, items: [] });
    byUser.get(row.user_id).items.push(row);
  }

  for (const [userId, { api_key, items }] of byUser.entries()) {
    if (!api_key) continue;
    try {
      const api = createApiClient(api_key);

      // Batch: group items by type
      const torrents = items.filter(i => i.type === 'torrent');
      const usnets   = items.filter(i => i.type === 'usenet');
      const webdls   = items.filter(i => i.type === 'webdl');

      if (torrents.length) {
        const res = await api.getTorrentList(true).catch(() => null);
        const list = res?.data || [];
        for (const t of torrents) {
          const found = list.find(x =>
            String(x.id) === String(t.item_id) ||
            (x.hash && String(x.hash).toLowerCase() === String(t.item_id).toLowerCase()) ||
            (x.name && t.name && x.name === t.name)
          );
          if (!found) continue;

          if (found.id && String(found.id) !== String(t.item_id)) {
            await updateTrackedItemId(userId, t.item_id, found.id, 'torrent');
            t.item_id = found.id;
          }

          const state = getDownloadStateInfo(found);
          const cleanName = resolveCleanDownloadName(found, t.name, null);
          if (cleanName && cleanName !== t.name) {
            t.name = cleanName;
            await updateTrackedName(userId, t.item_id, 'torrent', cleanName).catch(() => {});
          }

          if (state.isReady) {
            await updateDownloadStatus(userId, t.item_id, 'torrent', state.status || 'completed', true, cleanName || t.name);
          } else if (state.isFailed) {
            await updateDownloadStatus(userId, t.item_id, 'torrent', 'failed: ' + (state.status || 'error'), true, cleanName || t.name);
          } else {
            await updateDownloadStatus(userId, t.item_id, 'torrent', state.status, false, cleanName || t.name);
          }
        }
      }

      if (usnets.length) {
        const res = await api.getUsenetList(true).catch(() => null);
        const list = res?.data || [];
        for (const u of usnets) {
          const found = list.find(x =>
            String(x.id) === String(u.item_id) ||
            (x.hash && String(x.hash).toLowerCase() === String(u.item_id).toLowerCase()) ||
            (x.name && u.name && x.name === u.name)
          );
          if (!found) continue;

          if (found.id && String(found.id) !== String(u.item_id)) {
            await updateTrackedItemId(userId, u.item_id, found.id, 'usenet');
            u.item_id = found.id;
          }

          const state = getDownloadStateInfo(found);
          const cleanName = resolveCleanDownloadName(found, u.name, null);
          if (cleanName && cleanName !== u.name) {
            u.name = cleanName;
            await updateTrackedName(userId, u.item_id, 'usenet', cleanName).catch(() => {});
          }

          if (state.isReady) {
            await updateDownloadStatus(userId, u.item_id, 'usenet', state.status || 'completed', true, cleanName || u.name);
          } else if (state.isFailed) {
            await updateDownloadStatus(userId, u.item_id, 'usenet', 'failed: ' + (state.status || 'error'), true, cleanName || u.name);
          } else {
            await updateDownloadStatus(userId, u.item_id, 'usenet', state.status, false, cleanName || u.name);
          }
        }
      }

      if (webdls.length) {
        const res = await api.getWebDlList(true).catch(() => null);
        const list = res?.data || [];
        for (const w of webdls) {
          const found = list.find(x =>
            String(x.id) === String(w.item_id) ||
            (x.name && w.name && x.name === w.name)
          );
          if (!found) continue;

          const state = getDownloadStateInfo(found);
          const cleanName = resolveCleanDownloadName(found, w.name, null);
          if (cleanName && cleanName !== w.name) {
            w.name = cleanName;
            await updateTrackedName(userId, w.item_id, 'webdl', cleanName).catch(() => {});
          }

          if (state.isReady) {
            await updateDownloadStatus(userId, w.item_id, 'webdl', state.status || 'completed', true, cleanName || w.name);
          } else if (state.isFailed) {
            await updateDownloadStatus(userId, w.item_id, 'webdl', 'failed: ' + (state.status || 'error'), true, cleanName || w.name);
          } else {
            await updateDownloadStatus(userId, w.item_id, 'webdl', state.status, false, cleanName || w.name);
          }
        }
      }
    } catch (err) {
      // non-fatal, skip this user this cycle
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Step 2: Notify users whose downloads just finished ────────
async function sendPendingNotifications() {
  const pending = await getPendingNotifications();
  if (!pending || !pending.length) return;

  // Group pending notifications by targetChat
  const byUser = new Map();
  for (const row of pending) {
    const targetChat = row.chat_id || (await getPrivateChatId(row.user_id)) || row.user_id;
    const cidStr = targetChat ? String(targetChat).trim() : '';
    if (!cidStr || cidStr === 'null' || cidStr === 'undefined') {
      await markNotified(row);
      continue;
    }
    if (!byUser.has(cidStr)) byUser.set(cidStr, []);
    byUser.get(cidStr).push(row);
  }

  for (const [targetChat, items] of byUser.entries()) {
    if (items.length === 1) {
      const row = items[0];
      const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[row.type] || '📦';
      let name = resolveCleanDownloadName(row, row.name || `${row.type} #${row.item_id}`);
      if (isHashString(name)) {
        try {
          const key = row.api_key || getUserApiKey(row.user_id);
          if (key && row.type === 'torrent') {
            const api = createApiClient(key);
            const tInfo = await api.getTorrentById(Number(row.item_id)).catch(() => null);
            const tItem = Array.isArray(tInfo?.data) ? tInfo.data.find(x => String(x.id) === String(row.item_id)) : tInfo?.data;
            const resolved = resolveCleanDownloadName(tItem, null, null);
            if (resolved && !isHashString(resolved)) {
              name = resolved;
              await updateTrackedName(row.user_id, row.item_id, 'torrent', resolved).catch(() => {});
            }
          }
        } catch (_) {}
      }

      const isFailed = String(row.last_status || '').toLowerCase().includes('fail') ||
                       String(row.last_status || '').toLowerCase().includes('error');

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (isFailed) {
            await bot.sendMessage(
              targetChat,
              `❌ <b>Download Failed</b>\n\n${typeEmoji} <b>${escapeHtml(name)}</b>\n\nTorBox status: <code>${escapeHtml(row.last_status || 'Failed')}</code>\n\n<i>TorBox was unable to complete this download.</i>`,
              { parse_mode: 'HTML' }
            );
          } else {
            await bot.sendMessage(
              targetChat,
              `✅ <b>Download Ready!</b>\n\n${typeEmoji} <b>${escapeHtml(name)}</b>\n\nYour content is ready on TorBox.\n⚠️ <i>Tap below to get direct download links.</i>`,
              {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔗 Get Download Link', callback_data: `getlink:${row.type}:${row.item_id}` }],
                    [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:${row.type}:${row.item_id}` }],
                  ],
                },
              }
            );
          }
          await markNotified(row);
          console.log(`📩 Notified user ${row.user_id} — ${row.type} #${row.item_id}`);
          break;
        } catch (err) {
          const retrySecs = err.response?.body?.parameters?.retry_after || 5;
          if (err.message?.includes('429')) {
            console.warn(`⚠️ Telegram rate limit (429). Retrying after ${retrySecs}s…`);
            await sleep((retrySecs + 1) * 1000);
          } else {
            console.error(`❌ Failed to notify ${row.user_id}:`, err.message);
            await markNotified(row);
            break;
          }
        }
      }
      await sleep(1000);
    } else if (items.length > 1) {
      let text = `✅ <b>${items.length} Downloads Updated!</b>\n\n`;
      for (let idx = 0; idx < items.length; idx++) {
        const row = items[idx];
        const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[row.type] || '📦';
        let name = resolveCleanDownloadName(row, row.name || `${row.type} #${row.item_id}`);
        if (isHashString(name)) {
          try {
            const key = row.api_key || getUserApiKey(row.user_id);
            if (key && row.type === 'torrent') {
              const api = createApiClient(key);
              const tInfo = await api.getTorrentById(Number(row.item_id)).catch(() => null);
              const tItem = Array.isArray(tInfo?.data) ? tInfo.data.find(x => String(x.id) === String(row.item_id)) : tInfo?.data;
              const resolved = resolveCleanDownloadName(tItem, null, null);
              if (resolved && !isHashString(resolved)) {
                name = resolved;
                await updateTrackedName(row.user_id, row.item_id, 'torrent', resolved).catch(() => {});
              }
            }
          } catch (_) {}
        }
        const isFailed = String(row.last_status || '').toLowerCase().includes('fail') ||
                         String(row.last_status || '').toLowerCase().includes('error');
        text += `${idx + 1}. ${typeEmoji} ${isFailed ? '❌' : '✅'} <b>${escapeHtml(name)}</b>\n`;
      }
      text += `\n<i>Your content is updated on TorBox. Tap below to view your downloads.</i>`;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.sendMessage(targetChat, text, {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '📥 View My Downloads', callback_data: 'mydownloads' },
              ]],
            },
          });
          for (const row of items) await markNotified(row);
          console.log(`📩 Notified user ${targetChat} — ${items.length} items ready`);
          break;
        } catch (err) {
          const retrySecs = err.response?.body?.parameters?.retry_after || 5;
          if (err.message?.includes('429')) {
            console.warn(`⚠️ Telegram rate limit (429). Retrying after ${retrySecs}s…`);
            await sleep((retrySecs + 1) * 1000);
          } else {
            console.error(`❌ Failed to notify ${targetChat}:`, err.message);
            for (const row of items) await markNotified(row);
            break;
          }
        }
      }
      await sleep(1000);
    }
  }
}
