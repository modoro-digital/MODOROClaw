#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');

const root = path.resolve(__dirname, '..', '..');
const electronRoot = path.join(root, 'electron');
const vendorTar = path.join(electronRoot, 'vendor-bundle.tar');

let fail = 0;
function ok(name) { console.log('  PASS', name); }
function bad(name, why) { fail++; console.error('  FAIL', name, '-', why); }

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-skill-routing-'));
  try {
    fs.mkdirSync(path.join(dir, 'skills', 'operations', 'docx'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'operations', 'pptx'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'anthropic-docx'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'anthropic-pptx'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'operations', 'docx', 'SKILL.md'), 'legacy docx skill', 'utf8');
    fs.writeFileSync(path.join(dir, 'skills', 'operations', 'pptx', 'SKILL.md'), 'legacy pptx skill', 'utf8');
    fs.writeFileSync(path.join(dir, 'skills', 'anthropic-docx', 'SKILL.md'), 'canonical anthropic docx skill', 'utf8');
    fs.writeFileSync(path.join(dir, 'skills', 'anthropic-pptx', 'SKILL.md'), 'canonical anthropic pptx skill', 'utf8');
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tarEntries() {
  if (!fs.existsSync(vendorTar)) return new Set();
  // Pass the bare filename with cwd set to its directory. A full Windows path
  // like D:\...\vendor-bundle.tar makes GNU tar treat "D:" as a remote host
  // ("tar: Cannot connect to D:"). Using basename + cwd avoids the colon
  // entirely and works for both GNU tar and bsdtar on every platform.
  const out = cp.execFileSync('tar', ['-tf', path.basename(vendorTar)], {
    cwd: path.dirname(vendorTar),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return new Set(out.split(/\r?\n/).filter(Boolean));
}

const requiredSkills = [
  'skills/anthropic-docx/SKILL.md',
  'skills/anthropic-xlsx/SKILL.md',
  'skills/anthropic-pptx/SKILL.md',
  'skills/anthropic-pdf/SKILL.md',
];

for (const skill of requiredSkills) {
  if (fs.existsSync(path.join(root, skill))) ok(`${skill} exists`);
  else bad(`${skill} exists`, 'missing');
}

const requiredRefs = [
  'skills/anthropic-pdf/reference.md',
  'skills/anthropic-pdf/forms.md',
  'skills/anthropic-pptx/pptxgenjs.md',
  'skills/anthropic-pptx/editing.md',
  'skills/anthropic-xlsx/scripts/recalc.py',
  'skills/anthropic-docx/scripts/office/validate.py',
];
for (const ref of requiredRefs) {
  if (fs.existsSync(path.join(root, ref))) ok(`${ref} exists`);
  else bad(`${ref} exists`, 'missing');
}

const skillText = requiredSkills.map(read).join('\n');
const pptxSkill = read('skills/anthropic-pptx/SKILL.md');
const pptxGuide = read('skills/anthropic-pptx/pptxgenjs.md');
const agents = read('AGENTS.md');
if (!/npm install -g (docx|pptxgenjs)/.test(skillText)) ok('Anthropic skills do not require global npm installs');
else bad('Anthropic skills do not require global npm installs', 'found npm install -g instructions');

if (/clean install|bundled/i.test(read('skills/anthropic-docx/SKILL.md')) &&
    /clean install|bundled/i.test(read('skills/anthropic-pptx/SKILL.md')) &&
    /clean install|bundled/i.test(read('skills/anthropic-xlsx/SKILL.md')) &&
    /clean install|bundled/i.test(read('skills/anthropic-pdf/SKILL.md'))) {
  ok('Anthropic skills document clean-install runtime path');
} else {
  bad('Anthropic skills document clean-install runtime path', 'missing bundled/clean-install guidance');
}

if (/\/api\/skill\/test-exec/.test(pptxSkill) && /do not use raw host exec/i.test(pptxSkill) && /NODE_PATH/.test(pptxSkill)) {
  ok('PPTX skill routes ad-hoc JS through bundled skill runner');
} else {
  bad('PPTX skill routes ad-hoc JS through bundled skill runner', 'missing /api/skill/test-exec guidance or host NODE_PATH warning');
}

if (/\/api\/skill\/test-exec/.test(agents) && /raw host exec[\s\S]{0,120}node -e/i.test(agents)) {
  ok('AGENTS routes document JS through bundled skill runner');
} else {
  bad('AGENTS routes document JS through bundled skill runner', 'AGENTS must warn that raw host exec node -e can miss bundled doc packages');
}

withTempWorkspace((ws) => {
  const workspaceModule = path.join(electronRoot, 'lib', 'workspace.js');
  const skillManagerModule = path.join(electronRoot, 'lib', 'skill-manager.js');
  const workspaceResolved = require.resolve(workspaceModule);
  const skillManagerResolved = require.resolve(skillManagerModule);
  const oldWorkspaceCache = require.cache[workspaceResolved];
  const oldSkillManagerCache = require.cache[skillManagerResolved];
  try {
    require.cache[workspaceResolved] = {
      id: workspaceResolved,
      filename: workspaceResolved,
      loaded: true,
      exports: { getWorkspace: () => ws },
    };
    delete require.cache[skillManagerResolved];
    const skillManager = require(skillManagerModule);
    const shippedIds = new Set(skillManager.listShippedSkills().map(s => s.id));
    if (!shippedIds.has('operations/docx') && !shippedIds.has('operations/pptx')) {
      ok('legacy operations document skills are not active shipped skills');
    } else {
      bad('legacy operations document skills are not active shipped skills', `found ${[...shippedIds].filter(id => /^operations\/(docx|pptx)$/.test(id)).join(', ')}`);
    }
    const legacyDocx = skillManager.getShippedSkillContent('operations/docx') || '';
    const legacyPptx = skillManager.getShippedSkillContent('operations/pptx') || '';
    if (/canonical anthropic docx skill/.test(legacyDocx) && /canonical anthropic pptx skill/.test(legacyPptx)) {
      ok('legacy document skill paths resolve to Anthropic canonical skills');
    } else {
      bad('legacy document skill paths resolve to Anthropic canonical skills', 'old operations/docx or operations/pptx path still resolves to legacy content');
    }
  } finally {
    if (oldWorkspaceCache) require.cache[workspaceResolved] = oldWorkspaceCache;
    else delete require.cache[workspaceResolved];
    if (oldSkillManagerCache) require.cache[skillManagerResolved] = oldSkillManagerCache;
    else delete require.cache[skillManagerResolved];
  }
});

const legacySkillRedirects = [
  ['skills/operations/docx/SKILL.md', 'skills/anthropic-docx/SKILL.md'],
  ['skills/operations/pptx/SKILL.md', 'skills/anthropic-pptx/SKILL.md'],
];
for (const [legacy, canonical] of legacySkillRedirects) {
  const legacyPath = path.join(root, legacy);
  if (!fs.existsSync(legacyPath)) {
    ok(`${legacy} absent from active template`);
    continue;
  }
  const legacyText = read(legacy);
  if (legacyText.includes(canonical) && !/references\//.test(legacyText)) {
    ok(`${legacy} is only a compatibility redirect`);
  } else {
    bad(`${legacy} is only a compatibility redirect`, `must point to ${canonical} and not load stale references`);
  }
}

const configJs = read('electron/lib/config.js');
if (/tg\.streaming\s*=\s*\{\s*mode:\s*['"]off['"]\s*\}/.test(configJs) &&
    !/tg\.streaming\s*=\s*\{\s*mode:\s*['"]progress['"]\s*\}/.test(configJs)) {
  ok('Telegram streaming progress is disabled by default');
} else {
  bad('Telegram streaming progress is disabled by default', 'raw OpenClaw tool progress can leak failed read-file status to CEO Telegram');
}

if (/replace\(\s*\/\^\\uFEFF\/\s*,\s*['"`]['"`]\s*\)/.test(pptxGuide)) {
  ok('PPTX guide strips UTF-8 BOM before JSON.parse');
} else {
  bad('PPTX guide strips UTF-8 BOM before JSON.parse', 'missing BOM-safe JSON input helper');
}

const prebuildVendor = read('electron/scripts/prebuild-vendor.js');
for (const pkg of ['docx', 'pptxgenjs', 'xlsx', 'pdfkit']) {
  if (new RegExp(`${pkg}@`).test(prebuildVendor) || new RegExp(`${pkg}['"]\\s*:`).test(prebuildVendor)) {
    ok(`prebuild-vendor pins ${pkg}`);
  } else {
    bad(`prebuild-vendor pins ${pkg}`, 'not pinned in vendor install list');
  }
}

const gateway = read('electron/lib/gateway.js');
const skillRunner = read('electron/lib/skill-runner.js');
const runtimeInstaller = read('electron/lib/runtime-installer.js');
const splashHtml = read('electron/ui/splash.html');
if (/NODE_PATH/.test(gateway) && /node_modules/.test(gateway)) ok('gateway exposes vendor node_modules via NODE_PATH');
else bad('gateway exposes vendor node_modules via NODE_PATH', 'NODE_PATH not configured for child agent processes');

if (/NODE_PATH/.test(skillRunner) && /node_modules/.test(skillRunner)) ok('skill-runner exposes bundled node_modules via NODE_PATH');
else bad('skill-runner exposes bundled node_modules via NODE_PATH', 'NODE_PATH not configured for skill scripts');

if (/ensurePython/.test(skillRunner)) ok('skill-runner can lazy-install embedded Python on Windows');
else bad('skill-runner can lazy-install embedded Python on Windows', 'runScript only detects Python and never calls ensurePython');

if (/ensurePython/.test(runtimeInstaller) &&
    /needsPythonInstall/.test(runtimeInstaller) &&
    /step:\s*['"]python['"]/.test(runtimeInstaller) &&
    /step:\s*['"]python-done['"]/.test(runtimeInstaller)) {
  ok('runtime splash installs Python helper runtime before app ready');
} else {
  bad('runtime splash installs Python helper runtime before app ready', 'runtime-installer does not wire Python into splash installation');
}

if (/step-python/.test(splashHtml) &&
    /data\.step === ['"]python['"]/.test(splashHtml) &&
    /data\.step === ['"]python-done['"]/.test(splashHtml)) {
  ok('splash UI shows Python helper runtime step');
} else {
  bad('splash UI shows Python helper runtime step', 'splash.html does not render/handle python installation progress');
}

for (const pkg of ['docx', 'pptxgenjs', 'xlsx', 'pdfkit']) {
  if (new RegExp(`name:\\s*['"]${pkg}['"]`).test(runtimeInstaller)) {
    ok(`runtime installer installs ${pkg} on clean machines`);
  } else {
    bad(`runtime installer installs ${pkg} on clean machines`, `${pkg} missing from runtime PACKAGES`);
  }
}

const entries = tarEntries();
if (entries.size > 0) {
  for (const pkg of ['docx', 'pptxgenjs', 'xlsx', 'pdfkit']) {
    const entry = `vendor/node_modules/${pkg}/package.json`;
    if (entries.has(entry)) ok(`vendor bundle contains ${pkg}`);
    else bad(`vendor bundle contains ${pkg}`, `${entry} missing`);
  }
} else {
  bad('vendor bundle readable', 'electron/vendor-bundle.tar missing or empty');
}

if (fail) {
  console.error(`[anthropic-doc-runtime] ${fail} failure(s)`);
  process.exit(1);
}
console.log('[anthropic-doc-runtime] PASS clean-install document runtime checks');
