// Facebook Graph API — page posting (publish-only)

const https = require('https');
const crypto = require('crypto');
const path = require('path');

const GRAPH_API = 'graph.facebook.com';
const API_VERSION = 'v25.0';
const RESPONSE_TIMEOUT_MS = 30000;

function graphRequest(method, endpoint, token, body) {
  return new Promise((resolve, reject) => {
    const url = `/${API_VERSION}${endpoint}`;
    const isPost = method === 'POST';
    const payload = isPost && body ? JSON.stringify(body) : null;
    const headers = { 'Authorization': `Bearer ${token}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: GRAPH_API, path: url, method, headers }, res => {
      let d = '';
      const bodyTimer = setTimeout(() => { req.destroy(); reject(new Error('response body timeout')); }, RESPONSE_TIMEOUT_MS);
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(bodyTimer);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'Graph API error'));
          resolve(parsed);
        } catch { reject(new Error('Invalid JSON from Graph API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('connect timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function detectMime(imagePath) {
  const ext = path.extname(imagePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function graphMultipartPhoto(pageId, token, message, imageBuffer, imagePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----FBBoundary' + crypto.randomBytes(16).toString('hex');
    const safeMessage = String(message).replace(/\r/g, '');
    let body = '';
    body += `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${safeMessage}\r\n`;
    const mime = detectMime(imagePath);
    const ext = mime.split('/')[1] || 'png';
    body += `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="image.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const prefix = Buffer.from(body, 'utf-8');
    const suffix = Buffer.from(tail, 'utf-8');
    const payload = Buffer.concat([prefix, imageBuffer, suffix]);

    const req = https.request({
      hostname: GRAPH_API,
      path: `/${API_VERSION}/${pageId}/photos`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      }
    }, res => {
      let d = '';
      const bodyTimer = setTimeout(() => { req.destroy(); reject(new Error('response body timeout')); }, RESPONSE_TIMEOUT_MS);
      res.on('data', c => d += c);
      res.on('end', () => {
        clearTimeout(bodyTimer);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed);
        } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('connect timeout')); });
    req.write(payload);
    req.end();
  });
}

function formatPostUrl(compoundId) {
  if (!compoundId) return null;
  const parts = String(compoundId).split('_');
  if (parts.length === 2) return `https://www.facebook.com/${parts[0]}/posts/${parts[1]}`;
  return `https://www.facebook.com/${compoundId}`;
}

function hasPageCreateContentTask(tasks) {
  if (!Array.isArray(tasks)) return true;
  return tasks.includes('CREATE_CONTENT') || tasks.includes('PROFILE_PLUS_CREATE_CONTENT');
}

async function verifyToken(token) {
  if (!token || !String(token).trim()) {
    return { valid: false, error: 'Token Facebook trống.' };
  }
  const requiredMsg = 'Token cần là Page Access Token hoặc User Token có pages_show_list, pages_manage_posts, pages_read_engagement và Page task CREATE_CONTENT.';
  try {
    const data = await graphRequest('GET', '/me/accounts?fields=id,name,access_token,tasks&limit=25', token);
    if (data.data && data.data.length > 0) {
      const page = data.data.find(p => p && p.access_token && hasPageCreateContentTask(p.tasks));
      if (!page) {
        return { valid: false, error: 'Không tìm thấy Fanpage có quyền tạo nội dung. ' + requiredMsg };
      }
      return { valid: true, pageId: page.id, pageName: page.name, pageToken: page.access_token };
    }
    return { valid: false, error: 'Không tìm thấy Fanpage nào. ' + requiredMsg };
  } catch (accountsErr) {
    try {
      const page = await graphRequest('GET', '/me?fields=id,name,category', token);
      if (page.id && page.category !== undefined) {
        return { valid: true, pageId: page.id, pageName: page.name, pageToken: token };
      }
      return { valid: false, error: requiredMsg };
    } catch (pageErr) {
      return { valid: false, error: accountsErr.message || pageErr.message || requiredMsg };
    }
  }
}

async function postText(pageId, token, message) {
  const data = await graphRequest('POST', `/${pageId}/feed`, token, { message });
  return { postId: data.id, postUrl: formatPostUrl(data.id) };
}

async function postPhoto(pageId, token, message, imageBuffer, imagePath) {
  const data = await graphMultipartPhoto(pageId, token, message, imageBuffer, imagePath);
  const postId = data.post_id || data.id;
  return { postId, postUrl: formatPostUrl(postId) };
}

async function getRecentPosts(pageId, token, limit = 5) {
  const data = await graphRequest('GET',
    `/${pageId}/feed?fields=message,created_time,full_picture&limit=${limit}`, token);
  return data.data || [];
}

module.exports = { verifyToken, postText, postPhoto, getRecentPosts, _test: { hasPageCreateContentTask } };
