'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let app;
try { ({ app } = require('electron')); } catch {}

const { getUserDataDir, copyDirRecursive } = require('./workspace');

// =====================================================================
// Migration Configuration
// =====================================================================

const MIGRATION_VERSION = '2.4.0';
const PREVIOUS_VERSION_MIN = '2.3.0';

// Files/directories to preserve during migration
const PRESERVE_PATHS = [
  // Workspace data
  'memory/',
  'memory/zalo-users/',
  'memory/zalo-groups/',
  'knowledge/',
  'knowledge/cong-ty/',
  'knowledge/san-pham/',
  'knowledge/nhan-vien/',
  'knowledge/cong-ty/files/',
  'knowledge/san-pham/files/',
  'knowledge/nhan-vien/files/',

  // Config files
  'schedules.json',
  'custom-crons.json',
  'AGENTS.md',
  'IDENTITY.md',
  'BOOTSTRAP.md',
  'SOUL.md',
  'USER.md',
  'MEMORY.md',
  'COMPANY.md',
  'PRODUCTS.md',

  // OpenClaw config
  'openclaw.json',
  'zalo-blocklist.json',

  // Logs (optional - keep for debugging)
  'logs/',
  'audit.jsonl',
];

// Old bundled files to clean up.
// NOTE: 'vendor/' must be included — v2.3.x shipped a bundled vendor at
// userData/vendor/ which would otherwise persist and be found by
// detectNodeInstallation() as a seemingly-suitable runtime Node, causing
// migration to short-circuit. Rename to stale-* so it can be deleted after restart.
const CLEANUP_PATHS = [
  'vendor/',
  'vendor-bundle.tar',
  'vendor-meta.json',
  'vendor-version.txt',
];

// =====================================================================
// Path Helpers
// =====================================================================

// getUserDataDir and copyDirRecursive imported from ./workspace above

/**
 * Get all possible userData directories (for migration scanning)
 */
function getAllUserDataDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs = [];

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appdata, '9bizclaw'));
    dirs.push(path.join(appdata, 'modoro-claw'));
    dirs.push(path.join(appdata, '.openclaw'));
  } else if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    dirs.push(path.join(support, '9bizclaw'));
    dirs.push(path.join(support, 'modoro-claw'));
    dirs.push(path.join(support, '.openclaw'));
  } else {
    dirs.push(path.join(home, '.config', '9bizclaw'));
    dirs.push(path.join(home, '.config', 'modoro-claw'));
    dirs.push(path.join(home, '.openclaw'));
  }

  return dirs.filter(d => fs.existsSync(d));
}

function getBackupDir() {
  return path.join(getUserDataDir(), 'backups');
}

function getVersionFile() {
  return path.join(getUserDataDir(), 'version.txt');
}

function getMigrationMarkerFile() {
  return path.join(getUserDataDir(), 'migration-completed.txt');
}

// =====================================================================
// Version Detection
// =====================================================================

/**
 * Get current installed version
 */
function getInstalledVersion() {
  try {
    const vf = getVersionFile();
    if (fs.existsSync(vf)) {
      return fs.readFileSync(vf, 'utf8').trim();
    }
  } catch {}
  return null;
}

/**
 * Check if this is an upgrade from v2.3.x.
 *
 * C4-FIX: Do NOT check for vendor directories or tar files in getAllUserDataDirs().
 * After extracting the bundled tar on a fresh install, those paths now exist in the
 * current userDataDir, causing false positives (isUpgradeFromV23 = true even on fresh).
 *
 * The ONLY reliable signal for v2.3.x upgrade is the presence of a version file
 * with content < 2.4.0, written by the old installer. Fresh v2.4.0 installs never
 * had such a file — they only get runtime-version.txt (written by the runtime
 * installer) after setup completes.
 */
function isUpgradeFromV23() {
  // v2.3.x wrote vendor-version.txt (NOT version.txt) during tar extraction.
  // Check BOTH files — the original code only checked version.txt which
  // v2.3.x never created, so migration never triggered on real upgrades.
  const ud = getUserDataDir();
  const candidates = [
    path.join(ud, 'version.txt'),
    path.join(ud, 'vendor-version.txt'),
  ];
  for (const versionFile of candidates) {
    try {
      if (fs.existsSync(versionFile)) {
        const content = fs.readFileSync(versionFile, 'utf8').trim();
        const match = content.match(/^(\d+)\.(\d+)/);
        if (match) {
          const major = parseInt(match[1], 10);
          const minor = parseInt(match[2], 10);
          if (major < 2 || (major === 2 && minor < 4)) {
            return true;
          }
        }
        // vendor-version.txt may contain a hash/bundle version, not semver.
        // If the file exists but content isn't semver, it's still a v2.3.x artifact.
        if (versionFile.endsWith('vendor-version.txt') && content.length > 0) {
          return true;
        }
      }
    } catch {}
  }

  // Fallback: if userData has an old bundled vendor/ with node_modules but
  // NO runtime-version.txt, this is a v2.3.x install that never migrated.
  try {
    const runtimeMarker = path.join(ud, 'runtime-version.txt');
    const oldVendor = path.join(ud, 'vendor', 'node_modules');
    if (!fs.existsSync(runtimeMarker) && fs.existsSync(oldVendor)) {
      console.log('[migration] detected v2.3.x vendor/ without runtime marker — triggering migration');
      return true;
    }
  } catch {}

  return false;
}

