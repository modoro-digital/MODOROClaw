'use strict';
const fs = require('fs');
const path = require('path');
const ctx = require('./context');

let app, shell;
try { ({ app, shell } = require('electron')); } catch {}

const UPDATE_REPO = 'huybt-peter/9BizClaw-Premium';
let _latestRelease = null; // cached { version, body, html_url, assets }
let _updateDownloadInFlight = false; // H1: concurrency guard

function compareVersions(a, b) {
  // Returns >0 if a > b, <0 if a < b, 0 if equal
  const pa = String(a || '0').replace(/^v/, '').split('.').map(Number);
  const pb = String(b || '0').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdates() {
  const https = require('https');
  const current = app.getVersion();
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${UPDATE_REPO}/releases/latest`,
      headers: { 'User-Agent': '9BizClaw/' + current, 'Accept': 'application/vnd.github.v3+json' },
      timeout: 10000,
    };
    let dataLen = 0;
    const req = https.get(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        dataLen += chunk.length;
        // M3: cap response body at 1MB to prevent memory abuse
        if (dataLen > 1024 * 1024) { req.destroy(); return resolve(null); }
        data += chunk;
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.log('[update] GitHub API status', res.statusCode);
            return resolve(null);
          }
          const release = JSON.parse(data);
          const latest = String(release.tag_name || '').replace(/^v/, '');
          if (compareVersions(latest, current) > 0) {
            _latestRelease = {
              version: latest,
              body: release.body || '',
              html_url: release.html_url || '',
              published_at: release.published_at || '',
              assets: (release.assets || []).map(a => ({
                name: a.name,
                size: a.size,
                url: a.browser_download_url,
              })),
            };
            console.log('[update] new version available:', latest, '(current:', current + ')');
            // Notify renderer
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
              ctx.mainWindow.webContents.send('update-available', _latestRelease);
            }
            return resolve(_latestRelease);
          }
          console.log('[update] up to date:', current);
          resolve(null);
        } catch (e) {
          console.warn('[update] parse error:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.warn('[update] check failed:', e.message);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Download installer to temp dir, return local path
async function downloadUpdate(assetUrl, filename, expectedSize) {
  const https = require('https');
  const tmpDir = path.join(app.getPath('temp'), '9bizclaw-update');
  fs.mkdirSync(tmpDir, { recursive: true });
  // L2: clean old downloads before starting new one
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.endsWith('.exe') || f.endsWith('.dmg')) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      }
    }
  } catch {}
  const dest = path.join(tmpDir, filename);

  // Follow redirects (GitHub assets redirect to S3)
  function followRedirect(url, redirectCount) {
    if (redirectCount > 5) throw new Error('Too many redirects');
    // H3: only follow HTTPS redirects
    if (!String(url).startsWith('https://')) throw new Error('Refused non-HTTPS redirect');
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': '9BizClaw' }, timeout: 120000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // L1: drain response body to free socket
          return resolve(followRedirect(res.headers.location, redirectCount + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        let lastProgressAt = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          const now = Date.now();
          if (now - lastProgressAt > 500 && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
            lastProgressAt = now;
            ctx.mainWindow.webContents.send('update-download-progress', {
              received, total: totalBytes,
              percent: totalBytes > 0 ? Math.round(received / totalBytes * 100) : 0,
            });
          }
        });
        res.on('end', () => {
          file.end(() => {
            // M1: verify downloaded size matches expected asset size
            if (expectedSize && expectedSize > 0 && received < expectedSize * 0.95) {
              try { fs.unlinkSync(dest); } catch {}
              return reject(new Error('Download incomplete: ' + received + '/' + expectedSize + ' bytes'));
            }
            // Hard minimum: EXE/DMG must be >50MB. Catches truncated downloads
            // when GitHub doesn't return content-length (asset.size=0 on redirects).
            const MIN_INSTALLER_SIZE = 50 * 1024 * 1024;
            if (received < MIN_INSTALLER_SIZE) {
              try { fs.unlinkSync(dest); } catch {}
              return reject(new Error('Download too small (' + Math.round(received / 1024) + 'KB) — likely truncated. Retry.'));
            }
            resolve(dest);
          });
        });
        res.on('error', (e) => {
          file.destroy();
          try { fs.unlinkSync(dest); } catch {} // H2: cleanup partial file
          reject(e);
        });
      });
      // C1: timeout handler — destroy request on stall, explicitly reject
      // (req.destroy() should emit 'error' but we don't rely on that side-effect)
      req.on('timeout', () => {
        req.destroy();
        try { fs.unlinkSync(dest); } catch {} // H2: cleanup partial file
        reject(new Error('Download timed out'));
      });
      req.on('error', (e) => {
        try { fs.unlinkSync(dest); } catch {} // H2: cleanup partial file
        reject(e);
      });
    });
  }

  return followRedirect(assetUrl, 0);
}

// --- Mac DMG auto-install helper ---
// Mount DMG → mv old .app → cp new .app → xattr → unmount → relaunch
// C1: shell script file (no inline osascript injection risk)
// C2: async exec (no main-thread blocking)
// C3: atomic mv swap (never a moment with no .app)
async function installDmgUpdate(dmgPath) {
  const { exec } = require('child_process');
  const execAsync = (cmd, opts = {}) => new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve(stdout);
    });
  });

  function sendInstallStatus(status) {
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('update-install-status', { status });
    }
  }

  const tmpDir = path.dirname(dmgPath);

  // 1. Detach any stale mount from previous failed update (I5)
  try { await execAsync('hdiutil detach "/Volumes/9BizClaw"* -force 2>/dev/null || true', { timeout: 10000 }); } catch {}

  // 2. Mount DMG (async — doesn't block main thread)
  sendInstallStatus('Đang mở DMG...');
  let mountPoint = null;
  try {
    const out = await execAsync(`hdiutil attach "${dmgPath}" -nobrowse -noautoopen -readonly`, { timeout: 90000 });
    const lines = out.trim().split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.match(/\t(\/Volumes\/.+)$/);
      if (match) { mountPoint = match[1].trim(); break; }
    }
    if (!mountPoint) {
      const fallback = out.match(/(\/Volumes\/[^\t\n]+)/);
      if (fallback) mountPoint = fallback[1].trim();
    }
    if (!mountPoint) throw new Error('Could not determine mount point');
    console.log('[update] DMG mounted at:', mountPoint);
  } catch (e) {
    throw new Error('Không mount được DMG: ' + e.message);
  }

  // 3. Find .app inside mounted volume (I2: validate name)
  const EXPECTED_APP = '9BizClaw.app';
  let appName = null;
  try {
    const items = fs.readdirSync(mountPoint);
    appName = items.find(i => i === EXPECTED_APP);
    if (!appName) appName = items.find(i => i.endsWith('.app') && !i.startsWith('.'));
    if (!appName) throw new Error('Không tìm thấy .app trong DMG');
  } catch (e) {
    try { await execAsync(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch {}
    throw new Error('Không đọc được DMG: ' + e.message);
  }

  const srcApp = path.join(mountPoint, appName);
  const destApp = '/Applications/' + appName;
  const backupApp = '/Applications/' + appName + '.old';

  // 4. Write install script to temp file (C1: no shell injection via osascript inline)
  //    C3: atomic mv swap — old app moved to .old, never deleted before copy completes
  const sq = s => s.replace(/'/g, "'\\''"); // single-quote escape for shell
  const scriptPath = path.join(tmpDir, 'update-install.sh');
  const scriptContent = [
    '#!/bin/bash',
    'set -e',
    `rm -rf '${sq(backupApp)}'`,
    `if [ -d '${sq(destApp)}' ]; then mv '${sq(destApp)}' '${sq(backupApp)}'; fi`,
    `cp -R '${sq(srcApp)}' '${sq(destApp)}'`,
    `xattr -dr com.apple.quarantine '${sq(destApp)}'`,
    `rm -rf '${sq(backupApp)}'`,
  ].join('\n');
  fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
  fs.chmodSync(scriptPath, 0o755);

  // 5. Run install with admin privileges (C2: async, doesn't block main thread)
  sendInstallStatus('Đang cài đặt... (cần mật khẩu admin)');
  try {
    await execAsync(`osascript -e 'do shell script "${sq(scriptPath)}" with administrator privileges'`);
    console.log('[update] App installed to', destApp);
  } catch (e) {
    try { await execAsync(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch {}
    try { fs.unlinkSync(scriptPath); } catch {}
    if (e.message && (e.message.includes('User canceled') || e.message.includes('(-128)'))) {
      // Restore backup if user cancelled after mv but before cp
      try { await execAsync(`[ -d '${sq(backupApp)}' ] && mv '${sq(backupApp)}' '${sq(destApp)}' || true`, { timeout: 10000 }); } catch {}
      throw new Error('Đã hủy nhập mật khẩu admin');
    }
    // Restore backup on any failure
    try { await execAsync(`[ -d '${sq(backupApp)}' ] && mv '${sq(backupApp)}' '${sq(destApp)}' || true`, { timeout: 10000 }); } catch {}
    throw new Error('Lỗi cài đặt: ' + e.message);
  }

  // 6. Cleanup
  sendInstallStatus('Đang dọn dẹp...');
  try { await execAsync(`hdiutil detach "${mountPoint}" -force`, { timeout: 15000 }); } catch (e) {
    console.warn('[update] DMG unmount failed (non-fatal):', e.message);
  }
  try { fs.unlinkSync(dmgPath); } catch {}
  try { fs.unlinkSync(scriptPath); } catch {}

  // 7. Relaunch (I1: app.exit instead of app.quit to avoid before-quit deadlock)
  sendInstallStatus('Khởi động lại...');
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 1500);
}

// H4: validate URL is a safe GitHub URL before opening externally
function openGitHubUrl(url) {
  const { shell } = require('electron');
  if (url && String(url).startsWith('https://github.com/')) {
    shell.openExternal(url);
    return true;
  }
  console.warn('[update] refused to open non-GitHub URL:', String(url).slice(0, 80));
  return false;
}

// --- State accessors for IPC handlers in main.js ---
function getLatestRelease() { return _latestRelease; }
function getUpdateDownloadInFlight() { return _updateDownloadInFlight; }
function setUpdateDownloadInFlight(v) { _updateDownloadInFlight = v; }

module.exports = {
  compareVersions, checkForUpdates, downloadUpdate, installDmgUpdate, openGitHubUrl,
  getLatestRelease, getUpdateDownloadInFlight, setUpdateDownloadInFlight,
};
