#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { WORKSPACE_ROOT, absFromWorkspace } = require('./lib/architecture-map');

const strict = process.argv.includes('--strict');
const budgetPath = absFromWorkspace('config/build-size-budget.json');
const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
const failures = [];
const warnings = [];
const rows = [];

function bytesFor(relPath) {
  const abs = absFromWorkspace(relPath);
  if (!fs.existsSync(abs)) return null;
  const stat = fs.statSync(abs);
  if (stat.isFile()) return stat.size;
  let total = 0;
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else total += fs.statSync(child).size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function tarContainsEntries(tarRelPath, entries) {
  const tarPath = absFromWorkspace(tarRelPath);
  if (!fs.existsSync(tarPath)) return false;
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const res = spawnSync(tarBin, ['-tf', tarPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.status !== 0) return false;
  const found = new Set(res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  return entries.every(entry => found.has(entry) || found.has(entry.replace(/\\/g, '/')));
}

for (const [name, cfg] of Object.entries(budget.artifacts || {})) {
  const bytes = bytesFor(cfg.path);
  if (bytes === null) {
    if (name === 'embeddingModel' && tarContainsEntries('electron/vendor-bundle.tar', [
      'vendor/models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx',
      'vendor/models/Xenova/multilingual-e5-small/tokenizer.json',
      'vendor/models/Xenova/multilingual-e5-small/config.json',
    ])) {
      warnings.push(`${name} missing at ${cfg.path}, verified inside electron/vendor-bundle.tar`);
      continue;
    }
    const msg = `${name} missing at ${cfg.path}`;
    if (strict) failures.push(msg);
    else warnings.push(msg);
    continue;
  }
  const growth = bytes - cfg.baselineBytes;
  const maxByGrowth = cfg.baselineBytes + cfg.maxGrowthBytes;
  rows.push({ name, path: cfg.path, bytes, growth, maxBytes: cfg.maxBytes, maxByGrowth });
  if (bytes > cfg.maxBytes) failures.push(`${name} ${formatBytes(bytes)} exceeds max ${formatBytes(cfg.maxBytes)}`);
  if (bytes > maxByGrowth) failures.push(`${name} grew ${formatBytes(growth)} beyond allowed ${formatBytes(cfg.maxGrowthBytes)}`);
}

rows.sort((a, b) => b.bytes - a.bytes);
console.log('[bundle-size] measured artifacts:');
for (const row of rows) {
  const sign = row.growth >= 0 ? '+' : '';
  console.log(`  - ${row.name}: ${formatBytes(row.bytes)} (${sign}${formatBytes(row.growth)} vs baseline) ${row.path}`);
}
for (const warning of warnings) console.warn('[bundle-size] WARN ' + warning);

if (failures.length) {
  console.error('[bundle-size] FAIL');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(`[bundle-size] PASS budget=${path.relative(WORKSPACE_ROOT, budgetPath).replace(/\\/g, '/')}`);
