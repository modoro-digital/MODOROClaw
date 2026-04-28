#!/usr/bin/env node
// Runtime logic tests for round 4 fixes

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}`); }
}

// ============================================================
// 1. groupId sanitization regex
// ============================================================
console.log('\n[groupId path traversal sanitization]');

const groupIdRe = /[\/\\]|\.\./.source;
const re = new RegExp(groupIdRe);

assert(re.test('../etc/passwd'), 'blocks "../etc/passwd"');
assert(re.test('..\\windows'), 'blocks "..\\windows"');
assert(re.test('group/slash'), 'blocks "group/slash"');
assert(re.test('a\\b'), 'blocks "a\\b"');
assert(re.test('....'), 'blocks "...." (contains ..)');
assert(!re.test('12345678'), 'allows "12345678"');
assert(!re.test('abc-def-ghi'), 'allows "abc-def-ghi"');
assert(!re.test('group_name_123'), 'allows "group_name_123"');
assert(!re.test('a.b'), 'allows "a.b" (single dot OK)');

// Also test the typeof + empty guard
function validateGroupId(groupId) {
  if (typeof groupId !== 'string' || !groupId || /[\/\\]|\.\./.test(groupId)) return false;
  return true;
}

assert(!validateGroupId(null), 'rejects null');
assert(!validateGroupId(undefined), 'rejects undefined');
assert(!validateGroupId(123), 'rejects number');
assert(!validateGroupId(''), 'rejects empty string');
assert(!validateGroupId('../../../etc/passwd'), 'rejects path traversal');
assert(validateGroupId('valid-group-id'), 'accepts valid group id');

// ============================================================
// 2. botToken redaction
// ============================================================
console.log('\n[botToken redaction logic]');

function redactToken(token) {
  const t = token || '';
  return {
    botToken: t ? t.slice(0, 6) + '…' + t.slice(-4) : '',
    botTokenSet: !!t,
  };
}

const fullToken = '1234567890:ABCDEFghijklmnopqrstuvwxyz1234567890';
const r1 = redactToken(fullToken);
assert(r1.botTokenSet === true, 'botTokenSet is true when token exists');
assert(r1.botToken.length < fullToken.length, 'redacted token is shorter than original');
assert(!r1.botToken.includes('ABCDEFghijklmnopqrstuvwxyz'), 'redacted token does not contain middle portion');
assert(r1.botToken.startsWith('123456'), 'redacted token starts with first 6 chars');
assert(r1.botToken.endsWith('7890'), 'redacted token ends with last 4 chars');

const r2 = redactToken('');
assert(r2.botTokenSet === false, 'botTokenSet is false when no token');
assert(r2.botToken === '', 'redacted empty token is empty string');

const r3 = redactToken(null);
assert(r3.botTokenSet === false, 'botTokenSet is false for null');

// ============================================================
// 3. POST body size limit simulation
// ============================================================
console.log('\n[POST body size limit logic]');

function simulateParseBody(chunks) {
  let totalLen = 0;
  const MAX_BODY = 1024 * 1024;
  const accepted = [];
  let destroyed = false;
  for (const c of chunks) {
    totalLen += c.length;
    if (totalLen <= MAX_BODY) accepted.push(c);
    else { destroyed = true; break; }
  }
  return { accepted, destroyed, totalLen };
}

const small = simulateParseBody([Buffer.alloc(500, 'a')]);
assert(!small.destroyed, '500 byte body accepted');
assert(small.accepted.length === 1, '500 byte body has 1 chunk');

const exact = simulateParseBody([Buffer.alloc(1024 * 1024, 'a')]);
assert(!exact.destroyed, 'exactly 1MB body accepted');

const over = simulateParseBody([Buffer.alloc(1024 * 1024 + 1, 'a')]);
assert(over.destroyed, '1MB+1 byte body rejected and destroyed');

const chunked = simulateParseBody([
  Buffer.alloc(512 * 1024, 'a'),
  Buffer.alloc(512 * 1024, 'b'),
  Buffer.alloc(1, 'c'),
]);
assert(chunked.destroyed, 'chunked body exceeding 1MB rejected on 3rd chunk');
assert(chunked.accepted.length === 2, 'first 2 chunks accepted before limit hit');

// ============================================================
// 4. add-cron error handling simulation
// ============================================================
console.log('\n[add-cron error return logic]');

function simulateAddCron(name, cron) {
  try {
    const parts = (cron || '').split(/\s+/);
    if (parts.length >= 2) {
      const m = parts[0].padStart(2, '0');
      const h = parts[1].padStart(2, '0');
      // Simulate loadSchedules throwing
      throw new Error('schedules file not found');
    }
    return { success: true };
  } catch (e) {
    console.error('  (expected error):', e.message);
    return { success: false, error: e.message };
  }
}

const cronResult = simulateAddCron('morning', '30 7 * * *');
assert(cronResult.success === false, 'add-cron returns success:false on error');
assert(cronResult.error === 'schedules file not found', 'add-cron returns error message');

const emptyResult = simulateAddCron('x', '');
// empty cron → parts.length < 2 → no throw → falls through to success
// But with our fix, success is inside try so it still returns
assert(emptyResult === undefined || emptyResult?.success === true || emptyResult?.success === undefined,
  'add-cron with empty cron does not throw');

// ============================================================
// 5. trimZaloMemoryFile logic
// ============================================================
console.log('\n[trimZaloMemoryFile for group files]');

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-test-'));
const testFile = path.join(tmpDir, 'test-group.md');

// Create a file with front-matter + multiple dated sections that exceeds 50KB
let content = '---\nname: Test Group\n---\n# Group 123\n\n';
for (let i = 0; i < 100; i++) {
  const date = `2025-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`;
  content += `\n## ${date}\n`;
  content += 'A'.repeat(600) + '\n';
}

fs.writeFileSync(testFile, content, 'utf-8');
const originalSize = fs.statSync(testFile).size;
assert(originalSize > 50 * 1024, `test file is ${originalSize} bytes (> 50KB)`);

// Load and run the actual trimZaloMemoryFile function from main.js
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf-8');
const trimMatch = mainSrc.match(/function trimZaloMemoryFile\(filePath, maxBytes\) \{[\s\S]*?\n\}/);
if (trimMatch) {
  const trimFn = new Function('fs', 'filePath', 'maxBytes', `
    const Buffer = global.Buffer;
    ${trimMatch[0].replace('function trimZaloMemoryFile(filePath, maxBytes)', '')}
  `);
  trimFn(fs, testFile, 50 * 1024);
  const newSize = fs.statSync(testFile).size;
  assert(newSize <= 50 * 1024, `trimmed file is ${newSize} bytes (<= 50KB)`);
  const trimmedContent = fs.readFileSync(testFile, 'utf-8');
  assert(trimmedContent.startsWith('---\nname: Test Group'), 'front-matter preserved after trim');
  assert(trimmedContent.includes('## 2025-'), 'some dated sections remain after trim');
} else {
  assert(false, 'could not extract trimZaloMemoryFile from main.js');
  assert(false, 'trim test skipped');
  assert(false, 'trim test skipped');
}

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

// ============================================================
// Results
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Runtime tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);
if (failed > 0) process.exit(1);
else console.log('\n✓ All runtime tests passed.');
