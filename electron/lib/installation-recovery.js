'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

let app;
try { ({ app } = require('electron')); } catch {}

// =====================================================================
// Recovery Strategies
// =====================================================================

const RECOVERY_STRATEGIES = {
  // Network errors
  'ECONNREFUSED': { retry: true, retryDelay: 5000, maxRetries: 3 },
  'ETIMEDOUT': { retry: true, retryDelay: 10000, maxRetries: 3 },
  'ENOTFOUND': { retry: false, fallback: 'check-dns' },
  'NETWORK_ERROR': { retry: true, retryDelay: 5000, maxRetries: 2 },

  // Disk errors
  'ENOSPC': { retry: false, action: 'cleanup-disk' },
  'EACCES': { retry: false, action: 'request-permission' },
  'EBUSY': { retry: true, retryDelay: 10000, maxRetries: 4 },

  // Install errors
  'NPM_INSTALL_FAILED': { retry: true, retryDelay: 3000, maxRetries: 2 },
  'EXTRACT_FAILED': { retry: true, retryDelay: 2000, maxRetries: 1 },
  'VERIFICATION_FAILED': { retry: true, retryDelay: 1000, maxRetries: 2 },

  // Permission errors
  'EACCES_PERMISSION': { retry: false, action: 'use-local-install' },
  'SUDO_REQUIRED': { retry: false, action: 'use-local-install' },
};

// =====================================================================
// Error Classification
// =====================================================================

/**
 * Classify an error to determine recovery strategy
 */
function classifyError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const code = error?.code || '';

  // Network errors
  if (code === 'ECONNREFUSED' || message.includes('connection refused')) {
    return { type: 'ECONNREFUSED', strategy: RECOVERY_STRATEGIES.ECONNREFUSED };
  }
  if (code === 'ETIMEDOUT' || message.includes('timeout') || message.includes('timed out')) {
    return { type: 'ETIMEDOUT', strategy: RECOVERY_STRATEGIES.ETIMEDOUT };
  }
  if (code === 'ENOTFOUND' || message.includes('not found') || message.includes('dns')) {
    return { type: 'ENOTFOUND', strategy: RECOVERY_STRATEGIES.ENOTFOUND };
  }
  if (message.includes('network')) {
    return { type: 'NETWORK_ERROR', strategy: RECOVERY_STRATEGIES.NETWORK_ERROR };
  }

  // Disk errors
  if (code === 'ENOSPC' || message.includes('no space') || message.includes('disk full')) {
    return { type: 'ENOSPC', strategy: RECOVERY_STRATEGIES.ENOSPC };
  }
  if (code === 'EACCES' || message.includes('permission denied')) {
    return { type: 'EACCES_PERMISSION', strategy: RECOVERY_STRATEGIES.EACCES_PERMISSION };
  }
  if (code === 'EBUSY' || message.includes('busy') || message.includes('in use')) {
    return { type: 'EBUSY', strategy: RECOVERY_STRATEGIES.EBUSY };
  }

  // Install errors
  if (message.includes('npm install failed') || message.includes('install failed')) {
    return { type: 'NPM_INSTALL_FAILED', strategy: RECOVERY_STRATEGIES.NPM_INSTALL_FAILED };
  }
  if (message.includes('extract') || message.includes('unzip') || message.includes('untar')) {
    return { type: 'EXTRACT_FAILED', strategy: RECOVERY_STRATEGIES.EXTRACT_FAILED };
  }
  if (message.includes('verification') || message.includes('sha') || message.includes('checksum')) {
    return { type: 'VERIFICATION_FAILED', strategy: RECOVERY_STRATEGIES.VERIFICATION_FAILED };
  }

  // Permission errors
  if (message.includes('sudo') || message.includes('administrator') || message.includes('admin')) {
    return { type: 'SUDO_REQUIRED', strategy: RECOVERY_STRATEGIES.SUDO_REQUIRED };
  }

  // Default
  return { type: 'UNKNOWN', strategy: null };
}

// =====================================================================
// Retry Logic
// =====================================================================

/**
 * Execute with retry logic
 */
