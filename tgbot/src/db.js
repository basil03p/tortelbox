// ============================================================
// Database Manager — MongoDB Major Persistence & Fast Cache
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

// ── In-Memory Fast Caches (synced 100% with MongoDB Atlas) ─────
const userCache = new Map();        // user_id -> { is_allowed, username, first_name }
const apiKeyCache = new Map();      // user_id -> { api_key, plan }
const privateChatCache = new Map();  // user_id -> chat_id

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

    // Initial cache sync from MongoDB
    const users = await mongoDb.collection('users').find({}).toArray();
    users.forEach((u) => userCache.set(String(u.user_id), u));

    const keys = await mongoDb.collection('api_keys').find({}).toArray();
    keys.forEach((k) => apiKeyCache.set(String(k.user_id), k));

    const chats = await mongoDb.collection('private_chats').find({}).toArray();
    chats.forEach((c) => privateChatCache.set(String(c.user_id), String(c.chat_id)));

    console.log(`🍃 MongoDB cache ready: ${users.length} users, ${keys.length} API keys, ${chats.length} chat sessions.`);
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
  const uData = { user_id: uid, username: username || null, first_name: firstName || null };
  userCache.set(uid, { ...(userCache.get(uid) || {}), ...uData });

  if (mongoDb) {
    mongoDb.collection('users').updateOne(
      { user_id: uid },
      { $set: uData },
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
    const cached = userCache.get(uid);
    if (cached?.is_allowed === 1 || cached?.is_allowed === true) return true;
    if (adminId || envAllowed) return false;
    let allowedCount = 0;
    for (const [, u] of userCache.entries()) {
      if (u?.is_allowed === 1 || u?.is_allowed === true) allowedCount++;
    }
    if (allowedCount > 0) return false;
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
  const uData = { user_id: uid, is_allowed: 1, added_by: addedBy ? String(addedBy) : null, added_at: new Date().toISOString() };
  userCache.set(uid, { ...(userCache.get(uid) || {}), ...uData });

  if (mongoDb) {
    mongoDb.collection('users').updateOne(
      { user_id: uid },
      { $set: uData },
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
  const existing = userCache.get(uid);
  if (existing) existing.is_allowed = 0;

  if (mongoDb) {
    mongoDb.collection('users').updateOne({ user_id: uid }, { $set: { is_allowed: 0 } }).catch(console.error);
    return;
  }
  db.prepare('UPDATE users SET is_allowed = 0 WHERE user_id = ?').run(uid);
}

export function listAllowedUsers() {
  if (mongoDb) {
    const list = [];
    for (const [, u] of userCache.entries()) {
      if (u.is_allowed === 1 || u.is_allowed === true) list.push(u);
    }
    return list;
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
  if (mongoDb) {
    for (const [, u] of userCache.entries()) {
      if (u.is_allowed === 1 || u.is_allowed === true) return false;
    }
    return true;
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed = 1').get();
  return count.c === 0;
}

// ──────────────────────────────────────────────────────────────
// API KEY HELPERS
// ──────────────────────────────────────────────────────────────

export function getUserApiKey(userId) {
  const uid = String(userId);
  if (mongoDb) {
    const cached = apiKeyCache.get(uid);
    return cached?.api_key || process.env.TORBOX_API_KEY || null;
  }
  const row = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(uid);
  return row?.api_key || process.env.TORBOX_API_KEY || null;
}

export function setUserApiKey(userId, apiKey, plan = null) {
  const uid = String(userId);
  const kData = { user_id: uid, api_key: apiKey, plan, updated_at: new Date().toISOString() };
  apiKeyCache.set(uid, kData);

  if (mongoDb) {
    mongoDb.collection('api_keys').updateOne(
      { user_id: uid },
      { $set: kData },
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
  const existing = apiKeyCache.get(uid) || { user_id: uid, api_key: '' };
  existing.plan = plan;
  apiKeyCache.set(uid, existing);

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
  if (mongoDb) {
    return apiKeyCache.get(uid)?.plan ?? null;
  }
  const row = db.prepare('SELECT plan FROM api_keys WHERE user_id = ?').get(uid);
  return row?.plan ?? null;
}

export function setPrivateChatId(userId, chatId) {
  const uid = String(userId);
  const cid = String(chatId);
  privateChatCache.set(uid, cid);

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
  if (mongoDb) {
    return privateChatCache.get(uid) || uid;
  }
  const row = db.prepare('SELECT chat_id FROM private_chats WHERE user_id = ?').get(uid);
  return row?.chat_id || uid;
}

// ──────────────────────────────────────────────────────────────
// TRACKED DOWNLOADS (Strict Per-User Explicit Tracking Only)
// ──────────────────────────────────────────────────────────────

export async function trackDownload(userId, itemId, type, name) {
  const uid = String(userId);
  const itemStr = String(itemId);
  if (mongoDb) {
    await mongoDb.collection('tracked_downloads').updateOne(
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

export async function updateDownloadStatus(userId, itemId, type, status, isDone, name = null) {
  const uid = String(userId);
  const itemStr = String(itemId);
  const doneVal = isDone ? 1 : 0;

  if (mongoDb) {
    const updateObj = { last_status: status };
    if (isDone) updateObj.is_done = 1;
    if (name) updateObj.name = name;

    await mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: itemStr, type },
      { $set: updateObj }
    ).catch(console.error);
    return;
  }

  db.prepare(`
    UPDATE tracked_downloads
    SET last_status = ?, is_done = MAX(is_done, ?), name = COALESCE(?, name)
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).run(status, doneVal, name || null, uid, itemStr, type);
}

export async function clearOldPendingNotifications() {
  if (mongoDb) {
    await mongoDb.collection('tracked_downloads').updateMany(
      { is_done: 1, notified_done: 0 },
      { $set: { notified_done: 1 } }
    ).catch(console.error);
    return;
  }
  db.prepare('UPDATE tracked_downloads SET notified_done = 1 WHERE is_done = 1 AND notified_done = 0').run();
}

export async function markNotified(item) {
  if (mongoDb) {
    if (!item) return;
    const docId = typeof item === 'object' ? item._id : item;
    const uidStr = item?.user_id != null ? String(item.user_id) : null;
    const uidNum = item?.user_id != null && !isNaN(Number(item.user_id)) ? Number(item.user_id) : null;
    const iidStr = item?.item_id != null ? String(item.item_id) : null;
    const iidNum = item?.item_id != null && !isNaN(Number(item.item_id)) ? Number(item.item_id) : null;

    const clauses = [];
    if (docId) clauses.push({ _id: docId });
    if (uidStr && iidStr) clauses.push({ user_id: uidStr, item_id: iidStr });
    if (uidNum && iidNum) clauses.push({ user_id: uidNum, item_id: iidNum });
    if (uidStr && iidNum) clauses.push({ user_id: uidStr, item_id: iidNum });
    if (uidNum && iidStr) clauses.push({ user_id: uidNum, item_id: iidStr });

    if (clauses.length > 0) {
      await mongoDb.collection('tracked_downloads').updateMany(
        { $or: clauses },
        { $set: { is_done: 1, notified_done: 1 } }
      ).catch(console.error);
    }
    return;
  }

  const uid = item && typeof item === 'object' ? String(item.user_id || '') : '';
  const iid = item && typeof item === 'object' ? String(item.item_id || '') : '';
  if (uid && iid) {
    db.prepare('UPDATE tracked_downloads SET is_done = 1, notified_done = 1 WHERE user_id = ? AND item_id = ?').run(uid, iid);
  } else {
    const idVal = typeof item === 'object' ? item.id : item;
    db.prepare('UPDATE tracked_downloads SET is_done = 1, notified_done = 1 WHERE id = ?').run(idVal);
  }
}

export async function getPendingNotifications() {
  if (mongoDb) {
    return await mongoDb.collection('tracked_downloads').find({ is_done: 1, notified_done: 0 }).toArray();
  }
  return db.prepare(`
    SELECT d.*, k.api_key, p.chat_id
    FROM tracked_downloads d
    LEFT JOIN api_keys k ON k.user_id = d.user_id
    LEFT JOIN private_chats p ON p.user_id = d.user_id
    WHERE d.is_done = 1 AND d.notified_done = 0
  `).all();
}

export async function getActiveTracked() {
  if (mongoDb) {
    return await mongoDb.collection('tracked_downloads').find({ is_done: 0 }).toArray();
  }
  return db.prepare(`
    SELECT d.*, k.api_key
    FROM tracked_downloads d
    LEFT JOIN api_keys k ON k.user_id = d.user_id
    WHERE d.is_done = 0
    ORDER BY d.created_at
  `).all();
}

export async function getUserDownloads(userId) {
  const uid = String(userId);
  if (mongoDb) {
    return await mongoDb.collection('tracked_downloads').find({ user_id: uid }).sort({ created_at: -1 }).limit(20).toArray();
  }
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(uid);
}

export async function getDownloadById(userId, itemId, type) {
  const uid = String(userId);
  const itemStr = String(itemId);
  if (mongoDb) {
    return await mongoDb.collection('tracked_downloads').findOne({ user_id: uid, item_id: itemStr, type });
  }
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).get(uid, itemStr, type);
}

export async function getUserTrackedItemIds(userId, type) {
  const uid = String(userId);
  if (mongoDb) {
    const docs = await mongoDb.collection('tracked_downloads').find({ user_id: uid, type }).toArray();
    return new Set(docs.map((d) => String(d.item_id)));
  }
  const rows = db.prepare(`
    SELECT item_id FROM tracked_downloads
    WHERE user_id = ? AND type = ?
  `).all(uid, type);
  return new Set(rows.map((r) => String(r.item_id)));
}

export async function isItemOwnedByUser(userId, itemId, type) {
  const uid = String(userId);
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
  if (adminId && uid === adminId) return true;

  if (mongoDb) {
    const doc = await mongoDb.collection('tracked_downloads').findOne({ user_id: uid, item_id: String(itemId), type });
    return !!doc;
  }

  const row = db.prepare(`
    SELECT id FROM tracked_downloads
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).get(uid, String(itemId), type);
  return !!row;
}

export async function getStats() {
  if (mongoDb) {
    return {
      total_users: await mongoDb.collection('users').countDocuments(),
      allowed_users: await mongoDb.collection('users').countDocuments({ is_allowed: 1 }),
      total_tracked: await mongoDb.collection('tracked_downloads').countDocuments(),
      active_tracked: await mongoDb.collection('tracked_downloads').countDocuments({ is_done: 0 }),
      done_tracked: await mongoDb.collection('tracked_downloads').countDocuments({ is_done: 1 }),
    };
  }
  return {
    total_users:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    allowed_users:  db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed=1').get().c,
    total_tracked:  db.prepare('SELECT COUNT(*) as c FROM tracked_downloads').get().c,
    active_tracked: db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE is_done=0').get().c,
    done_tracked:   db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE is_done=1').get().c,
  };
}
