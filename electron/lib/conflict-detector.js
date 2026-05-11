'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);
const execSync = require('child_process').execSync;

let app;
try { ({ app } = require('electron')); } catch {}

const { PINNED_VERSIONS, MIN_NODE_VERSION, compareVersions, satisfiesMinVersion } = require('./runtime-installer');
const { enumerateNodeManagerBinDirs } = require('./boot');

function findNpmBin() {
  const isWin = process.platform === 'win32';
  const name = isWin ? 'npm.cmd' : 'npm';
  try {
    const cmd = isWin ? 'where npm.cmd' : 'command -v npm';
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, shell: !isWin }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && fs.existsSync(first)) return first;
  } catch {}
  for (const dir of enumerateNodeManagerBinDirs()) {
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return name;
}

// =====================================================================
// Conflict Detection
// =====================================================================

/**
 * Detection matrix for existing installations
 */
const DETECTION_MATRIX = [
  { state: 'no-node', action: 'install-node', reason: 'No Node.js found' },
  { state: 'node-too-old', action: 'install-node', reason: 'Node < 22.14' },
  { state: 'node-ok', action: 'use-existing', reason: 'Node >= 22.14' },
  { state: 'openclaw-old', action: 'upgrade-openclaw', reason: 'openclaw version mismatch' },
  { state: 'nine-router-old', action: 'upgrade-nine-router', reason: '9router version mismatch' },
  { state: 'packages-ok', action: 'use-existing', reason: 'All packages at correct versions' },
  { state: 'permission-denied', action: 'fallback-local', reason: 'Cannot install globally' },
];

/**
 * Check if npm global install would require permission
 */
async function wouldNeedSudo() {
  const isWin = process.platform === 'win32';
  const npmBin = findNpmBin();
  try {
    const out = execSync(npmBin + ' config get prefix', { encoding: 'utf-8', timeout: 5000, shell: isWin }).trim();
    if (isWin) return out.includes('Program Files');
    return out === '/usr' || out === '/usr/local';
  } catch {
    return false;
  }
}

/**
 * Detect version manager installations (nvm, volta, fnm, etc.)
 */
function detectVersionManagers() {
  const managers = [];
  const isWin = process.platform === 'win32';
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // nvm
  if (isWin) {
    const nvmRoot = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const nvmPath = path.join(nvmRoot, 'nvm');
    if (fs.existsSync(nvmPath)) {
      managers.push({ type: 'nvm', path: nvmPath, binDir: nvmPath });
    }
  } else {
    const nvmPath = path.join(home, '.nvm');
    if (fs.existsSync(nvmPath)) {
      managers.push({ type: 'nvm', path: nvmPath, binDir: path.join(nvmPath, 'versions', 'node') });
    }
  }

  // volta
  const voltaRoot = process.env.VOLTA_HOME || path.join(home, '.volta');
  if (fs.existsSync(voltaRoot)) {
    managers.push({ type: 'volta', path: voltaRoot, binDir: path.join(voltaRoot, 'bin') });
  }

  // fnm
  if (!isWin) {
    const fnmPath = path.join(home, '.fnm');
    if (fs.existsSync(fnmPath)) {
      managers.push({ type: 'fnm', path: fnmPath, binDir: path.join(fnmPath, 'node-versions') });
    }
  }

  // asdf
  if (!isWin) {
    const asdfPath = path.join(home, '.asdf');
    if (fs.existsSync(asdfPath)) {
      managers.push({ type: 'asdf', path: asdfPath, binDir: path.join(asdfPath, 'shims') });
    }
  }

  return managers;
}

/**
 * Check if user has other Node.js projects (heuristic)
 */
function hasOtherNodeProjects() {
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // Check common project locations
  const checkDirs = [
    path.join(home, 'projects'),
    path.join(home, 'dev'),
    path.join(home, 'code'),
    path.join(home, 'workspace'),
  ];

  for (const dir of checkDirs) {
    try {
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const pkgPath = path.join(dir, entry, 'package.json');
          if (fs.existsSync(pkgPath)) {
            return true;
          }
        }
      }
    } catch {}
  }

  return false;
}

