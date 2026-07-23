// ============================================================
// Handlers: Torrents — with plan gating + private DL links + HTML formatting
// ============================================================
import { createApiClient, extractHashFromMagnet, isInfohash } from '../api.js';
import { getUserApiKey, getCachedPlan, checkPlanFeature, getPrivateChatId } from '../session.js';
import { trackDownload } from '../db.js';
import {
  formatBytes, formatSpeed, formatEta, formatDate, formatRatio,
  statusEmoji, progressBar, truncate, escapeHtml,
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

    // Auto-track all torrents in DB so /mydownloads and /getlink work instantly
    for (const t of torrents) {
      if (t.id) trackDownload(userId, t.id, 'torrent', t.name);
    }

    const { items, page: p, totalPages, total } = paginate(torrents, page, PAGE_SIZE);

    let text = `<b>📦 Torrents</b> — Page ${p + 1}/${totalPages} (${total} total)\n\n`;
    const rowBtns = [];

    for (const t of items) {
      const pct = t.progress != null ? t.progress * 100 : 0;
      const status = t.download_state || t.status || 'unknown';
      const name = truncate(t.name, 35);
      const size = formatBytes(t.size);
      const isCached = status.toLowerCase().includes('cached') || status.toLowerCase().includes('complete');

      text += `${statusEmoji(status)} <b>${escapeHtml(name)}</b>\n`;
      text += `  🆔 <code>${t.id}</code> | ${escapeHtml(status)} | ${escapeHtml(size)}\n`;
      text += `  <code>${progressBar(pct)}</code>\n`;
      if (t.download_speed) text += `  ⬇ ${escapeHtml(formatSpeed(t.download_speed))}`;
      if (t.eta) text += ` | ⏱ ${escapeHtml(formatEta(t.eta))}`;
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
      parse_mode: 'HTML', reply_markup: keyboard,
    });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
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

    let text = `📋 <b>${escapeHtml(t.name)}</b>\n\n`;
    text += `🆔 ID: <code>${t.id}</code>\n`;
    text += `${statusEmoji(status)} Status: <code>${escapeHtml(status)}</code>\n`;
    text += `📦 Size: <code>${escapeHtml(formatBytes(t.size))}</code>\n`;
    text += `<code>${progressBar(pct)}</code>\n`;
    if (t.download_speed) text += `⬇ Speed: <code>${escapeHtml(formatSpeed(t.download_speed))}</code>\n`;
    if (t.upload_speed)   text += `⬆ Upload: <code>${escapeHtml(formatSpeed(t.upload_speed))}</code>\n`;
    if (t.eta)            text += `⏱ ETA: <code>${escapeHtml(formatEta(t.eta))}</code>\n`;
    if (t.ratio != null)  text += `⚖ Ratio: <code>${formatRatio(t.ratio)}</code>\n`;
    if (t.seeds != null)  text += `🌱 Seeds: <code>${t.seeds}</code>\n`;
    if (t.peers != null)  text += `👥 Peers: <code>${t.peers}</code>\n`;
    if (t.hash)           text += `🔑 Hash: <code>${escapeHtml(t.hash)}</code>\n`;
    if (t.created_at)     text += `📅 Added: <code>${escapeHtml(formatDate(t.created_at))}</code>\n`;
    if (t.airlocked)      text += `🔒 Airlocked: Yes\n`;
    if (files.length)     text += `\n📁 Files: ${files.length} file${files.length > 1 ? 's' : ''}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '⏸ Pause', callback_data: `torrent_ctrl:${t.id}:pause` },
          { text: '▶ Resume', callback_data: `torrent_ctrl:${t.id}:resume` },
          { text: '🔄 Reannounce', callback_data: `torrent_ctrl:${t.id}:reannounce` },
        ],
        ...(isReady ? [
          [{ text: '🔗 Get Download Link (private)', callback_data: `torrent_dl:${t.id}:zip` }],
          [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:torrent:${t.id}` }],
        ] : []),
        ...(isReady && files.length > 1 ? [[{ text: '📁 List Files', callback_data: `torrent_files:${t.id}` }]] : []),
        [
          { text: '🗑 Delete', callback_data: `torrent_del:${t.id}:confirm` },
          { text: '🔙 Back', callback_data: 'torrent_list:0' },
        ],
      ],
    };

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${escapeHtml(e)}`, { parse_mode: 'HTML' });
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

    let text = `📁 <b>Files in: ${escapeHtml(truncate(t.name, 40))}</b>\n\n`;
    const btns = [];

    files.slice(0, 15).forEach((f, i) => {
      const fname = truncate(f.name || f.short_name || `File ${i + 1}`, 35);
      const size = formatBytes(f.size);
      text += `${i + 1}. ${escapeHtml(fname)} (${escapeHtml(size)})\n`;
      btns.push([{ text: `⬇ ${truncate(fname, 25)}`, callback_data: `torrent_dl:${torrentId}:${f.id}` }]);
    });

    if (files.length > 15) text += `\n<i>…and ${files.length - 15} more</i>`;
    btns.push([{ text: '📦 Download All (ZIP)', callback_data: `torrent_dl:${torrentId}:zip` }]);
    btns.push([{ text: '🔙 Back', callback_data: `torrent_info:${torrentId}` }]);

    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: btns } });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${escapeHtml(e)}`, { parse_mode: 'HTML' });
  }
}

