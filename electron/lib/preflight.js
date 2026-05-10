'use strict';
const fs = require('fs');
const path = require('path');

let app;
try { app = require('electron').app; } catch {}

function guardPath(label, actual, mustBeInside) {
  if (!actual) throw new Error(`[preflight] ${label}: path is null`);
  if (mustBeInside) {
    const rel = path.relative(mustBeInside, actual);
    if (rel.startsWith('..') || path.isAbsolute(rel))
      throw new Error(`[preflight] ${label}: ${actual} escapes ${mustBeInside}`);
  }
}

function guardWritable(label, dir) {
  if (!dir) throw new Error(`[preflight] ${label}: dir is null`);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      throw new Error(`[preflight] ${label}: cannot create ${dir}: ${e.message}`);
    }
  }
  try { fs.accessSync(dir, fs.constants.W_OK); } catch {
    throw new Error(`[preflight] ${label}: not writable: ${dir}`);
  }
}

async function runPreflightChecks() {
  const TIMEOUT = 10000;
  const results = [];
  const deadline = Date.now() + TIMEOUT;

  const checks = [
    { name: 'paths',     critical: true,  fn: checkPaths },
    { name: 'config',    critical: true,  fn: checkConfig },
    { name: 'processes', critical: true,  fn: checkProcesses },
    { name: 'native',    critical: false, fn: checkNative },
    { name: 'model',     critical: false, fn: checkModel },
  ];

  for (const check of checks) {
    if (Date.now() > deadline) {
      results.push({ name: check.name, pass: false, critical: check.critical, message: 'Timeout — check skipped' });
      continue;
    }
    try {
      const r = await check.fn();
      results.push({ name: check.name, pass: r.pass, critical: check.critical, message: r.message });
    } catch (e) {
      results.push({ name: check.name, pass: false, critical: check.critical, message: e.message });
    }
  }

  const criticalFailures = results.filter(r => !r.pass && r.critical);
  const warnings = results.filter(r => !r.pass && !r.critical);
  const allCriticalPass = criticalFailures.length === 0;

  for (const r of results) {
    const icon = r.pass ? 'OK' : (r.critical ? 'FAIL' : 'WARN');
    console.log(`[preflight] ${icon} ${r.name}: ${r.message}`);
  }

  return { allCriticalPass, criticalFailures, warnings, results };
}

function checkPaths() {
  const { getUserDataDir, getWorkspace } = require('./workspace');
  const { getBundledVendorDir } = require('./boot');
  const { getModelDir } = require('./model-downloader');

  const ud = getUserDataDir();
  guardWritable('getUserDataDir', ud);

  const ws = getWorkspace();
  guardWritable('getWorkspace', ws);

  const vendor = getBundledVendorDir();
  if (vendor) {
    if (!fs.existsSync(vendor)) {
      return { pass: false, message: `vendor dir missing: ${vendor}` };
    }
    const nm = path.join(vendor, 'node_modules');
    if (!fs.existsSync(nm)) {
      return { pass: false, message: `vendor/node_modules missing: ${nm}` };
    }
  }

  const modelDir = getModelDir();
  guardPath('getModelDir', modelDir, ud);

  return { pass: true, message: 'All paths OK' };
}

function checkConfig() {
  const ctx = require('./context');
  const configPath = path.join(ctx.HOME, '.openclaw', 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    return { pass: true, message: 'No openclaw.json yet (fresh install)' };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    JSON.parse(raw);
  } catch (e) {
    try {
      const backupPath = configPath + '.corrupt.' + Date.now();
      fs.copyFileSync(configPath, backupPath);
      fs.unlinkSync(configPath);
      return { pass: true, message: 'Config was corrupt JSON — backed up and removed for re-creation' };
    } catch (backupErr) {
      return { pass: false, message: 'Config is corrupt JSON and backup failed: ' + backupErr.message };
    }
  }
  return { pass: true, message: 'openclaw.json valid' };
}

function checkProcesses() {
  const { findNodeBin, getBundledVendorDir } = require('./boot');
  const node = findNodeBin();
  if (!node) {
    return { pass: false, message: 'Node binary not found — cron and gateway will fail' };
  }
  const vendor = getBundledVendorDir();
  if (vendor) {
    const nrDir = path.join(vendor, 'node_modules', '9router');
    if (!fs.existsSync(nrDir)) {
      return { pass: false, message: '9router package missing from vendor' };
    }
  }
  return { pass: true, message: 'Node: ' + node };
}

function checkNative() {
  try {
    require('better-sqlite3');
    return { pass: true, message: 'better-sqlite3 loads OK' };
  } catch (e) {
    if (String(e.message).includes('NODE_MODULE_VERSION')) {
      try {
        const { autoFixBetterSqlite3 } = require('./knowledge');
        const fixed = autoFixBetterSqlite3();
        if (fixed) return { pass: true, message: 'better-sqlite3 ABI auto-fixed' };
      } catch {}
    }
    return { pass: false, message: 'better-sqlite3: ' + e.message };
  }
}

function checkModel() {
  const { isModelDownloaded } = require('./model-downloader');
  if (isModelDownloaded()) {
    return { pass: true, message: 'RAG model present' };
  }
  return { pass: false, message: 'RAG model missing — will download on splash' };
}

module.exports = {
  guardPath,
  guardWritable,
  runPreflightChecks,
};
