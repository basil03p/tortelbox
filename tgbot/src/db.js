// ============================================================
// Database Manager — SQLite persistence via better-sqlite3
// ============================================================
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'bot.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id      TEXT PRIMARY KEY,
    username     TEXT,
    first_name   TEXT,
    is_allowed   INTEGER NOT NULL DEFAULT 0,
    added_by     TEXT,
    added_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    user_id      TEXT PRIMARY KEY,
    api_key      TEXT NOT NULL,
    plan         INTEGER,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS private_chats (
    user_id      TEXT PRIMARY KEY,
    chat_id      TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tracked_downloads (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    type         TEXT NOT NULL DEFAULT 'torrent',
    name         TEXT,
    last_status  TEXT,
    is_done      INTEGER NOT NULL DEFAULT 0,
    notified_done INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    done_at      TEXT,
    UNIQUE(user_id, item_id, type)
  );

  CREATE INDEX IF NOT EXISTS idx_tracked_pending
    ON tracked_downloads(is_done, notified_done);
`);

console.log(`💾 Database opened: ${DB_PATH}`);

// ──────────────────────────────────────────────────────────────
// USER HELPERS
// ──────────────────────────────────────────────────────────────

export function upsertUser(userId, { username, firstName } = {}) {
  db.prepare(`
    INSERT INTO users (user_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username   = COALESCE(excluded.username, username),
      first_name = COALESCE(excluded.first_name, first_name)
  `).run(String(userId), username || null, firstName || null);
}

export function isUserAllowed(userId) {
  const uid = String(userId);
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
  if (adminId && uid === adminId) return true;

  const envAllowed = process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USERS || process.env.BOT_OWNER_ID || process.env.OWNER_ID;
  if (envAllowed) {
    const list = envAllowed.split(',').map(x => x.trim()).filter(Boolean);
    if (list.includes(uid)) return true;
  }

  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed = 1').get();
  if (count.c > 0) {
    const row = db.prepare('SELECT is_allowed FROM users WHERE user_id = ?').get(uid);
    return row?.is_allowed === 1;
  }

  // If admin ID or env allowed list exists, block all unlisted users
  if (adminId || envAllowed) return false;

  return true;
}

export function addAllowedUser(userId, addedBy = null) {
  db.prepare(`
    INSERT INTO users (user_id, is_allowed, added_by)
    VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET is_allowed = 1, added_by = excluded.added_by
  `).run(String(userId), addedBy ? String(addedBy) : null);
}

export function removeAllowedUser(userId) {
  db.prepare('UPDATE users SET is_allowed = 0 WHERE user_id = ?').run(String(userId));
}

export function listAllowedUsers() {
  return db.prepare(`
    SELECT u.user_id, u.username, u.first_name, u.added_at,
           k.plan
    FROM users u
    LEFT JOIN api_keys k ON k.user_id = u.user_id
    WHERE u.is_allowed = 1
    ORDER BY u.added_at
  `).all();
}

export function isOpenAccess() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed = 1').get();
  return count.c === 0;
}

// ──────────────────────────────────────────────────────────────
// API KEY HELPERS
// ──────────────────────────────────────────────────────────────

export function getUserApiKey(userId) {
  const row = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(String(userId));
  return row?.api_key || process.env.TORBOX_API_KEY || null;
}

export function setUserApiKey(userId, apiKey, plan = null) {
  db.prepare(`
    INSERT INTO api_keys (user_id, api_key, plan, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      api_key    = excluded.api_key,
      plan       = excluded.plan,
      updated_at = excluded.updated_at
  `).run(String(userId), apiKey, plan);
}

export function hasApiKey(userId) {
  return Boolean(getUserApiKey(userId));
}

export function setCachedPlan(userId, plan) {
  db.prepare(`
    INSERT INTO api_keys (user_id, api_key, plan, updated_at)
    VALUES (?, COALESCE((SELECT api_key FROM api_keys WHERE user_id = ?), ''), ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at
  `).run(String(userId), String(userId), plan);
}

export function getCachedPlan(userId) {
  const row = db.prepare('SELECT plan FROM api_keys WHERE user_id = ?').get(String(userId));
  return row?.plan ?? null;
}

// ──────────────────────────────────────────────────────────────
// PRIVATE CHAT HELPERS
// ──────────────────────────────────────────────────────────────

export function setPrivateChatId(userId, chatId) {
  db.prepare(`
    INSERT INTO private_chats (user_id, chat_id, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at
  `).run(String(userId), String(chatId));
}

export function getPrivateChatId(userId) {
  const row = db.prepare('SELECT chat_id FROM private_chats WHERE user_id = ?').get(String(userId));
  return row?.chat_id || null;
}

// ──────────────────────────────────────────────────────────────
// TRACKED DOWNLOADS
// ──────────────────────────────────────────────────────────────

export function trackDownload(userId, itemId, type, name, isAlreadyDone = false) {
  try {
    const doneVal = isAlreadyDone ? 1 : 0;
    db.prepare(`
      INSERT INTO tracked_downloads (user_id, item_id, type, name, is_done, notified_done)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id, type) DO UPDATE SET
        name = excluded.name,
        notified_done = CASE WHEN excluded.notified_done = 1 THEN 1 ELSE tracked_downloads.notified_done END
    `).run(String(userId), String(itemId), type, name || null, doneVal, doneVal);
  } catch (_) { /* silently skip duplicates */ }
}

export function updateDownloadStatus(userId, itemId, type, status, isDone) {
  db.prepare(`
    UPDATE tracked_downloads
    SET last_status = ?, is_done = ?, done_at = CASE WHEN ? = 1 AND done_at IS NULL THEN datetime('now') ELSE done_at END
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).run(status, isDone ? 1 : 0, isDone ? 1 : 0, String(userId), String(itemId), type);
}

export function markNotified(id) {
  db.prepare('UPDATE tracked_downloads SET notified_done = 1 WHERE id = ?').run(id);
}

export function getPendingNotifications() {
  // Get all done downloads not yet notified
  return db.prepare(`
    SELECT d.*, k.api_key, p.chat_id
    FROM tracked_downloads d
    LEFT JOIN api_keys k ON k.user_id = d.user_id
    LEFT JOIN private_chats p ON p.user_id = d.user_id
    WHERE d.is_done = 1 AND d.notified_done = 0
  `).all();
}

export function getActiveTracked() {
  // Get all in-progress tracked downloads (not done)
  return db.prepare(`
    SELECT d.*, k.api_key
    FROM tracked_downloads d
    LEFT JOIN api_keys k ON k.user_id = d.user_id
    WHERE d.is_done = 0
    ORDER BY d.created_at
  `).all();
}

export function getUserDownloads(userId) {
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(String(userId));
}

export function getDownloadById(userId, itemId, type) {
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).get(String(userId), String(itemId), type);
}

export function getUserTrackedItemIds(userId, type) {
  const rows = db.prepare(`
    SELECT item_id FROM tracked_downloads
    WHERE user_id = ? AND type = ?
  `).all(String(userId), type);
  return new Set(rows.map((r) => String(r.item_id)));
}

export function isItemOwnedByUser(userId, itemId, type) {
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
  if (adminId && String(userId) === adminId) return true;

  const row = db.prepare(`
    SELECT id FROM tracked_downloads
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).get(String(userId), String(itemId), type);
  return !!row;
}

// ──────────────────────────────────────────────────────────────
// STATS (for admin panel)
// ──────────────────────────────────────────────────────────────

export function getStats() {
  return {
    total_users:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    allowed_users:  db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed=1').get().c,
    total_tracked:  db.prepare('SELECT COUNT(*) as c FROM tracked_downloads').get().c,
    active_tracked: db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE is_done=0').get().c,
    done_tracked:   db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE is_done=1').get().c,
  };
}

export function getAllTracked(limit = 100) {
  return db.prepare(`
    SELECT d.*, u.username, u.first_name
    FROM tracked_downloads d
    LEFT JOIN users u ON u.user_id = d.user_id
    ORDER BY d.created_at DESC
    LIMIT ?
  `).all(limit);
}

export { db };
