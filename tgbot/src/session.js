// ============================================================
// Session — thin in-memory layer for conversation state
// Persistent data (API keys, users, plans) is in db.js
// ============================================================

// Re-export everything from db.js so existing code still works
export {
  isUserAllowed, isUserAllowedMain, addAllowedUser, removeAllowedUser, listAllowedUsers, isOpenAccess,
  getUserApiKey, getMainApiKey, setUserApiKey, removeUserApiKey, hasApiKey, hasPersonalApiKey,
  setCachedPlan, getCachedPlan,
  setPrivateChatId, getPrivateChatId, updateTrackedItemId,
  cleanApiKey,
} from './db.js';

// ── Plan feature gate ─────────────────────────────────────────
const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };

const REQUIREMENTS = {
  usenet:         { minPlan: 1, label: 'Usenet downloads' },
  webdl:          { minPlan: 1, label: 'Web downloads' },
  rss:            { minPlan: 1, label: 'RSS feeds' },
  notifications:  { minPlan: 1, label: 'Notifications' },
  addUncached:    { minPlan: 1, label: 'Uncached torrent downloads' },
  addCached:      { minPlan: 0, label: 'Cached torrents' },
  search:         { minPlan: 0, label: 'Search' },
};

export function checkPlanFeature(plan, feature) {
  if (plan === null || plan === undefined) return null; // unknown — let TorBox decide
  const req = REQUIREMENTS[feature];
  if (!req) return null;
  if (plan < req.minPlan) {
    const needed = PLAN_NAMES[req.minPlan] || `Plan ${req.minPlan}`;
    const current = PLAN_NAMES[plan] || `Plan ${plan}`;
    return (
      `🚫 *${escMd(req.label)}* requires *${escMd(needed)}* or higher\\.\n\n` +
      `Your plan: *${escMd(current)}*\n` +
      `Upgrade at: https://torbox\\.app/subscription`
    );
  }
  return null;
}

// ── In-memory conversation sessions ──────────────────────────
const DEFAULT_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT_MS || '300000', 10);

class SessionStore {
  constructor() {
    this._store = new Map();
    setInterval(() => this._cleanup(), 60_000);
  }
  get(userId) {
    const e = this._store.get(String(userId));
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this._store.delete(String(userId)); return null; }
    e.expiresAt = Date.now() + DEFAULT_TIMEOUT;
    return e.data;
  }
  set(userId, data) {
    this._store.set(String(userId), { data, expiresAt: Date.now() + DEFAULT_TIMEOUT });
  }
  update(userId, partial) {
    this.set(userId, { ...(this.get(userId) || {}), ...partial });
  }
  delete(userId) { this._store.delete(String(userId)); }
  _cleanup() {
    const now = Date.now();
    for (const [id, e] of this._store.entries()) if (now > e.expiresAt) this._store.delete(id);
  }
}

export const sessions = new SessionStore();

function escMd(s) {
  return String(s).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}
