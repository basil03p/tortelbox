// ============================================================
// Handlers: Gofile — Upload TorBox downloads (torrent, webdl, usenet) to Gofile & list history
// ============================================================
import { createApiClient } from '../api.js';
import { getUserApiKey } from '../session.js';
import { saveGofileUpload, getUserGofileUploads } from '../db.js';
import { streamUrlToGofile } from '../gofile.js';
import { truncate, escapeHtml, extractApiError, formatDate } from '../utils.js';

export async function handleGofileUpload(bot, chatId, userId, type = 'torrent', itemId) {
  const apiKey = getUserApiKey(userId);
  const loading = await bot.sendMessage(
    chatId,
    `📤 Requesting link from TorBox for ${type} <code>#${itemId}</code>…`,
    { parse_mode: 'HTML' }
  );

  try {
    const api = createApiClient(apiKey);
    let linkRes;

    if (type === 'torrent') {
      linkRes = await api.requestTorrentDl(Number(itemId), null, true).catch(() => null);
    } else if (type === 'webdl') {
      linkRes = await api.requestWebDlDl(Number(itemId), null, true).catch(() => null);
    } else if (type === 'usenet') {
      linkRes = await api.requestUsenetDl(Number(itemId), null, true).catch(() => null);
    }

    const downloadUrl = linkRes?.data;
    if (!downloadUrl || typeof downloadUrl !== 'string') {
      const reason =
        linkRes?.detail ||
        linkRes?.error ||
        'Could not fetch download URL from TorBox. Ensure the item is ready/completed.';
      await bot.editMessageText(`❌ ${escapeHtml(reason)}`, {
        chat_id: chatId,
        message_id: loading.message_id,
        parse_mode: 'HTML',
      });
      return;
    }

    // Determine filename
    let fileName = `${type}_${itemId}.zip`;
    if (type === 'torrent') {
      const details = await api.getTorrentById(Number(itemId)).catch(() => null);
      const items = details?.data;
      const t = Array.isArray(items) ? items.find((x) => String(x.id) === String(itemId)) : items;
      if (t?.name) fileName = t.name.endsWith('.zip') ? t.name : `${t.name}.zip`;
    } else if (type === 'webdl') {
      const details = await api.getWebDlList(true).catch(() => null);
      const items = details?.data || [];
      const w = items.find((x) => String(x.id) === String(itemId));
      if (w?.name) fileName = w.name.endsWith('.zip') ? w.name : `${w.name}.zip`;
    } else if (type === 'usenet') {
      const details = await api.getUsenetList(true).catch(() => null);
      const items = details?.data || [];
      const u = items.find((x) => String(x.id) === String(itemId));
      if (u?.name) fileName = u.name.endsWith('.zip') ? u.name : `${u.name}.zip`;
    }

    await bot.editMessageText(
      `⏳ Streaming <code>${escapeHtml(fileName)}</code> to Gofile.io…\n\n<i>Please wait while the file is uploaded.</i>`,
      { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
    );

    const gofileRes = await streamUrlToGofile(downloadUrl, fileName);

    if (gofileRes?.ok && gofileRes?.downloadPage) {
      await saveGofileUpload(userId, type, itemId, fileName, gofileRes.downloadPage, gofileRes.fileId);

      const successText =
        `✅ <b>Uploaded to Gofile.io Successfully!</b>\n\n` +
        `📁 <b>File:</b> <code>${escapeHtml(fileName)}</code>\n` +
        `🔗 <b>Gofile Link:</b> ${escapeHtml(gofileRes.downloadPage)}\n\n` +
        `💡 <i>Link saved to your Gofile history in MongoDB. Retrieve anytime via /mygofile</i>`;

      await bot.editMessageText(successText, {
        chat_id: chatId,
        message_id: loading.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Open Gofile Download Page', url: gofileRes.downloadPage }],
            [{ text: '📤 View My Gofile Uploads', callback_data: 'mygofile' }],
          ],
        },
      });
    } else {
      await bot.editMessageText(
        `❌ <b>Gofile Upload Failed</b>\n\n${escapeHtml(gofileRes?.detail || 'Failed to upload to Gofile.')}`,
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'HTML',
    });
  }
}

export async function handleMyGofile(bot, msg) {
  const userId = msg.from?.id || msg.chat.id;
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏳ Fetching your Gofile upload history…');

  try {
    const uploads = await getUserGofileUploads(userId, 15);

    if (!uploads || !uploads.length) {
      await bot.editMessageText(
        '📭 <b>No Gofile uploads found.</b>\n\nYou can upload any completed torrent, web download, or usenet file to Gofile using the 📤 <b>Upload to Gofile</b> button.',
        { chat_id: chatId, message_id: loading.message_id, parse_mode: 'HTML' }
      );
      return;
    }

    let text = `📤 <b>My Gofile Uploads</b> (${uploads.length})\n\n`;
    const btns = [];

    uploads.forEach((u, i) => {
      const typeEmoji = { torrent: '🧲', usenet: '📰', webdl: '🌐' }[u.type] || '📦';
      const name = truncate(u.name || `Upload #${i + 1}`, 35);
      const dateStr = u.created_at ? formatDate(u.created_at) : '';

      text += `<b>${i + 1}.</b> ${typeEmoji} <b>${escapeHtml(name)}</b>\n`;
      if (dateStr) text += `   📅 ${escapeHtml(dateStr)}\n`;
      text += `   🔗 <code>${escapeHtml(u.download_page)}</code>\n\n`;

      btns.push([{ text: `🌐 #${i + 1} Open: ${truncate(name, 22)}`, url: u.download_page }]);
    });

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'HTML',
      reply_markup: btns.length ? { inline_keyboard: btns } : undefined,
    });
  } catch (err) {
    const e = extractApiError(err);
    await bot.editMessageText(`❌ ${escapeHtml(e)}`, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'HTML',
    });
  }
}
