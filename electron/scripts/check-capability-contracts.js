#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  WORKSPACE_ROOT,
  absFromWorkspace,
  readText,
  walkFiles,
  collectApiRoutes
} = require('./lib/architecture-map');

const routeSet = new Set(collectApiRoutes().map(r => r.path));
const files = walkFiles('capabilities', { exts: ['.json'] }).filter(f => f.endsWith('.contract.json'));
const failures = [];

function fail(rel, message) {
  failures.push(`${rel}: ${message}`);
}

function requireArray(contract, rel, key, min = 1) {
  if (!Array.isArray(contract[key]) || contract[key].length < min) {
    fail(rel, `${key} must be an array with at least ${min} item(s)`);
    return [];
  }
  return contract[key];
}

for (const rel of files) {
  let contract;
  try {
    contract = JSON.parse(readText(rel));
  } catch (e) {
    fail(rel, `invalid JSON: ${e.message}`);
    continue;
  }

  for (const key of ['id', 'title', 'tokenSource']) {
    if (!contract[key] || typeof contract[key] !== 'string') fail(rel, `${key} is required`);
  }

  const ownerSource = requireArray(contract, rel, 'ownerSource');
  const triggerExamples = requireArray(contract, rel, 'triggerExamples');
  const allowedChannels = requireArray(contract, rel, 'allowedChannels');
  const blockedChannels = requireArray(contract, rel, 'blockedChannels');
  const apiCalls = requireArray(contract, rel, 'apiCalls');
  const successProofs = requireArray(contract, rel, 'successProofs');
  const negativeTests = requireArray(contract, rel, 'negativeTests', 2);
  const sideEffects = Array.isArray(contract.sideEffects) ? contract.sideEffects : [];

  for (const src of ownerSource) {
    if (!fs.existsSync(absFromWorkspace(src))) fail(rel, `ownerSource missing: ${src}`);
  }
  if (!triggerExamples.some(s => /[^\x00-\x7F]/.test(s))) fail(rel, 'triggerExamples should include real Vietnamese user phrasing');
  if (allowedChannels.includes('zalo-customer') && sideEffects.length) fail(rel, 'Zalo customer channel cannot own side-effect capabilities');
  if (!blockedChannels.some(c => c.startsWith('zalo'))) fail(rel, 'blockedChannels must explicitly mention Zalo boundary');
  if (/workspace\/read\?path=cron-api-token\.txt/i.test(contract.tokenSource || '')) fail(rel, 'tokenSource uses blocked cron-api-token workspace read');

  const highRisk = sideEffects.some(s => /publishes-to-facebook|may-send-email|may-send-zalo|creates-cron/i.test(s));
  if (highRisk && contract.requiresConfirmation !== true) fail(rel, 'high-risk side effects require CEO confirmation');

  for (const call of apiCalls) {
    if (!call || typeof call.path !== 'string') {
      fail(rel, 'apiCalls entries require path');
      continue;
    }
    if (!routeSet.has(call.path)) fail(rel, `api route not implemented: ${call.path}`);
    if (!call.purpose) fail(rel, `api call ${call.path} is missing purpose`);
  }

  if (!successProofs.some(s => /response|contains|id|success|values|metadata|jobId/i.test(s))) {
    fail(rel, 'successProofs must name a concrete machine-checkable proof');
  }
  if (!negativeTests.some(s => /must|reject|block|not/i.test(s))) {
    fail(rel, 'negativeTests must describe blocked failure modes');
  }
}

if (!files.length) fail('capabilities', 'no capability contracts found');

const fbPublisher = readText('electron/lib/fb-publisher.js');
if (/return\s+\{\s*valid:\s*true,\s*pageId:\s*me\.id/.test(fbPublisher)) {
  fail('electron/lib/fb-publisher.js', 'Facebook verifier still accepts plain /me user token as publishable Page config');
}

const cronApi = readText('electron/lib/cron-api.js');
if (!cronApi.includes('stripCronApiTokenFromCustomCrons') || !cronApi.includes('removed live API token from custom-crons.json')) {
  fail('electron/lib/cron-api.js', 'cron API must remove embedded live tokens from custom-crons after restart');
}
if (/finalPrompt\s*\+=[\s\S]{0,600}token=\s*['"]?\s*\+\s*_cronApiToken/.test(cronApi)) {
  fail('electron/lib/cron-api.js', 'agent cron prompts must not persist the live cron API token');
}
if (!cronApi.includes('/^memory\\/[^\\/]+\\.md$/') || !cronApi.includes('/^memory\\/?$/') || !cronApi.includes('/^\\.?learnings\\/?$/')) {
  fail('electron/lib/cron-api.js', 'workspace API must allow the night cron to read/list learnings and top-level memory journals');
}

const cronJs = readText('electron/lib/cron.js');
if (!cronJs.includes('collectMeditationContext') || !cronJs.includes('DU LIEU NOI BO DA DOC SAN')) {
  fail('electron/lib/cron.js', 'night meditation cron must preload workspace context instead of making the agent discover raw paths');
}

const facebookSkill = readText('skills/operations/facebook-image.md');
if (/workspace\/read\?path=cron-api-token\.txt/i.test(facebookSkill)) {
  fail('skills/operations/facebook-image.md', 'Facebook skill still instructs blocked cron token file read');
}

if (failures.length) {
  console.error('[capability-contracts] FAIL');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(`[capability-contracts] PASS ${files.length} contract(s), ${routeSet.size} route(s) checked`);
