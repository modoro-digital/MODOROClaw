'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getWorkspace } = require('./workspace');
const { appDataDir } = require('./boot');

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------
const BACKUP_VERSION = 1;
// Oldest app version whose restore schema is still compatible with the current
// backup format. Raise this constant ONLY when a genuinely backward-incompatible
// backup format change ships (e.g. new required section, changed archive layout).
// Do NOT set it to appVersion — that would permanently lock out rollback restores.
const MIN_RESTORE_FLOOR = '2.4.0';
const SKIP_DIRS = new Set(['logs', 'backups', 'vendor', 'node_modules', '.git']);
const SKIP_FILES = new Set(['.machine-id']);

// ---------------------------------------------------------------------------
//  _collectDir — recursive directory walker
// ---------------------------------------------------------------------------
function _collectDir(baseDir, relPrefix, skipDirs, skipFiles) {
  const results = [];
  if (!baseDir || !fs.existsSync(baseDir)) return results;

  function walk(dir, relPath) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = relPath ? relPath + '/' + ent.name : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (skipFiles.has(ent.name)) continue;
        results.push({ abs, rel: relPrefix + '/' + rel });
      }
    }
  }

  walk(baseDir, '');
  return results;
}

// ---------------------------------------------------------------------------
//  _collectExplicitFiles — collect specific files that exist
// ---------------------------------------------------------------------------
function _collectExplicitFiles(pairs) {
  const results = [];
  for (const { abs, rel } of pairs) {
    try { if (fs.existsSync(abs) && fs.statSync(abs).isFile()) results.push({ abs, rel }); } catch {}
  }
  return results;
}

function _get9RouterDataDir(appData) {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === 'win32') return path.join(appData, '9router');
  return path.join(os.homedir(), '.9router');
}

// ---------------------------------------------------------------------------
//  collectBackupFiles — main collector (5 sources)
// ---------------------------------------------------------------------------
function collectBackupFiles() {
  const files = [];
  const ws = getWorkspace();
  const home = os.homedir();
  const appData = appDataDir();

  // --- 1. Workspace ---
  const wsDirs = [
    'memory', 'knowledge', 'skills', 'user-skills', 'prompts', 'tools',
    'docs', 'personas', 'media-assets', 'brand-assets', 'documents',
    '.learnings', 'config', 'zalo-account-settings',
  ];
  for (const d of wsDirs) {
    files.push(..._collectDir(path.join(ws, d), 'workspace/' + d, SKIP_DIRS, SKIP_FILES));
  }

  const wsMdFiles = [
    'AGENTS', 'SOUL', 'IDENTITY', 'COMPANY', 'PRODUCTS', 'USER',
    'MEMORY', 'BOOTSTRAP', 'TOOLS', 'CEO-MEMORY',
  ];
  for (const name of wsMdFiles) {
    files.push(..._collectExplicitFiles([{ abs: path.join(ws, name + '.md'), rel: 'workspace/' + name + '.md' }]));
  }

  const wsJsonFiles = [
    'schedules', 'custom-crons', 'active-persona', 'zalo-group-settings',
    'zalo-user-settings', // internal-user flag (read by inbound.ts __mcReadUserSettings) — back up alongside group settings
    'zalo-blocklist', 'zalo-allowlist', 'zalo-stranger-policy', 'shop-state',
    'media-library',
    'app-prefs', 'setup-complete', 'follow-up-queue',
    'appointments', // calendar appointments written by bot + dispatcher
    'telegram-paused', 'zalo-paused', // channel pause state (channels.js pauseChannel)
    'zalo-thread-paused', // per-thread takeover pause (inbound.ts /tamdung command)
  ];
  for (const name of wsJsonFiles) {
    files.push(..._collectExplicitFiles([{ abs: path.join(ws, name + '.json'), rel: 'workspace/' + name + '.json' }]));
  }

  const wsDbFiles = ['memory.db', 'memory.db-wal', 'memory.db-shm'];
  for (const name of wsDbFiles) {
    files.push(..._collectExplicitFiles([{ abs: path.join(ws, name), rel: 'workspace/' + name }]));
  }

  // --- 2. OpenClaw (~/.openclaw/) ---
  const ocDir = path.join(home, '.openclaw');
  files.push(..._collectExplicitFiles([{ abs: path.join(ocDir, 'openclaw.json'), rel: 'openclaw/openclaw.json' }]));

  // Glob: modoroclaw-sticky-*.json
  try {
    if (fs.existsSync(ocDir)) {
      for (const f of fs.readdirSync(ocDir)) {
        if (f.startsWith('modoroclaw-sticky-') && f.endsWith('.json')) {
          const abs = path.join(ocDir, f);
          try { if (fs.statSync(abs).isFile()) files.push({ abs, rel: 'openclaw/' + f }); } catch {}
        }
      }
    }
  } catch {}

  files.push(..._collectDir(path.join(ocDir, 'identity'), 'openclaw/identity', SKIP_DIRS, SKIP_FILES));
  files.push(..._collectExplicitFiles([{ abs: path.join(ocDir, 'cron', 'jobs.json'), rel: 'openclaw/cron/jobs.json' }]));

  // --- 3. Openzca (~/.openzca/) ---
  const zcaDir = path.join(home, '.openzca');
  const zcaFiles = [
    { abs: path.join(zcaDir, 'profiles.json'), rel: 'openzca/profiles.json' },
    { abs: path.join(zcaDir, 'profiles', 'default', 'credentials.json'), rel: 'openzca/profiles/default/credentials.json' },
    { abs: path.join(zcaDir, 'profiles', 'default', 'listener-owner.json'), rel: 'openzca/profiles/default/listener-owner.json' },
    { abs: path.join(zcaDir, 'profiles', 'default', 'cache', 'friends.json'), rel: 'openzca/profiles/default/cache/friends.json' },
    { abs: path.join(zcaDir, 'profiles', 'default', 'cache', 'groups.json'), rel: 'openzca/profiles/default/cache/groups.json' },
  ];
  files.push(..._collectExplicitFiles(zcaFiles));

  // --- 4. 9Router (appDataDir/9router/) ---
  const nrDir = _get9RouterDataDir(appData);
  files.push(..._collectExplicitFiles([
    { abs: path.join(nrDir, 'db.json'), rel: '9router/db.json' },
    { abs: path.join(nrDir, 'machine-id'), rel: '9router/machine-id' },
    { abs: path.join(nrDir, 'auth', 'cli-secret'), rel: '9router/auth/cli-secret' },
    { abs: path.join(nrDir, 'db', 'data.sqlite'), rel: '9router/db/data.sqlite' },
    { abs: path.join(nrDir, 'db', 'data.sqlite-wal'), rel: '9router/db/data.sqlite-wal' },
    { abs: path.join(nrDir, 'db', 'data.sqlite-shm'), rel: '9router/db/data.sqlite-shm' },
  ]));

  // --- 5. Provider keys (appDataDir/) ---
  files.push(..._collectExplicitFiles([{ abs: path.join(appData, 'modoroclaw-provider-keys.json'), rel: 'provider-keys/modoroclaw-provider-keys.json' }]));

  return files;
}

