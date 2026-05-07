'use strict';

const fs = require('fs');
const path = require('path');

const ELECTRON_ROOT = path.resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = path.resolve(ELECTRON_ROOT, '..');

function relFromWorkspace(absPath) {
  return path.relative(WORKSPACE_ROOT, absPath).replace(/\\/g, '/');
}

function absFromWorkspace(relPath) {
  return path.join(WORKSPACE_ROOT, relPath);
}

function readText(relPath) {
  try { return fs.readFileSync(absFromWorkspace(relPath), 'utf8'); }
  catch { return ''; }
}

function walkFiles(startRel, options = {}) {
  const start = absFromWorkspace(startRel);
  const results = [];
  const ignore = new Set(options.ignore || ['node_modules', '.git', 'dist', 'vendor', 'win-unpacked']);
  const exts = options.exts || null;
  function walk(absDir) {
    let entries = [];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (!exts || exts.includes(path.extname(entry.name).toLowerCase())) {
        results.push(relFromWorkspace(abs));
      }
    }
  }
  if (fs.existsSync(start)) walk(start);
  return results.sort();
}

function addRoute(routeMap, route, source, kind) {
  if (!route || !route.startsWith('/api/')) return;
  const clean = route.replace(/\/+$/, '');
  if (!routeMap.has(clean)) routeMap.set(clean, { path: clean, sources: [], kinds: [] });
  const item = routeMap.get(clean);
  if (!item.sources.includes(source)) item.sources.push(source);
  if (kind && !item.kinds.includes(kind)) item.kinds.push(kind);
}

function collectApiRoutes() {
  const routeMap = new Map();
  const cronApiRel = 'electron/lib/cron-api.js';
  const cronApi = readText(cronApiRel);
  for (const match of cronApi.matchAll(/['"`](\/api\/[A-Za-z0-9_./-]+)['"`]/g)) {
    addRoute(routeMap, match[1], cronApiRel, 'local-api');
  }

  const googleRel = 'electron/lib/google-routes.js';
  const google = readText(googleRel);
  for (const match of google.matchAll(/urlPath\s*===\s*['"`](\/[A-Za-z0-9_./-]+)['"`]/g)) {
    addRoute(routeMap, '/api/google' + match[1], googleRel, 'google-api');
  }

  const fbSchedRel = 'electron/lib/fb-schedule.js';
  const fbSched = readText(fbSchedRel);
  for (const match of fbSched.matchAll(/urlPath\s*===\s*['"`](\/api\/[A-Za-z0-9_./-]+)['"`]/g)) {
    addRoute(routeMap, match[1], fbSchedRel, 'fb-schedule-api');
  }

  return [...routeMap.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function collectIpcHandlers() {
  const files = walkFiles('electron/lib', { exts: ['.js'] });
  const handlers = [];
  for (const rel of files) {
    const text = readText(rel);
    for (const match of text.matchAll(/ipcMain\.handle\(\s*['"`]([^'"`]+)['"`]/g)) {
      handlers.push({ channel: match[1], source: rel });
    }
  }
  return handlers.sort((a, b) => a.channel.localeCompare(b.channel));
}

function collectPreloadBridges() {
  const rel = 'electron/preload.js';
  const text = readText(rel);
  const bridges = [];
  for (const match of text.matchAll(/([A-Za-z0-9_]+)\s*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\(\s*['"`]([^'"`]+)['"`]/g)) {
    bridges.push({ name: match[1], channel: match[2], source: rel });
  }
  return bridges.sort((a, b) => a.name.localeCompare(b.name));
}

function collectDashboardPages() {
  const rel = 'electron/ui/dashboard.html';
  const text = readText(rel);
  const pages = [];
  for (const match of text.matchAll(/id=["']page-([^"']+)["']/g)) {
    pages.push({ id: match[1], source: rel });
  }
  return [...new Map(pages.map(p => [p.id, p])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

function collectCapabilityContracts() {
  const files = walkFiles('capabilities', { exts: ['.json'] }).filter(f => f.endsWith('.contract.json'));
  return files.map(rel => {
    try {
      const parsed = JSON.parse(readText(rel));
      return { id: parsed.id || path.basename(rel), title: parsed.title || '', source: rel };
    } catch {
      return { id: path.basename(rel), title: 'INVALID JSON', source: rel };
    }
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function collectLargeSourceFiles() {
  const files = [
    ...walkFiles('electron/lib', { exts: ['.js'] }),
    ...walkFiles('electron/ui', { exts: ['.html', '.css', '.js'] })
  ];
  return files.map(rel => {
    let bytes = 0;
    try { bytes = Buffer.byteLength(readText(rel).replace(/\r\n/g, '\n'), 'utf8'); } catch {}
    return { path: rel, bytes };
  }).filter(f => f.bytes >= 20000).sort((a, b) => b.bytes - a.bytes);
}

function collectApiRefsFromText(rel, text) {
  const refs = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(/\/api\/[A-Za-z0-9_./*-]+/g)) {
      const clean = match[0].replace(/[).,;:]+$/g, '').replace(/\/+$/g, '');
      refs.push({ path: clean, source: rel, line: i + 1, text: lines[i].trim() });
    }
  }
  return refs;
}

function buildSystemMap() {
  const apiRoutes = collectApiRoutes();
  const ipcHandlers = collectIpcHandlers();
  const preloadBridges = collectPreloadBridges();
  const dashboardPages = collectDashboardPages();
  const capabilityContracts = collectCapabilityContracts();
  return {
    generatedBy: 'electron/scripts/generate-system-map.js',
    counts: {
      apiRoutes: apiRoutes.length,
      ipcHandlers: ipcHandlers.length,
      preloadBridges: preloadBridges.length,
      dashboardPages: dashboardPages.length,
      capabilityContracts: capabilityContracts.length
    },
    apiRoutes,
    ipcHandlers,
    preloadBridges,
    dashboardPages,
    capabilityContracts,
    largeSourceFiles: collectLargeSourceFiles()
  };
}

function renderSystemMapText(map) {
  const lines = [];
  lines.push('9BizClaw Generated System Map');
  lines.push('');
  lines.push('Counts');
  for (const [key, value] of Object.entries(map.counts)) lines.push(`- ${key}: ${value}`);
  lines.push('');
  lines.push('Capability Contracts');
  for (const c of map.capabilityContracts) lines.push(`- ${c.id}: ${c.title} (${c.source})`);
  lines.push('');
  lines.push('API Routes');
  for (const r of map.apiRoutes) lines.push(`- ${r.path} [${r.kinds.join(', ')}]`);
  lines.push('');
  lines.push('Dashboard Pages');
  for (const p of map.dashboardPages) lines.push(`- ${p.id}`);
  lines.push('');
  lines.push('Large Source Files');
  for (const f of map.largeSourceFiles.slice(0, 20)) lines.push(`- ${f.path}: ${f.bytes} bytes`);
  return lines.join('\n') + '\n';
}

module.exports = {
  ELECTRON_ROOT,
  WORKSPACE_ROOT,
  absFromWorkspace,
  relFromWorkspace,
  readText,
  walkFiles,
  collectApiRoutes,
  collectApiRefsFromText,
  buildSystemMap,
  renderSystemMapText
};
