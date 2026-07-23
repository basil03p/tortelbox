// ============================================================
// Helpers: byte formatting, status emoji, pagination, etc.
// ============================================================

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '—';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function formatRatio(ratio) {
  if (ratio == null) return '—';
  return Number(ratio).toFixed(3);
}

export function statusEmoji(status) {
  const map = {
    downloading: '⬇️',
    uploading: '⬆️',
    seeding: '🌱',
    paused: '⏸',
    stalled: '⚠️',
    completed: '✅',
    cached: '⚡',
    error: '❌',
    processing: '⚙️',
    checking: '🔍',
    waiting: '⏳',
    queued: '🔜',
    metaDL: '📋',
    active: '🟢',
    inactive: '🔴',
    deleted: '🗑',
  };
  const s = String(status || '').toLowerCase();
  for (const [key, emoji] of Object.entries(map)) {
    if (s.includes(key)) return emoji;
  }
  return '📄';
}

export function progressBar(percent, width = 10) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round((p / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(p)}%`;
}

export function truncate(str, max = 30) {
  if (!str) return '—';
  const s = String(str);
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}

export function escapeMarkdown(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}

/** Chunk an array into pages */
export function paginate(arr, page, pageSize) {
  const total = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safeP = Math.max(0, Math.min(page, totalPages - 1));
  return {
    items: arr.slice(safeP * pageSize, (safeP + 1) * pageSize),
    page: safeP,
    totalPages,
    total,
  };
}

/** Build prev/next inline keyboard */
export function paginationKeyboard(action, page, totalPages, extra = []) {
  const btns = [];
  if (page > 0) btns.push({ text: '◀ Prev', callback_data: `${action}:${page - 1}` });
  if (page < totalPages - 1) btns.push({ text: 'Next ▶', callback_data: `${action}:${page + 1}` });
  const rows = [];
  if (btns.length) rows.push(btns);
  if (extra.length) extra.forEach((row) => rows.push(row));
  return { inline_keyboard: rows };
}
