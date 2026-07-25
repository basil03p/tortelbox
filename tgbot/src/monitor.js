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
  clearOldPendingNotifications,
} from './db.js';
import { escapeHtml } from './utils.js';

const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '10000', 10);

// Status strings from TorBox that mean "download is ready"
const DONE_STATES = new Set([
  'completed', 'seeding', 'stalled (no seeds)', 'paused',
  'cached', 'ready', 'finished', 'done',
]);
// Partially-done patterns (case-insensitive check)
function isDoneStatus(itemOrStatus) {
  if (!itemOrStatus) return false;
  if (typeof itemOrStatus === 'object') {
    if (itemOrStatus.download_finished === true || itemOrStatus.progress >= 1 || itemOrStatus.cached === true) return true;
    itemOrStatus = itemOrStatus.download_state || itemOrStatus.status || '';
  }
  const s = String(itemOrStatus).toLowerCase();
  return DONE_STATES.has(s) ||
    s.includes('complet') ||
    s.includes('seed') ||
    s.includes('cached') ||
    s.includes('finish') ||
    s.includes('ready');
}

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
    const key = row.api_key || (await getUserApiKey(row.user_id));
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
          const found = list.find(x => String(x.id) === String(t.item_id));
          if (!found) continue;
          const status = found.download_state || found.status || '';
          const done   = isDoneStatus(found);
          const name   = found.name || found.filename || null;
          await updateDownloadStatus(userId, t.item_id, 'torrent', status, done, name);
        }
      }

      if (usnets.length) {
        const res = await api.getUsenetList(true).catch(() => null);
        const list = res?.data || [];
        for (const u of usnets) {
          const found = list.find(x => String(x.id) === String(u.item_id));
          if (!found) continue;
          const status = found.download_state || found.status || '';
          const name   = found.name || found.filename || null;
          await updateDownloadStatus(userId, u.item_id, 'usenet', status, isDoneStatus(found), name);
        }
      }

      if (webdls.length) {
        const res = await api.getWebDlList(true).catch(() => null);
        const list = res?.data || [];
        for (const w of webdls) {
          const found = list.find(x => String(x.id) === String(w.item_id));
          if (!found) continue;
          const status = found.download_state || found.status || '';
          const name   = found.name || found.filename || null;
          await updateDownloadStatus(userId, w.item_id, 'webdl', status, isDoneStatus(found), name);
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
      const name = row.name || `${row.type} #${row.item_id}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.sendMessage(
            targetChat,
            `✅ <b>Download Ready!</b>\n\n${typeEmoji} <b>${escapeHtml(name)}</b>\n\nYour content is ready on TorBox.\n⚠️ <i>Tap below to get direct download links.</i>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: '🔗 Get Download Link', callback_data: `getlink:${row.type}:${row.item_id}` },
                ]],
              },
            }
          );
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
      let text = `✅ <b>${items.length} Downloads Ready!</b>\n\n`;
      items.forEach((row, idx) => {
        const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[row.type] || '📦';
        const name = row.name || `${row.type} #${row.item_id}`;
        text += `${idx + 1}. ${typeEmoji} <b>${escapeHtml(name)}</b>\n`;
      });
      text += `\n<i>Your content is ready on TorBox. Tap below to view your downloads.</i>`;

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

function escMd(s) {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