/**
 * Check if migration already completed
 */
function isMigrationCompleted() {
  try {
    const markerFile = getMigrationMarkerFile();
    if (fs.existsSync(markerFile)) {
      const content = fs.readFileSync(markerFile, 'utf8').trim();
      return content === MIGRATION_VERSION;
    }
  } catch {}
  return false;
}

// =====================================================================
// Backup
// =====================================================================

/**
 * Create backup before migration
 */
function createBackup() {
  console.log('[migration] Creating backup...');

  const userData = getUserDataDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(getBackupDir(), `backup-${timestamp}`);

  try {
    fs.mkdirSync(backupDir, { recursive: true });

    // Backup key files
    const filesToBackup = [
      'openclaw.json',
      'memory/',
      'knowledge/',
      'schedules.json',
      'custom-crons.json',
      'zalo-blocklist.json',
      'version.txt',
    ];

    for (const fileOrDir of filesToBackup) {
      const srcPath = path.join(userData, fileOrDir);
      const destPath = path.join(backupDir, fileOrDir);

      if (!fs.existsSync(srcPath)) continue;

      try {
        if (fs.statSync(srcPath).isDirectory()) {
          copyDirRecursive(srcPath, destPath);
        } else {
          const destDir = path.dirname(destPath);
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcPath, destPath);
        }
        console.log('[migration] Backed up:', fileOrDir);
      } catch (e) {
        console.warn('[migration] Could not backup:', fileOrDir, e.message);
      }
    }

    // Write backup manifest
    const manifest = {
      timestamp,
      version: getInstalledVersion(),
      files: filesToBackup,
    };
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    console.log('[migration] Backup created at:', backupDir);
    return { success: true, backupDir };

  } catch (e) {
    console.error('[migration] Backup failed:', e.message);
    return { success: false, error: e.message, backupDir };
  }
}

// copyDirRecursive imported from ./workspace

/**
 * List available backups
 */
function listBackups() {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  try {
    const entries = fs.readdirSync(backupDir)
      .filter(e => e.startsWith('backup-'))
      .map(e => {
        const manifestPath = path.join(backupDir, e, 'manifest.json');
        let manifest = null;
        try {
          if (fs.existsSync(manifestPath)) {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          }
        } catch {}
        return {
          name: e,
          path: path.join(backupDir, e),
          manifest,
        };
      })
      .sort((a, b) => (b.manifest?.timestamp || '').localeCompare(a.manifest?.timestamp || ''));

    return entries;
  } catch {
    return [];
  }
}

// =====================================================================
// Old File Cleanup
// =====================================================================

/**
 * Clean up old bundled files from v2.3.x
 */
function cleanupOldBundledFiles() {
  console.log('[migration] Cleaning up old bundled files...');

  const userData = getUserDataDir();
  const cleaned = [];

  for (const fileOrDir of CLEANUP_PATHS) {
    const filePath = path.join(userData, fileOrDir);

    if (!fs.existsSync(filePath)) continue;

    try {
      if (fs.statSync(filePath).isDirectory()) {
        // Don't delete vendor/ immediately - it might be in use
        // Instead, schedule it for deletion
        const staleDir = filePath + '.stale-' + Date.now();
        try {
          fs.renameSync(filePath, staleDir);
          console.log('[migration] Renamed to stale:', staleDir);
          // Schedule deletion after app restarts
          const _t = setTimeout(() => {
            try {
              fs.rmSync(staleDir, { recursive: true, force: true });
              console.log('[migration] Deleted stale dir:', staleDir);
            } catch (e) {
              console.warn('[migration] Could not delete stale dir:', staleDir, e.message);
            }
          }, 30000); // Wait 30s before deleting
          if (_t && _t.unref) _t.unref();
        } catch (renameErr) {
          // If rename fails, file might be in use - just leave it
          console.warn('[migration] Could not rename, leaving:', filePath, renameErr.message);
        }
      } else {
        fs.unlinkSync(filePath);
        console.log('[migration] Deleted:', filePath);
      }
      cleaned.push(fileOrDir);
    } catch (e) {
      console.warn('[migration] Could not clean:', fileOrDir, e.message);
    }
  }

  // Also clean stale directories from previous runs
  try {
    const entries = fs.readdirSync(userData);
    for (const e of entries) {
      if (e.startsWith('vendor.stale-')) {
        const stalePath = path.join(userData, e);
        try {
          fs.rmSync(stalePath, { recursive: true, force: true });
          console.log('[migration] Deleted stale vendor:', e);
        } catch {}
      }
    }
  } catch {}

  return cleaned;
}

