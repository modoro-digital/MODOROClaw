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

const withToolChoice = t.buildCodexRequest ? t.buildCodexRequest('make an ad', [], '1024x1024') : {};
assert('default request forces image tool', withToolChoice.tool_choice?.type === 'image_generation', JSON.stringify(withToolChoice.tool_choice));

const withoutToolChoice = t.buildCodexRequest ? t.buildCodexRequest('make an ad', [], '1024x1024', { toolChoice: false }) : {};
assert('fallback request removes tool_choice', !Object.prototype.hasOwnProperty.call(withoutToolChoice, 'tool_choice'), JSON.stringify(withoutToolChoice.tool_choice));

assert(
  'detects 9router tool-choice rejection',
  t.isImageToolChoiceUnsupported?.(new Error("9router 400: Tool choice 'image_generation' not found in 'tools' parameter")) === true,
  'unsupported image tool-choice error was not recognized'
);

const cronApiSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf8');
assert('image route waits for immediate failure', cronApiSource.includes('waitForJobResult(jobId, 3000)'), 'image route does not wait for early job failure');
assert('image route returns failed status', cronApiSource.includes("status: 'failed'"), 'image route does not return failed status');
assert('image route exposes mediaId after completion', fs.readFileSync(path.join(__dirname, '..', 'lib', 'image-gen.js'), 'utf8').includes('mediaId'), 'image status does not expose mediaId for follow-up delivery');
assert('atomic image-to-zalo route exists', cronApiSource.includes('/api/image/generate-and-send-zalo'), 'missing atomic generate-and-send-zalo route');
assert('generated internal media can be sent only with explicit flag', cronApiSource.includes('allowInternalGenerated') && cronApiSource.includes("asset.type === 'generated'"), 'send-media does not gate internal generated image delivery explicitly');

if (failures.length) {
  console.error('[image-generation-route] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[image-generation-route] PASS early failure handling and tool-choice fallback');
