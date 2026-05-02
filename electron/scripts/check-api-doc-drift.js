#!/usr/bin/env node
'use strict';

const {
  readText,
  walkFiles,
  collectApiRoutes,
  collectApiRefsFromText
} = require('./lib/architecture-map');

const routeSet = new Set(collectApiRoutes().map(r => r.path));
const failures = [];
const warnings = [];

const files = [
  'AGENTS.md',
  'README.md',
  ...walkFiles('skills', { exts: ['.md'] }).filter(f => !f.startsWith('skills/_archived/')),
  ...walkFiles('docs', { exts: ['.md'] }).filter(f => !f.startsWith('docs/generated/') && !f.startsWith('docs/superpowers/'))
];

function routeExists(refPath) {
  if (routeSet.has(refPath)) return true;
  if (refPath.endsWith('/*')) {
    const prefix = refPath.slice(0, -1);
    return [...routeSet].some(route => route.startsWith(prefix));
  }
  return false;
}

for (const rel of files) {
  const text = readText(rel);
  if (!text) continue;
  if (/\/api\/workspace\/read\?path=cron-api-token\.txt/i.test(text)) {
    failures.push(`${rel}: blocked token bootstrap path /api/workspace/read?path=cron-api-token.txt`);
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\/api\/auth\/token/.test(line) && !/bot_token/.test(line) && !/(KHÔNG|KHONG|do not|don't)/i.test(line)) {
      warnings.push(`${rel}:${i + 1}: /api/auth/token mentioned without bot_token on the same line`);
    }
  }
  for (const ref of collectApiRefsFromText(rel, text)) {
    if (/\/api\/google\/\*/.test(ref.path)) continue;
    if (/\/api\/[A-Za-z0-9_-]+\/\*/.test(ref.path) && routeExists(ref.path)) continue;
    if (!routeExists(ref.path)) {
      failures.push(`${ref.source}:${ref.line}: documented API route not implemented: ${ref.path}`);
    }
  }
}

if (failures.length) {
  console.error('[api-doc-drift] FAIL');
  for (const f of failures.slice(0, 80)) console.error('  - ' + f);
  if (failures.length > 80) console.error(`  ... ${failures.length - 80} more`);
  process.exit(1);
}

console.log(`[api-doc-drift] PASS ${files.length} docs/skill file(s), ${routeSet.size} implemented route(s)`);
for (const w of warnings.slice(0, 10)) console.warn('[api-doc-drift] WARN ' + w);
