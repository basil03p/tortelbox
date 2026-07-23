import 'dotenv/config';
import axios from 'axios';

// ============================================================
// TorBox API Client — Direct API calls (no backend required)
// ============================================================

const BASE_URL = (process.env.TORBOX_API_BASE || 'https://api.torbox.app').replace(/\/$/, '');
const API_VERSION = process.env.TORBOX_API_VERSION || 'v1';
const API_ROOT = `${BASE_URL}/${API_VERSION}`;

export function createApiClient(apiKey) {
  const client = axios.create({
    baseURL: API_ROOT,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'TorBox-TelegramBot/1.0.0',
    },
    timeout: 30000,
  });

  return {
    // ── User ────────────────────────────────────────────────
    async getMe() {
      const r = await client.get('/api/user/me');
      return r.data;
    },
    async getStats() {
      const r = await client.get('/api/user/stats');
      return r.data;
    },
    async getSubscriptions() {
      const r = await client.get('/api/user/subscriptions');
      return r.data;
    },
    async getTransactions() {
      const r = await client.get('/api/user/transactions');
      return r.data;
    },

    // ── Torrents ─────────────────────────────────────────────
    async getTorrentList(bypassCache = false) {
      const r = await client.get('/api/torrents/mylist', {
        params: { bypass_cache: bypassCache },
      });
      return r.data;
    },

    async getTorrentById(id) {
      const r = await client.get('/api/torrents/mylist', {
        params: { id, bypass_cache: true },
      });
      return r.data;
    },

    async createTorrent({ magnet, file, seed = 1, allowZip = true, asQueued = false, addOnlyIfCached = false, name = '' }) {
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      if (magnet) form.append('magnet', magnet);
      if (file) form.append('file', file.data, { filename: file.name, contentType: 'application/x-bittorrent' });
      form.append('seed', String(seed));
      form.append('allow_zip', allowZip ? '1' : '0');
      form.append('as_queued', asQueued ? '1' : '0');
      if (addOnlyIfCached) form.append('add_only_if_cached', '1');
      if (name) form.append('name', name);

      const r = await client.post('/api/torrents/createtorrent', form, {
        headers: form.getHeaders(),
        timeout: 60000,
      });
      return r.data;
    },

    async controlTorrent(torrentId, operation) {
      const r = await client.post('/api/torrents/controltorrent', {
        torrent_id: torrentId,
        operation,
      });
      return r.data;
    },

    // FIX: token = apiKey (for CDN auth), torrent_id = the actual ID
    async requestTorrentDl(torrentId, fileId = null, zipLink = false) {
      const params = {
        token: apiKey,
        torrent_id: torrentId,
        zip_link: zipLink,
      };
      if (fileId !== null && fileId !== undefined) params.file_id = fileId;
      const r = await client.get('/api/torrents/requestdl', { params });
      return r.data;
    },

    async checkCachedTorrent(hashes) {
      const hashList = Array.isArray(hashes) ? hashes.join(',') : hashes;
      const r = await client.get('/api/torrents/checkcached', {
        params: { hash: hashList, format: 'list', list_files: false },
      });
      return r.data;
    },

    async searchTorrents(query) {
      const r = await client.get('/api/torrents/search', { params: { query } });
      return r.data;
    },

    // ── Usenet ───────────────────────────────────────────────
    async getUsenetList(bypassCache = false) {
      const r = await client.get('/api/usenet/mylist', {
        params: { bypass_cache: bypassCache },
      });
      return r.data;
    },

    async createUsenet({ file, url, name = '' }) {
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      if (file) form.append('file', file.data, { filename: file.name, contentType: 'application/x-nzb' });
      if (url) form.append('link', url);
      if (name) form.append('name', name);

      const r = await client.post('/api/usenet/createusenetdownload', form, {
        headers: form.getHeaders(),
        timeout: 60000,
      });
      return r.data;
    },

    async controlUsenet(usenetId, operation) {
      const r = await client.post('/api/usenet/controlusenetdownload', {
        usenet_id: usenetId,
        operation,
      });
      return r.data;
    },

    // FIX: token = apiKey, usenet_id = the actual ID
    async requestUsenetDl(usenetId, fileId = null, zipLink = false) {
      const params = {
        token: apiKey,
        usenet_id: usenetId,
        zip_link: zipLink,
      };
      if (fileId !== null && fileId !== undefined) params.file_id = fileId;
      const r = await client.get('/api/usenet/requestdl', { params });
      return r.data;
    },

    // ── Web Downloads ────────────────────────────────────────
    async getWebDlList(bypassCache = false) {
      const r = await client.get('/api/webdl/mylist', {
        params: { bypass_cache: bypassCache },
      });
      return r.data;
    },

    async createWebDl({ url, name = '' }) {
      const r = await client.post('/api/webdl/createwebdownload', { link: url, name });
      return r.data;
    },

    async controlWebDl(webdlId, operation) {
      const r = await client.post('/api/webdl/controlwebdownload', {
        webdl_id: webdlId,
        operation,
      });
      return r.data;
    },

    // FIX: token = apiKey, web_id = the actual ID
    async requestWebDlDl(webdlId, fileId = null, zipLink = false) {
      const params = {
        token: apiKey,
        web_id: webdlId,
        zip_link: zipLink,
      };
      if (fileId !== null && fileId !== undefined) params.file_id = fileId;
      const r = await client.get('/api/webdl/requestdl', { params });
      return r.data;
    },

    // ── Queued ───────────────────────────────────────────────
    async getQueued(type = 'torrent') {
      const r = await client.get('/api/queued/getqueued', { params: { type } });
      return r.data;
    },

    async controlQueued(queuedId, operation, type = 'torrent') {
      const r = await client.post('/api/queued/controlqueued', {
        queued_id: queuedId,
        operation,
        type,
      });
      return r.data;
    },

    // ── RSS Feeds ─────────────────────────────────────────────
    async getRssFeeds() {
      const r = await client.get('/api/rss/myfeeds');
      return r.data;
    },
    async addRssFeed(url) {
      const r = await client.post('/api/rss/addfeed', { url });
      return r.data;
    },
    async controlRssFeed(feedId, operation) {
      const r = await client.post('/api/rss/controlfeed', { feed_id: feedId, operation });
      return r.data;
    },

    // ── Notifications ─────────────────────────────────────────
    async getNotifications() {
      const r = await client.get('/api/notifications/mynotifications');
      return r.data;
    },
    async clearNotifications() {
      const r = await client.post('/api/notifications/clear');
      return r.data;
    },

    // ── Search ────────────────────────────────────────────────
    async search(query, type = 'all') {
      const r = await client.get('/api/search/all', { params: { query, type } });
      return r.data;
    },

    // ── General Stats ─────────────────────────────────────────
    async getGeneralStats() {
      const r = await client.get('/api/stats');
      return r.data;
    },
  };
}

/** Extract infohash from magnet URI */
export function extractHashFromMagnet(magnet) {
  const match = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return match ? match[1].toUpperCase() : null;
}

/** Is this string a raw infohash (40 hex or 32 base32)? */
export function isInfohash(str) {
  return /^[a-fA-F0-9]{40}$/.test(str) || /^[a-zA-Z2-7]{32}$/.test(str);
}
