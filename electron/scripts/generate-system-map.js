#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  WORKSPACE_ROOT,
  buildSystemMap,
  renderSystemMapText
} = require('./lib/architecture-map');

const CHECK = process.argv.includes('--check');
const outDir = path.join(WORKSPACE_ROOT, 'docs', 'generated');
const jsonPath = path.join(outDir, 'system-map.json');
const textPath = path.join(outDir, 'system-map.txt');

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const map = buildSystemMap();
const json = stableJson(map);
const text = renderSystemMapText(map);

if (CHECK) {
  const currentJson = readIfExists(jsonPath);
  const currentText = readIfExists(textPath);
  const stale = currentJson !== json || currentText !== text;
  if (stale) {
    console.error('[system-map] generated map is stale. Run: npm run map:generate');
    if (currentJson === null) console.error('[system-map] missing docs/generated/system-map.json');
    if (currentText === null) console.error('[system-map] missing docs/generated/system-map.txt');
    if (currentJson && currentJson !== json) {
      const cLines = currentJson.split('\n');
      const gLines = json.split('\n');
      console.error(`[system-map] json diff: committed=${cLines.length} lines (${currentJson.length} chars), generated=${gLines.length} lines (${json.length} chars)`);
      for (let i = 0; i < Math.max(cLines.length, gLines.length); i++) {
        if (cLines[i] !== gLines[i]) {
          console.error(`[system-map] first diff at line ${i + 1}:`);
          console.error(`  committed: ${JSON.stringify((cLines[i] || '').slice(0, 200))}`);
          console.error(`  generated: ${JSON.stringify((gLines[i] || '').slice(0, 200))}`);
          const ctx = 3;
          for (let j = i + 1; j < Math.min(i + ctx + 1, Math.max(cLines.length, gLines.length)); j++) {
            if (cLines[j] !== gLines[j]) {
              console.error(`  diff line ${j + 1}: committed=${JSON.stringify((cLines[j] || '').slice(0, 120))} generated=${JSON.stringify((gLines[j] || '').slice(0, 120))}`);
            }
          }
          break;
        }
      }
    }
    process.exit(1);
  }
  console.log(`[system-map] PASS routes=${map.counts.apiRoutes} ipc=${map.counts.ipcHandlers} capabilities=${map.counts.capabilityContracts}`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(jsonPath, json, 'utf8');
fs.writeFileSync(textPath, text, 'utf8');
console.log(`[system-map] wrote ${path.relative(WORKSPACE_ROOT, jsonPath)} and ${path.relative(WORKSPACE_ROOT, textPath)}`);
