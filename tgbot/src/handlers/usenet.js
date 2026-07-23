// ============================================================
// Handlers: Usenet — Essential+ only, private DL links
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
  const msg = checkPlanFeature(plan, 'usenet');
  if (msg) { bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' }); return true; }
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
    const items = data?.data || [];

    if (!items.length) {
      await bot.editMessageText('📭 No usenet downloads found.\n\nUse /addnzb <url> or send an .nzb file.', { chat_id: chatId, message_id: loading.message_id });
      return;
    }

    const { items: pageItems, page: p, totalPages, total } = paginate(items, page, PAGE_SIZE);
    let text = `📰 *Usenet Downloads* — Page ${p + 1}/${totalPages} \\(${total}\\)\n\n`;
    const rowBtns = [];

    for (const u of pageItems) {
      const status = u.download_state || u.status || 'unknown';
      const pct = u.progress != null ? u.progress * 100 : 0;
      const name = truncate(u.name, 30);
      text += `${statusEmoji(status)} *${escapeMarkdown(name)}*\n`;
      text += `  🆔 \`${u.id}\` \\| ${escapeMarkdown(status)} \\| ${escapeMarkdown(formatBytes(u.size))}\n`;
      text += `  ${progressBar(pct)}\n`;
      if (u.download_speed) text += `  ⬇ ${escapeMarkdown(formatSpeed(u.download_speed))}\n`;
      text += '\n';
      rowBtns.push([{ text: `📋 ${truncate(u.name, 20)}`, callback_data: `usenet_info:${u.id}` }]);
    }

    const keyboard = paginationKeyboard('usenet_list', p, totalPages);
    keyboard.inline_keyboard = [...keyboard.inline_keyboard, ...rowBtns,
      [{ text: '🔄 Refresh', callback_data: `usenet_list:${p}` }]
    ];
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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

    let text = `📰 *${escapeMarkdown(u.name)}*\n\n`;
    text += `🆔 ID: \`${u.id}\`\n`;
    text += `${statusEmoji(status)} Status: \`${escapeMarkdown(status)}\`\n`;
    text += `📦 Size: \`${escapeMarkdown(formatBytes(u.size))}\`\n`;
    text += `${progressBar(pct)}\n`;
    if (u.download_speed) text += `⬇ Speed: \`${escapeMarkdown(formatSpeed(u.download_speed))}\`\n`;
    if (u.eta)            text += `⏱ ETA: \`${escapeMarkdown(formatEta(u.eta))}\`\n`;
    if (u.created_at)     text += `📅 Added: \`${escapeMarkdown(formatDate(u.created_at))}\`\n`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '⏸ Pause', callback_data: `usenet_ctrl:${u.id}:pause` }, { text: '▶ Resume', callback_data: `usenet_ctrl:${u.id}:resume` }],
        ...(isReady ? [[{ text: '🔗 Get Link (private)', callback_data: `usenet_dl:${u.id}:zip` }]] : []),
        [{ text: '🗑 Delete', callback_data: `usenet_del:${u.id}:confirm` }, { text: '🔙 Back', callback_data: 'usenet_list:0' }],
      ],
    };
    await bot.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.sendMessage(chatId, `❌ ${e}`);
  }
}

export async function handleUsenetControl(bot, chatId, usenetId, operation, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `⚙️ Sending \`${operation}\`…`, { parse_mode: 'Markdown' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlUsenet(Number(usenetId), operation);
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅' : '❌'} ${escapeMarkdown(String(result?.detail || result?.data || (ok ? 'Done!' : 'Failed.')))}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

export async function handleUsenetDelete(bot, chatId, usenetId, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, `🗑 Deleting \`${usenetId}\`…`, { parse_mode: 'Markdown' });
  try {
    const api = createApiClient(apiKey);
    const result = await api.controlUsenet(Number(usenetId), 'delete');
    const ok = result?.success;
    await bot.editMessageText(`${ok ? '✅ Deleted\\.' : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' });
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}

// Download link → private DM only
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

export async function handleAddNzbLink(bot, chatId, url, userId) {
  if (planBlock(bot, chatId, userId)) return;
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(chatId, '📤 Adding Usenet download…');
  try {
    const api = createApiClient(apiKey);
    const result = await api.createUsenet({ url });
    const ok = result?.success;
    const name = result?.data?.name || url;
    await bot.editMessageText(
      ok ? `✅ Added\\!\n📰 *${escapeMarkdown(truncate(name, 40))}*` : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
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
    await bot.editMessageText(
      ok ? `✅ Added\\!\n📰 *${escapeMarkdown(name)}*` : `❌ ${escapeMarkdown(result?.detail || 'Failed.')}`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'MarkdownV2' }
    );
  } catch (err) {
    const e = err.response?.data?.detail || err.response?.data?.error || err.message;
    await bot.editMessageText(`❌ ${e}`, { chat_id: chatId, message_id: loading.message_id });
  }
}
