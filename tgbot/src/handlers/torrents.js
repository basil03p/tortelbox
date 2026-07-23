// ============================================================
// Handlers: Torrents — with plan gating + private DL links
// ============================================================
import { createApiClient, extractHashFromMagnet, isInfohash } from '../api.js';
import { getUserApiKey, getCachedPlan, checkPlanFeature, getPrivateChatId } from '../session.js';
import { trackDownload } from '../db.js';
import {
  formatBytes, formatSpeed, formatEta, formatDate, formatRatio,
  statusEmoji, progressBar, truncate, escapeMarkdown,
  paginate, paginationKeyboard,
} from '../utils.js';

const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '5', 10);

// ── List Torrents ─────────────────────────────────────────────
export async function handleTorrentList(bot, msg, page = 0) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '⏳ Fetching your torrent list…');

  try {
    const api = createApiClient(apiKey);
    const data = await api.getTorrentList();
    const torrents = data?.data || [];

    if (!torrents.length) {
      await bot.editMessageText('📭 No torrents found.\n\nSend a magnet link or .torrent file to add one.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const { items, page: p, totalPages, total } = paginate(torrents, page, PAGE_SIZE);

    let text = `📦 *Torrents* — Page ${p + 1}/${totalPages} \\(${total} total\\)\n\n`;
    const rowBtns = [];

    for (const t of items) {
      const pct = t.progress != null ? t.progress * 100 : 0;
      const status = t.download_state || t.status || 'unknown';
      const name = truncate(t.name, 30);
      const size = formatBytes(t.size);
      const isCached = status.toLowerCase().includes('cached') || status.toLowerCase().includes('complete');

      text += `${statusEmoji(status)} *${escapeMarkdown(name)}*\n`;
      text += `  🆔 \`${t.id}\` \\| ${escapeMarkdown(status)} \\| ${escapeMarkdown(size)}\n`;
      text += `  ${progressBar(pct)}\n`;
      if (t.download_speed) text += `  ⬇ ${escapeMarkdown(formatSpeed(t.download_speed))}`;
      if (t.eta) text += ` \\| ⏱ ${escapeMarkdown(formatEta(t.eta))}`;
      if (t.download_speed || t.eta) text += '\n';
      text += '\n';

      rowBtns.push([
        { text: `${isCached ? '⚡' : statusEmoji(status)} ${truncate(t.name, 20)}`, callback_data: `torrent_info:${t.id}` },
      ]);
    }

    const keyboard = paginationKeyboard('torrent_list', p, totalPages);
    keyboard.inline_keyboard = [...keyboard.inline_keyboard, ...rowBtns,
      [{ text: '🔄 Refresh', callback_data: `torrent_list:${p}` }]
    ];

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id,
      parse_mode: 'MarkdownV2', reply_markup: keyboard,
    });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Torrent Detail ────────────────────────────────────────────
export async function handleTorrentInfo(bot, chatId, torrentId, userId) {
  const apiKey = getUserApiKey(userId);
  try {
    const api = createApiClient(apiKey);
    const data = await api.getTorrentById(torrentId);
    const items = data?.data;
    const t = Array.isArray(items)
      ? items.find((x) => String(x.id) === String(torrentId))
      : items;

    if (!t) { await bot.sendMessage(chatId, '❌ Torrent not found.'); return; }

    const status = t.download_state || t.status || 'unknown';
    const pct = t.progress != null ? t.progress * 100 : 0;
    const files = Array.isArray(t.files) ? t.files : [];
    const isReady = pct >= 100 || status.toLowerCase().includes('complete') || status.toLowerCase().includes('cached') || status.toLowerCase().includes('seed');

    let text = `📋 *${escapeMarkdown(t.name)}*\n\n`;
    text += `🆔 ID: \`${t.id}\`\n`;
    text += `${statusEmoji(status)} Status: \`${escapeMarkdown(status)}\`\n`;
    text += `📦 Size: \`${formatBytes(t.size)}\`\n`;
    text += `${progressBar(pct)}\n`;
    if (t.download_speed) text += `⬇ Speed: \`${escapeMarkdown(formatSpeed(t.download_speed))}\`\n`;
    if (t.upload_speed)   text += `⬆ Upload: \`${escapeMarkdown(formatSpeed(t.upload_speed))}\`\n`;
    if (t.eta)            text += `⏱ ETA: \`${escapeMarkdown(formatEta(t.eta))}\`\n`;
    if (t.ratio != null)  text += `⚖ Ratio: \`${formatRatio(t.ratio)}\`\n`;
    if (t.seeds != null)  text += `🌱 Seeds: \`${t.seeds}\`\n`;
    if (t.peers != null)  text += `👥 Peers: \`${t.peers}\`\n`;
    if (t.hash)           text += `🔑 Hash: \`${escapeMarkdown(t.hash)}\`\n`;
    if (t.created_at)     text += `📅 Added: \`${escapeMarkdown(formatDate(t.created_at))}\`\n`;
    if (t.airlocked)      text += `🔒 Airlocked: Yes\n`;
    if (files.length)     text += `\n📁 Files: ${files.length} file${files.length > 1 ? 's' : ''}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '⏸ Pause', callback_data: `torrent_ctrl:${t.id}:pause` },
          { text: '▶ Resume', callback_data: `torrent_ctrl:${t.id}:resume` },
          { text: '🔄 Reannounce', callback_data: `torrent_ctrl:${t.id}:reannounce` },
        ],
        ...(isReady ? [[{ text: '🔗 Get Download Link (private)', callback_data: `torrent_dl:${t.id}:zip` }]] : []),
        ...(isReady && files.length > 1 ? [[{ text: '📁 List Files', callback_data: `torrent_files:${t.id}` }]] : []),
        [
          { text: '🗑 Delete', callback_data: `torrent_del:${t.id}:confirm` },
          { text: '🔙 Back', callback_data: 'torrent_list:0' },
        ],
      ],
    };

    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${e}`);
  }
}

