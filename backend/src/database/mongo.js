import { MongoClient } from 'mongodb';
import logger from '../utils/logger.js';
import { hashApiKey, encrypt } from '../utils/crypto.js';

let mongoDb = null;
let client = null;

/**
 * Initialize MongoDB connection if MONGODB_URI / MONGO_URL is provided in environment.
 */
export async function initMongo() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGODB_URL;
  if (!mongoUri) {
    logger.debug('No MONGODB_URI set; Mongo DB helper uninitialized');
    return null;
  }

  if (mongoDb) return mongoDb;

  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    const dbName = process.env.MONGODB_DB_NAME || 'torbox_master';
    mongoDb = client.db(dbName);
    logger.info('Connected to MongoDB database successfully', { dbName });

    // Create unique indexes
    await mongoDb.collection('users').createIndex({ auth_id: 1 }, { unique: true });
    await mongoDb.collection('api_keys').createIndex({ auth_id: 1 }, { unique: true });

    return mongoDb;
  } catch (error) {
    logger.error('Failed to connect to MongoDB', error);
    return null;
  }
}

/**
 * Get active MongoDB instance
 */
export function getMongoDb() {
  return mongoDb;
}

/**
 * Register or update an API key in MongoDB
 */
export async function registerApiKeyMongo(apiKey, keyName = null, dbPath = null) {
  const authId = hashApiKey(apiKey);
  const encryptedKey = encrypt(apiKey);
  const db = getMongoDb();
  if (!db) return null;

  const now = new Date().toISOString();

  // Upsert user in 'users' collection
  await db.collection('users').updateOne(
    { auth_id: authId },
    {
      $set: {
        auth_id: authId,
        status: 'active',
        is_allowed: 1,
        updated_at: now,
      },
      $setOnInsert: {
        created_at: now,
        db_path: dbPath || `data/user_${authId}.db`,
      },
    },
    { upsert: true }
  );

  // Upsert in 'api_keys' collection
  const existingKey = await db.collection('api_keys').findOne({ auth_id: authId });
  const wasNew = !existingKey;

  await db.collection('api_keys').updateOne(
    { auth_id: authId },
    {
      $set: {
        auth_id: authId,
        encrypted_key: encryptedKey,
        key_name: keyName,
        is_active: 1,
        updated_at: now,
      },
      $setOnInsert: {
        created_at: now,
      },
    },
    { upsert: true }
  );

  return { authId, wasNew };
}

/**
 * Update user status in MongoDB
 */
export async function updateUserStatusMongo(authId, status) {
  const db = getMongoDb();
  if (!db) return null;

  const now = new Date().toISOString();
  const isActive = status === 'active' ? 1 : 0;

  await db.collection('users').updateOne(
    { auth_id: authId },
    { $set: { status, is_allowed: isActive, updated_at: now } }
  );

  await db.collection('api_keys').updateOne(
    { auth_id: authId },
    { $set: { is_active: isActive, updated_at: now } }
  );

  return { authId, status };
}

/**
 * Grant access to a user in MongoDB
 */
export async function grantUserAccessMongo(authId) {
  return updateUserStatusMongo(authId, 'active');
}

/**
 * Revoke access from a user in MongoDB
 */
export async function revokeUserAccessMongo(authId) {
  return updateUserStatusMongo(authId, 'inactive');
}
