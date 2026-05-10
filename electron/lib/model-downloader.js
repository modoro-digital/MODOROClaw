'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { promisify } = require('util');

let app;
try { ({ app } = require('electron')); } catch {}

// Model configuration from prebuild-models.js
const MODEL_CONFIG = {
  repo: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  files: [
    'tokenizer.json',
    'tokenizer_config.json',
    'config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
  ],
  destSubdir: 'vendor/models/Xenova/multilingual-e5-small',
};

// Expected file sizes (for progress estimation)
const EXPECTED_SIZES = {
  'tokenizer.json': 500 * 1024,           // ~500 KB
  'tokenizer_config.json': 2 * 1024,      // ~2 KB
  'config.json': 5 * 1024,                // ~5 KB
  'special_tokens_map.json': 100 * 1024,   // ~100 KB
  'onnx/model_quantized.onnx': 450 * 1024 * 1024, // ~450 MB
};

const TOTAL_SIZE = Object.values(EXPECTED_SIZES).reduce((a, b) => a + b, 0); // ~451 MB

// =====================================================================
// Path Helpers
// =====================================================================

const { getUserDataDir } = require('./workspace');

function getModelDir() {
  const dest = path.join(getUserDataDir(), MODEL_CONFIG.destSubdir);
  // Migrate from old path (userData/models/...) to new path (userData/vendor/models/...)
  if (!fs.existsSync(dest)) {
    const oldDir = path.join(getUserDataDir(), 'models', 'Xenova', 'multilingual-e5-small');
    if (fs.existsSync(oldDir)) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(oldDir, dest);
        console.log('[model-downloader] migrated model from', oldDir, 'to', dest);
      } catch (e) {
        console.warn('[model-downloader] migration failed, will re-download:', e.message);
      }
    }
  }
  try {
    if (app && app.isPackaged) {
      const { guardPath } = require('./preflight');
      guardPath('getModelDir', dest, getUserDataDir());
    }
  } catch (e) {
    console.error(e.message);
  }
  return dest;
}

function getModelFilePath(filename) {
  const dir = getModelDir();
  const full = path.join(dir, filename);
  try {
    const { guardPath } = require('./preflight');
    guardPath('getModelFilePath', full, dir);
  } catch (e) {
    console.error(e.message);
  }
  return full;
}

// =====================================================================
// Model Status Check
// =====================================================================

/**
 * Check if model is already downloaded
 */
function isModelDownloaded() {
  const modelDir = getModelDir();

  // Check if directory exists
  if (!fs.existsSync(modelDir)) {
    return false;
  }

  // Check if all required files exist
  for (const file of MODEL_CONFIG.files) {
    const filePath = getModelFilePath(file);
    if (!fs.existsSync(filePath)) {
      console.log('[model-downloader] Missing file:', file);
      return false;
    }
    // Check file is not empty
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        console.log('[model-downloader] Empty file:', file);
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Get download progress (bytes downloaded / total)
 */
function getDownloadProgress() {
  let downloaded = 0;

  for (const file of MODEL_CONFIG.files) {
    const filePath = getModelFilePath(file);
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        downloaded += stats.size;
      } catch {}
    }
  }

  return {
    downloaded,
    total: TOTAL_SIZE,
    percent: Math.floor((downloaded / TOTAL_SIZE) * 100),
  };
}

/**
 * Get list of missing files
 */
function getMissingFiles() {
  const missing = [];

  for (const file of MODEL_CONFIG.files) {
    const filePath = getModelFilePath(file);
    if (!fs.existsSync(filePath)) {
      missing.push(file);
    } else {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
          missing.push(file);
        }
      } catch {
        missing.push(file);
      }
    }
  }

  return missing;
}

// =====================================================================
// Download Helpers
// =====================================================================

/**
 * Get CDN URL for a model file (use Hugging Face)
 */