// =====================================================================
// Cleanup Bundled Tar in Resources (v2.3.x upgrade)
// =====================================================================

/**
 * After runtime install is complete on a v2.3.x upgrade, the bundled tar
 * in the EXE's resources/ is no longer needed — it was only used for first-
 * launch extraction.  Deleting it saves ~2 GB of disk space.
 *
 * We only clean resources/ on packaged builds where app is available.
 * This is safe to call multiple times (idempotent via file-existence check).
 *
 * This mirrors the cleanup done by runtime-installer.js cleanupBundledTarIfInstalled()
 * (removed in pure runtime v2.4.0). The migration path still runs this for
 * v2.3.x → v2.4.0 upgrades where a bundled tar existed in resources/.
 */
function cleanupBundledTarInResources() {
  if (!app || !app.isPackaged) return;

  let resourcesPath;
  try {
    resourcesPath = app.getPath('resourcesPath');
  } catch {
    console.warn('[migration] Could not get resourcesPath — skipping resources cleanup');
    return;
  }

  const toDelete = [
    path.join(resourcesPath, 'vendor-bundle.tar'),
    path.join(resourcesPath, 'vendor-meta.json'),
  ];

  let cleaned = [];
  for (const f of toDelete) {
    if (!fs.existsSync(f)) continue;
    try {
      fs.unlinkSync(f);
      console.log('[migration] Deleted bundled artifact:', f);
      cleaned.push(f);
    } catch (e) {
      // Non-fatal: file might be locked or permission denied (e.g. running
      // from a read-only install location like Program Files without admin).
      // We intentionally do NOT throw — the app still works without cleanup.
      console.warn('[migration] Could not delete bundled artifact (non-fatal):', f, e.message);
    }
  }
  return cleaned;
}

// =====================================================================
// Migration Steps
// =====================================================================

/**
 * Run migration from v2.3.x to v2.4.0
 */
