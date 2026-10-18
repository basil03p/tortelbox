// ============================================================
// Helpers: byte formatting, status emoji, HTML escaping, pagination
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

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function extractApiError(err) {
  if (!err) return 'Unknown error';
  const data = err.response?.data;
  if (data) {
    if (Array.isArray(data.detail)) {
      return data.detail
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && item.msg) {
            const loc = Array.isArray(item.loc) ? item.loc.filter((l) => l !== 'body').join('.') : item.loc;
            return loc ? `${loc}: ${item.msg}` : item.msg;
          }
          return JSON.stringify(item);
        })
        .join('; ');
    }
    if (typeof data.detail === 'string') return data.detail;
    if (data.detail && typeof data.detail === 'object') {
      return data.detail.message || data.detail.error || JSON.stringify(data.detail);
    }
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error === 'object') {
      return data.error.message || JSON.stringify(data.error);
    }
    if (typeof data.message === 'string') return data.message;
  }
  return err.message || String(err);
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

/** Extract download link URL from various TorBox API response shapes */
export function extractDownloadUrl(data) {
  if (!data) return null;
  if (typeof data === 'string' && data.startsWith('http')) return data;
  if (typeof data.data === 'string' && data.data.startsWith('http')) return data.data;
  if (typeof data.download_url === 'string' && data.download_url.startsWith('http')) return data.download_url;
  if (typeof data.data?.download_url === 'string' && data.data.download_url.startsWith('http')) return data.data.download_url;
  if (typeof data.data?.link === 'string' && data.data.link.startsWith('http')) return data.data.link;
  if (typeof data.link === 'string' && data.link.startsWith('http')) return data.link;
  if (typeof data.url === 'string' && data.url.startsWith('http')) return data.url;
  return null;
}

/** Analyze status of a TorBox download item (torrent, usenet, webdl) accurately */
export function getDownloadStateInfo(item) {
  if (!item) return { isReady: false, isFailed: false, isProcessing: false, status: 'unknown' };
  const rawStatus = typeof item === 'object' ? (item.download_state || item.status || '') : String(item);
  const s = String(rawStatus).toLowerCase();

  const isFailed = s.includes('fail') || s.includes('error') || s.includes('corrupt') || s.includes('abort');
  if (isFailed) {
    return { isReady: false, isFailed: true, isProcessing: false, status: rawStatus || 'failed' };
  }

  const isProcessing = s.includes('repair') || s.includes('extract') || s.includes('unpack') ||
                       s.includes('process') || s.includes('checking') || s.includes('verif') ||
                       s.includes('metadl') || s.includes('queued');
  if (isProcessing) {
    return { isReady: false, isFailed: false, isProcessing: true, status: rawStatus || 'processing' };
  }

  const isReady = item.cached === true ||
                  item.download_finished === true ||
                  s === 'completed' || s === 'finished' || s === 'ready' || s === 'seeding' || s === 'done' ||
                  s.includes('complete') || s.includes('finish') || s.includes('cached') ||
                  ((item.progress >= 1 && (item.progress <= 1 ? item.progress === 1 : item.progress >= 100)) && !s.includes('downloading'));

  return { isReady: !!isReady, isFailed: false, isProcessing: false, status: rawStatus || (isReady ? 'completed' : 'downloading') };
}

/** Extract display name (&dn=) from magnet URI */
export function extractNameFromMagnet(magnet) {
  if (!magnet || typeof magnet !== 'string') return null;
  try {
    const match = magnet.match(/[?&]dn=([^&]+)/i);
    if (match && match[1]) {
      const decoded = decodeURIComponent(match[1].replace(/\+/g, ' ')).trim();
      return decoded || null;
    }
  } catch (_) {}
  return null;
}

/** Check if a string looks like an infohash or placeholder instead of a human title */
export function isHashString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (!s || s === '(new torrent)' || s.toLowerCase() === 'new torrent' || s.toLowerCase() === 'torrent') {
    return true;
  }
  return /^[a-fA-F0-9]{32,40}$/.test(s) || /^[a-fA-F0-9]{64}$/.test(s) || /^[a-zA-Z2-7]{32}$/.test(s);
}

/** Resolve the cleanest, human-readable name for a download */
export function resolveCleanDownloadName(item, fallback = null, magnet = null) {
  // 1. Try magnet display name (&dn=)
  if (magnet) {
    const dn = extractNameFromMagnet(magnet);
    if (dn && !isHashString(dn)) return dn;
  }

  // 2. Check item object if provided
  if (item && typeof item === 'object') {
    if (item.name && typeof item.name === 'string' && !isHashString(item.name)) {
      return item.name.trim();
    }
    if (item.filename && typeof item.filename === 'string' && !isHashString(item.filename)) {
      return item.filename.trim();
    }
    const files = Array.isArray(item.files) ? item.files : [];
    if (files.length > 0) {
      const sorted = [...files].sort((a, b) => (b.size || 0) - (a.size || 0));
      for (const f of sorted) {
        const rawFn = f?.name || f?.short_name || f?.s3_path;
        if (rawFn && typeof rawFn === 'string') {
          const parts = rawFn.split('/').filter(Boolean);
          if (parts.length > 1 && !isHashString(parts[0])) {
            return parts[0].trim();
          }
          const fn = parts[parts.length - 1];
          if (fn && !isHashString(fn)) {
            return fn.trim();
          }
        }
      }
    }
    if (item.name && typeof item.name === 'string' && item.name.trim() && !isHashString(item.name)) {
      return item.name.trim();
    }
  }

  // 3. Fallback string
  if (fallback && typeof fallback === 'string' && !isHashString(fallback)) {
    return fallback.trim();
  }

  if (typeof item === 'string' && !isHashString(item)) {
    return item.trim();
  }

  return fallback || item?.name || item?.hash || 'Download';
}