// ---------------------------------------------------------------------------
//  buildManifest
// ---------------------------------------------------------------------------
function buildManifest(files, appVersion) {
  const sections = {};
  let sizeBytes = 0;
  for (const f of files) {
    const section = f.rel.split('/')[0];
    sections[section] = (sections[section] || 0) + 1;
    try { sizeBytes += fs.statSync(f.abs).size; } catch {}
  }
  return {
    version: BACKUP_VERSION,
    app: '9bizclaw',
    appVersion,
    minRestoreVersion: MIN_RESTORE_FLOOR,
    createdAt: new Date().toISOString(),
    machine: os.hostname(),
    platform: process.platform,
    fileCount: files.length,
    sizeBytes,
    sections,
  };
}

// ---------------------------------------------------------------------------
//  checkpointMemoryDb — flush WAL before backup
// ---------------------------------------------------------------------------
function checkpointMemoryDb() {
  try {
    const { getDocumentsDb } = require('./knowledge');
    const db = getDocumentsDb();
    if (db) db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[backup] WAL checkpoint failed (non-fatal):', e.message);
  }
}

// ---------------------------------------------------------------------------
//  Crypto helpers
// ---------------------------------------------------------------------------
function _deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}

function _encrypt(buffer, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = _deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [16-byte salt][12-byte IV][ciphertext][16-byte auth tag]
  return Buffer.concat([salt, iv, encrypted, tag]);
}

