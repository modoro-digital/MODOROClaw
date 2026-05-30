#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const BACKUP_DIR = path.join(ROOT, '.obfuscate-backup');
const TARGETS = ['updates.js'];

// ---- restore mode ----
if (process.argv.includes('--restore')) {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log('[obfuscate] No backup found, nothing to restore');
    process.exit(0);
  }
  for (const file of TARGETS) {
    const backup = path.join(BACKUP_DIR, file);
    const target = path.join(LIB, file);
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, target);
      console.log(`[obfuscate] Restored ${file}`);
    }
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log('[obfuscate] Restore complete');
  process.exit(0);
}

// ---- obfuscate mode ----

// Auto-restore stale backups from a crashed build
if (fs.existsSync(BACKUP_DIR)) {
  console.log('[obfuscate] Stale backup found — restoring originals first');
  for (const file of TARGETS) {
    const backup = path.join(BACKUP_DIR, file);
    const target = path.join(LIB, file);
    if (fs.existsSync(backup)) fs.copyFileSync(backup, target);
  }
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

// Backup originals
fs.mkdirSync(BACKUP_DIR, { recursive: true });
for (const file of TARGETS) {
  fs.copyFileSync(path.join(LIB, file), path.join(BACKUP_DIR, file));
}
console.log('[obfuscate] Backed up originals to .obfuscate-backup/');

// Obfuscate
const JavaScriptObfuscator = require('javascript-obfuscator');

const OBF_OPTIONS = {
  target: 'node',
  seed: 0,
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.75,
  stringArrayEncoding: ['rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 1,
  splitStrings: true,
  splitStringsChunkLength: 6,
  transformObjectKeys: true,
  numbersToExpressions: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  renameProperties: false,
  unicodeEscapeSequence: false,
  disableConsoleOutput: false,
};

for (const file of TARGETS) {
  const filePath = path.join(LIB, file);
  const code = fs.readFileSync(filePath, 'utf-8');
  const result = JavaScriptObfuscator.obfuscate(code, OBF_OPTIONS);
  const obfuscated = result.getObfuscatedCode();
  fs.writeFileSync(filePath, obfuscated, 'utf-8');
  const ratio = ((1 - code.length / obfuscated.length) * 100).toFixed(0);
  console.log(`[obfuscate] ${file}: ${code.length} -> ${obfuscated.length} bytes (+${ratio}% overhead)`);
}

console.log('[obfuscate] Done — run with --restore to undo');
