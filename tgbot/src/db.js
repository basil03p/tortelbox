// ============================================================
// Database Manager — MongoDB Major Persistence & Fast Cache
// ============================================================
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
let Database = null;

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
    await mongoDb.collection('tracked_downloads').createIndex({ user_id: 1, updated_at: -1 });
    await mongoDb.collection('tracked_downloads').createIndex({ user_id: 1, created_at: -1 });
    await mongoDb.collection('gofile_uploads').createIndex({ user_id: 1, created_at: -1 });

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
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error('⚠️ Could not load better-sqlite3:', err.message);
  }
  if (Database) {
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
      allow_main   INTEGER NOT NULL DEFAULT 0,
      added_by     TEXT,
      added_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  try {
    db.exec('ALTER TABLE users ADD COLUMN allow_main INTEGER NOT NULL DEFAULT 0;');
  } catch (_) {}

  try {
    const allUsers = db.prepare('SELECT * FROM users').all();
    allUsers.forEach((u) => userCache.set(String(u.user_id), u));
  } catch (_) {}

  db.exec(`
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
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      done_at      TEXT,
      UNIQUE(user_id, item_id, type)
    );

    CREATE INDEX IF NOT EXISTS idx_tracked_pending
      ON tracked_downloads(is_done, notified_done);

    CREATE TABLE IF NOT EXISTS gofile_uploads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      type          TEXT NOT NULL,
      item_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      download_page TEXT NOT NULL,
      file_id       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations for existing databases
  try {
    db.exec("ALTER TABLE tracked_downloads ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE tracked_downloads ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));");
  } catch (_) {}
  try {
    db.exec("ALTER TABLE tracked_downloads ADD COLUMN done_at TEXT;");
  } catch (_) {}
  try {
    db.exec("UPDATE tracked_downloads SET created_at = datetime('now') WHERE created_at IS NULL;");
    db.exec("UPDATE tracked_downloads SET updated_at = created_at WHERE updated_at IS NULL;");
  } catch (_) {}

    console.log(`💾 Database opened: ${DB_PATH}`);
  }
}

// ──────────────────────────────────────────────────────────────
// API KEY SANITIZATION UTILITY
// ──────────────────────────────────────────────────────────────

export function cleanApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  let cleaned = key.trim();
  // Strip surrounding quotes: "xxx" or 'xxx'
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Strip leading Bearer prefix if accidentally included
  if (cleaned.toLowerCase().startsWith('bearer ')) {
    cleaned = cleaned.slice(7).trim();
  }
  // Strip surrounding quotes again if nested like "'xxx'"
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  // Reject obvious placeholder strings
  const lower = cleaned.toLowerCase();
  if (['', 'null', 'undefined', 'your_api_key', 'your_torbox_api_key', 'api_key', 'changeme', 'placeholder'].includes(lower)) {
    return '';
  }
  return cleaned;
}

// ──────────────────────────────────────────────────────────────
// USER HELPERS
// ──────────────────────────────────────────────────────────────

export function upsertUser(userId, { username, firstName, isAllowed, allowMain } = {}) {
  const uid = String(userId);
  const existing = userCache.get(uid) || {};
  const mainVal = (allowMain === true || allowMain === 1 || String(allowMain).toLowerCase() === 'main' || String(allowMain) === '1')
    ? 1
    : (allowMain === false || allowMain === 0 || String(allowMain) === '0')
      ? 0
      : (existing.allow_main ?? 0);

  const uData = {
    user_id: uid,
    username: username !== undefined ? (username || null) : (existing.username || null),
    first_name: firstName !== undefined ? (firstName || null) : (existing.first_name || null),
    is_allowed: isAllowed !== undefined ? (isAllowed ? 1 : 0) : (existing.is_allowed ?? 0),
    allow_main: mainVal,
  };
  userCache.set(uid, { ...existing, ...uData });

  if (mongoDb) {
    mongoDb.collection('users').updateOne(
      { user_id: uid },
      { $set: uData },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  if (db) {
    db.prepare(`
      INSERT INTO users (user_id, username, first_name, is_allowed, allow_main)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username   = COALESCE(excluded.username, username),
        first_name = COALESCE(excluded.first_name, first_name),
        is_allowed = CASE WHEN excluded.is_allowed IS NOT NULL THEN excluded.is_allowed ELSE is_allowed END,
        allow_main = CASE WHEN excluded.allow_main IS NOT NULL THEN excluded.allow_main ELSE allow_main END
    `).run(uid, uData.username, uData.first_name, uData.is_allowed, uData.allow_main);
  }
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

  if (db) {
    const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_allowed = 1').get();
    if (count.c > 0) {
      const row = db.prepare('SELECT is_allowed FROM users WHERE user_id = ?').get(uid);
      return row?.is_allowed === 1;
    }
  }

  const cached = userCache.get(uid);
  if (cached?.is_allowed === 1 || cached?.is_allowed === true) return true;

  if (adminId || envAllowed) return false;
  return true;
}

export function isUserAllowedMain(userId) {
  const uid = String(userId);
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
  if (adminId && uid === adminId) return true;

  const cached = userCache.get(uid);
  if (cached?.allow_main === 1 || cached?.allow_main === true || cached?.allow_main === '1' || cached?.allow_main === 'true') {
    return true;
  }

  if (db) {
    const row = db.prepare('SELECT allow_main FROM users WHERE user_id = ?').get(uid);
    return row?.allow_main === 1 || row?.allow_main === true || row?.allow_main === '1' || row?.allow_main === 'true';
  }
  return false;
}

export function addAllowedUser(userId, addedBy = null, allowMain = false) {
  const uid = String(userId);
  const mainVal = (allowMain === true || allowMain === 1 || String(allowMain).toLowerCase() === 'main' || String(allowMain) === '1') ? 1 : 0;
  if (mainVal === 1) {
    // When granted shared access to the main account, wipe any old/stale personal key
    removeUserApiKey(uid);
  }
  const existing = userCache.get(uid) || {};
  const uData = {
    user_id: uid,
    is_allowed: 1,
    allow_main: mainVal,
    added_by: addedBy ? String(addedBy) : null,
    added_at: existing.added_at || new Date().toISOString(),
  };
  userCache.set(uid, { ...existing, ...uData });

  if (mongoDb) {
    mongoDb.collection('users').updateOne(
      { user_id: uid },
      { $set: uData },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  if (db) {
    db.prepare(`
      INSERT INTO users (user_id, is_allowed, allow_main, added_by)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET is_allowed = 1, allow_main = excluded.allow_main, added_by = excluded.added_by
    `).run(uid, mainVal, addedBy ? String(addedBy) : null);
  }
}

export function removeAllowedUser(userId) {
  const uid = String(userId);
  const existing = userCache.get(uid);
  if (existing) {
    existing.is_allowed = 0;
    existing.allow_main = 0;
  }

  if (mongoDb) {
    mongoDb.collection('users').updateOne({ user_id: uid }, { $set: { is_allowed: 0, allow_main: 0 } }).catch(console.error);
    return;
  }
  if (db) {
    db.prepare('UPDATE users SET is_allowed = 0, allow_main = 0 WHERE user_id = ?').run(uid);
  }
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
    SELECT u.user_id, u.username, u.first_name, u.is_allowed, u.allow_main, u.added_at, k.plan
    FROM users u
    LEFT JOIN api_keys k ON k.user_id = u.user_id
    WHERE u.is_allowed = 1
    ORDER BY u.added_at
  `).all();
}

