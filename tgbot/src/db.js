// ============================================================
// Database Manager — Supports MongoDB & SQLite persistence
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

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGODB_URL;
let mongoDb = null;
let db = null;

if (MONGO_URI) {
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    mongoDb = client.db(process.env.MONGODB_DB_NAME || 'torbox_bot');
    console.log('🍃 Connected to MongoDB database successfully!');

    // Create indexes for fast lookup
    await mongoDb.collection('users').createIndex({ user_id: 1 }, { unique: true });
    await mongoDb.collection('api_keys').createIndex({ user_id: 1 }, { unique: true });
    await mongoDb.collection('private_chats').createIndex({ user_id: 1 }, { unique: true });
    await mongoDb.collection('tracked_downloads').createIndex({ user_id: 1, item_id: 1, type: 1 }, { unique: true });
  } catch (err) {
    console.error('⚠️ MongoDB connection failed, falling back to SQLite:', err.message);
  }
}

if (!mongoDb) {
  const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'bot.db');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
}

// ──────────────────────────────────────────────────────────────
// USER HELPERS
// ──────────────────────────────────────────────────────────────

export function upsertUser(userId, { username, firstName } = {}) {
  const uid = String(userId);
  if (mongoDb) {
    mongoDb.collection('users').updateOne(
      { user_id: uid },
      { $set: { username: username || null, first_name: firstName || null } },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  db.prepare(`
    INSERT INTO users (user_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username   = COALESCE(excluded.username, username),
      first_name = COALESCE(excluded.first_name, first_name)
  `).run(uid, username || null, firstName || null);
}

export function isUserAllowed(userId) {
  const uid = String(userId);
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
  if (adminId && uid === adminId) return true;

  const envAllowed = process.env.ALLOWED_USER_IDS || process.env.ALLOWED_USERS || process.env.BOT_OWNER_ID || process.env.OWNER_ID;
  if (envAllowed) {
    const list = envAllowed.split(',').map((x) => x.trim()).filter(Boolean);
    if (list.includes(uid)) return true;
  }

  if (mongoDb) {
    // Sync check placeholder — if admin or env list configured, enforce strict deny
    if (adminId || envAllowed) return false;
    return true;
  }

  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed = 1').get();
  if (count.c > 0) {
    const row = db.prepare('SELECT is_allowed FROM users WHERE user_id = ?').get(uid);
    return row?.is_allowed === 1;
  }

  if (adminId || envAllowed) return false;
  return true;
}

export function addAllowedUser(userId, addedBy = null) {
  const uid = String(userId);
  if (mongoDb) {
    mongoDb.collection('users').updateOne(
      { user_id: uid },
      { $set: { is_allowed: 1, added_by: addedBy ? String(addedBy) : null, added_at: new Date().toISOString() } },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  db.prepare(`
    INSERT INTO users (user_id, is_allowed, added_by)
    VALUES (?, 1, ?)
    ON CONFLICT(user_id) DO UPDATE SET is_allowed = 1, added_by = excluded.added_by
  `).run(uid, addedBy ? String(addedBy) : null);
}

export function removeAllowedUser(userId) {
  const uid = String(userId);
  if (mongoDb) {
    mongoDb.collection('users').updateOne({ user_id: uid }, { $set: { is_allowed: 0 } }).catch(console.error);
    return;
  }
  db.prepare('UPDATE users SET is_allowed = 0 WHERE user_id = ?').run(uid);
}

export function listAllowedUsers() {
  if (mongoDb) {
    return [];
  }
  return db.prepare(`
    SELECT u.user_id, u.username, u.first_name, u.added_at, k.plan
    FROM users u
    LEFT JOIN api_keys k ON k.user_id = u.user_id
    WHERE u.is_allowed = 1
    ORDER BY u.added_at
  `).all();
}

export function isOpenAccess() {
  if (mongoDb) return false;
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed = 1').get();
  return count.c === 0;
}

// ──────────────────────────────────────────────────────────────
// API KEY HELPERS
// ──────────────────────────────────────────────────────────────

export function getUserApiKey(userId) {
  const uid = String(userId);
  if (mongoDb) {
    return process.env.TORBOX_API_KEY || null;
  }
  const row = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(uid);
  return row?.api_key || process.env.TORBOX_API_KEY || null;
}

export function setUserApiKey(userId, apiKey, plan = null) {
  const uid = String(userId);
  if (mongoDb) {
    mongoDb.collection('api_keys').updateOne(
      { user_id: uid },
      { $set: { api_key: apiKey, plan, updated_at: new Date().toISOString() } },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  db.prepare(`
    INSERT INTO api_keys (user_id, api_key, plan)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET api_key = excluded.api_key, plan = excluded.plan, updated_at = datetime('now')
  `).run(uid, apiKey, plan);
}

export function hasApiKey(userId) {
  return !!getUserApiKey(userId);
}

export function setCachedPlan(userId, plan) {
  const uid = String(userId);
  if (mongoDb) {
    mongoDb.collection('api_keys').updateOne(
      { user_id: uid },
      { $set: { plan, updated_at: new Date().toISOString() } },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  db.prepare(`
    INSERT INTO api_keys (user_id, api_key, plan)
    VALUES (?, '', ?)
    ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan
  `).run(uid, plan);
}

export function getCachedPlan(userId) {
  const uid = String(userId);
  if (mongoDb) return null;
  const row = db.prepare('SELECT plan FROM api_keys WHERE user_id = ?').get(uid);
  return row?.plan ?? null;
}

export function setPrivateChatId(userId, chatId) {
  const uid = String(userId);
  const cid = String(chatId);
  if (mongoDb) {
    mongoDb.collection('private_chats').updateOne(
      { user_id: uid },
      { $set: { chat_id: cid, updated_at: new Date().toISOString() } },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  db.prepare(`
    INSERT INTO private_chats (user_id, chat_id)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, updated_at = datetime('now')
  `).run(uid, cid);
}

export function getPrivateChatId(userId) {
  const uid = String(userId);
  if (mongoDb) return uid;
  const row = db.prepare('SELECT chat_id FROM private_chats WHERE user_id = ?').get(uid);
  return row?.chat_id || uid;
}

// ──────────────────────────────────────────────────────────────
// TRACKED DOWNLOADS (Strict Per-User Explicit Tracking Only)
// ──────────────────────────────────────────────────────────────

export function trackDownload(userId, itemId, type, name) {
  const uid = String(userId);
  const itemStr = String(itemId);
  if (mongoDb) {
    mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: itemStr, type },
      {
        $set: {
          name: name || null,
          created_at: new Date().toISOString(),
        },
        $setOnInsert: {
          is_done: 0,
          notified_done: 0,
        },
      },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  try {
    db.prepare(`
      INSERT INTO tracked_downloads (user_id, item_id, type, name, is_done, notified_done)
      VALUES (?, ?, ?, ?, 0, 0)
      ON CONFLICT(user_id, item_id, type) DO UPDATE SET name = excluded.name
    `).run(uid, itemStr, type, name || null);
  } catch (_) { /* skip duplicates */ }
}

export function updateDownloadStatus(userId, itemId, type, status, isDone) {
  const uid = String(userId);
  const itemStr = String(itemId);
  const doneVal = isDone ? 1 : 0;

  if (mongoDb) {
    const updateObj = { last_status: status, is_done: doneVal };
    if (isDone) updateObj.done_at = new Date().toISOString();
    mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: itemStr, type },
      { $set: updateObj }
    ).catch(console.error);
    return;
  }

  db.prepare(`
    UPDATE tracked_downloads
    SET last_status = ?, is_done = ?, done_at = CASE WHEN ? = 1 AND done_at IS NULL THEN datetime('now') ELSE done_at END
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).run(status, doneVal, doneVal, uid, itemStr, type);
}

export function markNotified(id) {
  if (mongoDb) {
    mongoDb.collection('tracked_downloads').updateOne(
      { _id: id },
      { $set: { notified_done: 1 } }
    ).catch(console.error);
    return;
  }
  db.prepare('UPDATE tracked_downloads SET notified_done = 1 WHERE id = ?').run(id);
}

export function getPendingNotifications() {
  if (mongoDb) {
    return [];
  }
  return db.prepare(`
    SELECT d.*, k.api_key, p.chat_id
    FROM tracked_downloads d
    LEFT JOIN api_keys k ON k.user_id = d.user_id
    LEFT JOIN private_chats p ON p.user_id = d.user_id
    WHERE d.is_done = 1 AND d.notified_done = 0
  `).all();
}

export function getActiveTracked() {
  if (mongoDb) {
    return [];
  }
  return db.prepare(`
    SELECT d.*, k.api_key
    FROM tracked_downloads d
    LEFT JOIN api_keys k ON k.user_id = d.user_id
    WHERE d.is_done = 0
    ORDER BY d.created_at
  `).all();
}

export function getUserDownloads(userId) {
  const uid = String(userId);
  if (mongoDb) return [];
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(uid);
}

export function getDownloadById(userId, itemId, type) {
  const uid = String(userId);
  const itemStr = String(itemId);
  if (mongoDb) return null;
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).get(uid, itemStr, type);
}

export function getUserTrackedItemIds(userId, type) {
  const uid = String(userId);
  if (mongoDb) return new Set();
  const rows = db.prepare(`
    SELECT item_id FROM tracked_downloads
    WHERE user_id = ? AND type = ?
  `).all(uid, type);
  return new Set(rows.map((r) => String(r.item_id)));
}

export function isItemOwnedByUser(userId, itemId, type) {
  const uid = String(userId);
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
  if (adminId && uid === adminId) return true;

  if (mongoDb) return true;

  const row = db.prepare(`
    SELECT id FROM tracked_downloads
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).get(uid, String(itemId), type);
  return !!row;
}

export function getStats() {
  if (mongoDb) {
    return { total_users: 0, allowed_users: 0, total_tracked: 0, active_tracked: 0, done_tracked: 0 };
  }
  return {
    total_users:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    allowed_users:  db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed=1').get().c,
    total_tracked:  db.prepare('SELECT COUNT(*) as c FROM tracked_downloads').get().c,
    active_tracked: db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE is_done=0').get().c,
    done_tracked:   db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE is_done=1').get().c,
  };
}