async function withRetry(operation, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    onRetry,
    onFail,
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const classification = classifyError(error);
      const strategy = classification.strategy || { retry: false };

      if (attempt < maxRetries && strategy.retry) {
        const delay = Math.min(
          (strategy.retryDelay || baseDelay) * Math.pow(2, attempt),
          maxDelay
        );

        console.log(`[recovery] Retry ${attempt + 1}/${maxRetries} after ${delay}ms:`, error?.message || error);

        if (onRetry) {
          onRetry({
            attempt: attempt + 1,
            maxRetries,
            error,
            delay,
            classification,
          });
        }

        await sleep(delay);
      } else {
        break;
      }
    }
  }

  if (onFail) {
    onFail(lastError);
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =====================================================================
// Recovery Actions
// =====================================================================

/**
 * Check disk space and cleanup if needed
 */
async function checkAndCleanupDisk(requiredBytes = 500 * 1024 * 1024) {
  console.log('[recovery] Checking disk space...');

  // Get disk info
  const isWin = process.platform === 'win32';
  let freeBytes = 0;

  try {
    if (isWin) {
      const { stdout } = await execFilePromise('powershell', [
        '-NoProfile', '-Command',
        '(Get-PSDrive C).Free'
      ], { timeout: 5000 });
      freeBytes = parseInt(stdout.trim(), 10); // PS returns bytes
    } else {
      const { stdout } = await execFilePromise('df', ['-k', '/'], { timeout: 5000 });
      const lines = stdout.trim().split('\n');
      const parts = lines[lines.length - 1].split(/\s+/);
      freeBytes = parseInt(parts[3], 10) * 1024; // df returns 1K blocks
    }
  } catch (e) {
    console.warn('[recovery] Could not check disk space:', e.message);
    return { cleaned: false, freedBytes: 0 };
  }

  if (freeBytes >= requiredBytes) {
    return { cleaned: false, freedBytes: 0, freeBytes };
  }

  console.log('[recovery] Low disk space, attempting cleanup...');

  const userData = getUserDataDir();
  const itemsToClean = [];

  // 1. Clean stale vendor directories
  try {
    const entries = fs.readdirSync(userData);
    for (const e of entries) {
      if (e.startsWith('vendor.stale-')) {
        itemsToClean.push({
          path: path.join(userData, e),
          type: 'stale-vendor',
          size: estimateDirSize(path.join(userData, e)),
        });
      }
    }
  } catch {}

  // 2. Clean old logs (but keep recent ones)
  const logsDir = path.join(userData, 'logs');
  if (fs.existsSync(logsDir)) {
    try {
      const logFiles = fs.readdirSync(logsDir)
        .filter(f => f.startsWith('main.log'))
        .map(f => ({
          path: path.join(logsDir, f),
          type: 'old-log',
          mtime: fs.statSync(path.join(logsDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Keep only the 2 most recent logs
      for (let i = 2; i < logFiles.length; i++) {
        itemsToClean.push({
          path: logFiles[i].path,
          type: 'old-log',
          size: fs.statSync(logFiles[i].path).size,
        });
      }
    } catch {}
  }

  // 3. Clean temp files
  const tempDir = path.join(userData, 'temp');
  if (fs.existsSync(tempDir)) {
    itemsToClean.push({
      path: tempDir,
      type: 'temp-dir',
      size: estimateDirSize(tempDir),
    });
  }

  // Sort by size descending
  itemsToClean.sort((a, b) => b.size - a.size);

  let freedBytes = 0;
  for (const item of itemsToClean) {
    try {
      if (fs.statSync(item.path).isDirectory()) {
        fs.rmSync(item.path, { recursive: true, force: true });
      } else {
        fs.unlinkSync(item.path);
      }
      freedBytes += item.size;
      console.log('[recovery] Cleaned:', item.path, '(' + formatBytes(item.size) + ')');
    } catch (e) {
      console.warn('[recovery] Could not clean:', item.path, e.message);
    }
  }

  return { cleaned: true, freedBytes, freeBytes: freeBytes + freedBytes };
}

const { getUserDataDir } = require('./workspace');

function estimateDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        try { size += fs.statSync(fullPath).size; } catch {}
      } else if (entry.isDirectory()) {
        size += estimateDirSize(fullPath);
      }
    }
  } catch {}
  return size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/**
 * Use local install when global install fails
 */
async function useLocalInstallFallback(installer) {
  console.log('[recovery] Switching to local userData install...');

  // This is handled by runtime-installer.js's 3-tier install
  // This function just provides the strategy
  return { strategy: 'local-install', reason: 'Global install failed, using local install' };
}

/**
 * Check network/DNS issues
 */
async function checkNetworkHealth() {
  const isWin = process.platform === 'win32';
  const tests = [];

  // Test DNS resolution
  try {
    const { execSync } = require('child_process');
    if (isWin) {
      execSync('ping -n 1 -w 1000 nodejs.org', { stdio: 'ignore' });
    } else {
      execSync('ping -c 1 -W 1 nodejs.org', { stdio: 'ignore' });
    }
    tests.push({ name: 'nodejs.org', status: 'ok' });
  } catch {
    tests.push({ name: 'nodejs.org', status: 'failed' });
  }

  // Test HuggingFace
  try {
    const { execSync } = require('child_process');
    if (isWin) {
      execSync('ping -n 1 -w 1000 huggingface.co', { stdio: 'ignore' });
    } else {
      execSync('ping -c 1 -W 1 huggingface.co', { stdio: 'ignore' });
    }
    tests.push({ name: 'huggingface.co', status: 'ok' });
  } catch {
    tests.push({ name: 'huggingface.co', status: 'failed' });
  }

  return {
    healthy: tests.every(t => t.status === 'ok'),
    tests,
  };
}

// =====================================================================
// Error Recovery Manager
// =====================================================================

class InstallationRecovery {
  constructor(options = {}) {
    this.history = [];
    this.maxHistory = 50;
  }

  /**
   * Handle an error with appropriate recovery strategy
   */
  async handle(error, context = {}) {
    const classification = classifyError(error);

    console.log('[recovery] Handling error:', classification.type, error?.message || error);

    const entry = {
      timestamp: new Date().toISOString(),
      error: error?.message || String(error),
      classification: classification.type,
      context,
    };

    try {
      switch (classification.type) {
        case 'ENOSPC':
          const diskResult = await checkAndCleanupDisk();
          entry.action = 'disk-cleanup';
          entry.result = diskResult;
          if (!diskResult.cleaned) {
            entry.failed = true;
            entry.message = 'Low disk space, could not free enough';
          }
          break;

        case 'ECONNREFUSED':
        case 'ETIMEDOUT':
        case 'NETWORK_ERROR':
          const networkResult = await checkNetworkHealth();
          entry.action = 'network-check';
          entry.result = networkResult;
          if (!networkResult.healthy) {
            entry.failed = true;
            entry.message = 'Network appears to be offline or unreachable';
          }
          break;

        case 'EACCES_PERMISSION':
        case 'SUDO_REQUIRED':
          const localResult = await useLocalInstallFallback();
          entry.action = 'local-install-fallback';
          entry.result = localResult;
          break;

        default:
          entry.action = 'no-recovery';
          entry.failed = true;
          entry.message = 'Unknown error type, no automatic recovery available';
      }
    } catch (recoveryError) {
      entry.action = 'recovery-failed';
      entry.recoveryError = recoveryError?.message || String(recoveryError);
      entry.failed = true;
    }

    this.addToHistory(entry);
    return entry;
  }

  /**
   * Add entry to history
   */
  addToHistory(entry) {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Get recovery history
   */
  getHistory() {
    return this.history;
  }

  /**
   * Check if error is recoverable
   */
  isRecoverable(error) {
    const classification = classifyError(error);
    return classification.strategy?.retry === true ||
           ['ENOSPC', 'ECONNREFUSED', 'ETIMEDOUT', 'NETWORK_ERROR'].includes(classification.type);
  }
}

// Singleton instance
let _recoveryInstance = null;

function getRecoveryInstance() {
  if (!_recoveryInstance) {
    _recoveryInstance = new InstallationRecovery();
  }
  return _recoveryInstance;
}

// =====================================================================
// Module Exports
// =====================================================================
module.exports = {
  // Error classification
  classifyError,
  RECOVERY_STRATEGIES,

  // Retry logic
  withRetry,
  sleep,

  // Recovery actions
  checkAndCleanupDisk,
  useLocalInstallFallback,
  checkNetworkHealth,

  // Recovery manager
  InstallationRecovery,
  getRecoveryInstance,
};
