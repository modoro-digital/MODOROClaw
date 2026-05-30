#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const imageGen = require(path.join(__dirname, '..', 'lib', 'image-gen'));

const failures = [];

function assert(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail || 'assertion failed'}`);
}

const t = imageGen._test || {};
assert('exports test helpers', typeof t.buildCodexRequest === 'function', 'missing buildCodexRequest');
assert('exports waitForJobResult', typeof imageGen.waitForJobResult === 'function', 'missing waitForJobResult');

const req = t.buildCodexRequest ? t.buildCodexRequest('make an ad', [], '1024x1024') : {};
assert('request uses codex model', req.model === 'cx/gpt-5.4', 'model: ' + req.model);
assert('request has input', Array.isArray(req.input) && req.input.length > 0, 'missing input array');
assert('request has image_generation tool', Array.isArray(req.tools) && req.tools.some(t => t.type === 'image_generation'), 'missing image_generation tool');

assert('can resolve connection id', typeof t.findImageConnectionId === 'function', 'missing findImageConnectionId');
assert('exports stale job test helper', typeof t._expireJobIfStale === 'function' && typeof t._jobTiming === 'function', 'missing stale job helpers');
if (typeof t._expireJobIfStale === 'function' && typeof t._jobTiming === 'function') {
  let waiterCalled = false;
  const now = Date.now();
  const staleJob = { status: 'generating', startedAt: now - (16 * 60 * 1000), waiters: [() => { waiterCalled = true; }] };
  t._expireJobIfStale(staleJob, now);
  assert('stale generating job becomes failed', staleJob.status === 'failed' && /timed out/i.test(staleJob.error || ''), 'stale job did not fail');
  assert('stale generating job wakes waiters', waiterCalled === true, 'waiter was not notified when stale job expired');
  const timing = t._jobTiming({ startedAt: now - 1234 }, now);
  assert('job timing helper exposes polling metadata', timing.ageMs === 1234 && timing.timeoutMs > 0 && !!timing.timeoutAt, 'missing ageMs/timeoutMs/timeoutAt');
}

assert('exports normalizeImageSize', typeof imageGen.normalizeImageSize === 'function', 'missing normalizeImageSize');
if (imageGen.normalizeImageSize) {
  assert('landscape → 1792x1024', imageGen.normalizeImageSize('landscape') === '1792x1024', imageGen.normalizeImageSize('landscape'));
  assert('portrait → 1024x1792', imageGen.normalizeImageSize('portrait') === '1024x1792', imageGen.normalizeImageSize('portrait'));
  assert('square → 1024x1024', imageGen.normalizeImageSize('square') === '1024x1024', imageGen.normalizeImageSize('square'));
  assert('ngang → 1792x1024', imageGen.normalizeImageSize('ngang') === '1792x1024', imageGen.normalizeImageSize('ngang'));
  assert('valid size passes through', imageGen.normalizeImageSize('1024x1024') === '1024x1024', imageGen.normalizeImageSize('1024x1024'));
  assert('null → 1024x1024', imageGen.normalizeImageSize(null) === '1024x1024', imageGen.normalizeImageSize(null));
  assert('garbage → 1024x1024', imageGen.normalizeImageSize('blah') === '1024x1024', imageGen.normalizeImageSize('blah'));
}

const reqLandscape = t.buildCodexRequest ? t.buildCodexRequest('test', [], 'landscape') : {};
assert('buildCodexRequest normalizes landscape', reqLandscape.tools?.[0]?.size === '1792x1024', 'size: ' + reqLandscape.tools?.[0]?.size);

const cronApiSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf8');
const imageGenSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'image-gen.js'), 'utf8');
const root = path.join(__dirname, '..', '..');
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
const imageWorkflow = fs.readFileSync(path.join(root, 'skills', 'operations', 'image-generation.md'), 'utf8');
const chainWorkflow = fs.readFileSync(path.join(root, 'skills', 'operations', 'workflow-chains.md'), 'utf8');
const telegramCeo = fs.readFileSync(path.join(root, 'skills', 'operations', 'telegram-ceo.md'), 'utf8');
assert('image route waits for immediate failure', cronApiSource.includes('waitForJobResult(jobId, 3000)'), 'image route does not wait for early job failure');
assert('image route returns failed status', cronApiSource.includes("status: 'failed'"), 'image route does not return failed status');
assert('waitMs timeout stays pollable', cronApiSource.includes('timedOut: true') && cronApiSource.includes('retryStatusUrl') && !cronApiSource.includes("image generation did not finish within ${Math.round(waitMs / 1000)}s"), 'waitMs timeout should return a pollable 200 response, not hard HTTP 504');
assert('image route caps agent blocking waits at five minutes', cronApiSource.includes('maxAgentWaitMs = 5 * 60 * 1000') && cronApiSource.includes('waitMsCapped') && cronApiSource.includes('effectiveWaitMs'), 'image route must cap blocking waits at 5 minutes and expose cap metadata');
assert('atomic Zalo image route stays pollable', cronApiSource.includes('deliveryPending: true') && cronApiSource.includes('Zalo delivery will continue if the image finishes'), 'atomic image/Zalo route should return pollable pending state instead of blocking 14 minutes');
assert('image workflow uses five minute blocking wait for long follow-up jobs', imageWorkflow.includes('waitMs=300000') && !imageWorkflow.includes('waitMs=540000') && !imageWorkflow.includes('waitMs=180000') && !imageWorkflow.includes('waitMs=120000'), 'image-generation skill must teach a 5-minute wait, not stale 2/3/9-minute waits');
assert('image workflows document parallel multi-image starts', imageWorkflow.includes('2-3 ảnh') && imageWorkflow.includes('song song') && chainWorkflow.includes('song song'), 'image workflows must document parallel starts for 2-3 independent images');
assert('image status exposes age and timeout metadata', imageGenSource.includes('ageMs') && imageGenSource.includes('timeoutMs') && imageGenSource.includes('timeoutAt'), 'image status should expose ageMs/timeoutMs/timeoutAt so agents can poll intelligently');
assert('stale image jobs expire during status reads', imageGenSource.includes('function _expireJobIfStale') && /getJobStatus[\s\S]*_expireJobIfStale/.test(imageGenSource), 'getJobStatus should mark over-time generating jobs failed even if the timer callback is delayed');
assert('AUTO-MODE message tool ordering documented', agents.includes('tool `message` PHẢI chạy SAU') && agents.includes('tool cuối'), 'AUTO-MODE must tell agents not to put progress message before blocking tools');
assert('AUTO-MODE chains continue after step failure', chainWorkflow.includes('[AUTO-MODE]') && chainWorkflow.includes('BỎ QUA') && chainWorkflow.includes('tiếp tục bước sau'), 'workflow chains must not use fail-fast stopping semantics in AUTO-MODE');
assert('image route exposes mediaId after completion', imageGenSource.includes('mediaId'), 'image status does not expose mediaId for follow-up delivery');
assert('atomic image-to-zalo route exists', cronApiSource.includes('/api/image/generate-and-send-zalo'), 'missing atomic generate-and-send-zalo route');
assert('generated internal media delivery is gated', cronApiSource.includes('allowInternalGenerated') && cronApiSource.includes('recoveredGeneratedPath') && cronApiSource.includes("asset.type === 'generated'"), 'send-media does not gate internal generated image delivery explicitly');
assert('send-media can recover generated image path', cronApiSource.includes('resolveGeneratedMediaAssetFromPath') && cronApiSource.includes('send-media-path-recovery'), 'send-media should safely resolve brand-assets/generated paths after slow image jobs');
assert('send-media accepts text caption alias', cronApiSource.includes('mediaCaption') && cronApiSource.includes('params.text') && cronApiSource.includes('params.message'), 'send-media should treat text/message as caption aliases');
assert('Zalo group lookup route exists', cronApiSource.includes("/api/zalo/groups") && telegramCeo.includes('/api/zalo/groups?name=<tên>'), 'CEO workflows need a first-class group name lookup route');
assert('workflow sends generated image via API, not message tool', chainWorkflow.includes('imagePath=<path>') && chainWorkflow.includes('/api/zalo/send-media') && chainWorkflow.includes('KHÔNG dùng tool `message` channel modoro-zalo'), 'workflow must use /api/zalo/send-media for generated images');
assert('atomic image-to-zalo uses CEO override', /sendZaloMediaTo\(deliveryTarget,\s*imgPath,\s*\{[^}]*ceoOverride:\s*true/.test(cronApiSource), 'generate-and-send-zalo must bypass pause/policy for CEO commands');
assert('direct image-to-zalo uses CEO override', /sendZaloMediaTo\(zaloTarget,\s*imgPath,\s*\{[^}]*ceoOverride:\s*true/.test(cronApiSource), 'image/generate targetId delivery must bypass pause/policy for CEO commands');
assert('brand asset import route exists', cronApiSource.includes('/api/brand-assets/import'), 'missing route to import Telegram reference image paths into brand assets');
assert('brand asset import rejects non-images', /validImageExts\.has\(path\.extname\(safeName\)\.toLowerCase\(\)\)/.test(cronApiSource), 'brand asset import must restrict copied files to image extensions');

if (failures.length) {
  console.error('[image-generation-route] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[image-generation-route] PASS codex responses API routing and early failure handling');