/**
 * Get all registered users for admin (/regusers command)
 */
export async function getAllRegisteredUsers() {
  if (mongoDb) {
    const users = await mongoDb.collection('users').find({}).toArray();
    const keys = await mongoDb.collection('api_keys').find({}).toArray();
    const keyMap = new Map();
    keys.forEach((k) => keyMap.set(String(k.user_id), k));

    return users.map((u) => {
      const uid = String(u.user_id);
      const k = keyMap.get(uid) || {};
      return {
        user_id: uid,
        username: u.username || null,
        first_name: u.first_name || null,
        is_allowed: u.is_allowed === 1 || u.is_allowed === true ? 1 : 0,
        allow_main: u.allow_main === 1 || u.allow_main === true ? 1 : 0,
        added_by: u.added_by || null,
        added_at: u.added_at || u.created_at || null,
        api_key: k.api_key || null,
        plan: k.plan ?? null,
      };
    });
  }

  if (db) {
    return db.prepare(`
      SELECT u.user_id, u.username, u.first_name, u.is_allowed, u.allow_main, u.added_by, u.added_at, k.api_key, k.plan
      FROM users u
      LEFT JOIN api_keys k ON k.user_id = u.user_id
      ORDER BY u.added_at DESC
    `).all();
  }
  return [];
}

