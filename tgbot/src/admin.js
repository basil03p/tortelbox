// ============================================================
// Admin Web Panel — Express + password protection
// Serves on PORT (env var, default 3001)
// Set ADMIN_WEB_PASSWORD in env to secure it
// ============================================================
import express from 'express';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const expressSession = require('express-session');

import {
  listAllowedUsers, addAllowedUser, removeAllowedUser,
  isOpenAccess, getStats, getAllTracked,
} from './db.js';

const ADMIN_USERNAME = process.env.ADMIN_WEB_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_WEB_PASSWORD || 'admin';
const PORT = parseInt(process.env.ADMIN_PORT || process.env.BOT_ADMIN_PORT || '3001', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'torbox-admin-secret-' + Math.random();

const PLAN_NAMES = { 0: 'Free', 1: 'Essential', 2: 'Pro', 3: 'Ultimate' };

// ── HTML helpers ───────────────────────────────────────────────
function page(title, body, isAuthed = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — TorBox Bot Admin</title>
<style>
  :root{--bg:#0f0f13;--card:#1a1a24;--border:#2a2a3a;--accent:#7c3aed;--accent2:#6d28d9;--text:#e2e8f0;--muted:#94a3b8;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh;font-size:14px}
  a{color:var(--accent);text-decoration:none}.a:hover{text-decoration:underline}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 16px}
  .nav{background:var(--card);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:20px}
  .nav-brand{font-size:16px;font-weight:700;color:var(--text)}
  .nav-brand span{color:var(--accent)}
  .nav a{color:var(--muted);font-size:13px}.nav a:hover{color:var(--text)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:20px}
  .card h2{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;text-align:center}
  .stat-num{font-size:28px;font-weight:700;color:var(--accent)}
  .stat-label{font-size:12px;color:var(--muted);margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 10px;color:var(--muted);border-bottom:1px solid var(--border);font-weight:500}
  td{padding:8px 10px;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(124,58,237,.05)}
  .badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}
  .badge-green{background:rgba(34,197,94,.15);color:var(--green)}
  .badge-red{background:rgba(239,68,68,.15);color:var(--red)}
  .badge-yellow{background:rgba(245,158,11,.15);color:var(--yellow)}
  .badge-purple{background:rgba(124,58,237,.15);color:var(--accent)}
  form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  input{background:#111120;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;width:200px}
  input:focus{outline:none;border-color:var(--accent)}
  btn,.btn{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-weight:500}
  .btn:hover{background:var(--accent2)}.btn-red{background:var(--red)}.btn-red:hover{background:#dc2626}
  .login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}
  .login-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:40px;width:360px;text-align:center}
  .login-card h1{font-size:22px;font-weight:700;margin-bottom:8px}.login-card h1 span{color:var(--accent)}
  .login-card p{color:var(--muted);font-size:13px;margin-bottom:24px}
  .login-card input{width:100%;margin-bottom:12px;padding:10px 14px;font-size:14px}
  .login-card .btn{width:100%;padding:10px;font-size:14px}
  .err{color:var(--red);font-size:13px;margin-bottom:12px}
  .empty{color:var(--muted);font-size:13px;padding:20px 0;text-align:center}
  .type-icon{font-size:16px}
  .scroll{overflow-x:auto}
</style>
</head>
<body>
${isAuthed ? `<div class="nav">
  <div class="nav-brand">🤖 TorBox<span>Bot</span> Admin</div>
  <a href="/admin">Dashboard</a>
  <a href="/admin/users">Users</a>
  <a href="/admin/downloads">Downloads</a>
  <a href="/admin/logout">Logout</a>
</div>` : ''}
<div class="wrap">${body}</div>
</body></html>`;
}

// ── Express app ────────────────────────────────────────────────
export function startAdminServer() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'admin') {
    console.warn('⚠️  ADMIN_WEB_PASSWORD is not set or is default "admin". Change it in .env!');
  }

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(expressSession({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 8 * 3600 * 1000 }, // 8h session
  }));

  // Auth middleware
  const requireLogin = (req, res, next) => {
    if (req.session?.admin) return next();
    res.redirect('/admin/login');
  };

  // ── Login ────────────────────────────────────────────────────
  app.get('/admin/login', (req, res) => {
    res.send(page('Login', `
      <div class="login-wrap">
        <div class="login-card">
          <h1>🤖 TorBox<span>Bot</span></h1>
          <p>Admin Panel — sign in to continue</p>
          ${req.query.err ? '<div class="err">❌ Incorrect username or password</div>' : ''}
          <form method="POST" action="/admin/login">
            <input type="text" name="username" placeholder="Username" autofocus required>
            <input type="password" name="password" placeholder="Password" required>
            <button class="btn" type="submit">Sign In</button>
          </form>
        </div>
      </div>`));
  });

  app.post('/admin/login', (req, res) => {
    if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) {
      req.session.admin = true;
      res.redirect('/admin');
    } else {
      res.redirect('/admin/login?err=1');
    }
  });

  app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin/login');
  });

  // ── Dashboard ────────────────────────────────────────────────
  app.get('/admin', requireLogin, (req, res) => {
    const stats = getStats();
    const recentDownloads = getAllTracked(10);

    const statsHtml = `
      <div class="stats">
        <div class="stat"><div class="stat-num">${stats.total_users}</div><div class="stat-label">Total Users</div></div>
        <div class="stat"><div class="stat-num" style="color:var(--green)">${stats.allowed_users}</div><div class="stat-label">Allowed Users</div></div>
        <div class="stat"><div class="stat-num">${stats.total_tracked}</div><div class="stat-label">Tracked Downloads</div></div>
        <div class="stat"><div class="stat-num" style="color:var(--yellow)">${stats.active_tracked}</div><div class="stat-label">In Progress</div></div>
        <div class="stat"><div class="stat-num" style="color:var(--green)">${stats.done_tracked}</div><div class="stat-label">Completed</div></div>
      </div>`;

    const downloadsHtml = recentDownloads.length ? `
      <div class="scroll">
      <table>
        <tr><th>Type</th><th>User</th><th>Name</th><th>Status</th><th>Done</th><th>Added</th></tr>
        ${recentDownloads.map(d => `
          <tr>
            <td>${{ torrent: '🧲', usenet: '📰', webdl: '🌐' }[d.type] || '📦'} ${d.type}</td>
            <td>${d.username ? `@${d.username}` : d.first_name || d.user_id}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(d.name || '—')}</td>
            <td><span class="badge ${d.is_done ? 'badge-green' : 'badge-yellow'}">${escHtml(d.last_status || 'pending')}</span></td>
            <td>${d.is_done ? '✅' : '⏳'}</td>
            <td style="color:var(--muted)">${d.created_at?.substring(0, 16) || '—'}</td>
          </tr>`).join('')}
      </table></div>` : '<div class="empty">No tracked downloads yet.</div>';

    res.send(page('Dashboard', `
      ${statsHtml}
      <div class="card"><h2>📥 Recent Downloads</h2>${downloadsHtml}</div>
    `, true));
  });

  // ── Users ────────────────────────────────────────────────────
  app.get('/admin/users', requireLogin, (req, res) => {
    const users = listAllowedUsers();
    const openMode = isOpenAccess();

    const usersHtml = users.length ? `
      <div class="scroll"><table>
        <tr><th>User ID</th><th>Username</th><th>Name</th><th>Plan</th><th>Added</th><th>Action</th></tr>
        ${users.map(u => `
          <tr>
            <td><code>${u.user_id}</code></td>
            <td>${u.username ? `@${escHtml(u.username)}` : '—'}</td>
            <td>${escHtml(u.first_name || '—')}</td>
            <td><span class="badge badge-purple">${PLAN_NAMES[u.plan] || (u.plan != null ? `Plan ${u.plan}` : '—')}</span></td>
            <td style="color:var(--muted)">${u.added_at?.substring(0, 10) || '—'}</td>
            <td>
              <form method="POST" action="/admin/users/remove" style="display:inline">
                <input type="hidden" name="user_id" value="${escHtml(u.user_id)}">
                <button class="btn btn-red" onclick="return confirm('Remove this user?')" style="padding:4px 10px;font-size:12px">Remove</button>
              </form>
            </td>
          </tr>`).join('')}
      </table></div>` : '<div class="empty">No allowed users yet.</div>';

    res.send(page('Users', `
      ${openMode ? '<div class="card" style="border-color:var(--yellow)"><h2>⚠️ Open Access Mode</h2><p style="color:var(--muted)">No users in whitelist — bot is open to everyone. Add a user below to enable access control.</p></div>' : ''}
      <div class="card">
        <h2>👥 Allowed Users (${users.length})</h2>
        <form method="POST" action="/admin/users/add" style="margin-bottom:16px">
          <input type="text" name="user_id" placeholder="Telegram User ID" required pattern="\\d+">
          <button class="btn" type="submit">➕ Add User</button>
        </form>
        ${usersHtml}
      </div>`, true));
  });

  app.post('/admin/users/add', requireLogin, (req, res) => {
    const { user_id } = req.body;
    if (user_id && /^\d+$/.test(user_id.trim())) {
      addAllowedUser(user_id.trim(), 'admin-panel');
    }
    res.redirect('/admin/users');
  });

  app.post('/admin/users/remove', requireLogin, (req, res) => {
    const { user_id } = req.body;
    if (user_id) removeAllowedUser(user_id.trim());
    res.redirect('/admin/users');
  });

  // ── Downloads ────────────────────────────────────────────────
  app.get('/admin/downloads', requireLogin, (req, res) => {
    const downloads = getAllTracked(100);

    const html = downloads.length ? `
      <div class="scroll"><table>
        <tr><th>Type</th><th>Item ID</th><th>User</th><th>Name</th><th>Status</th><th>Notified</th><th>Added</th></tr>
        ${downloads.map(d => `
          <tr>
            <td>${{ torrent: '🧲', usenet: '📰', webdl: '🌐' }[d.type] || '📦'} ${d.type}</td>
            <td><code>${d.item_id}</code></td>
            <td>${d.username ? `@${escHtml(d.username)}` : d.first_name || d.user_id}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(d.name || '')}">${escHtml(d.name || '—')}</td>
            <td><span class="badge ${d.is_done ? 'badge-green' : 'badge-yellow'}">${escHtml(d.last_status || 'tracking')}</span></td>
            <td>${d.notified_done ? '✅' : '⏳'}</td>
            <td style="color:var(--muted)">${d.created_at?.substring(0, 16) || '—'}</td>
          </tr>`).join('')}
      </table></div>` : '<div class="empty">No tracked downloads yet.</div>';

    res.send(page('Downloads', `
      <div class="card"><h2>📥 All Tracked Downloads (${downloads.length})</h2>${html}</div>
    `, true));
  });

  // Root redirect
  app.get('/', (req, res) => res.redirect('/admin'));

  // Health check
  app.get('/health', (req, res) => res.json({ ok: true }));

  app.listen(PORT, () => {
    console.log(`🌐 Admin panel running at http://localhost:${PORT}/admin`);
    console.log(`🔑 Admin password: ${ADMIN_PASSWORD === 'admin' ? '⚠️  DEFAULT (change ADMIN_WEB_PASSWORD)' : '✅ Set'}`);
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