// ── List Files for a torrent ──────────────────────────────────
export async function handleTorrentFiles(bot, chatId, torrentId, userId) {
  const apiKey = getUserApiKey(userId);
  try {
    const api = createApiClient(apiKey);
    const data = await api.getTorrentById(torrentId);
    const items = data?.data;
    const t = Array.isArray(items) ? items.find((x) => String(x.id) === String(torrentId)) : items;
    const files = Array.isArray(t?.files) ? t.files : [];

    if (!files.length) {
      await bot.sendMessage(chatId, 'ℹ️ No individual file list available. Use zip link to get everything.');
      return;
    }

    let text = `📁 *Files in: ${escapeMarkdown(truncate(t.name, 40))}*\n\n`;
    const btns = [];

    files.slice(0, 15).forEach((f, i) => {
      const fname = truncate(f.name || f.short_name || `File ${i + 1}`, 35);
      const size = formatBytes(f.size);
      text += `${i + 1}\\. ${escapeMarkdown(fname)} \\(${escapeMarkdown(size)}\\)\n`;
      btns.push([{ text: `⬇ ${truncate(fname, 25)}`, callback_data: `torrent_dl:${torrentId}:${f.id}` }]);
    });

    if (files.length > 15) text += `\n_…and ${files.length - 15} more_`;
    btns.push([{ text: '📦 Download All (ZIP)', callback_data: `torrent_dl:${torrentId}:zip` }]);
    btns.push([{ text: '🔙 Back', callback_data: `torrent_info:${torrentId}` }]);

    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: btns } });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${e}`);
  }
}

// ── Get Download Link — ALWAYS sent as private DM ─────────────
export async function handleTorrentDl(bot, chatId, torrentId, fileIdOrZip, userId) {
  const apiKey = getUserApiKey(userId);
  const privateChatId = getPrivateChatId(userId);
  const isZip = fileIdOrZip === 'zip';
  const fileId = isZip ? null : fileIdOrZip;

  // Tell the user to check DMs if in group
  const notifyPublic = chatId !== userId && privateChatId && privateChatId !== chatId;
  if (notifyPublic) {
    await bot.sendMessage(chatId, `🔐 Sending your download link privately — check your DMs with me\\!`, { parse_mode: 'MarkdownV2' });
  }

  const targetChat = privateChatId || chatId;
  const loading = await bot.sendMessage(targetChat, '🔗 Generating your private download link…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.requestTorrentDl(Number(torrentId), fileId ? Number(fileId) : null, isZip);
    const link = result?.data;

    if (link && typeof link === 'string') {
      await bot.editMessageText(
        `🔗 *Your Download Link*\n\n` +
        `⚠️ _This link is for YOU only\\. Do not share it\\._\n\n` +
        `${link}\n\n` +
        `🕐 _Link expires after use or in ~1 hour_`,
        { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
      );
    } else {
      const reason = result?.detail || result?.error || 'Could not generate link';
      await bot.editMessageText(`❌ ${escapeMarkdown(reason)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeMarkdown(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  }
}