function getFileUrl(filename) {
  const { repo, revision } = MODEL_CONFIG;
  return `https://huggingface.co/${repo}/resolve/${revision}/${filename}`;
}

/**
 * Get HuggingFace CDN alternative (faster for some regions)
 */
function getCdnUrl(filename) {
  const { repo, revision } = MODEL_CONFIG;
  // Use HF mirror for faster download in some regions
  return `https://hf-mirror.com/${repo}/resolve/${revision}/${filename}`;
}

/**
 * Download a single file with progress
 */
async function downloadFile(url, destPath, options = {}) {
  const { onProgress, timeout = 600000 } = options; // 10 min default

  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';

    const curlBin = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe') : 'curl';
    const client = spawn(curlBin, ['-fSL', '-o', destPath, '--progress-bar', url], {
      stdio: 'pipe',
      timeout,
    });

    let stderr = '';
    client.stderr?.on('data', (d) => { stderr += String(d); });

    client.on('error', (e) => {
      reject(new Error(`Download failed: ${e.message}`));
    });

    client.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Download failed (exit ${code}): ${stderr}`));
      }
    });
  });
}

/**
 * Download with fallback to CDN
 */
async function downloadWithFallback(filename, destPath, options = {}) {
  const { onProgress } = options;

  const urls = [
    getFileUrl(filename),
    getCdnUrl(filename),
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      console.log('[model-downloader] Downloading:', filename, 'from', url);
      await downloadFile(url, destPath, { onProgress });
      return; // Success
    } catch (e) {
      lastError = e;
      console.warn('[model-downloader] Download failed for', filename, 'from', url, ':', e.message);
    }
  }

  throw lastError || new Error(`Failed to download ${filename} from all sources`);
}

// =====================================================================
// Download All Models
// =====================================================================

/**
 * Download all model files with progress
 */
async function downloadModels(options = {}) {
  const { onProgress, onFileProgress } = options;

  if (isModelDownloaded()) {
    console.log('[model-downloader] Model already downloaded');
    if (onProgress) onProgress({ percent: 100, message: 'Mô hình đã sẵn sàng' });
    return { alreadyDownloaded: true };
  }

  const modelDir = getModelDir();
  fs.mkdirSync(modelDir, { recursive: true });

  const results = [];
  let totalDownloaded = 0;
  const missingFiles = getMissingFiles();

  if (onProgress) {
    onProgress({
      percent: 0,
      message: `Đang tải mô hình ngôn ngữ... (~${Math.round(TOTAL_SIZE / (1024 * 1024))}MB)`,
    });
  }

  for (let i = 0; i < missingFiles.length; i++) {
    const filename = missingFiles[i];
    const destPath = getModelFilePath(filename);
    const expectedSize = EXPECTED_SIZES[filename] || 0;

    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      await downloadWithFallback(filename, destPath, {
        onProgress: (fileProg) => {
          if (onFileProgress) {
            const overallPercent = (totalDownloaded + (fileProg?.downloaded || 0)) / (TOTAL_SIZE) * 100;
            onFileProgress({
              file: filename,
              percent: overallPercent,
              message: `Đang tải ${filename}...`,
            });
          }
          if (onProgress) {
            const base = (i / missingFiles.length) * 100;
            const filePercent = fileProg?.percent || 0;
            const totalPercent = Math.min(99, base + (filePercent / missingFiles.length));
            onProgress({
              percent: Math.floor(totalPercent),
              message: `Đang tải ${filename}...`,
            });
          }
        },
      });

      // Verify file
      const stats = fs.statSync(destPath);
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }

      // Check against expected size (within 10% tolerance)
      if (expectedSize > 0) {
        const tolerance = expectedSize * 0.1;
        if (Math.abs(stats.size - expectedSize) > tolerance) {
          console.warn('[model-downloader] File size mismatch for', filename, ':', stats.size, 'vs expected', expectedSize);
        }
      }

      totalDownloaded += stats.size;
      results.push({ file: filename, success: true, size: stats.size });

    } catch (e) {
      console.error('[model-downloader] Failed to download', filename, ':', e.message);
      results.push({ file: filename, success: false, error: e.message });

      // Continue with other files, but note the failure
      if (onProgress) {
        onProgress({
          percent: Math.floor((i / missingFiles.length) * 100),
          message: `Lỗi tải ${filename}: ${e.message}`,
        });
      }
    }
  }

  // Final check
  const allDownloaded = isModelDownloaded();

  if (onProgress) {
    onProgress({
      percent: allDownloaded ? 100 : 50,
      message: allDownloaded ? 'Mô hình đã sẵn sàng!' : 'Một số file chưa tải được',
    });
  }

  return {
    alreadyDownloaded: false,
    allDownloaded,
    results,
  };
}

// =====================================================================
// Verify Model Integrity
// =====================================================================

/**
 * Verify model integrity by checking file existence and sizes
 */
function verifyModelIntegrity() {
  const issues = [];

  for (const file of MODEL_CONFIG.files) {
    const filePath = getModelFilePath(file);

    if (!fs.existsSync(filePath)) {
      issues.push({ file, issue: 'missing' });
      continue;
    }

    try {
      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        issues.push({ file, issue: 'empty' });
      }
    } catch (e) {
      issues.push({ file, issue: 'error', detail: e.message });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

// =====================================================================
// Cleanup
// =====================================================================

/**
 * Remove downloaded model files
 */
function cleanupModel() {
  const modelDir = getModelDir();

  if (fs.existsSync(modelDir)) {
    fs.rmSync(modelDir, { recursive: true, force: true });
    console.log('[model-downloader] Model cleaned up');
  }
}

/**
 * Remove a specific model file (for re-download)
 */
function removeModelFile(filename) {
  const filePath = getModelFilePath(filename);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log('[model-downloader] Removed:', filePath);
  }
}

// =====================================================================
// Graceful Degradation (grep fallback)
// =====================================================================

/**
 * Check if we should use grep fallback instead of RAG
 */
function shouldUseGrepFallback() {
  // Use grep fallback if model is not downloaded
  return !isModelDownloaded();
}

/**
 * Search knowledge files using grep (fallback when RAG unavailable)
 */
function grepSearchKnowledge(query, knowledgeDir) {
  const results = [];
  const rootDir = knowledgeDir || path.join(getUserDataDir(), 'knowledge');

  if (!fs.existsSync(rootDir)) {
    return results;
  }

  const queryLower = query.toLowerCase();

  function walkDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.isFile() && /\.(txt|md|pdf|doc|docx)$/i.test(entry.name)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.toLowerCase().includes(queryLower)) {
              results.push({
                file: fullPath,
                name: entry.name,
                // Return a snippet around the match
                snippet: extractSnippet(content, query, 200),
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  walkDir(rootDir);
  return results;
}

/**
 * Extract a snippet of text around the query match
 */
function extractSnippet(content, query, maxLength = 200) {
  const lower = content.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);

  if (idx === -1) {
    return content.slice(0, maxLength) + (content.length > maxLength ? '...' : '');
  }

  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + query.length + maxLength - 50);

  let snippet = content.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// =====================================================================
// Module Exports
// =====================================================================
module.exports = {
  // Configuration
  MODEL_CONFIG,
  TOTAL_SIZE,
  EXPECTED_SIZES,

  // Status
  isModelDownloaded,
  getDownloadProgress,
  getMissingFiles,
  verifyModelIntegrity,

  // Download
  downloadModels,
  downloadFile,
  getFileUrl,

  // Cleanup
  cleanupModel,
  removeModelFile,

  // Fallback
  shouldUseGrepFallback,
  grepSearchKnowledge,
  extractSnippet,

  // Paths
  getModelDir,
  getModelFilePath,
};
