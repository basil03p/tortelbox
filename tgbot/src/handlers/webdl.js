// ============================================================
// Handlers: Web Downloads — Essential+ only, private DL links + HTML formatting
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey, getCachedPlan, checkPlanFeature, getPrivateChatId, hasPersonalApiKey } from '../session.js';
import { trackDownload, getUserTrackedItemIds, isItemOwnedByUser, updateDownloadStatus, deleteTrackedDownload } from '../db.js';
import { handleGetLink } from '../index.js';
import {
  formatBytes, formatSpeed, formatEta, formatDate,
  statusEmoji, progressBar, truncate, escapeHtml, extractApiError,
  paginate, paginationKeyboard, extractDownloadUrl,
  resolveCleanDownloadName,
} from '../utils.js';

const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '5', 10);

function planBlock(bot, chatId, userId) {
  const plan = getCachedPlan(userId);
  const msg = checkPlanFeature(plan, 'webdl');
  if (msg) { bot.sendMessage(chatId, msg, { parse_mode: 'HTML' }); return true; }
  return false;
}

export async function handleWebDlList(bot, msg, page = 0) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  if (planBlock(bot, chatId, userId)) return;

  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '⏳ Fetching web downloads…');
  try {
    const api = createApiClient(apiKey);
    const data = await api.getWebDlList();
    const userItemIds = await getUserTrackedItemIds(userId, 'webdl');

    const allItems = data?.data || [];
    // STRICT: Only show web downloads tracked for this user in MongoDB/SQLite database
    const items = allItems.filter((w) => userItemIds.has(String(w.id)));

    if (!items.length) {
      await bot.editMessageText('📭 No tracked web downloads found for your account.\n\nUse /addwebdl <url> to add a link.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const { items: pageItems, page: p, totalPages, total } = paginate(items, page, PAGE_SIZE);
    let text = `<b>🌐 Web Downloads</b> — Page ${p + 1}/${totalPages} (${total})\n\n`;
    const rowBtns = [];

    for (const w of pageItems) {
      const status = w.download_state || w.status || 'unknown';
      const pct = w.progress != null ? w.progress * 100 : 0;
      const cleanName = resolveCleanDownloadName(w, w.name);
      const name = truncate(cleanName, 35);
      text += `${statusEmoji(status)} <b>${escapeHtml(name)}</b>\n`;
      text += `  🆔 <code>${w.id}</code> | ${escapeHtml(status)} | ${escapeHtml(formatBytes(w.size))}\n`;
      text += `  <code>${progressBar(pct)}</code>\n`;
      if (w.download_speed) text += `  ⬇ ${escapeHtml(formatSpeed(w.download_speed))}\n`;
      text += '\n';
      rowBtns.push([{ text: `📋 ${truncate(cleanName, 20)}`, callback_data: `webdl_info:${w.id}` }]);
    }

    const keyboard = paginationKeyboard('webdl_list', p, totalPages);
    keyboard.inline_keyboard = [...keyboard.inline_keyboard, ...rowBtns,
      [{ text: '🔄 Refresh', callback_data: `webdl_list:${p}` }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleWebDlInfo(bot, chatId, webdlId, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  try {
    const api = createApiClient(apiKey);
    const data = await api.getWebDlList(true);
    const items = data?.data || [];
    const w = items.find((x) => String(x.id) === String(webdlId));
    if (!w) { await bot.sendMessage(chatId, '❌ Web download not found.'); return; }

    const status = w.download_state || w.status || 'unknown';
    const pct = w.progress != null ? w.progress * 100 : 0;
    const isReady = pct >= 100 || status.toLowerCase().includes('complete');

    let text = `🌐 <b>${escapeHtml(w.name)}</b>\n\n`;
    text += `🆔 ID: <code>${w.id}</code>\n`;
    text += `${statusEmoji(status)} Status: <code>${escapeHtml(status)}</code>\n`;
    text += `📦 Size: <code>${escapeHtml(formatBytes(w.size))}</code>\n`;
    text += `<code>${progressBar(pct)}</code>\n`;
    if (w.download_speed) text += `⬇ Speed: <code>${escapeHtml(formatSpeed(w.download_speed))}</code>\n`;
    if (w.eta)            text += `⏱ ETA: <code>${escapeHtml(formatEta(w.eta))}</code>\n`;
    if (w.original_url)   text += `🔗 URL: <code>${escapeHtml(truncate(w.original_url, 50))}</code>\n`;
    if (w.created_at)     text += `📅 Added: <code>${escapeHtml(formatDate(w.created_at))}</code>\n`;

    const keyboard = {
      inline_keyboard: [
        ...(isReady ? [
          [{ text: '🔗 Get Link (private)', callback_data: `webdl_dl:${w.id}:zip` }],
          [{ text: '📤 Upload to Gofile.io ⚡', callback_data: `gofile:webdl:${w.id}` }],
        ] : []),
        [{ text: '🗑 Delete', callback_data: `webdl_del:${w.id}:confirm` }, { text: '🔙 Back', callback_data: 'webdl_list:0' }],
      ],
    };
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (err) {
    const e = extractApiError(err);
    await bot.sendMessage(chatId, `❌ ${escapeHtml(e)}`, { parse_mode: 'HTML' });
  }
}

export async function handleWebDlControl(bot, chatId, webdlId, operation, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `⚙️ Sending <code>${operation}</code>…`, { parse_mode: 'HTML' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlWebDl(Number(webdlId), operation);
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅' : '❌'} ${escapeHtml(String(result?.detail || result?.data || (ok ? 'Done!' : 'Failed.')))}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleWebDlDelete(bot, chatId, webdlId, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🗑 Deleting <code>${webdlId}</code>…`, { parse_mode: 'HTML' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlWebDl(Number(webdlId), 'delete');
    const ok = result?.success;
    if (ok) {
      await deleteTrackedDownload(userId, webdlId, 'webdl').catch(() => {});
    }
    await bot.editMessageText(`${ok ? '✅ Deleted.' : `❌ ${escapeHtml(result?.detail || 'Failed.')}`}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  } catch (err) {
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleWebDlDl(bot, chatId, webdlId, fileIdOrZip, userId) {
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
    const result = await api.requestWebDlDl(Number(webdlId), fileId ? Number(fileId) : null, isZip);
    const link = extractDownloadUrl(result);
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
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}

export async function handleAddWebDl(bot, chatId, url, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '🌐 Adding web download…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createWebDl({ url });
    const ok = result?.success;
    const webdlId = result?.data?.webdl_id || result?.data?.id || result?.web_id || result?.id;

    let wItem = null;
    if (ok && webdlId) {
      const listData = await api.getWebDlList(true).catch(() => null);
      wItem = Array.isArray(listData?.data) ? listData.data.find(x => String(x.id) === String(webdlId)) : result?.data;
    }

    const cleanName = resolveCleanDownloadName(wItem, result?.data?.name || url);
    if (ok && webdlId) trackDownload(userId, webdlId, 'webdl', cleanName);

    if (ok && webdlId) {
      const isReady = wItem?.download_finished || wItem?.cached || wItem?.progress >= 1 || (wItem?.download_state && String(wItem.download_state).toLowerCase().includes('complete'));

      if (isReady) {
        await updateDownloadStatus(userId, webdlId, 'webdl', 'completed', true, cleanName).catch(() => {});
        const replyMarkup = {
          inline_keyboard: [[
            { text: '📋 View Details', callback_data: `webdl_info:${webdlId}` },
            { text: '🔗 Get Link', callback_data: `getlink:webdl:${webdlId}` }
          ]]
        };
        await bot.editMessageText(
          `⚡ <b>Web Download Ready! (Cached)</b>\n\n` +
          `🌐 <b>Name:</b> ${escapeHtml(truncate(cleanName, 40))}\n` +
          `🆔 <b>WebDL ID:</b> <code>${webdlId}</code>\n\n` +
          `🎉 <i>Instant download ready! Generating your link…</i>`,
          { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
        );
        await handleGetLink(bot, chatId, userId, 'webdl', webdlId);
        return;
      }
    }

    const replyMarkup = (ok && webdlId) ? {
      inline_keyboard: [[
        { text: '📋 View Details', callback_data: `webdl_info:${webdlId}` },
        { text: '🔗 Get Link', callback_data: `getlink:webdl:${webdlId}` }
      ]]
    } : undefined;

    await bot.editMessageText(
      ok
        ? `✅ <b>Web Download Added!</b>\n\n` +
          `🌐 <b>Name:</b> ${escapeHtml(truncate(name, 40))}\n` +
          `🆔 <b>WebDL ID:</b> <code>${webdlId || 'N/A'}</code>\n\n` +
          `🔄 <i>I will monitor this and auto-notify you when it's ready.</i>`
        : `❌ ${escapeHtml(result?.detail || result?.error || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML', reply_markup: replyMarkup }
    );
  } catch (err) {
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' });
  }
}
