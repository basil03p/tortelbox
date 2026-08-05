// ============================================================
// Handlers: User Account, Stats, API key — HTML formatted
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey, setUserApiKey, setCachedPlan, getCachedPlan } from '../session.js';
import { formatBytes, formatDate, escapeHtml } from '../utils.js';

const PLAN_NAMES = { 0: '🆓 Free', 1: '🥈 Essential', 2: '🥇 Pro', 3: '💎 Ultimate' };
const PLAN_LIMITS = {
  0: 'Torrents (cached only) | 1 slot | 10 downloads/mo | 10 GB max',
  1: 'Torrents + Usenet + WebDL + RSS | 3 slots | Unlimited | 200 GB max',
  2: 'Everything | 10 slots | Unlimited | 1 TB max',
  3: 'Everything + Priority | Unlimited slots',
};

export async function handleMe(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '👤 Fetching your profile…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getMe();
    const u = result?.data;

    if (!u) {
      await bot.editMessageText('❌ Could not fetch profile.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    if (u.plan != null) setCachedPlan(userId, u.plan);

    const plan = u.plan ?? null;
    const planLabel = PLAN_NAMES[plan] || `Plan ${plan}`;
    const limits = PLAN_LIMITS[plan] || '';

    let text = `👤 <b>Your TorBox Account</b>\n\n`;
    text += `📧 Email: <code>${escapeHtml(u.email || '—')}</code>\n`;
    text += `🆔 Auth ID: <code>${escapeHtml(u.auth_id || '—')}</code>\n`;
    text += `🏷 Plan: <b>${escapeHtml(planLabel)}</b>\n`;
    text += `📋 Subscription: ${u.is_subscribed ? '✅ Active' : '❌ Inactive'}\n`;
    if (limits) text += `🎛 Limits: ${escapeHtml(limits)}\n`;
    if (u.expiration) text += `⏰ Expires: <code>${escapeHtml(formatDate(u.expiration))}</code>\n`;
    if (u.total_downloaded != null) text += `⬇ Downloaded: <code>${escapeHtml(formatBytes(u.total_downloaded))}</code>\n`;
    if (u.created_at) text += `📅 Member since: <code>${escapeHtml(formatDate(u.created_at))}</code>\n`;

    text += `\n<b>🔓 Your plan includes:</b>\n`;
    text += `✅ Torrents ${plan === 0 ? '(cached only)' : ''}\n`;
    text += `${plan >= 1 ? '✅' : '❌'} Usenet downloads\n`;
    text += `${plan >= 1 ? '✅' : '❌'} Web downloads & Debrid\n`;
    text += `${plan >= 1 ? '✅' : '❌'} RSS feeds\n`;
    text += `${plan >= 1 ? '✅' : '❌'} Notifications\n`;

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleStats(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📊 Fetching stats…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getStats();
    const s = result?.data;

    if (!s) {
      await bot.editMessageText('❌ Could not fetch stats.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    let text = `📊 <b>Your TorBox Stats</b>\n\n`;
    if (s.torrents_downloaded != null) text += `🧲 Torrents Downloaded: <code>${s.torrents_downloaded}</code>\n`;
    if (s.usenet_downloaded  != null) text += `📰 Usenet Downloaded: <code>${s.usenet_downloaded}</code>\n`;
    if (s.web_downloaded     != null) text += `🌐 Web Downloaded: <code>${s.web_downloaded}</code>\n`;
    if (s.total_bytes_downloaded != null) text += `📦 Total Data: <code>${escapeHtml(formatBytes(s.total_bytes_downloaded))}</code>\n`;
    if (s.total_bytes_uploaded   != null) text += `⬆ Uploaded: <code>${escapeHtml(formatBytes(s.total_bytes_uploaded))}</code>\n`;
    if (s.seeds_participated     != null) text += `🌱 Seeds Participated: <code>${s.seeds_participated}</code>\n`;
    if (s.cached_hit             != null) text += `⚡ Cache Hits: <code>${s.cached_hit}</code>\n`;

    if (text === `📊 <b>Your TorBox Stats</b>\n\n`) {
      text += `<pre>${escapeHtml(JSON.stringify(s, null, 2).substring(0, 600))}</pre>`;
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleSubscriptions(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '💳 Fetching subscriptions…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getSubscriptions();
    const subs = result?.data;

    if (!subs || (Array.isArray(subs) && !subs.length)) {
      await bot.editMessageText('📭 No subscriptions found.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const list = Array.isArray(subs) ? subs : [subs];
    let text = `💳 <b>Subscriptions</b>\n\n`;
    for (const sub of list) {
      const planNum = sub.plan ?? sub.type ?? sub.plan_id;
      const planNameStr = sub.plan_name || sub.name || sub.title;
      const planLabel = planNameStr || PLAN_NAMES[planNum] || (planNum != null ? `Plan ${planNum}` : 'Standard Subscription');
      text += `🏷 Plan: <b>${escapeHtml(planLabel)}</b>\n`;
      if (sub.status) text += `📋 Status: <code>${escapeHtml(sub.status)}</code>\n`;
      if (sub.expiration || sub.expires_at) text += `⏰ Expires: <code>${escapeHtml(formatDate(sub.expiration || sub.expires_at))}</code>\n`;
      if (sub.created_at) text += `📅 Started: <code>${escapeHtml(formatDate(sub.created_at))}</code>\n`;
      text += '\n';
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleTransactions(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📜 Fetching transactions…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getTransactions();
    const txns = result?.data;

    if (!txns || (Array.isArray(txns) && !txns.length)) {
      await bot.editMessageText('📭 No transactions found.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const list = (Array.isArray(txns) ? txns : [txns]).slice(0, 10);
    let text = `📜 <b>Recent Transactions</b> (last ${list.length})\n\n`;
    for (const t of list) {
      const amount = t.amount != null ? `$${Number(t.amount).toFixed(2)}` : '—';
      const type = t.type || t.transaction_type || '—';
      const date = formatDate(t.created_at || t.date);
      text += `💰 <code>${escapeHtml(amount)}</code> — ${escapeHtml(type)}\n`;
      text += `   📅 ${escapeHtml(date)}\n\n`;
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleGlobalStats(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '🌐 Fetching TorBox global stats…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getGeneralStats();
    const s = result?.data;

    if (!s) {
      await bot.editMessageText('❌ Could not fetch stats.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    let text = `🌐 <b>TorBox Global Stats</b>\n\n`;
    if (s.total_users   != null) text += `👥 Total Users: <code>${s.total_users.toLocaleString()}</code>\n`;
    if (s.active_users  != null) text += `🟢 Active Users: <code>${s.active_users.toLocaleString()}</code>\n`;
    if (s.total_torrents != null) text += `🧲 Total Torrents: <code>${s.total_torrents.toLocaleString()}</code>\n`;
    if (s.total_bytes   != null) text += `📦 Total Data: <code>${escapeHtml(formatBytes(s.total_bytes))}</code>\n`;
    if (s.total_files   != null) text += `📁 Total Files: <code>${s.total_files.toLocaleString()}</code>\n`;
    if (text === `🌐 <b>TorBox Global Stats</b>\n\n`) {
      text += `<pre>${escapeHtml(JSON.stringify(s, null, 2).substring(0, 600))}</pre>`;
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleSetKey(bot, msg, newKey) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (!newKey || newKey.trim().length < 10) {
    await bot.sendMessage(chatId, '❌ Invalid API key. Usage: <code>/setkey YOUR_API_KEY</code>', { parse_mode: 'HTML' });
    return;
  }

  const loading = await bot.sendMessage(chatId, '🔑 Validating API key…');
  try {
    const api = createApiClient(newKey.trim());
    const result = await api.getMe();
    if (result?.success) {
      setUserApiKey(userId, newKey.trim());
      const u = result?.data;
      if (u?.plan != null) setCachedPlan(userId, u.plan);
      const plan = u?.plan ?? null;
      const planLabel = PLAN_NAMES[plan] || `Plan ${plan}`;
      const email = u?.email || '—';
      await bot.editMessageText(
        `✅ <b>API key saved!</b>\n\n` +
        `👤 Account: <code>${escapeHtml(email)}</code>\n` +
        `🏷 Plan: <b>${escapeHtml(planLabel)}</b>\n\n` +
        `<i>Your plan features are now unlocked.</i>`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
      );
    } else {
      await bot.editMessageText(
        `❌ Key rejected: ${escapeHtml(result?.detail || 'Invalid key')}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}
