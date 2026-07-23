// ============================================================
// Handlers: User Account, Stats, API key — sets plan cache
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey, setUserApiKey, setCachedPlan, getCachedPlan } from '../session.js';
import { formatBytes, formatDate, escapeMarkdown } from '../utils.js';

const PLAN_NAMES  = { 0: '🆓 Free', 1: '🥈 Essential', 2: '🥇 Pro', 3: '💎 Ultimate' };
const PLAN_LIMITS = {
  0: 'Torrents \\(cached only\\) \\| 1 slot \\| 10 downloads/mo \\| 10 GB max',
  1: 'Torrents \\+ Usenet \\+ WebDL \\+ RSS \\| 3 slots \\| Unlimited \\| 200 GB max',
  2: 'Everything \\| 10 slots \\| Unlimited \\| 1 TB max',
  3: 'Everything \\+ Priority \\| Unlimited slots',
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

    // Cache the plan so feature gates work immediately
    if (u.plan != null) setCachedPlan(userId, u.plan);

    const plan = u.plan ?? null;
    const planLabel = PLAN_NAMES[plan] || `Plan ${plan}`;
    const limits = PLAN_LIMITS[plan] || '';

    let text = `👤 *Your TorBox Account*\n\n`;
    text += `📧 Email: \`${escapeMarkdown(u.email || '—')}\`\n`;
    text += `🆔 Auth ID: \`${escapeMarkdown(u.auth_id || '—')}\`\n`;
    text += `🏷 Plan: *${planLabel}*\n`;
    text += `📋 Subscription: ${u.is_subscribed ? '✅ Active' : '❌ Inactive'}\n`;
    if (limits) text += `🎛 Limits: ${limits}\n`;
    if (u.expiration) text += `⏰ Expires: \`${escapeMarkdown(formatDate(u.expiration))}\`\n`;
    if (u.total_downloaded != null) text += `⬇ Downloaded: \`${escapeMarkdown(formatBytes(u.total_downloaded))}\`\n`;
    if (u.created_at) text += `📅 Member since: \`${escapeMarkdown(formatDate(u.created_at))}\`\n`;

    // Show what's enabled for their plan
    text += `\n*🔓 Your plan includes:*\n`;
    text += `✅ Torrents ${plan === 0 ? '\\(cached only\\)' : ''}\n`;
    text += `${plan >= 1 ? '✅' : '❌'} Usenet downloads\n`;
    text += `${plan >= 1 ? '✅' : '❌'} Web downloads\n`;
    text += `${plan >= 1 ? '✅' : '❌'} RSS feeds\n`;
    text += `${plan >= 2 ? '✅' : plan >= 1 ? '✅ \\(basic\\)' : '❌'} Notifications\n`;

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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

    let text = `📊 *Your TorBox Stats*\n\n`;
    if (s.torrents_downloaded != null) text += `🧲 Torrents Downloaded: \`${s.torrents_downloaded}\`\n`;
    if (s.usenet_downloaded  != null) text += `📰 Usenet Downloaded: \`${s.usenet_downloaded}\`\n`;
    if (s.web_downloaded     != null) text += `🌐 Web Downloaded: \`${s.web_downloaded}\`\n`;
    if (s.total_bytes_downloaded != null) text += `📦 Total Data: \`${escapeMarkdown(formatBytes(s.total_bytes_downloaded))}\`\n`;
    if (s.total_bytes_uploaded   != null) text += `⬆ Uploaded: \`${escapeMarkdown(formatBytes(s.total_bytes_uploaded))}\`\n`;
    if (s.seeds_participated     != null) text += `🌱 Seeds Participated: \`${s.seeds_participated}\`\n`;
    if (s.cached_hit             != null) text += `⚡ Cache Hits: \`${s.cached_hit}\`\n`;

    if (text === `📊 *Your TorBox Stats*\n\n`) {
      text += `\`\`\`\n${JSON.stringify(s, null, 2).substring(0, 600)}\n\`\`\``;
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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
    let text = `💳 *Subscriptions*\n\n`;
    for (const sub of list) {
      const planNum = sub.plan ?? sub.type;
      const planLabel = PLAN_NAMES[planNum] || String(planNum || '—');
      text += `🏷 Plan: *${planLabel}*\n`;
      if (sub.status) text += `📋 Status: \`${escapeMarkdown(sub.status)}\`\n`;
      if (sub.expiration || sub.expires_at) text += `⏰ Expires: \`${escapeMarkdown(formatDate(sub.expiration || sub.expires_at))}\`\n`;
      if (sub.created_at) text += `📅 Started: \`${escapeMarkdown(formatDate(sub.created_at))}\`\n`;
      text += '\n';
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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
    let text = `📜 *Recent Transactions* \\(last ${list.length}\\)\n\n`;
    for (const t of list) {
      const amount = t.amount != null ? `$${Number(t.amount).toFixed(2)}` : '—';
      const type = t.type || t.transaction_type || '—';
      const date = formatDate(t.created_at || t.date);
      text += `💰 \`${escapeMarkdown(amount)}\` — ${escapeMarkdown(type)}\n`;
      text += `   📅 ${escapeMarkdown(date)}\n\n`;
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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

    let text = `🌐 *TorBox Global Stats*\n\n`;
    if (s.total_users   != null) text += `👥 Total Users: \`${s.total_users.toLocaleString()}\`\n`;
    if (s.active_users  != null) text += `🟢 Active Users: \`${s.active_users.toLocaleString()}\`\n`;
    if (s.total_torrents != null) text += `🧲 Total Torrents: \`${s.total_torrents.toLocaleString()}\`\n`;
    if (s.total_bytes   != null) text += `📦 Total Data: \`${escapeMarkdown(formatBytes(s.total_bytes))}\`\n`;
    if (s.total_files   != null) text += `📁 Total Files: \`${s.total_files.toLocaleString()}\`\n`;
    if (text === `🌐 *TorBox Global Stats*\n\n`) {
      text += `\`\`\`\n${JSON.stringify(s, null, 2).substring(0, 600)}\n\`\`\``;
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Set API Key — validates + caches plan immediately ─────────
export async function handleSetKey(bot, msg, newKey) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  if (!newKey || newKey.trim().length < 10) {
    await bot.sendMessage(chatId, '❌ Invalid API key\\. Usage: `/setkey YOUR_API_KEY`', { parse_mode: 'MarkdownV2' });
    return;
  }

  const loading = await bot.sendMessage(chatId, '🔑 Validating API key…');
  try {
    const api = createApiClient(newKey.trim());
    const result = await api.getMe();
    if (result?.success) {
      setUserApiKey(userId, newKey.trim());
      const u = result?.data;
      // Immediately cache the plan
      if (u?.plan != null) setCachedPlan(userId, u.plan);
      const plan = u?.plan ?? null;
      const planLabel = PLAN_NAMES[plan] || `Plan ${plan}`;
      const email = u?.email || '—';
      await bot.editMessageText(
        `✅ *API key saved\\!*\n\n` +
        `👤 Account: \`${escapeMarkdown(email)}\`\n` +
        `🏷 Plan: *${planLabel}*\n\n` +
        `_Your plan features are now unlocked\\._`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
      );
    } else {
      await bot.editMessageText(
        `❌ Key rejected: ${escapeMarkdown(result?.detail || 'Invalid key')}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
      );
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}
