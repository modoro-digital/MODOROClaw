#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
function assert(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail || 'assertion failed'}`);
}

let security = null;
try {
  security = require(path.join(__dirname, '..', 'lib', 'attachment-security'));
} catch (e) {
  failures.push(`loads attachment-security module: ${e.message}`);
}

if (security) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '9bizclaw-attachment-security-'));
  try {
    const sourcePath = path.join(tmp, 'source.pdf');
    fs.writeFileSync(sourcePath, Buffer.from('%PDF-1.4\n% attachment smoke\n', 'utf8'));
    const record = security.createQuarantineRecord({
      workspace: tmp,
      source: 'gmail',
      sourceRef: { messageId: 'msg-1', attachmentId: 'att-1' },
      filePath: sourcePath,
      filename: '../bao-gia.pdf',
      mimeType: 'application/pdf',
    });
    assert('quarantine record has id', /^att_[a-f0-9]{16}_[a-z0-9]+$/.test(record.id), JSON.stringify(record));
    assert('quarantine path is inside quarantine root', security.isQuarantinePath(record.path, { workspace: tmp }), record.path);
    assert('filename is sanitized', record.filename === 'bao-gia.pdf', record.filename);
    assert('pdf magic is detected', record.detectedType === 'pdf', record.detectedType);
    assert('pdf record is not blocked', record.risk && record.risk.blocked === false, JSON.stringify(record.risk));
    const agentView = security.toAgentAttachment(record);
    assert('agent view exposes quarantine id', agentView.quarantineId === record.id, JSON.stringify(agentView));
    assert('agent view does not expose raw file path', !Object.prototype.hasOwnProperty.call(agentView, 'path'), JSON.stringify(agentView));
    assert('agent view marks untrusted', agentView.untrusted === true, JSON.stringify(agentView));
    assert('agent view exposes analyze route', /\/api\/attachments\/analyze\?id=/.test(agentView.analyzeUrl || ''), JSON.stringify(agentView));

    const exePath = path.join(tmp, 'evil.exe');
    fs.writeFileSync(exePath, Buffer.from('MZfake', 'utf8'));
    const exe = security.createQuarantineRecord({
      workspace: tmp,
      source: 'gmail',
      sourceRef: { messageId: 'msg-1', attachmentId: 'att-2' },
      filePath: exePath,
      filename: 'invoice.exe',
      mimeType: 'application/octet-stream',
    });
    assert('dangerous extension is blocked', exe.risk.blocked === true && exe.risk.reasons.includes('dangerous-extension'), JSON.stringify(exe.risk));

    const mismatchPath = path.join(tmp, 'mismatch.pdf');
    fs.writeFileSync(mismatchPath, Buffer.from('MZnot-a-pdf', 'utf8'));
    const mismatch = security.createQuarantineRecord({
      workspace: tmp,
      source: 'gmail',
      sourceRef: { messageId: 'msg-1', attachmentId: 'att-3' },
      filePath: mismatchPath,
      filename: 'mismatch.pdf',
      mimeType: 'application/pdf',
    });
    assert('magic mismatch is blocked', mismatch.risk.blocked === true && mismatch.risk.reasons.includes('extension-magic-mismatch'), JSON.stringify(mismatch.risk));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const securitySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'attachment-security.js'), 'utf8');
assert('child analyzer receives packaged NODE_PATH', securitySource.includes('NODE_PATH') && securitySource.includes('getRuntimeNodeModulesDir'), 'packaged child analyzer must resolve runtime vendor packages');

const cronApiSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf8');
assert('attachments analyze route exists', cronApiSource.includes("urlPath === '/api/attachments/analyze'"), 'missing /api/attachments/analyze');
assert('file read blocks quarantine paths', cronApiSource.includes('isQuarantinePath(abs'), 'file/read must not parse quarantine files directly');

const analyzerPath = path.join(__dirname, 'attachment-analyzer-child.js');
assert('child analyzer exists', fs.existsSync(analyzerPath), 'missing scripts/attachment-analyzer-child.js');
if (fs.existsSync(analyzerPath)) {
  const analyzer = fs.readFileSync(analyzerPath, 'utf8');
  assert('child analyzer disables network modules', analyzer.includes('disableNetwork'), 'child analyzer must disable network APIs');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert('guard script registered', packageJson.scripts['guard:attachment-security'], 'missing guard:attachment-security');
assert('architecture runs attachment guard', packageJson.scripts['guard:architecture'].includes('guard:attachment-security'), 'guard:architecture must include attachment security');

if (failures.length) {
  console.error('[attachment-security] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[attachment-security] PASS quarantine, analyze route, and raw-read guard');
