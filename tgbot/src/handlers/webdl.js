// ============================================================
// Handlers: Web Downloads — Essential+ only, private DL links
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey, getCachedPlan, checkPlanFeature, getPrivateChatId } from '../session.js';
import {
  formatBytes, formatSpeed, formatEta, formatDate,
  statusEmoji, progressBar, truncate, escapeMarkdown,
  paginate, paginationKeyboard,
} from '../utils.js';

const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '5', 10);

function planBlock(bot, chatId, userId) {
  const plan = getCachedPlan(userId);
  const msg = checkPlanFeature(plan, 'webdl');
  if (msg) { bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' }); return true; }
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
    const items = data?.data || [];

    if (!items.length) {
      await bot.editMessageText('📭 No web downloads found.\n\nUse /addwebdl <url> to add a link.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const { items: pageItems, page: p, totalPages, total } = paginate(items, page, PAGE_SIZE);
    let text = `🌐 *Web Downloads* — Page ${p + 1}/${totalPages} \\(${total}\\)\n\n`;
    const rowBtns = [];

    for (const w of pageItems) {
      const status = w.download_state || w.status || 'unknown';
      const pct = w.progress != null ? w.progress * 100 : 0;
      const name = truncate(w.name, 30);
      text += `${statusEmoji(status)} *${escapeMarkdown(name)}*\n`;
      text += `  🆔 \`${w.id}\` \\| ${escapeMarkdown(status)} \\| ${escapeMarkdown(formatBytes(w.size))}\n`;
      text += `  ${progressBar(pct)}\n`;
      if (w.download_speed) text += `  ⬇ ${escapeMarkdown(formatSpeed(w.download_speed))}\n`;
      text += '\n';
      rowBtns.push([{ text: `📋 ${truncate(w.name, 20)}`, callback_data: `webdl_info:${w.id}` }]);
    }

    const keyboard = paginationKeyboard('webdl_list', p, totalPages);
    keyboard.inline_keyboard = [...keyboard.inline_keyboard, ...rowBtns,
      [{ text: '🔄 Refresh', callback_data: `webdl_list:${p}` }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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

    let text = `🌐 *${escapeMarkdown(w.name)}*\n\n`;
    text += `🆔 ID: \`${w.id}\`\n`;
    text += `${statusEmoji(status)} Status: \`${escapeMarkdown(status)}\`\n`;
    text += `📦 Size: \`${escapeMarkdown(formatBytes(w.size))}\`\n`;
    text += `${progressBar(pct)}\n`;
    if (w.download_speed) text += `⬇ Speed: \`${escapeMarkdown(formatSpeed(w.download_speed))}\`\n`;
    if (w.eta)            text += `⏱ ETA: \`${escapeMarkdown(formatEta(w.eta))}\`\n`;
    if (w.original_url)   text += `🔗 URL: \`${escapeMarkdown(truncate(w.original_url, 50))}\`\n`;
    if (w.created_at)     text += `📅 Added: \`${escapeMarkdown(formatDate(w.created_at))}\`\n`;

    const keyboard = {
      inline_keyboard: [
        ...(isReady ? [[{ text: '🔗 Get Link (private)', callback_data: `webdl_dl:${w.id}:zip` }]] : []),
        [{ text: '🗑 Delete', callback_data: `webdl_del:${w.id}:confirm` }, { text: '🔙 Back', callback_data: 'webdl_list:0' }],
      ],
    };
    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${e}`);
  }
}

export async function handleWebDlControl(bot, chatId, webdlId, operation, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `⚙️ Sending \`${operation}\`…`, { parse_mode: 'Markdown' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlWebDl(Number(webdlId), operation);
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅' : '❌'} ${escapeMarkdown(String(result?.detail || result?.data || (ok ? 'Done!' : 'Failed.')))}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

export async function handleWebDlDelete(bot, chatId, webdlId, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🗑 Deleting \`${webdlId}\`…`, { parse_mode: 'Markdown' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlWebDl(Number(webdlId), 'delete');
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅ Deleted\\.' : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// Download link → private DM only
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
    const link = result?.data;
    if (link && typeof link === 'string') {
      await bot.editMessageText(
        `🔗 *Your Download Link*\n\n⚠️ _For your eyes only — do not share\\._\n\n${link}\n\n🕐 _Expires in ~1 hour_`,
        { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
      );
    } else {
      await bot.editMessageText(`❌ ${escapeMarkdown(result?.detail || 'Could not generate link.')}`,
        { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
    }
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${escapeMarkdown(e)}`, { chat_id: targetChat, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
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
    const name = result?.data?.name || url;
    await bot.editMessageText(
      ok ? `✅ Added\\!\n🌐 *${escapeMarkdown(truncate(name, 40))}*` : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}