/**
 * Get conflict info for a specific package
 */
async function getPackageConflict(pkgName) {
  try {
    const isWin = process.platform === 'win32';
    const npmBin = findNpmBin();
    const { stdout } = await execFilePromise(
      npmBin,
      ['view', pkgName, 'version'],
      { timeout: 10000, encoding: 'utf-8', shell: isWin }
    );
    const latestVersion = stdout.trim();

    // Check if installed
    let installedVersion = null;
    try {
      const { stdout: lsOut } = await execFilePromise(
        npmBin,
        ['list', '-g', pkgName, '--depth=0', '--json'],
        { timeout: 10000, encoding: 'utf-8', shell: isWin }
      );
      const info = JSON.parse(lsOut);
      installedVersion = info[pkgName]?.version || null;
    } catch {}

    return {
      name: pkgName,
      installed: installedVersion,
      latest: latestVersion,
      pinned: PINNED_VERSIONS[pkgName.replace('-', '').replace('9router', 'nineRouter')] || null,
      outdated: installedVersion && compareVersions(installedVersion, latestVersion) < 0,
    };
  } catch (e) {
    return {
      name: pkgName,
      installed: null,
      latest: null,
      pinned: null,
      outdated: false,
      error: e.message,
    };
  }
}

/**
 * Detect all conflicts
 */
async function detectAllConflicts() {
  const conflicts = {
    node: {
      found: false,
      version: null,
      satisfiesMin: false,
      managers: detectVersionManagers(),
      wouldNeedSudo: await wouldNeedSudo(),
      hasOtherProjects: hasOtherNodeProjects(),
    },
    packages: [],
    strategies: [],
  };

  // Check Node.js
  try {
    const isWin = process.platform === 'win32';
    const { stdout } = await execFilePromise(
      isWin ? 'node' : 'node',
      ['--version'],
      { timeout: 5000, encoding: 'utf-8' }
    );
    const version = stdout.trim();
    conflicts.node.found = true;
    conflicts.node.version = version;
    conflicts.node.satisfiesMin = satisfiesMinVersion(version);
  } catch {
    conflicts.node.found = false;
  }

  // Check packages
  for (const pkg of [
    { name: 'openclaw', key: 'openclaw' },
    { name: 'openzca', key: 'openzca' },
    { name: '9router', key: 'nineRouter' },
  ]) {
    const conflict = await getPackageConflict(pkg.name);
    conflicts.packages.push(conflict);
  }

  // Determine strategies
  if (!conflicts.node.found) {
    conflicts.strategies.push({
      type: 'install-node',
      priority: 1,
      reason: 'No Node.js found',
    });
  } else if (!conflicts.node.satisfiesMin) {
    conflicts.strategies.push({
      type: 'install-node',
      priority: 1,
      reason: `Node ${conflicts.node.version} < ${MIN_NODE_VERSION}`,
    });
  }

  // Check if would need sudo for global install
  if (conflicts.node.wouldNeedSudo) {
    conflicts.strategies.push({
      type: 'local-install',
      priority: 2,
      reason: 'Would need admin rights for global install',
    });
  }

  // Check for other Node.js projects
  if (conflicts.node.hasOtherProjects) {
    conflicts.strategies.push({
      type: 'parallel-install',
      priority: 3,
      reason: 'User has other Node.js projects',
    });
  }

  return conflicts;
}

// =====================================================================
// Conflict Resolution Strategies
// =====================================================================

/**
 * Resolution strategy: Use existing if compatible
 */
async function useExistingStrategy(conflicts) {
  if (!conflicts.node.found || !conflicts.node.satisfiesMin) {
    return { applied: false, reason: 'Node not suitable for use' };
  }

  // Check all packages
  for (const pkg of conflicts.packages) {
    if (pkg.installed && pkg.installed !== pkg.pinned) {
      return {
        applied: false,
        reason: `Package ${pkg.name} version mismatch: have ${pkg.installed}, need ${pkg.pinned}`,
      };
    }
  }

  return {
    applied: true,
    strategy: 'use-existing',
    reason: 'Existing installation is compatible',
  };
}

