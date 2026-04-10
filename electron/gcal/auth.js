/**
 * Google Calendar OAuth2 — raw HTTPS, no googleapis package.
 *
 * Token storage: ~/.openclaw/gcal-tokens.json
 * Encrypted via electron.safeStorage when available, plaintext fallback.
 *
 * Exports: getAuthUrl, exchangeCode, getAccessToken, isConnected, disconnect,
 *          startCallbackServer, stopCallbackServer
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ---------------------------------------------------------------------------
// Google OAuth2 credentials — PLACEHOLDER, MODORO fills in real values
// ---------------------------------------------------------------------------
const CLIENT_ID = 'REPLACE_WITH_REAL_CLIENT_ID.apps.googleusercontent.com';
const CLIENT_SECRET = 'REPLACE_WITH_REAL_CLIENT_SECRET';
const REDIRECT_URI = 'http://127.0.0.1:20199/gcal/callback';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve token file path — same level as openclaw.json */
function tokenPath() {
  // Reuse getWorkspace from main.js via a simple heuristic:
  // ~/.openclaw/gcal-tokens.json (matches other gcal-config, sticky-chatid, etc.)
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const openclawDir = path.join(home, '.openclaw');
  try { fs.mkdirSync(openclawDir, { recursive: true }); } catch {}
  return path.join(openclawDir, 'gcal-tokens.json');
}

/** Try encrypt with safeStorage (Electron), fallback plaintext JSON */
function saveTokens(tokens) {
  const filePath = tokenPath();
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(JSON.stringify(tokens));
      fs.writeFileSync(filePath, encrypted);
      return;
    }
  } catch {}
  // Fallback: plaintext JSON
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2));
}

/** Load tokens — try decrypt, fallback parse JSON */
function loadTokens() {
  const filePath = tokenPath();
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath);
  // Try safeStorage decrypt first
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const decrypted = safeStorage.decryptString(raw);
      return JSON.parse(decrypted);
    }
  } catch {}
  // Fallback: try parsing as plaintext JSON
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth2 URL
// ---------------------------------------------------------------------------

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange / refresh via raw HTTPS
// ---------------------------------------------------------------------------

function httpsPost(hostname, pathStr, body) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request({
      hostname,
      path: pathStr,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error('Invalid JSON from Google: ' + Buffer.concat(chunks).toString().slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Token request timeout')); });
    req.write(data);
    req.end();
  });
}

async function exchangeCode(code) {
  const resp = await httpsPost('oauth2.googleapis.com', '/token', {
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  if (resp.error) throw new Error(resp.error_description || resp.error);
  const tokens = {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 - 60000, // 1 min buffer
    email: null,
  };
  // Fetch user email for display
  try {
    const info = await httpsGet('www.googleapis.com', '/oauth2/v2/userinfo', resp.access_token);
    tokens.email = info.email || null;
  } catch {}
  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('No refresh token available');
  const resp = await httpsPost('oauth2.googleapis.com', '/token', {
    refresh_token: tokens.refresh_token,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  if (resp.error) throw new Error(resp.error_description || resp.error);
  tokens.access_token = resp.access_token;
  tokens.expiresAt = Date.now() + (resp.expires_in || 3600) * 1000 - 60000;
  saveTokens(tokens);
  return tokens.access_token;
}

/** Get a valid access token, refreshing if expired */
async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Google Calendar not connected');
  if (Date.now() < tokens.expiresAt) return tokens.access_token;
  return await refreshAccessToken();
}

function isConnected() {
  const tokens = loadTokens();
  return !!(tokens && tokens.refresh_token);
}

function getEmail() {
  const tokens = loadTokens();
  return tokens?.email || null;
}

function disconnect() {
  const filePath = tokenPath();
  try { fs.unlinkSync(filePath); } catch {}
}

// ---------------------------------------------------------------------------
// HTTPS GET helper (used by calendar.js too)
// ---------------------------------------------------------------------------

function httpsGet(hostname, pathStr, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: pathStr,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) {
            reject(new Error(body.error?.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(body);
          }
        } catch (e) {
          reject(new Error('Invalid JSON from Google'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function httpsPostJson(hostname, pathStr, body, accessToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname,
      path: pathStr,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) {
            reject(new Error(body.error?.message || `HTTP ${res.statusCode}`));
          } else {
            resolve(body);
          }
        } catch (e) {
          reject(new Error('Invalid JSON from Google'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Temporary callback server for OAuth redirect
// ---------------------------------------------------------------------------

let _callbackServer = null;

/**
 * Start a temp HTTP server on port 20199 that waits for the OAuth callback.
 * Returns a promise that resolves with the tokens once the code is exchanged.
 */
function startCallbackServer() {
  return new Promise((resolve, reject) => {
    if (_callbackServer) {
      try { _callbackServer.close(); } catch {}
      _callbackServer = null;
    }

    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname === '/gcal/callback') {
        const code = parsed.query.code;
        const error = parsed.query.error;

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Ket noi that bai</h2><p>' + error + '</p><p>Ban co the dong tab nay.</p></body></html>');
          stopCallbackServer();
          reject(new Error(error));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Loi</h2><p>Khong nhan duoc ma xac thuc.</p></body></html>');
          return;
        }

        try {
          const tokens = await exchangeCode(code);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Ket noi thanh cong!</h2><p>Google Calendar da duoc ket noi voi MODOROClaw.</p><p>Ban co the dong tab nay.</p></body></html>');
          stopCallbackServer();
          resolve(tokens);
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Loi</h2><p>' + (e.message || 'Unknown error') + '</p></body></html>');
          stopCallbackServer();
          reject(e);
        }
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(20199, '127.0.0.1', () => {
      _callbackServer = server;
      console.log('[gcal] OAuth callback server listening on http://127.0.0.1:20199');
    });

    server.on('error', (err) => {
      console.error('[gcal] Callback server error:', err.message);
      reject(err);
    });

    // Auto-close after 5 minutes if no callback received
    setTimeout(() => {
      if (_callbackServer === server) {
        stopCallbackServer();
        reject(new Error('OAuth timeout — no callback received within 5 minutes'));
      }
    }, 5 * 60 * 1000);
  });
}

function stopCallbackServer() {
  if (_callbackServer) {
    try { _callbackServer.close(); } catch {}
    _callbackServer = null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAccessToken,
  isConnected,
  getEmail,
  disconnect,
  startCallbackServer,
  stopCallbackServer,
  // Expose for calendar.js
  httpsGet,
  httpsPostJson,
};
