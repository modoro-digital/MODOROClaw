#!/usr/bin/env node
'use strict';
// Fail loud if updates.js is obfuscated in the working tree.
//
// Build process obfuscates these for shipping then restores via finally{}.
// If the build is Ctrl+C'd or crashes hard before the restore, the working
// tree is left with obfuscated source — and any `git add -A` would ship the
// obfuscated blob upstream. Guard against that here so smoke fails loud.
//
// Run by: npm run guard:obfuscation-residue (wired into guard:architecture).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const TARGETS = ['updates.js'];
const BACKUP_DIR = path.join(ROOT, '.obfuscate-backup');

// Obfuscator signatures we know about. `_0x[0-9a-f]{4,}` is the hex identifier
// pattern emitted by javascript-obfuscator with `identifierNamesGenerator:
// 'hexadecimal'`. Three or more such tokens in a row = obfuscated.
const OBF_PATTERN = /(_0x[0-9a-f]{4,}.*){3,}/;

let failures = 0;
for (const file of TARGETS) {
  const p = path.join(LIB, file);
  if (!fs.existsSync(p)) continue;
  const head = fs.readFileSync(p, 'utf-8').slice(0, 4096);
  if (OBF_PATTERN.test(head)) {
    console.error(`[obfuscation-residue] FAIL ${file} appears obfuscated`);
    console.error(`  Run: node electron/scripts/obfuscate.js --restore`);
    if (fs.existsSync(path.join(BACKUP_DIR, file))) {
      console.error(`  (backup available at .obfuscate-backup/${file})`);
    } else {
      console.error(`  WARNING: no backup found. Recover from git: git checkout HEAD electron/lib/${file}`);
    }
    failures++;
  }
}

if (failures > 0) {
  console.error(`[obfuscation-residue] ${failures} file(s) need restore before commit`);
  process.exit(1);
}

console.log('[obfuscation-residue] OK — all targets are clean source');
