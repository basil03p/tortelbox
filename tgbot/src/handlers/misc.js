// ============================================================
// Handlers: Search, Notifications, Queued, RSS — with plan gates
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey, getCachedPlan, checkPlanFeature } from '../session.js';
import {
  formatBytes, formatDate, truncate, escapeMarkdown,
  paginate, paginationKeyboard,
} from '../utils.js';

const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '5', 10);

// ── Search ────────────────────────────────────────────────────
export async function handleSearch(bot, chatId, query, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🔍 Searching for: *${escapeMarkdown(query)}*…`, { parse_mode: 'MarkdownV2' });

  try {
    const api = createApiClient(apiKey);
    const result = await api.search(query);
    const results = result?.data || [];

    if (!results.length) {
      await bot.editMessageText('📭 No results found\\. Try different keywords\\.', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
      return;
    }

    const { items, page: p, totalPages, total } = paginate(results, 0, PAGE_SIZE);
    let text = `🔍 *"${escapeMarkdown(query)}"* — ${total} results\n\n`;

    for (const r of items) {
      const name  = truncate(r.name || r.title || '—', 40);
      const size  = r.size ? formatBytes(r.size) : '—';
      const seeds = r.seeds  != null ? ` 🌱${r.seeds}` : '';
      const peers = r.peers  != null ? ` 👥${r.peers}` : '';
      const type  = r.type   || r.category || '';
      const cached = r.cached ? ' ⚡' : '';

      text += `${cached}📄 *${escapeMarkdown(name)}*\n`;
      if (type) text += `  📂 ${escapeMarkdown(type)} \\| `;
      else text += `  `;
      text += `📦 ${escapeMarkdown(size)}${escapeMarkdown(seeds)}${escapeMarkdown(peers)}\n`;
      if (r.magnet) {
        const shortHash = r.magnet.match(/btih:([a-fA-F0-9]+)/i)?.[1]?.substring(0, 12) || '…';
        text += `  🔑 \`${escapeMarkdown(shortHash)}…\`\n`;
      }
      text += '\n';
    }

    if (totalPages > 1) {
      text += `_Page 1 of ${totalPages} — use /search again to see more_`;
    }

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id,
      parse_mode: 'MarkdownV2',
    });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ Search failed: ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Notifications — Essential+ ────────────────────────────────
export async function handleNotifications(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  const plan = getCachedPlan(userId);
  const planErr = checkPlanFeature(plan, 'notifications');
  if (planErr) { await bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '🔔 Fetching notifications…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getNotifications();
    const notifs = result?.data || [];

    if (!notifs.length) {
      await bot.editMessageText('🔕 No notifications\\.', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
      return;
    }

    const list = notifs.slice(0, 10);
    let text = `🔔 *Notifications* \\(${list.length} of ${notifs.length}\\)\n\n`;
    for (const n of list) {
      const title = truncate(n.title || n.message || 'Notification', 40);
      const date  = formatDate(n.created_at || n.timestamp);
      const read  = n.read ? '✅' : '🔵';
      text += `${read} *${escapeMarkdown(title)}*\n`;
      if (n.body || n.detail) text += `  ${escapeMarkdown(truncate(n.body || n.detail, 60))}\n`;
      text += `  📅 ${escapeMarkdown(date)}\n\n`;
    }

    const keyboard = { inline_keyboard: [[{ text: '🗑 Clear All', callback_data: 'notif_clear' }]] };
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

export async function handleClearNotifications(bot, chatId, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '🗑 Clearing notifications…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.clearNotifications();
    const ok = result?.success;
    await bot.editMessageText(ok ? '✅ Notifications cleared\\.' : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Queued items ──────────────────────────────────────────────
export async function handleQueued(bot, msg, type = 'torrent') {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  // Non-torrent queues need Essential+
  if (type !== 'torrent') {
    const plan = getCachedPlan(userId);
    const feature = type === 'usenet' ? 'usenet' : 'webdl';
    const planErr = checkPlanFeature(plan, feature);
    if (planErr) { await bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }
  }

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `⏳ Fetching queued ${type}s…`);

  try {
    const api = createApiClient(apiKey);
    const result = await api.getQueued(type);
    const items = result?.data || [];

    if (!items.length) {
      await bot.editMessageText(`📭 No queued ${type}s\\.`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
      return;
    }

    let text = `🔜 *Queued ${type.charAt(0).toUpperCase() + type.slice(1)}s* \\(${items.length}\\)\n\n`;
    for (const q of items.slice(0, 10)) {
      const name = truncate(q.name || q.hash || '—', 35);
      text += `📋 *${escapeMarkdown(name)}*\n`;
      text += `  🆔 \`${q.id}\` \\| ⏳ Pos: ${q.queue_position ?? '—'}\n\n`;
    }

    const plan = getCachedPlan(userId);
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🧲 Torrents', callback_data: 'queued:torrent' },
          ...(plan === null || plan >= 1 ? [{ text: '📰 Usenet', callback_data: 'queued:usenet' }] : []),
          ...(plan === null || plan >= 1 ? [{ text: '🌐 WebDL',  callback_data: 'queued:webdl'  }] : []),
        ],
      ],
    };

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── RSS — Essential+ ──────────────────────────────────────────
export async function handleRssFeeds(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;

  const plan = getCachedPlan(userId);
  const planErr = checkPlanFeature(plan, 'rss');
  if (planErr) { await bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📡 Fetching RSS feeds…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.getRssFeeds();
    const feeds = result?.data || [];

    if (!feeds.length) {
      await bot.editMessageText('📭 No RSS feeds added\\.\n\nUse `/addrss <URL>` to add one\\.', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
      return;
    }

    let text = `📡 *RSS Feeds* \\(${feeds.length}\\)\n\n`;
    const rowBtns = [];

    for (const f of feeds) {
      const name   = truncate(f.name || f.url || '—', 35);
      const active = f.active !== false;
      text += `${active ? '🟢' : '⏸'} *${escapeMarkdown(name)}*\n`;
      text += `  🆔 \`${f.id}\`\n`;
      if (f.url) text += `  🔗 \`${escapeMarkdown(truncate(f.url, 50))}\`\n`;
      text += '\n';
      rowBtns.push([
        { text: `${active ? '⏸ Pause' : '▶ Resume'}`, callback_data: `rss_ctrl:${f.id}:${active ? 'pause' : 'resume'}` },
        { text: '🗑 Delete', callback_data: `rss_ctrl:${f.id}:delete` },
      ]);
    }

    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: rowBtns } });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

export async function handleAddRss(bot, chatId, url, userId) {
  const plan = getCachedPlan(userId);
  const planErr = checkPlanFeature(plan, 'rss');
  if (planErr) { await bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📡 Adding RSS feed…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.addRssFeed(url);
    const ok = result?.success;
    await bot.editMessageText(ok ? '✅ RSS feed added\\!' : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

export async function handleRssControl(bot, chatId, feedId, operation, userId) {
  const plan = getCachedPlan(userId);
  const planErr = checkPlanFeature(plan, 'rss');
  if (planErr) { await bot.sendMessage(chatId, planErr, { parse_mode: 'MarkdownV2' }); return; }

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `⚙️ ${operation} RSS feed…`);
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlRssFeed(Number(feedId), operation);
    const ok = result?.success;
    await bot.editMessageText(ok ? '✅ Done\\!' : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}
