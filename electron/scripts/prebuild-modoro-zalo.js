#!/usr/bin/env node
/**
 * prebuild-modoro-zalo.js
 *
 * Bundles ONLY the modoro-zalo plugin into the dist/modoro-zalo/ directory.
 * This replaces the old prebuild-vendor.js which bundled everything.
 *
 * Usage:
 *   node scripts/prebuild-modoro-zalo.js
 *
 * Output:
 *   dist/modoro-zalo/ — modoro-zalo plugin files
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Paths
const ROOT = path.join(__dirname, '..');
const SRC_PLUGIN_DIR = path.join(ROOT, 'packages', 'modoro-zalo');
const DIST_PLUGIN_DIR = path.join(ROOT, 'dist', 'modoro-zalo');

// Required files that must exist in the plugin
const REQUIRED_FILES = [
  'openclaw.plugin.json',
  'src/inbound.ts',
  'src/send.ts',
  'src/channel.ts',
  'src/openzca.ts',
  'package.json',
];

// Files/directories to exclude from bundle
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  'tsbuildinfo',
  'dist',
  'coverage',
];

/**
 * Check if a file/directory name matches any exclude pattern
 */
function shouldExclude(name, patterns) {
  for (const pattern of patterns) {
    if (name === pattern) return true;
    // Handle glob patterns like *.tsbuildinfo
    if (pattern.startsWith('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(name)) return true;
    }
  }
  return false;
}

/**
 * Copy a file or directory recursively
 */
function copyRecursive(src, dest, options = {}) {
  const { onFile, onDir, exclude = [] } = options;

  if (!fs.existsSync(src)) {
    throw new Error(`Source does not exist: ${src}`);
  }

  const stat = fs.statSync(src);
  const basename = path.basename(src);

  if (stat.isDirectory()) {
    // Check if should exclude this directory
    if (shouldExclude(basename, exclude)) {
      return { skipped: true, reason: 'excluded' };
    }

    if (onDir) onDir(src, dest);

    fs.mkdirSync(dest, { recursive: true });

    const entries = fs.readdirSync(src, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const result = copyRecursive(srcPath, destPath, { exclude });
      results.push(result);
    }

    return { copied: true, children: results };
  } else {
    // Check if should exclude this file
    if (shouldExclude(basename, exclude)) {
      return { skipped: true, reason: 'excluded' };
    }

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    // Copy file
    fs.copyFileSync(src, dest);

    if (onFile) onFile(src, dest, stat.size);

    return { copied: true, size: stat.size };
  }
}

/**
 * Validate plugin source directory
 */
function validateSource() {
  console.log('[prebuild-modoro-zalo] Validating source at:', SRC_PLUGIN_DIR);

  for (const file of REQUIRED_FILES) {
    const filePath = path.join(SRC_PLUGIN_DIR, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file missing: ${file}`);
    }
    console.log('  ✓', file);
  }

  // Validate package.json
  const pkgJson = JSON.parse(fs.readFileSync(path.join(SRC_PLUGIN_DIR, 'package.json'), 'utf8'));
  console.log('[prebuild-modoro-zalo] Plugin name:', pkgJson.name);
  console.log('[prebuild-modoro-zalo] Plugin version:', pkgJson.version);

  return pkgJson;
}

/**
 * Generate bundle manifest
 */
function generateManifest(pkgJson) {
  const manifest = {
    bundle_version: '1.0.0',
    plugin_name: pkgJson.name,
    plugin_version: pkgJson.version,
    bundled_at: new Date().toISOString(),
    files: [],
  };

  // Count files
  function countFiles(dir, baseDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        countFiles(fullPath, baseDir);
      } else {
        const stats = fs.statSync(fullPath);
        manifest.files.push({
          path: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
          size: stats.size,
        });
      }
    }
  }

  countFiles(DIST_PLUGIN_DIR, DIST_PLUGIN_DIR);

  manifest.file_count = manifest.files.length;
  manifest.total_size = manifest.files.reduce((sum, f) => sum + f.size, 0);

  return manifest;
}

/**
 * Main build function
 */
async function build() {
  console.log('==========================================');
  console.log('prebuild-modoro-zalo');
  console.log('==========================================');

  const startedAt = Date.now();

  // 1. Validate source
  const pkgJson = validateSource();

  // 2. Create dist directory
  console.log('\n[prebuild-modoro-zalo] Creating bundle at:', DIST_PLUGIN_DIR);
  fs.mkdirSync(DIST_PLUGIN_DIR, { recursive: true });

  // 3. Copy plugin files
  let totalSize = 0;
  let fileCount = 0;

  const result = copyRecursive(SRC_PLUGIN_DIR, DIST_PLUGIN_DIR, {
    exclude: EXCLUDE_PATTERNS,
    onFile: (src, dest, size) => {
      fileCount++;
      totalSize += size;
    },
    onDir: (src, dest) => {
      console.log('  +', path.relative(SRC_PLUGIN_DIR, src));
    },
  });

  // 4. Generate manifest
  const manifest = generateManifest(pkgJson);

  // 5. Write manifest
  const manifestPath = path.join(DIST_PLUGIN_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('\n[prebuild-modoro-zalo] Manifest:', manifestPath);
  console.log('  Files:', manifest.file_count);
  console.log('  Total size:', formatBytes(manifest.total_size));

  // 6. Validate bundle
  console.log('\n[prebuild-modoro-zalo] Validating bundle...');
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(DIST_PLUGIN_DIR, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Bundle validation failed: ${file} not found`);
    }
    console.log('  ✓', file);
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(2);
  console.log('\n[prebuild-modoro-zalo] Done in', duration, 's');

  return {
    success: true,
    fileCount,
    totalSize,
    duration,
  };
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Run
build()
  .then(result => {
    console.log('\n✓ Bundle created successfully');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n✗ Bundle failed:', err.message);
    process.exit(1);
  });