/**
 * Resolution strategy: Install in parallel (userData)
 */
function parallelInstallStrategy(conflicts) {
  return {
    applied: true,
    strategy: 'parallel-install',
    reason: 'Installing to userData to avoid affecting system Node',
    installPath: path.join(
      process.env.APPDATA || (process.env.HOME + '/.local/share'),
      app?.isPackaged ? '9bizclaw' : 'openclaw',
      'node_modules'
    ),
  };
}

/**
 * Resolution strategy: Upgrade existing packages
 */
async function upgradeStrategy(conflicts) {
  const upgrades = [];

  for (const pkg of conflicts.packages) {
    if (pkg.installed && pkg.pinned && pkg.installed !== pkg.pinned) {
      upgrades.push({
        name: pkg.name,
        from: pkg.installed,
        to: pkg.pinned,
        breaking: false, // TODO: check changelog
      });
    }
  }

  if (upgrades.length === 0) {
    return { applied: false, reason: 'No packages need upgrade' };
  }

  return {
    applied: true,
    strategy: 'upgrade',
    upgrades,
    reason: `Upgrading ${upgrades.length} package(s)`,
  };
}

/**
 * Resolution strategy: Prompt user for upgrade
 */
function promptUpgradeStrategy(conflicts) {
  return {
    applied: true,
    strategy: 'prompt-upgrade',
    reason: 'Major version change requires user confirmation',
    requiresConfirmation: true,
  };
}

/**
 * Resolution strategy: Fallback to local install
 */
function fallbackLocalStrategy(conflicts) {
  return {
    applied: true,
    strategy: 'fallback-local',
    reason: 'Global install not available, using local userData install',
    installPath: path.join(
      app?.getPath?.('userData') || process.env.APPDATA || '',
      '9bizclaw',
      'node_modules'
    ),
  };
}

// =====================================================================
// Main Resolution
// =====================================================================

/**
 * Determine best resolution strategy for conflicts
 */
async function resolveConflicts(conflicts) {
  // Try strategies in order of preference

  // Strategy 1: Use existing if compatible
  const existingResult = await useExistingStrategy(conflicts);
  if (existingResult.applied) {
    return existingResult;
  }

  // Strategy 2: Upgrade existing packages
  const upgradeResult = await upgradeStrategy(conflicts);
  if (upgradeResult.applied) {
    return upgradeResult;
  }

  // Strategy 3: Would need sudo + has other projects → parallel install
  if (conflicts.node.wouldNeedSudo && conflicts.node.hasOtherProjects) {
    return parallelInstallStrategy(conflicts);
  }

  // Strategy 4: Would need sudo → fallback local
  if (conflicts.node.wouldNeedSudo) {
    return fallbackLocalStrategy(conflicts);
  }

  // Strategy 5: Default → install Node if needed
  if (!conflicts.node.found || !conflicts.node.satisfiesMin) {
    return {
      applied: true,
      strategy: 'install-node',
      reason: 'Need to install Node.js',
    };
  }

  // Default fallback
  return fallbackLocalStrategy(conflicts);
}

/**
 * Main entry point: detect and resolve all conflicts
 */
async function analyzeAndResolve() {
  console.log('[conflict-detector] Analyzing conflicts...');

  const conflicts = await detectAllConflicts();

  console.log('[conflict-detector] Node:', conflicts.node);
  console.log('[conflict-detector] Packages:', conflicts.packages.map(p => `${p.name}@${p.installed || 'not installed'}`));

  const resolution = await resolveConflicts(conflicts);

  console.log('[conflict-detector] Resolution:', resolution);

  return {
    conflicts,
    resolution,
  };
}

// =====================================================================
// Module Exports
// =====================================================================
module.exports = {
  // Detection
  detectAllConflicts,
  detectVersionManagers,
  wouldNeedSudo,
  getPackageConflict,
  hasOtherNodeProjects,

  // Resolution
  resolveConflicts,
  analyzeAndResolve,
  useExistingStrategy,
  parallelInstallStrategy,
  upgradeStrategy,
  promptUpgradeStrategy,
  fallbackLocalStrategy,

  // Constants
  DETECTION_MATRIX,
};
