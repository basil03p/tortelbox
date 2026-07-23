// ============================================================
// Gofile.io Uploader — Streams TorBox downloads to Gofile
// ============================================================
import axios from 'axios';
import FormData from 'form-data';

/**
 * Upload a readable stream or buffer to Gofile.io
 * @param {import('stream').Readable | Buffer} stream - File stream or buffer
 * @param {string} fileName - File name with extension
 * @returns {Promise<{ ok: boolean, downloadPage?: string, fileName?: string, detail?: string }>}
 */
export async function uploadToGofile(stream, fileName = 'download.zip') {
  try {
    // 1. Get available server node from Gofile API
    const serverRes = await axios.get('https://api.gofile.io/servers', { timeout: 10000 });
    const servers = serverRes?.data?.data?.servers;
    if (!servers || !servers.length) {
      return { ok: false, detail: 'No Gofile servers available at the moment.' };
    }

    const serverName = servers[0].name;

    // 2. Prepare multipart form data
    const form = new FormData();
    form.append('file', stream, { filename: fileName });

    // 3. Upload to target server
    const uploadRes = await axios.post(
      `https://${serverName}.gofile.io/contents/uploadfile`,
      form,
      {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 600000, // 10 min timeout
      }
    );

    const data = uploadRes?.data?.data;
    if (uploadRes?.data?.status === 'ok' && data?.downloadPage) {
      return {
        ok: true,
        downloadPage: data.downloadPage,
        fileId: data.id,
        fileName: data.name || fileName,
      };
    }

    return { ok: false, detail: uploadRes?.data?.error || 'Gofile upload failed.' };
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'Network error during Gofile upload';
    return { ok: false, detail: msg };
  }
}

/**
 * Stream a remote URL directly to Gofile.io
 * @param {string} downloadUrl - TorBox direct download URL
 * @param {string} fileName - Destination file name
 */
export async function streamUrlToGofile(downloadUrl, fileName) {
  try {
    const res = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 120000,
    });

    return await uploadToGofile(res.data, fileName);
  } catch (err) {
    return { ok: false, detail: err.message || 'Failed to stream file from TorBox.' };
  }
}
