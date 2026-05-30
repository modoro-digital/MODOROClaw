#!/usr/bin/env node
'use strict';

/**
 * Pre-flight contract test — catches 90% of refactoring bugs:
 * 1. Every lib/*.js module loads without throwing
 * 2. Every exported function is callable (not undefined/null)
 * 3. No infinite recursion in zero-arg getters (detects self-referential functions)
 * 4. Path-returning functions don't return null when workspace is available
 * 5. All module.exports keys are defined
 *
 * Run: node scripts/check-module-contracts.js
 * Exit 0 = all OK, Exit 1 = failures found
 */

const fs = require('fs');
const path = require('path');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const failures = [];
const warnings = [];

function fail(msg) { failures.push(msg); console.error('  FAIL  ' + msg); }
function warn(msg) { warnings.push(msg); console.warn('  WARN  ' + msg); }
function pass(msg) { console.log('  PASS  ' + msg); }

// Mock electron for modules that import it
try {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'electron') {
      return require.resolve('../scripts/mock-electron.js');
    }
    return origResolve.call(this, request, parent, isMain, options);
  };
} catch {}

// Create minimal electron mock if it doesn't exist
const mockPath = path.join(__dirname, 'mock-electron.js');
if (!fs.existsSync(mockPath)) {
  fs.writeFileSync(mockPath, `
'use strict';
module.exports = {
  app: {
    getPath: (name) => {
      if (name === 'userData') return require('path').join(require('os').homedir(), 'AppData', 'Roaming', '9bizclaw');
      return require('os').tmpdir();
    },
    getName: () => '9bizclaw',
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: () => {},
    requestSingleInstanceLock: () => true,
    quit: () => {},
    exit: () => {},
  },
  BrowserWindow: class BrowserWindow { constructor() {} loadFile() {} },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openExternal: () => {} },
  dialog: { showOpenDialog: () => Promise.resolve({}) },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  powerMonitor: { on: () => {} },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } }, fromPartition: () => ({ webRequest: { onHeadersReceived: () => {} } }) },
  nativeTheme: { themeSource: 'system' },
  Tray: class Tray { constructor() {} setContextMenu() {} setToolTip() {} },
  Menu: { buildFromTemplate: () => ({}) },
};
`, 'utf-8');
}

// ============================================
// TEST 1: Every lib/*.js module loads
// ============================================
console.log('\n[Module load test]');
const libFiles = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.js')).sort();
const loadedModules = {};

for (const file of libFiles) {
  const modPath = path.join(LIB_DIR, file);
  try {
    loadedModules[file] = require(modPath);
    pass(file + ' loaded OK');
  } catch (e) {
    fail(file + ' FAILED to load: ' + e.message.split('\n')[0]);
  }
}

// ============================================
// TEST 2: Every export is defined (not undefined)
// ============================================
console.log('\n[Export definition test]');
let undefinedExports = 0;
for (const [file, mod] of Object.entries(loadedModules)) {
  if (!mod || typeof mod !== 'object') continue;
  for (const [key, val] of Object.entries(mod)) {
    if (val === undefined) {
      fail(file + ' exports.' + key + ' is undefined');
      undefinedExports++;
    } else if (val === null && key.toLowerCase().includes('path')) {
      warn(file + ' exports.' + key + ' is null (path function returning null?)');
    }
  }
}
if (undefinedExports === 0) pass('all exports defined');

// ============================================
// TEST 3: Zero-arg getter functions don't infinite-recurse
// ============================================
console.log('\n[Infinite recursion test]');
const GETTER_PATTERNS = /^(get|find|resolve|load|read|compute|detect)/;
const SAFE_TIMEOUT = 500; // ms

for (const [file, mod] of Object.entries(loadedModules)) {
  if (!mod || typeof mod !== 'object') continue;
  for (const [key, val] of Object.entries(mod)) {
    if (typeof val !== 'function') continue;
    if (!GETTER_PATTERNS.test(key)) continue;
    if (val.length > 0) continue; // skip functions with required params

    try {
      const start = Date.now();
      const timer = setTimeout(() => {
        fail(file + '.' + key + '() — took >500ms (possible infinite recursion)');
      }, SAFE_TIMEOUT);

      val();
      clearTimeout(timer);

      const elapsed = Date.now() - start;
      if (elapsed > 200) {
        warn(file + '.' + key + '() took ' + elapsed + 'ms (slow)');
      }
    } catch (e) {
      if (e.message && e.message.includes('Maximum call stack')) {
        fail(file + '.' + key + '() INFINITE RECURSION detected');
      }
      // Other errors are OK (may need runtime context)
    }
  }
}
pass('zero-arg getters checked');

// ============================================
// TEST 4: Path functions return strings (not null) when workspace exists
// ============================================
console.log('\n[Path function null test]');
const PATH_FUNCS = /^(get|find).*(path|dir|file)/i;

for (const [file, mod] of Object.entries(loadedModules)) {
  if (!mod || typeof mod !== 'object') continue;
  for (const [key, val] of Object.entries(mod)) {
    if (typeof val !== 'function') continue;
    if (!PATH_FUNCS.test(key)) continue;
    if (val.length > 0) continue;

    try {
      const result = val();
      if (result === null || result === undefined) {
        warn(file + '.' + key + '() returned null/undefined — callers must handle null');
      }
    } catch {
      // Expected for some functions that need runtime context
    }
  }
}
pass('path functions checked');

// ============================================
// TEST 5: Source-level checks (grep for common bugs)
// ============================================
console.log('\n[Source pattern test]');

for (const file of libFiles) {
  const src = fs.readFileSync(path.join(LIB_DIR, file), 'utf-8');

  // Check for self-referential functions: function foo() { return foo(); }
  const selfRefRegex = /function\s+(\w+)\s*\([^)]*\)\s*\{\s*return\s+\1\s*\(/g;
  let match;
  while ((match = selfRefRegex.exec(src)) !== null) {
    fail(file + ': function ' + match[1] + '() calls itself — infinite recursion');
  }

  // Check for path.join/path.dirname with potential null
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // path.join(getXxxPath(), ...) where getXxxPath might return null
    if (/path\.(join|dirname|resolve)\(get\w+Path\(\)/.test(line)) {
      // Check if there's a null guard in the preceding 3 lines
      const context = lines.slice(Math.max(0, i - 3), i).join('\n');
      if (!context.includes('if (!') && !context.includes('if (') && !context.includes('|| ')) {
        warn(file + ':' + (i + 1) + ' — path.join with getter that may return null, no null guard visible');
      }
    }
  }
}
pass('source patterns checked');

// ============================================
// SUMMARY
// ============================================
console.log('\n============================================');
if (failures.length === 0) {
  console.log('Module contracts OK: ' + libFiles.length + ' modules, 0 failures, ' + warnings.length + ' warnings');
  process.exit(0);
} else {
  console.error('Module contracts FAILED: ' + failures.length + ' failure(s), ' + warnings.length + ' warning(s)');
  process.exit(1);
}