// ── Get Download Link — ALWAYS sent as private DM ─────────────
export async function handleTorrentDl(bot, chatId, torrentId, fileIdOrZip, userId) {
  const apiKey = getUserApiKey(userId);
  const privateChatId = getPrivateChatId(userId);
  const isZip = fileIdOrZip === 'zip';
  const fileId = isZip ? null : fileIdOrZip;

  const notifyPublic = chatId !== userId && privateChatId && privateChatId !== chatId;
  if (notifyPublic) {
    await bot.sendMessage(chatId, `🔐 Sending your download link privately — check your DMs with me!`);
  }

  const targetChat = privateChatId || chatId;
  const loading = await bot.sendMessage(targetChat, '🔗 Generating your private download link…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.requestTorrentDl(Number(torrentId), fileId ? Number(fileId) : null, isZip);
    const link = result?.data;

    if (link && typeof link === 'string') {
      await bot.editMessageText(
        `🔗 <b>Your Download Link</b>\n\n` +
        `⚠️ <i>This link is for YOU only. Do not share it.</i>\n\n` +
        `${escapeHtml(link)}\n\n` +
        `🕐 <i>Link expires after use or in ~1 hour</i>`,
        { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' }
      );
    } else {
      const reason = result?.detail || result?.error || 'Could not generate link';
      await bot.editMessageText(`❌ ${escapeHtml(reason)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

// ── Control Torrent ───────────────────────────────────────────
export async function handleTorrentControl(bot, chatId, torrentId, operation, userId) {
  const apiKey = getUserApiKey(userId);
  const opEmoji = { pause: '⏸', resume: '▶️', reannounce: '🔄', delete: '🗑' };
  const loading = await bot.sendMessage(chatId, `${opEmoji[operation] || '⚙️'} Sending <code>${operation}</code>…`, { parse_mode: 'HTML' });

  try {
    const api = createApiClient(apiKey);
    const result = await api.controlTorrent(Number(torrentId), operation);
    const ok = result?.success;
    const msg = result?.detail || result?.data || (ok ? 'Done!' : 'Failed.');
    await bot.editMessageText(`${ok ? '✅' : '❌'} ${escapeHtml(String(msg))}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

// ── Delete Torrent ────────────────────────────────────────────
export async function handleTorrentDelete(bot, chatId, torrentId, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🗑 Deleting torrent <code>${torrentId}</code>…`, { parse_mode: 'HTML' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlTorrent(Number(torrentId), 'delete');
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅ Deleted.' : `❌ ${escapeHtml(result?.detail || 'Failed.')}`}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

// ── Add Magnet ────────────────────────────────────────────────
export async function handleAddMagnet(bot, chatId, magnet, userId) {
  const apiKey = getUserApiKey(userId);
  const plan = getCachedPlan(userId);

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
            `🚫 <b>Free Plan Restriction</b>\n\nThis torrent is <b>not cached</b> on TorBox.\n\n` +
            `Free users can only add ⚡ cached torrents.\n` +
            `Upgrade to Essential or higher: https://torbox.app/subscription`,
            { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
          );
          return;
        }
        await bot.editMessageText('⚡ Cached! Adding torrent…', { chat_id: chatId, message_id: loading.message_id });
      } catch (_) {}
    }
  }

  const loading2 = await bot.sendMessage(chatId, '🧲 Adding magnet link…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createTorrent({ magnet });
    const ok = result?.success;
    const name = result?.data?.name || result?.data?.hash || '(new torrent)';
    const torrentId = result?.data?.torrent_id || result?.data?.id || result?.torrent_id || result?.id;
    if (ok && torrentId) trackDownload(userId, torrentId, 'torrent', name);
    
    const replyMarkup = (ok && torrentId) ? {
      inline_keyboard: [[
        { text: '📋 View Details', callback_data: `torrent_info:${torrentId}` },
        { text: '🔗 Get Link', callback_data: `getlink:torrent:${torrentId}` }
      ]]
    } : undefined;

    await bot.editMessageText(
      ok
        ? `✅ <b>Torrent Added!</b>\n\n` +
          `📋 <b>Name:</b> ${escapeHtml(name)}\n` +
          `🆔 <b>Torrent ID:</b> <code>${torrentId || 'N/A'}</code>\n\n` +
          `🔄 <i>I will monitor this and auto-notify you when it's ready.</i>`
        : `❌ ${escapeHtml(result?.detail || 'Failed to add torrent')}`,
      { chat_id: chatId, message_id: loading2.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading2.message_id, parse_mode: 'HTML' });
  }
}

// ── Add Cached Only (/addcached) ──────────────────────────────
export async function handleAddCached(bot, chatId, input, userId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '⚡ Checking cache status…');

  let hash = isInfohash(input) ? input.toUpperCase() : extractHashFromMagnet(input);
  const magnet = input.startsWith('magnet:') ? input : null;

  if (!hash) {
    await bot.editMessageText('❌ Invalid input. Send a magnet link or a 40-char infohash.', { chat_id: chatId, message_id: loading.message_id });
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
        `❌ <b>Not Cached</b>\n\nHash <code>${escapeHtml(hash)}</code> is not available on TorBox's cache.\n\n` +
        `It would need to be downloaded from scratch (requires Essential plan).\n\n` +
        `💡 Tip: Try a different release or check later.`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
      );
      return;
    }

    await bot.editMessageText('⚡ <b>Cached!</b> Adding to your TorBox…', { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });

    const addMagnet = magnet || `magnet:?xt=urn:btih:${hash}`;
    const result = await api.createTorrent({ magnet: addMagnet, addOnlyIfCached: true });
    const ok = result?.success;
    const name = result?.data?.name || result?.data?.hash || hash;
    const torrentId = result?.data?.torrent_id || result?.data?.id || result?.torrent_id || result?.id;
    if (ok && torrentId) trackDownload(userId, torrentId, 'torrent', name);

    const replyMarkup = (ok && torrentId) ? {
      inline_keyboard: [[
        { text: '📋 View Details', callback_data: `torrent_info:${torrentId}` },
        { text: '🔗 Get Link', callback_data: `getlink:torrent:${torrentId}` }
      ]]
    } : undefined;

    await bot.editMessageText(
      ok
        ? `✅ <b>Added from Cache!</b>\n\n` +
          `📋 <b>Name:</b> ${escapeHtml(name)}\n` +
          `🆔 <b>Torrent ID:</b> <code>${torrentId || 'N/A'}</code>\n\n` +
          `⚡ <i>No waiting — content is cached on TorBox.</i>`
        : `❌ ${escapeHtml(result?.detail || 'Failed to add')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

// ── Check Cached ──────────────────────────────────────────────
export async function handleCheckCached(bot, chatId, input, userId) {
  const apiKey = getUserApiKey(userId);
  const hash = isInfohash(input) ? input.toUpperCase() : extractHashFromMagnet(input);

  if (!hash) {
    await bot.sendMessage(chatId, '❌ Invalid input. Send a 40-char infohash or magnet link.');
    return;
  }

  const loading = await bot.sendMessage(chatId, '🔍 Checking TorBox cache…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.checkCachedTorrent(hash);
    const cached = result?.data;
    const isCached = (Array.isArray(cached) && cached.length > 0) ||
      (cached && typeof cached === 'object' && Object.keys(cached).length > 0);

    let text = `🔍 <b>Cache Check</b>\n\nHash: <code>${escapeHtml(hash)}</code>\n\n`;
    if (isCached) {
      const fileCount = Array.isArray(cached) ? cached.length : Object.keys(cached).length;
      text += `⚡ <b>CACHED</b> — Instantly available!\n`;
      if (fileCount) text += `📁 ${fileCount} file${fileCount > 1 ? 's' : ''} available\n`;
      text += `\n<i>This torrent can be added from cache.</i>`;
    } else {
      text += `❌ <b>NOT CACHED</b>\n\n<i>This torrent needs to be downloaded from scratch.</i>\n`;
      text += `<i>(Requires Essential plan or higher)</i>`;
    }

    const keyboard = isCached ? {
      inline_keyboard: [[{ text: '⚡ Add from Cache', callback_data: `addcached:${hash}` }]],
    } : undefined;

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: loading.message_id,
      parse_mode: 'HTML', reply_markup: keyboard,
    });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
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
    const torrentId = result?.data?.torrent_id || result?.data?.id || result?.torrent_id || result?.id;
    if (ok && torrentId) trackDownload(userId, torrentId, 'torrent', name);

    const replyMarkup = (ok && torrentId) ? {
      inline_keyboard: [[
        { text: '📋 View Details', callback_data: `torrent_info:${torrentId}` },
        { text: '🔗 Get Link', callback_data: `getlink:torrent:${torrentId}` }
      ]]
    } : undefined;

    await bot.editMessageText(
      ok
        ? `✅ <b>Torrent Uploaded!</b>\n\n` +
          `📋 <b>Name:</b> ${escapeHtml(name)}\n` +
          `🆔 <b>Torrent ID:</b> <code>${torrentId || 'N/A'}</code>\n\n` +
          `🔄 <i>I will monitor this and auto-notify you when it's ready.</i>`
        : `❌ ${escapeHtml(result?.detail || 'Failed')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}
