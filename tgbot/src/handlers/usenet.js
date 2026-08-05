// ============================================================
// Handlers: Usenet — Essential+ only, private DL links + HTML formatting
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey, getCachedPlan, checkPlanFeature, getPrivateChatId } from '../session.js';
import { trackDownload, getUserTrackedItemIds, isItemOwnedByUser } from '../db.js';
import {
  formatBytes, formatSpeed, formatEta, formatDate,
  statusEmoji, progressBar, truncate, escapeHtml,
  paginate, paginationKeyboard,
} from '../utils.js';

const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '5', 10);

function planBlock(bot, chatId, userId) {
  const plan = getCachedPlan(userId);
  const msg = checkPlanFeature(plan, 'usenet');
  if (msg) { bot.sendMessage(chatId, msg, { parse_mode: 'HTML' }); return true; }
  return false;
}

export async function handleUsenetList(bot, msg, page = 0) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  if (planBlock(bot, chatId, userId)) return;

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '⏳ Fetching usenet downloads…');
  try {
    const api = createApiClient(apiKey);
    const data = await api.getUsenetList();
    const userItemIds = await getUserTrackedItemIds(userId, 'usenet');
    const adminId = process.env.BOT_ADMIN_ID ? String(process.env.BOT_ADMIN_ID).trim() : null;
    const isUserAdmin = adminId && String(userId) === adminId;

    const allItems = data?.data || [];
    const items = allItems.filter((u) => isUserAdmin || userItemIds.has(String(u.id)));

    if (!items.length) {
      await bot.editMessageText('📭 No usenet downloads found for your account.\n\nUse /addnzb <url> or send an .nzb file.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const { items: pageItems, page: p, totalPages, total } = paginate(items, page, PAGE_SIZE);
    let text = `<b>📰 Usenet Downloads</b> — Page ${p + 1}/${totalPages} (${total})\n\n`;
    const rowBtns = [];

    for (const u of pageItems) {
      const status = u.download_state || u.status || 'unknown';
      const pct = u.progress != null ? u.progress * 100 : 0;
      const name = truncate(u.name, 35);
      text += `${statusEmoji(status)} <b>${escapeHtml(name)}</b>\n`;
      text += `  🆔 <code>${u.id}</code> | ${escapeHtml(status)} | ${escapeHtml(formatBytes(u.size))}\n`;
      text += `  <code>${progressBar(pct)}</code>\n`;
      if (u.download_speed) text += `  ⬇ ${escapeHtml(formatSpeed(u.download_speed))}\n`;
      text += '\n';
      rowBtns.push([{ text: `📋 ${truncate(u.name, 20)}`, callback_data: `usenet_info:${u.id}` }]);
    }

    const keyboard = paginationKeyboard('usenet_list', p, totalPages);
    keyboard.inline_keyboard = [...keyboard.inline_keyboard, ...rowBtns,
      [{ text: '🔄 Refresh', callback_data: `usenet_list:${p}` }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleUsenetInfo(bot, chatId, usenetId, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  try {
    const api = createApiClient(apiKey);
    const data = await api.getUsenetList(true);
    const items = data?.data || [];
    const u = items.find((x) => String(x.id) === String(usenetId));
    if (!u) { await bot.sendMessage(chatId, '❌ Usenet download not found.'); return; }

    const status = u.download_state || u.status || 'unknown';
    const pct = u.progress != null ? u.progress * 100 : 0;
    const isReady = pct >= 100 || status.toLowerCase().includes('complete');

    let text = `📰 <b>${escapeHtml(u.name)}</b>\n\n`;
    text += `🆔 ID: <code>${u.id}</code>\n`;
    text += `${statusEmoji(status)} Status: <code>${escapeHtml(status)}</code>\n`;
    text += `📦 Size: <code>${escapeHtml(formatBytes(u.size))}</code>\n`;
    text += `<code>${progressBar(pct)}</code>\n`;
    if (u.download_speed) text += `⬇ Speed: <code>${escapeHtml(formatSpeed(u.download_speed))}</code>\n`;
    if (u.eta)            text += `⏱ ETA: <code>${escapeHtml(formatEta(u.eta))}</code>\n`;
    if (u.created_at)     text += `📅 Added: <code>${escapeHtml(formatDate(u.created_at))}</code>\n`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '⏸ Pause', callback_data: `usenet_ctrl:${u.id}:pause` }, { text: '▶ Resume', callback_data: `usenet_ctrl:${u.id}:resume` }],
        ...(isReady ? [
          [{ text: '🔗 Get Link (private)', callback_data: `usenet_dl:${u.id}:zip` }],
          [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:usenet:${u.id}` }],
        ] : []),
        [{ text: '🗑 Delete', callback_data: `usenet_del:${u.id}:confirm` }, { text: '🔙 Back', callback_data: 'usenet_list:0' }],
      ],
    };
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${escapeHtml(e)}`, { parse_mode: 'HTML' });
  }
}

export async function handleUsenetControl(bot, chatId, usenetId, operation, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `⚙️ Sending <code>${operation}</code>…`, { parse_mode: 'HTML' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlUsenet(Number(usenetId), operation);
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅' : '❌'} ${escapeHtml(String(result?.detail || result?.data || (ok ? 'Done!' : 'Failed.')))}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleUsenetDelete(bot, chatId, usenetId, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🗑 Deleting <code>${usenetId}</code>…`, { parse_mode: 'HTML' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlUsenet(Number(usenetId), 'delete');
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅ Deleted.' : `❌ ${escapeHtml(result?.detail || 'Failed.')}`}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleUsenetDl(bot, chatId, usenetId, fileIdOrZip, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const privateChatId = getPrivateChatId(userId);
  const isZip = fileIdOrZip === 'zip';
  const fileId = isZip ? null : fileIdOrZip;

  if (chatId !== userId && privateChatId && privateChatId !== chatId) {
    await bot.sendMessage(chatId, '🔐 Sending your download link privately…');
  }
  const targetChat = privateChatId || chatId;
  const loading = await bot.sendMessage(targetChat, '🔗 Generating private download link…');

  try {
    const api = createApiClient(apiKey);
    const result = await api.requestUsenetDl(Number(usenetId), fileId ? Number(fileId) : null, isZip);
    const link = result?.data;
    if (link && typeof link === 'string') {
      await bot.editMessageText(
        `🔗 <b>Your Download Link</b>\n\n⚠️ <i>For your eyes only — do not share.</i>\n\n${escapeHtml(link)}\n\n🕐 <i>Expires in ~1 hour</i>`,
        { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' }
      );
    } else {
      await bot.editMessageText(`❌ ${escapeHtml(result?.detail || 'Could not generate link.')}`,
        { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleAddNzbLink(bot, chatId, url, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📤 Adding Usenet download…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createUsenet({ url });
    const ok = result?.success;
    const name = result?.data?.name || url;
    const usenetId = result?.data?.usenet_id || result?.data?.id || result?.usenet_id || result?.id;
    if (ok && usenetId) trackDownload(userId, usenetId, 'usenet', name);
    
    const replyMarkup = (ok && usenetId) ? {
      inline_keyboard: [[
        { text: '📋 View Details', callback_data: `usenet_info:${usenetId}` },
        { text: '🔗 Get Link', callback_data: `getlink:usenet:${usenetId}` }
      ]]
    } : undefined;

    await bot.editMessageText(
      ok
        ? `✅ <b>Usenet Download Added!</b>\n\n` +
          `📰 <b>Name:</b> ${escapeHtml(truncate(name, 40))}\n` +
          `🆔 <b>Usenet ID:</b> <code>${usenetId || 'N/A'}</code>\n\n` +
          `🔄 <i>I will monitor this and auto-notify you when it's ready.</i>`
        : `❌ ${escapeHtml(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleAddNzbFile(bot, chatId, fileBuffer, fileName, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📤 Uploading NZB file…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createUsenet({ file: { data: fileBuffer, name: fileName } });
    const ok = result?.success;
    const name = result?.data?.name || fileName;
    const usenetId = result?.data?.usenet_id || result?.data?.id || result?.usenet_id || result?.id;
    if (ok && usenetId) trackDownload(userId, usenetId, 'usenet', name);

    const replyMarkup = (ok && usenetId) ? {
      inline_keyboard: [[
        { text: '📋 View Details', callback_data: `usenet_info:${usenetId}` },
        { text: '🔗 Get Link', callback_data: `getlink:usenet:${usenetId}` }
      ]]
    } : undefined;

    await bot.editMessageText(
      ok
        ? `✅ <b>NZB File Uploaded!</b>\n\n` +
          `📰 <b>Name:</b> ${escapeHtml(truncate(name, 40))}\n` +
          `🆔 <b>Usenet ID:</b> <code>${usenetId || 'N/A'}</code>\n\n` +
          `🔄 <i>I will monitor this and auto-notify you when it's ready.</i>`
        : `❌ ${escapeHtml(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}