function _decrypt(buffer, password) {
  if (!buffer || buffer.length < 45) {
    throw new Error('Buffer too small to contain encrypted data');
  }
  const salt = buffer.subarray(0, 16);
  const iv = buffer.subarray(16, 28);
  const tag = buffer.subarray(buffer.length - 16);
  const ciphertext = buffer.subarray(28, buffer.length - 16);
  const key = _deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
//  Tar helpers
// ---------------------------------------------------------------------------
function _getTarBin() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

function _compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
//  createBackup — main backup function
// ---------------------------------------------------------------------------
function createBackup(outputPath, password, appVersion) {
  if (!password || password.length < 4) throw new Error('Password too short (min 4 chars)');

  // 1. Flush WAL
  checkpointMemoryDb();

  // 2. Collect files
  const files = collectBackupFiles();
  if (files.length === 0) throw new Error('No files to back up');

  // 3. Stage into temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9bizclaw-backup-'));
  const stageDir = path.join(tmpDir, 'backup');
  try {
    for (const f of files) {
      const dest = path.join(stageDir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }

    // 4. Write manifest
    const manifest = buildManifest(files, appVersion);
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 5. Tar
    const tarPath = path.join(tmpDir, 'archive.tar');
    execFileSync(_getTarBin(), ['cf', tarPath, '-C', tmpDir, 'backup'], { stdio: 'ignore', timeout: 120000 });

    // 6. Encrypt
    const tarBuf = fs.readFileSync(tarPath);
    const encrypted = _encrypt(tarBuf, password);

    // 7. Write output
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, encrypted);

    return { ok: true, fileCount: files.length, sizeBytes: encrypted.length };
  } finally {
    // 8. Clean up
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  restoreBackupPreview — decrypt + read manifest only
// ---------------------------------------------------------------------------
function restoreBackupPreview(backupPath, password) {
  let decrypted;
  try {
    const raw = fs.readFileSync(backupPath);
    decrypted = _decrypt(raw, password);
  } catch {
    throw new Error('Mật khẩu sai hoặc file backup bị hỏng');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9bizclaw-preview-'));
  try {
    const tarPath = path.join(tmpDir, 'archive.tar');
    fs.writeFileSync(tarPath, decrypted);

    // Extract only manifest.json
    try {
      execFileSync(_getTarBin(), ['xf', tarPath, '-C', tmpDir, 'backup/manifest.json'], { stdio: 'ignore', timeout: 30000 });
    } catch {
      // Some tar versions need ./backup/manifest.json
      execFileSync(_getTarBin(), ['xf', tarPath, '-C', tmpDir, './backup/manifest.json'], { stdio: 'ignore', timeout: 30000 });
    }

    const manifestPath = path.join(tmpDir, 'backup', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return { ok: true, manifest };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  restoreBackup — full restore
// ---------------------------------------------------------------------------
function restoreBackup(backupPath, password, appVersion) {
  let decrypted;
  try {
    const raw = fs.readFileSync(backupPath);
    decrypted = _decrypt(raw, password);
  } catch {
    throw new Error('Mật khẩu sai hoặc file backup bị hỏng');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9bizclaw-restore-'));
  try {
    const tarPath = path.join(tmpDir, 'archive.tar');
    fs.writeFileSync(tarPath, decrypted);

    // Extract all
    execFileSync(_getTarBin(), ['xf', tarPath, '-C', tmpDir], { stdio: 'ignore', timeout: 120000 });

    const extractedDir = path.join(tmpDir, 'backup');
    const manifestPath = path.join(extractedDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Version check
    if (_compareVersions(appVersion, manifest.minRestoreVersion) < 0) {
      throw new Error(
        `App version ${appVersion} is too old to restore this backup (requires ${manifest.minRestoreVersion}+)`
      );
    }

    // Section → target directory mapping
    const ws = getWorkspace();
    const home = os.homedir();
    const appData = appDataDir();
    const sectionTargets = {
      'workspace': ws,
      'openclaw': path.join(home, '.openclaw'),
      'openzca': path.join(home, '.openzca'),
      '9router': path.join(appData, '9router'),
      'provider-keys': appData,
    };

    // Copy files from each section to their target
    const copyErrors = [];
    for (const [section, targetBase] of Object.entries(sectionTargets)) {
      const sectionDir = path.join(extractedDir, section);
      if (!fs.existsSync(sectionDir)) continue;
      _copyDirRecursive(sectionDir, targetBase, copyErrors);
    }

    if (copyErrors.length > 0) {
      console.warn(`[backup] restore completed with ${copyErrors.length} file(s) skipped:`, copyErrors);
    }
    return { ok: true, manifest, skipped: copyErrors };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
//  _copyDirRecursive — copy all files from src into dest, preserving structure
// ---------------------------------------------------------------------------
function _copyDirRecursive(src, dest, errors) {
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue;
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      try { fs.mkdirSync(destPath, { recursive: true }); } catch {}
      _copyDirRecursive(srcPath, destPath, errors);
    } else if (ent.isFile()) {
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
      } catch (e) {
        const rel = ent.name;
        console.warn(`[backup] copy failed: ${rel} — ${e.message}`);
        if (errors) errors.push(rel);
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------
module.exports = {
  collectBackupFiles,
  buildManifest,
  checkpointMemoryDb,
  createBackup,
  restoreBackupPreview,
  restoreBackup,
};