async function runMigration(options = {}) {
  const { onProgress, onError } = options;

  console.log('[migration] Starting migration to v' + MIGRATION_VERSION);

  // Check if already migrated
  if (isMigrationCompleted()) {
    console.log('[migration] Migration already completed');
    return { migrated: true, reason: 'already_completed' };
  }

  // Check if this is an upgrade
  if (!isUpgradeFromV23()) {
    console.log('[migration] Not upgrading from v2.3.x, skipping migration');
    return { migrated: false, reason: 'not_upgrade' };
  }

  const steps = [];

  try {
    // Step 1: Create backup
    if (onProgress) onProgress({ step: 'backup', percent: 0, message: 'Đang sao lưu dữ liệu...' });
    const backup = createBackup();
    if (!backup.success) {
      throw new Error('Backup failed: ' + backup.error);
    }
    steps.push({ step: 'backup', success: true, backupDir: backup.backupDir });
    if (onProgress) onProgress({ step: 'backup', percent: 100, message: 'Đã sao lưu xong' });

    // Step 2: Check existing bundled vendor
    if (onProgress) onProgress({ step: 'check', percent: 10, message: 'Đang kiểm tra cài đặt hiện tại...' });

    const runtimeInstaller = require('./runtime-installer');
    const status = await runtimeInstaller.checkInstallation();
    steps.push({ step: 'check', success: true, status });

    // Step 3: Decision - reuse existing or reinstall
    let needsInstall = false;
    if (!status.ready) {
      needsInstall = true;
    }

    if (needsInstall) {
      // Step 4: Run runtime install
      if (onProgress) onProgress({ step: 'install', percent: 20, message: 'Đang cài đặt runtime...' });

      await runtimeInstaller.runInstallation({
        onProgress: (p) => {
          if (onProgress) onProgress({ step: 'install', percent: 20 + Math.floor(p.percent * 0.6), message: p.message });
        }
      });

      steps.push({ step: 'install', success: true });
    } else {
      // Step 4: Just update packages if needed
      if (onProgress) onProgress({ step: 'update', percent: 50, message: 'Đang cập nhật packages...' });
      // TODO: implement package update
      steps.push({ step: 'update', success: true, reason: 'no_update_needed' });
    }

    if (onProgress) onProgress({ step: 'update', percent: 80, message: 'Đang dọn dẹp file cũ...' });

    // Step 5: Clean up old bundled files (userData)
    const cleaned = cleanupOldBundledFiles();
    // Check if cleanup ran successfully. We look for vendor.stale-* dirs
    // (meaning rename succeeded) rather than checking vendor/ absence,
    // because the runtime installer creates a NEW vendor/ directory
    // which would cause a false "cleanup failed" detection.
    const userData = getUserDataDir();
    const hasStaleVendor = (() => { try { return fs.readdirSync(userData).some(e => e.startsWith('vendor.stale-')); } catch { return false; } })();
    const cleanupComplete = cleaned.length > 0 || !hasStaleVendor;
    steps.push({ step: 'cleanup', success: cleanupComplete, cleaned });
    if (!cleanupComplete) {
      console.warn('[migration] vendor cleanup incomplete — will retry on next boot');
    }

    // Step 5b: Delete bundled tar from EXE resources (frees ~2 GB)
    const resourcesCleaned = cleanupBundledTarInResources();
    steps.push({ step: 'cleanupResources', success: true, cleaned: resourcesCleaned });

    // Step 6: Write migration marker
    // Only write if cleanup is complete. Data preservation (backup, install,
    // config) is already done — the marker specifically gates the cleanup step
    // so it retries on next boot if vendor/ was not removed.
    if (onProgress) onProgress({ step: 'complete', percent: 90, message: 'Đang hoàn tất...' });
    if (cleanupComplete) {
      fs.writeFileSync(getMigrationMarkerFile(), MIGRATION_VERSION, 'utf8');
    } else {
      // Write a partial marker so we know data migration succeeded but cleanup didn't.
      // On next boot, isMigrationCompleted() returns false (content !== MIGRATION_VERSION)
      // so cleanupOldBundledFiles() will be retried.
      fs.writeFileSync(getMigrationMarkerFile(), MIGRATION_VERSION + '-cleanup-pending', 'utf8');
    }

    // Step 7: Update version file
    // Only update version when cleanup is fully done, otherwise isUpgradeFromV23()
    // would return false on next boot and the cleanup retry would be skipped.
    if (cleanupComplete) {
      fs.writeFileSync(getVersionFile(), MIGRATION_VERSION, 'utf8');
    }

    if (onProgress) onProgress({ step: 'complete', percent: 100, message: 'Đã hoàn tất!' });

    console.log('[migration] Migration completed successfully');

    return {
      migrated: true,
      version: MIGRATION_VERSION,
      steps,
      backupDir: backup.backupDir,
    };

  } catch (e) {
    console.error('[migration] Migration failed:', e.message);

    if (onError) {
      onError(e);
    }

    return {
      migrated: false,
      error: e.message,
      steps,
    };
  }
}

/**
 * Rollback to backup
 */
async function rollback(backupPath) {
  console.log('[migration] Rolling back to backup:', backupPath);

  const userData = getUserDataDir();

  try {
    // Restore files from backup
    const manifestPath = path.join(backupPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Backup manifest not found');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    for (const fileOrDir of manifest.files) {
      const srcPath = path.join(backupPath, fileOrDir);
      const destPath = path.join(userData, fileOrDir);

      if (!fs.existsSync(srcPath)) continue;

      try {
        if (fs.statSync(srcPath).isDirectory()) {
          copyDirRecursive(srcPath, destPath);
        } else {
          const destDir = path.dirname(destPath);
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcPath, destPath);
        }
        console.log('[migration] Restored:', fileOrDir);
      } catch (e) {
        console.warn('[migration] Could not restore:', fileOrDir, e.message);
      }
    }

    // Remove migration marker
    try { fs.unlinkSync(getMigrationMarkerFile()); } catch {}

    console.log('[migration] Rollback completed');
    return { success: true };

  } catch (e) {
    console.error('[migration] Rollback failed:', e.message);
    return { success: false, error: e.message };
  }
}

// =====================================================================
// Progress UI Data
// =====================================================================

/**
 * Get migration UI state
 */
function getMigrationState() {
  const currentVersion = getInstalledVersion();
  const needsMigration = isUpgradeFromV23();
  const migrationCompleted = isMigrationCompleted();
  const backups = listBackups();

  return {
    currentVersion,
    targetVersion: MIGRATION_VERSION,
    needsMigration,
    migrationCompleted,
    canRollback: backups.length > 0,
    backups,
  };
}

// =====================================================================
// Module Exports
// =====================================================================
module.exports = {
  // Constants
  MIGRATION_VERSION,
  PREVIOUS_VERSION_MIN,

  // Version detection
  getInstalledVersion,
  isUpgradeFromV23,
  isMigrationCompleted,

  // Backup/Restore
  createBackup,
  listBackups,
  rollback,

  // Migration
  runMigration,
  cleanupOldBundledFiles,
  cleanupBundledTarInResources,

  // UI state
  getMigrationState,

  // Paths
  getUserDataDir,
  getAllUserDataDirs,
};
