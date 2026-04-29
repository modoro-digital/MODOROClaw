#!/usr/bin/env node
// Local license key manager — run: node license-manager.js
// Opens http://localhost:3847 with a simple UI to generate/list/revoke keys.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PORT = 3847;
const PRIVATE_KEY_PATH = path.join(os.homedir(), '.claw-license-private.pem');
const ISSUED_LOG_PATH = path.join(os.homedir(), '.claw-license-issued.jsonl');

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadPrivateKey() {
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8'));
}

function generateKey(email, months, plan) {
  const privateKey = loadPrivateKey();
  const now = new Date();
  const expiry = new Date(now);
  expiry.setMonth(expiry.getMonth() + months);
  const payload = {
    e: email,
    p: plan || 'premium',
    i: now.toISOString().slice(0, 10),
    v: expiry.toISOString().slice(0, 10),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
  const signature = crypto.sign(null, payloadBytes, privateKey);
  const combined = Buffer.concat([payloadBytes, signature]);
  const key = 'CLAW-' + base64urlEncode(combined);
  const entry = {
    email,
    plan: payload.p,
    issued: payload.i,
    expires: payload.v,
    keyHash: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
    key,
  };
  fs.appendFileSync(ISSUED_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

function listKeys() {
  if (!fs.existsSync(ISSUED_LOG_PATH)) return [];
  return fs.readFileSync(ISSUED_LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function deleteKey(keyHash) {
  if (!fs.existsSync(ISSUED_LOG_PATH)) return false;
  const lines = fs.readFileSync(ISSUED_LOG_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  const filtered = lines.filter(line => {
    try { return JSON.parse(line).keyHash !== keyHash; } catch { return true; }
  });
  fs.writeFileSync(ISSUED_LOG_PATH, filtered.join('\n') + (filtered.length ? '\n' : ''), 'utf-8');
  return lines.length !== filtered.length;
}

const HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>9BizClaw License Manager</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0f; color: #e4e4e7; min-height: 100vh; }
  .container { max-width: 900px; margin: 0 auto; padding: 48px 24px; }
  h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px; }
  .subtitle { color: #71717a; font-size: 14px; margin-bottom: 48px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 28px; margin-bottom: 32px; }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 20px; color: #f4f4f5; }
  .form-row { display: flex; gap: 12px; margin-bottom: 16px; }
  .form-group { flex: 1; }
  .form-group label { display: block; font-size: 12px; font-weight: 600; color: #a1a1aa; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  input, select { width: 100%; padding: 10px 14px; background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #e4e4e7; font-size: 14px; outline: none; transition: border-color 0.2s; }
  input:focus, select:focus { border-color: #3b82f6; }
  select { cursor: pointer; }
  button { padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  button:hover { background: #2563eb; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .btn-copy { background: #27272a; color: #a1a1aa; }
  .btn-copy:hover { background: #3f3f46; color: #e4e4e7; }
  .btn-delete { background: transparent; color: #ef4444; border: 1px solid #7f1d1d; }
  .btn-delete:hover { background: #7f1d1d; color: white; }
  .result { margin-top: 16px; padding: 16px; background: #09090b; border: 1px solid #27272a; border-radius: 8px; display: none; }
  .result.visible { display: block; animation: fadeIn 0.3s; }
  .result-key { font-family: 'SF Mono', 'Cascadia Code', monospace; font-size: 12px; word-break: break-all; line-height: 1.6; color: #22c55e; margin: 8px 0; padding: 12px; background: #0a0a0f; border-radius: 6px; user-select: all; }
  .result-meta { font-size: 12px; color: #71717a; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px; border-bottom: 1px solid #27272a; }
  td { font-size: 13px; padding: 12px; border-bottom: 1px solid #18181b; }
  tr:hover td { background: #18181b; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-premium { background: #1e3a5f; color: #60a5fa; }
  .badge-enterprise { background: #3b1f5e; color: #a78bfa; }
  .badge-expired { background: #3b1212; color: #f87171; }
  .badge-active { background: #0f2e1a; color: #4ade80; }
  .empty { text-align: center; color: #52525b; padding: 40px; font-size: 14px; }
  .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; background: #22c55e; color: #09090b; border-radius: 8px; font-size: 13px; font-weight: 600; transform: translateY(100px); opacity: 0; transition: all 0.3s; }
  .toast.show { transform: translateY(0); opacity: 1; }
  .count { color: #71717a; font-weight: 400; font-size: 14px; margin-left: 8px; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
</head>
<body>
<div class="container">
  <h1>9BizClaw License Manager</h1>
  <p class="subtitle">Tạo và quản lý license key cho khách hàng Premium</p>

  <div class="card">
    <h2>Tạo key mới</h2>
    <div class="form-row">
      <div class="form-group" style="flex:2">
        <label>Email khách hàng</label>
        <input type="email" id="email" placeholder="customer@company.com">
      </div>
      <div class="form-group">
        <label>Thời hạn</label>
        <select id="months">
          <option value="1">1 tháng</option>
          <option value="3">3 tháng</option>
          <option value="6">6 tháng</option>
          <option value="12" selected>12 tháng</option>
          <option value="24">24 tháng</option>
          <option value="36">36 tháng</option>
        </select>
      </div>
      <div class="form-group">
        <label>Gói</label>
        <select id="plan">
          <option value="premium">Premium</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </div>
    </div>
    <button onclick="generateKey()">Tạo license key</button>
    <div class="result" id="result">
      <div class="result-meta" id="result-meta"></div>
      <div class="result-key" id="result-key"></div>
      <button class="btn-sm btn-copy" onclick="copyKey()">Copy key</button>
    </div>
  </div>

  <div class="card">
    <h2>Danh sách key<span class="count" id="key-count"></span></h2>
    <div id="key-list"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2000);
}

function copyKey() {
  var key = document.getElementById('result-key').textContent;
  navigator.clipboard.writeText(key).then(function() { toast('Key copied!'); });
}

function copyFromList(hash) {
  var el = document.querySelector('[data-hash="' + hash + '"]');
  if (el) navigator.clipboard.writeText(el.textContent).then(function() { toast('Key copied!'); });
}

async function generateKey() {
  var emailEl = document.getElementById('email');
  var email = emailEl.value.trim();
  if (!email) { emailEl.focus(); emailEl.style.borderColor = '#ef4444'; setTimeout(function() { emailEl.style.borderColor = ''; }, 2000); return; }
  var btn = document.querySelector('.card button:not(.btn-sm)');
  btn.disabled = true; btn.textContent = 'Dang tao...';
  try {
    var months = document.getElementById('months').value;
    var plan = document.getElementById('plan').value;
    var res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, months: parseInt(months), plan: plan })
    });
    var data = await res.json();
    if (data.error) { alert(data.error); return; }
    var r = document.getElementById('result');
    r.classList.add('visible');
    document.getElementById('result-meta').textContent = data.email + ' — ' + data.plan + ' — ' + data.issued + ' → ' + data.expires;
    document.getElementById('result-key').textContent = data.key;
    emailEl.value = '';
    toast('Key created!');
    loadKeys();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Tao license key';
  }
}

async function deleteKey(hash) {
  if (!confirm('Xoa key nay?')) return;
  await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyHash: hash })
  });
  loadKeys();
  toast('Key deleted');
}

async function loadKeys() {
  var res = await fetch('/api/list');
  var keys = await res.json();
  document.getElementById('key-count').textContent = '(' + keys.length + ')';
  if (!keys.length) {
    document.getElementById('key-list').innerHTML = '<div class="empty">Chua co key nao</div>';
    return;
  }
  var now = new Date().toISOString().slice(0, 10);
  var html = '<table><thead><tr><th>Email</th><th>Goi</th><th>Ngay tao</th><th>Het han</th><th>Trang thai</th><th></th></tr></thead><tbody>';
  keys.reverse().forEach(function(k) {
    var expired = k.expires < now;
    var badge = expired ? '<span class="badge badge-expired">Het han</span>' : '<span class="badge badge-active">Active</span>';
    var planBadge = k.plan === 'enterprise' ? 'badge-enterprise' : 'badge-premium';
    html += '<tr>';
    html += '<td>' + esc(k.email) + '</td>';
    html += '<td><span class="badge ' + planBadge + '">' + esc(k.plan) + '</span></td>';
    html += '<td>' + esc(k.issued) + '</td>';
    html += '<td>' + esc(k.expires) + '</td>';
    html += '<td>' + badge + '</td>';
    html += '<td style="text-align:right;white-space:nowrap">';
    if (k.key) html += '<button class="btn-sm btn-copy" onclick="copyFromList(\\'' + k.keyHash + '\\')">Copy</button> ';
    html += '<button class="btn-sm btn-delete" onclick="deleteKey(\\'' + k.keyHash + '\\')">Xoa</button>';
    html += '</td>';
    html += '</tr>';
    if (k.key) html += '<tr style="display:none"><td colspan="6"><span data-hash="' + k.keyHash + '">' + esc(k.key) + '</span></td></tr>';
  });
  html += '</tbody></table>';
  document.getElementById('key-list').innerHTML = html;
}

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

loadKeys();
document.getElementById('email').addEventListener('keydown', function(e) { if (e.key === 'Enter') generateKey(); });
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listKeys()));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/generate') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email, months, plan } = JSON.parse(body);
        if (!email || !email.includes('@')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Email không hợp lệ' }));
          return;
        }
        const entry = generateKey(email, parseInt(months) || 12, plan || 'premium');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entry));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/delete') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { keyHash } = JSON.parse(body);
        deleteKey(keyHash);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  9BizClaw License Manager running at ${url}\n`);
  try {
    const cmd = process.platform === 'win32' ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    execSync(cmd, { stdio: 'ignore' });
  } catch {}
});
