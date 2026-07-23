// ============================================================
// Background Download Monitor
// Polls TorBox every MONITOR_INTERVAL_MS (default 60s).
// When a tracked item completes → auto-DMs the user
// with an inline button to get a fresh download link.
// ============================================================
import { createApiClient } from './api.js';
import {
  getActiveTracked, getPendingNotifications,
  updateDownloadStatus, markNotified, getPrivateChatId,
} from './db.js';

const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '60000', 10);

// Status strings from TorBox that mean "download is ready"
const DONE_STATES = new Set([
  'completed', 'seeding', 'stalled (no seeds)', 'paused',
  'cached', 'ready', 'finished', 'done',
]);
// Partially-done patterns (case-insensitive check)
function isDoneStatus(status) {
  if (!status) return false;
  const s = status.toLowerCase();
  return DONE_STATES.has(s) ||
    s.includes('complet') ||
    s.includes('seed') ||
    s.includes('cached') ||
    s.includes('finish');
}

let bot = null;
let monitorTimer = null;

export function startMonitor(botInstance) {
  bot = botInstance;
  console.log(`🔄 Download monitor started (interval: ${INTERVAL_MS / 1000}s)`);
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
  const active = getActiveTracked();
  if (!active.length) return;

  // Group by user_id + api_key to minimise API calls
  const byUser = new Map();
  for (const row of active) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, { api_key: row.api_key, items: [] });
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
          const done   = isDoneStatus(status);
          updateDownloadStatus(userId, t.item_id, 'torrent', status, done);
        }
      }

      if (usnets.length) {
        const res = await api.getUsenetList(true).catch(() => null);
        const list = res?.data || [];
        for (const u of usnets) {
          const found = list.find(x => String(x.id) === String(u.item_id));
          if (!found) continue;
          const status = found.download_state || found.status || '';
          updateDownloadStatus(userId, u.item_id, 'usenet', status, isDoneStatus(status));
        }
      }

      if (webdls.length) {
        const res = await api.getWebDlList(true).catch(() => null);
        const list = res?.data || [];
        for (const w of webdls) {
          const found = list.find(x => String(x.id) === String(w.item_id));
          if (!found) continue;
          const status = found.download_state || found.status || '';
          updateDownloadStatus(userId, w.item_id, 'webdl', status, isDoneStatus(status));
        }
      }
    } catch (err) {
      // non-fatal, skip this user this cycle
    }
  }
}

// ── Step 2: Notify users whose downloads just finished ────────
async function sendPendingNotifications() {
  const pending = getPendingNotifications();
  for (const row of pending) {
    const targetChat = row.chat_id || row.user_id;
    if (!targetChat) { markNotified(row.id); continue; }

    const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[row.type] || '📦';
    const name = row.name || `${row.type} #${row.item_id}`;

    try {
      await bot.sendMessage(
        targetChat,
        `✅ *Download Ready\\!*\n\n${typeEmoji} *${escMd(name)}*\n\nYour content is ready on TorBox\\.` +
        `\n⚠️ _Download links expire after ~1 hour\\. Tap below to get a fresh link anytime\\._`,
        {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[
              { text: '🔗 Get Download Link', callback_data: `getlink:${row.type}:${row.item_id}` },
            ]],
          },
        }
      );
      markNotified(row.id);
      console.log(`📩 Notified user ${row.user_id} — ${row.type} #${row.item_id}`);
    } catch (err) {
      console.error(`❌ Failed to notify ${row.user_id}:`, err.message);
    }
  }
}

function escMd(s) {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