// ── Control Torrent ───────────────────────────────────────────
export async function handleTorrentControl(bot, chatId, torrentId, operation, userId) {
  const apiKey = getUserApiKey(userId);
  const opEmoji = { pause: '⏸', resume: '▶️', reannounce: '🔄', delete: '🗑' };
  const loading = await bot.sendMessage(chatId, `${opEmoji[operation] || '⚙️'} Sending \`${operation}\`…`, { parse_mode: 'Markdown' });

  try {
    const api = createApiClient(apiKey);
    const result = await api.controlTorrent(Number(torrentId), operation);
    const ok = result?.success;
    const msg = result?.detail || result?.data || (ok ? 'Done!' : 'Failed.');
    await bot.editMessageText(`${ok ? '✅' : '❌'} ${escapeMarkdown(String(msg))}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Delete Torrent ────────────────────────────────────────────
export async function handleTorrentDelete(bot, chatId, torrentId, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🗑 Deleting torrent \`${torrentId}\`…`, { parse_mode: 'Markdown' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlTorrent(Number(torrentId), 'delete');
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅ Deleted\\.' : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Add Magnet ────────────────────────────────────────────────
export async function handleAddMagnet(bot, chatId, magnet, userId) {
  const apiKey = getUserApiKey(userId);
  const plan = getCachedPlan(userId);

  // Check if torrent is cached first for Free users
  if (plan === 0) {
    const hash = extractHashFromMagnet(magnet);
    if (hash) {
      const loading = await bot.sendMessage(chatId, '🆓 Free plan: Checking if torrent is cached…');
      try {
        const api = createApiClient(apiKey);
        const cacheResult = await api.checkCachedTorrent(hash);
        const cached = cacheResult?.data;
        const isCached = (Array.isArray(cached) && cached.length > 0) ||
          (cached && typeof cached === 'object' && Object.keys(cached).length > 0);

        if (!isCached) {
          await bot.editMessageText(
            `🚫 *Free Plan Restriction*\n\nThis torrent is *not cached* on TorBox\\.\n\n` +
            `Free users can only add ⚡ cached torrents\\.\n` +
            `Upgrade to Essential or higher: https://torbox\\.app/subscription`,
            { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
          );
          return;
        }
        await bot.editMessageText('⚡ Cached\\! Adding torrent…', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
      } catch (_) { /* ignore cache check errors, let TorBox decide */ }
    }
  }

  const loading2 = await bot.sendMessage(chatId, '🧲 Adding magnet link…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createTorrent({ magnet });
    const ok = result?.success;
    const name = result?.data?.name || result?.data?.hash || '(new torrent)';
    const torrentId = result?.data?.torrent_id || result?.data?.id;
    if (ok && torrentId) trackDownload(userId, torrentId, 'torrent', name);
    await bot.editMessageText(
      ok
        ? `✅ Torrent added\\!\n📋 *${escapeMarkdown(name)}*\n\n🔄 _I will notify you when it's ready to download\\._`
        : `❌ ${escapeMarkdown(result?.detail || 'Failed')}`,
      { chat_id: chatId, message_id: loading2.message_id, parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading2.message_id });
  }
}

// ── Add Cached Only (/addcached) ──────────────────────────────
export async function handleAddCached(bot, chatId, input, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '⚡ Checking cache status…');

  // Extract hash from magnet or use raw hash
  let hash = isInfohash(input) ? input.toUpperCase() : extractHashFromMagnet(input);
  const magnet = input.startsWith('magnet:') ? input : null;

  if (!hash) {
    await bot.editMessageText('❌ Invalid input\\. Send a magnet link or a 40\\-char infohash\\.', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
    return;
  }

  try {
    const api = createApiClient(apiKey);
    const cacheResult = await api.checkCachedTorrent(hash);
    const cached = cacheResult?.data;
    const isCached = (Array.isArray(cached) && cached.length > 0) ||
      (cached && typeof cached === 'object' && Object.keys(cached).length > 0);

    if (!isCached) {
      await bot.editMessageText(
        `❌ *Not Cached*\n\nHash \`${escapeMarkdown(hash)}\` is not available on TorBox\\'s cache\\.\n\n` +
        `It would need to be downloaded from scratch \\(requires Essential plan\\)\\.\n\n` +
        `💡 Tip: Try a different release or check later\\.`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
      );
      return;
    }

    await bot.editMessageText('⚡ *Cached\\!* Adding to your TorBox…', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });

    // Add with add_only_if_cached as safety net
    const addMagnet = magnet || `magnet:?xt=urn:btih:${hash}`;
    const result = await api.createTorrent({ magnet: addMagnet, addOnlyIfCached: true });
    const ok = result?.success;
    const name = result?.data?.name || result?.data?.hash || hash;

    await bot.editMessageText(
      ok
        ? `✅ *Added from cache\\!*\n📋 ${escapeMarkdown(name)}\n\n⚡ No waiting — content is already cached on TorBox\\.`
        : `❌ ${escapeMarkdown(result?.detail || 'Failed to add')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Check Cached ──────────────────────────────────────────────
export async function handleCheckCached(bot, chatId, input, userId) {
  const apiKey = getUserApiKey(userId);
  const hash = isInfohash(input) ? input.toUpperCase() : extractHashFromMagnet(input);

  if (!hash) {
    await bot.sendMessage(chatId, '❌ Invalid input\\. Send a 40\\-char infohash or magnet link\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const loading = await bot.sendMessage(chatId, '🔍 Checking TorBox cache…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.checkCachedTorrent(hash);
    const cached = result?.data;
    const isCached = (Array.isArray(cached) && cached.length > 0) ||
      (cached && typeof cached === 'object' && Object.keys(cached).length > 0);

    let text = `🔍 *Cache Check*\n\nHash: \`${escapeMarkdown(hash)}\`\n\n`;
    if (isCached) {
      const fileCount = Array.isArray(cached) ? cached.length : Object.keys(cached).length;
      text += `⚡ *CACHED* — Instantly available\\!\n`;
      if (fileCount) text += `📁 ${fileCount} file${fileCount > 1 ? 's' : ''} available\n`;
      text += `\n_This torrent can be added from cache\\._`;
    } else {
      text += `❌ *NOT CACHED*\n\n_This torrent needs to be downloaded from scratch\\._\n`;
      text += `_\\(Requires Essential plan or higher\\)_`;
    }

    const keyboard = isCached ? {
      inline_keyboard: [[{ text: '⚡ Add from Cache', callback_data: `addcached:${hash}` }]],
    } : undefined;

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id,
      parse_mode: 'MarkdownV2', reply_markup: keyboard,
    });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// ── Add .torrent file ─────────────────────────────────────────
export async function handleAddTorrentFile(bot, chatId, fileBuffer, fileName, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📤 Uploading torrent to TorBox…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createTorrent({ file: { data: fileBuffer, name: fileName } });
    const ok = result?.success;
    const name = result?.data?.name || result?.data?.hash || fileName;
    const torrentId = result?.data?.torrent_id || result?.data?.id;
    if (ok && torrentId) trackDownload(userId, torrentId, 'torrent', name);
    await bot.editMessageText(
      ok ? `✅ Torrent added\\!\n📋 *${escapeMarkdown(name)}*\n\n🔄 _I will notify you when it's ready to download\\._` : `❌ ${escapeMarkdown(result?.detail || 'Failed')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}