/**
 * Get detailed breakdown for a single user
 */
export async function getUserDetailedInfo(userId) {
  const uid = String(userId);
  let user = null;
  let apiKeyInfo = null;
  let trackedCount = 0;
  let activeTracked = 0;
  let doneTracked = 0;
  let gofileCount = 0;

  if (mongoDb) {
    user = await mongoDb.collection('users').findOne({ user_id: uid });
    apiKeyInfo = await mongoDb.collection('api_keys').findOne({ user_id: uid });
    trackedCount = await mongoDb.collection('tracked_downloads').countDocuments({ user_id: uid });
    activeTracked = await mongoDb.collection('tracked_downloads').countDocuments({ user_id: uid, is_done: 0 });
    doneTracked = await mongoDb.collection('tracked_downloads').countDocuments({ user_id: uid, is_done: 1 });
    gofileCount = await mongoDb.collection('gofile_uploads').countDocuments({ user_id: uid });
  } else if (db) {
    user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
    apiKeyInfo = db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(uid);
    trackedCount = db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE user_id = ?').get(uid)?.c || 0;
    activeTracked = db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE user_id = ? AND is_done = 0').get(uid)?.c || 0;
    doneTracked = db.prepare('SELECT COUNT(*) as c FROM tracked_downloads WHERE user_id = ? AND is_done = 1').get(uid)?.c || 0;
    gofileCount = db.prepare('SELECT COUNT(*) as c FROM gofile_uploads WHERE user_id = ?').get(uid)?.c || 0;
  }

  return {
    user_id: uid,
    username: user?.username || null,
    first_name: user?.first_name || null,
    is_allowed: user?.is_allowed === 1 || user?.is_allowed === true ? 1 : 0,
    allow_main: user?.allow_main === 1 || user?.allow_main === true ? 1 : 0,
    added_at: user?.added_at || null,
    api_key: apiKeyInfo?.api_key || null,
    plan: apiKeyInfo?.plan ?? null,
    trackedCount,
    activeTracked,
    doneTracked,
    gofileCount,
  };
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

export function getMainApiKey() {
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;

  // 1. First priority: Check if admin configured an active API key in MongoDB / SQLite via /setkey
  if (adminId) {
    const adminCached = apiKeyCache.get(adminId);
    const cleaned = cleanApiKey(adminCached?.api_key);
    if (cleaned) return cleaned;

    if (db) {
      const adminRow = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(adminId);
      const cleanedDb = cleanApiKey(adminRow?.api_key);
      if (cleanedDb) return cleanedDb;
    }
  }

  // 2. Second priority: process.env.TORBOX_API_KEY (cleaned of surrounding quotes, Bearer, whitespace)
  const envKey = cleanApiKey(process.env.TORBOX_API_KEY);
  if (envKey) return envKey;

  // 3. Third priority: Check owners or allowed users who might be the bot creator
  const ownerEnv = process.env.BOT_OWNER_ID || process.env.OWNER_ID;
  if (ownerEnv) {
    const ownerId = String(ownerEnv).trim();
    const ownerCached = apiKeyCache.get(ownerId);
    const cleaned = cleanApiKey(ownerCached?.api_key);
    if (cleaned) return cleaned;

    if (db) {
      const row = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(ownerId);
      const cleanedDb = cleanApiKey(row?.api_key);
      if (cleanedDb) return cleanedDb;
    }
  }

  // 4. Fourth priority: Any valid key saved in the database / cache
  for (const [, kData] of apiKeyCache.entries()) {
    const cleaned = cleanApiKey(kData?.api_key);
    if (cleaned) return cleaned;
  }
  if (db) {
    const rows = db.prepare('SELECT api_key FROM api_keys WHERE api_key IS NOT NULL AND api_key != ""').all();
    for (const row of rows) {
      const cleaned = cleanApiKey(row?.api_key);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

export function getUserApiKey(userId) {
  const uid = String(userId);

  // 1. If user is admin OR explicitly allowed with 'main', prioritize the main account key
  if (isUserAllowedMain(uid)) {
    const mainKey = getMainApiKey();
    if (mainKey) return mainKey;
  }

  // 2. Check if user has explicit personal key in cache/DB
  let personalKey = apiKeyCache.get(uid)?.api_key || null;
  if (!personalKey && db) {
    const row = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(uid);
    personalKey = row?.api_key || null;
  }

  const cleanedPersonal = cleanApiKey(personalKey);
  if (cleanedPersonal) return cleanedPersonal;

  // 3. Fallback to Main / Owner API Key if user is allowed with 'main'
  if (isUserAllowedMain(uid)) {
    return getMainApiKey();
  }

  return null;
}

export function setUserApiKey(userId, apiKey, plan = null) {
  const uid = String(userId);
  const cleanKey = cleanApiKey(apiKey);
  // Remove existing cached key entry for this user to ensure complete overwrite
  apiKeyCache.delete(uid);

  const kData = { user_id: uid, api_key: cleanKey, plan, updated_at: new Date().toISOString() };
  apiKeyCache.set(uid, kData);

  if (mongoDb) {
    mongoDb.collection('api_keys').updateOne(
      { user_id: uid },
      { $set: kData },
      { upsert: true }
    ).catch(console.error);
    return;
  }
  if (db) {
    db.prepare(`
      INSERT INTO api_keys (user_id, api_key, plan)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET api_key = excluded.api_key, plan = excluded.plan, updated_at = datetime('now')
    `).run(uid, cleanKey, plan);
  }
}

export function removeUserApiKey(userId) {
  const uid = String(userId);
  apiKeyCache.delete(uid);

  if (mongoDb) {
    mongoDb.collection('api_keys').deleteOne({ user_id: uid }).catch(console.error);
    return;
  }
  if (db) {
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(uid);
  }
}

export function hasApiKey(userId) {
  return !!getUserApiKey(userId);
}

export function hasPersonalApiKey(userId) {
  const uid = String(userId);
  if (mongoDb) {
    const cached = apiKeyCache.get(uid);
    return !!(cached?.api_key && cached.api_key.trim());
  }
  if (db) {
    const row = db.prepare('SELECT api_key FROM api_keys WHERE user_id = ?').get(uid);
    return !!(row?.api_key && row.api_key.trim());
  }
  const cached = apiKeyCache.get(uid);
  return !!(cached?.api_key && cached.api_key.trim());
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
  if (db) {
    db.prepare(`
      INSERT INTO api_keys (user_id, api_key, plan)
      VALUES (?, '', ?)
      ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan
    `).run(uid, plan);
  }
}

export function getCachedPlan(userId) {
  const uid = String(userId);
  const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;

  let plan = null;
  if (mongoDb) {
    plan = apiKeyCache.get(uid)?.plan ?? null;
  } else if (db) {
    const row = db.prepare('SELECT plan FROM api_keys WHERE user_id = ?').get(uid);
    plan = row?.plan ?? null;
  } else {
    plan = apiKeyCache.get(uid)?.plan ?? null;
  }

  // Fallback to Admin's plan for users with main account access
  if (plan === null && isUserAllowedMain(uid)) {
    if (mongoDb) {
      if (adminId && apiKeyCache.get(adminId)?.plan != null) {
        return apiKeyCache.get(adminId).plan;
      }
      for (const [, kData] of apiKeyCache.entries()) {
        if (kData?.plan != null) return kData.plan;
      }
    } else if (db) {
      if (adminId) {
        const adminRow = db.prepare('SELECT plan FROM api_keys WHERE user_id = ?').get(adminId);
        if (adminRow?.plan != null) return adminRow.plan;
      }
      const firstRow = db.prepare('SELECT plan FROM api_keys WHERE plan IS NOT NULL LIMIT 1').get();
      if (firstRow?.plan != null) return firstRow.plan;
    } else {
      if (adminId && apiKeyCache.get(adminId)?.plan != null) {
        return apiKeyCache.get(adminId).plan;
      }
    }
  }

  return plan;
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
  if (db) {
    db.prepare(`
      INSERT INTO private_chats (user_id, chat_id)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, updated_at = datetime('now')
    `).run(uid, cid);
  }
}

export function getPrivateChatId(userId) {
  const uid = String(userId);
  if (mongoDb) {
    return privateChatCache.get(uid) || uid;
  }
  if (db) {
    const row = db.prepare('SELECT chat_id FROM private_chats WHERE user_id = ?').get(uid);
    return row?.chat_id || uid;
  }
  return privateChatCache.get(uid) || uid;
}

// ──────────────────────────────────────────────────────────────
// TRACKED DOWNLOADS (Strict Per-User Explicit Tracking Only)
// ──────────────────────────────────────────────────────────────

export async function trackDownload(userId, itemId, type, name) {
  const uid = String(userId);
  const itemStr = String(itemId);
  const now = new Date().toISOString();

  if (mongoDb) {
    await mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: itemStr, type },
      {
        $set: {
          name: name || null,
          updated_at: now,
        },
        $setOnInsert: {
          created_at: now,
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
      INSERT INTO tracked_downloads (user_id, item_id, type, name, is_done, notified_done, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, item_id, type) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        updated_at = datetime('now')
    `).run(uid, itemStr, type, name || null);
  } catch (_) { /* skip duplicates */ }
}

export async function updateDownloadStatus(userId, itemId, type, status, isDone, name = null) {
  const uid = String(userId);
  const itemStr = String(itemId);
  const doneVal = isDone ? 1 : 0;
  const now = new Date().toISOString();

  if (mongoDb) {
    const updateObj = { last_status: status, updated_at: now };
    if (isDone) {
      updateObj.is_done = 1;
      updateObj.done_at = now;
    }
    if (name) updateObj.name = name;

    await mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: itemStr, type },
      { $set: updateObj }
    ).catch(console.error);
    return;
  }

  db.prepare(`
    UPDATE tracked_downloads
    SET last_status = ?,
        is_done = MAX(is_done, ?),
        done_at = CASE WHEN ? = 1 AND done_at IS NULL THEN datetime('now') ELSE done_at END,
        updated_at = datetime('now'),
        name = COALESCE(?, name)
    WHERE user_id = ? AND item_id = ? AND type = ?
  `).run(status, doneVal, doneVal, name || null, uid, itemStr, type);
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
  if (!item) return;
  if (mongoDb) {
    let filter = null;
    if (typeof item === 'object' && item !== null) {
      if (item._id) {
        filter = { _id: item._id };
      } else if (item.user_id && item.item_id) {
        filter = { user_id: String(item.user_id), item_id: String(item.item_id) };
      } else if (item.id) {
        filter = { id: item.id };
      } else {
        filter = { _id: item };
      }
    } else {
      filter = { _id: item };
    }

    if (filter) {
      const res = await mongoDb.collection('tracked_downloads').updateMany(
        filter,
        { $set: { is_done: 1, notified_done: 1 } }
      ).catch(console.error);

      if (res?.matchedCount > 0) {
        console.log(`✅ Marked notified in MongoDB (matched ${res.matchedCount} doc)`);
      }
    }
    return;
  }

  const idVal = typeof item === 'object' ? (item.id || item._id) : item;
  db.prepare('UPDATE tracked_downloads SET is_done = 1, notified_done = 1 WHERE id = ? OR (user_id = ? AND item_id = ?)').run(idVal, item?.user_id, item?.item_id);
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

export async function getUserDownloads(userId, limit = 50) {
  const uid = String(userId);
  let items = [];

  if (mongoDb) {
    items = await mongoDb.collection('tracked_downloads')
      .find({ user_id: uid })
      .sort({ updated_at: -1, created_at: -1, _id: -1 })
      .limit(limit)
      .toArray();
  } else if (db) {
    items = db.prepare(`
      SELECT * FROM tracked_downloads
      WHERE user_id = ?
      ORDER BY COALESCE(updated_at, created_at, done_at, datetime('1970-01-01')) DESC, id DESC
      LIMIT ?
    `).all(uid, limit);
  }

  // Ensure latest ones are strictly first in all database backends
  items.sort((a, b) => {
    const tA = new Date(a.updated_at || a.created_at || a.done_at || 0).getTime() || 0;
    const tB = new Date(b.updated_at || b.created_at || b.done_at || 0).getTime() || 0;
    if (tA !== tB) return tB - tA;

    const numA = Number(a.item_id);
    const numB = Number(b.item_id);
    if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numB - numA;

    if (a.id && b.id) return b.id - a.id;
    return String(b._id || '').localeCompare(String(a._id || ''));
  });

  return items;
}

export async function getTrackedDownloadByItemId(userId, itemId) {
  const uid = String(userId);
  const itemStr = String(itemId);
  if (mongoDb) {
    return await mongoDb.collection('tracked_downloads').findOne({ user_id: uid, item_id: itemStr });
  }
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE user_id = ? AND item_id = ?
    ORDER BY COALESCE(updated_at, created_at, datetime('1970-01-01')) DESC, id DESC
    LIMIT 1
  `).get(uid, itemStr);
}

export async function findTrackedDownloadById(itemId, userId = null) {
  const itemStr = String(itemId);
  if (userId) {
    const direct = await getTrackedDownloadByItemId(userId, itemStr);
    if (direct) return direct;
  }
  if (mongoDb) {
    return await mongoDb.collection('tracked_downloads').findOne({ item_id: itemStr });
  }
  return db.prepare(`
    SELECT * FROM tracked_downloads
    WHERE item_id = ?
    ORDER BY COALESCE(updated_at, created_at, datetime('1970-01-01')) DESC, id DESC
    LIMIT 1
  `).get(itemStr);
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

export async function updateTrackedName(userId, itemId, type, name) {
  const uid = String(userId);
  const itemStr = String(itemId);
  const now = new Date().toISOString();
  if (mongoDb) {
    await mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: itemStr, type },
      { $set: { name, updated_at: now } }
    ).catch(console.error);
    return;
  }
  db.prepare('UPDATE tracked_downloads SET name = ?, updated_at = datetime(\'now\') WHERE user_id = ? AND item_id = ? AND type = ?').run(name, uid, itemStr, type);
}

export async function deleteTrackedDownload(userId, itemId, type) {
  const uid = String(userId);
  const itemStr = String(itemId);
  if (mongoDb) {
    const res = await mongoDb.collection('tracked_downloads').deleteOne({ user_id: uid, item_id: itemStr, type }).catch(console.error);
    return res?.deletedCount || 0;
  }
  const info = db.prepare('DELETE FROM tracked_downloads WHERE user_id = ? AND item_id = ? AND type = ?').run(uid, itemStr, type);
  return info?.changes || 0;
}

export async function clearUserTracked(userId, onlyCompleted = true) {
  const uid = String(userId);
  const filter = { user_id: uid };
  if (onlyCompleted) filter.is_done = 1;
  if (mongoDb) {
    const res = await mongoDb.collection('tracked_downloads').deleteMany(filter).catch(console.error);
    return res?.deletedCount || 0;
  }
  const query = onlyCompleted
    ? 'DELETE FROM tracked_downloads WHERE user_id = ? AND is_done = 1'
    : 'DELETE FROM tracked_downloads WHERE user_id = ?';
  const info = db.prepare(query).run(uid);
  return info?.changes || 0;
}

export async function getUserTrackedItemIds(userId, type = null) {
  const uid = String(userId);
  const filter = { user_id: uid };
  if (type) filter.type = type;
  if (mongoDb) {
    const docs = await mongoDb.collection('tracked_downloads').find(filter).toArray();
    const set = new Set();
    for (const d of docs) {
      if (d.item_id) {
        set.add(String(d.item_id));
        set.add(String(d.item_id).toLowerCase());
      }
    }
    return set;
  }
  const query = type
    ? 'SELECT item_id FROM tracked_downloads WHERE user_id = ? AND type = ?'
    : 'SELECT item_id FROM tracked_downloads WHERE user_id = ?';
  const rows = type ? db.prepare(query).all(uid, type) : db.prepare(query).all(uid);
  const set = new Set();
  for (const r of rows) {
    if (r.item_id) {
      set.add(String(r.item_id));
      set.add(String(r.item_id).toLowerCase());
    }
  }
  return set;
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

export async function saveGofileUpload(userId, type, itemId, name, downloadPage, fileId = null) {
  const uid = String(userId);
  const doc = {
    user_id: uid,
    type,
    item_id: String(itemId),
    name: name || `File #${itemId}`,
    download_page: downloadPage,
    file_id: fileId,
    created_at: new Date().toISOString(),
  };

  if (mongoDb) {
    await mongoDb.collection('gofile_uploads').insertOne(doc).catch(console.error);
    return;
  }
  if (db) {
    db.prepare(`
      INSERT INTO gofile_uploads (user_id, type, item_id, name, download_page, file_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uid, type, String(itemId), doc.name, downloadPage, fileId || null, doc.created_at);
  }
}

export async function getUserGofileUploads(userId, limit = 20) {
  const uid = String(userId);
  if (mongoDb) {
    return await mongoDb.collection('gofile_uploads').find({ user_id: uid }).sort({ created_at: -1 }).limit(limit).toArray();
  }
  if (db) {
    return db.prepare(`
      SELECT * FROM gofile_uploads
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(uid, limit);
  }
  return [];
}

export function getAllTracked(limit = 50) {
  if (mongoDb) {
    // In sync call context for admin panel or callers
    const docs = [];
    return docs;
  }
  if (db) {
    return db.prepare(`
      SELECT d.*, u.username, u.first_name
      FROM tracked_downloads d
      LEFT JOIN users u ON u.user_id = d.user_id
      ORDER BY d.created_at DESC
      LIMIT ?
    `).all(limit);
  }
  return [];
}

export async function updateTrackedItemId(userId, oldItemId, newItemId, type) {
  const uid = String(userId);
  const oldId = String(oldItemId);
  const newId = String(newItemId);
  if (oldId === newId) return;

  if (mongoDb) {
    await mongoDb.collection('tracked_downloads').updateOne(
      { user_id: uid, item_id: oldId, type },
      { $set: { item_id: newId } }
    ).catch(console.error);
    return;
  }
  if (db) {
    try {
      db.prepare(`
        UPDATE tracked_downloads
        SET item_id = ?
        WHERE user_id = ? AND item_id = ? AND type = ?
      `).run(newId, uid, oldId, type);
    } catch (_) {}
  }
}
