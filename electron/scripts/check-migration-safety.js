'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const workspace = require('../lib/workspace');

let failures = 0;

function ok(name) {
  console.log('[PASS]', name);
}

function fail(name, detail) {
  failures += 1;
  console.error('[FAIL]', name + ': ' + detail);
}

function assertFile(root, rel, expectedText) {
  const fp = path.join(root, rel);
  if (!fs.existsSync(fp)) {
    fail('migration safety', rel + ' is missing');
    return;
  }
  if (expectedText) {
    const content = fs.readFileSync(fp, 'utf-8');
    if (!content.includes(expectedText)) {
      fail('migration safety', rel + ' did not preserve expected content');
    }
  }
}

function write(relRoot, rel, body) {
  const fp = path.join(relRoot, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body);
}

function latestBackupRoot(ws) {
  const root = path.join(ws, 'backups');
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root).filter(n => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(n)).sort();
  if (!names.length) return null;
  return path.join(root, names[names.length - 1]);
}

function seedFree2350LikeWorkspace(tmp) {
  write(tmp, 'AGENTS.md', '<!-- modoroclaw-agents-version: 76 -->\n# Old free AGENTS\ncustomer-old-agent-rule\n');
  write(tmp, 'skills/custom/premium-customer-skill.md', '# Customer Skill\nkeep-this-custom-skill\n');
  write(tmp, 'skills/operations/telegram-ceo.md', '# Customer Edited Template Skill\nold-template-skill-copy\n');
  write(tmp, 'knowledge/cong-ty/index.md', '# Knowledge\nold-company-index\n');
  write(tmp, 'knowledge/cong-ty/files/catalog.pdf', 'fake-pdf-content');
  write(tmp, 'knowledge/san-pham/files/product.txt', 'product-knowledge-file');
  write(tmp, 'brand-assets/logo.png', 'fake-logo');
  write(tmp, 'media-assets/product/product.png', 'fake-product-image');
  write(tmp, 'media-assets/index.json', JSON.stringify({ version: 1, assets: [{ id: 'product_1', filename: 'product.png' }] }, null, 2));
  write(tmp, 'config/zalo-mode.txt', 'read');
  write(tmp, 'custom-crons.json', JSON.stringify([{ id: 'customer-cron', enabled: true, prompt: 'do not lose' }], null, 2));
  write(tmp, 'schedules.json', JSON.stringify([{ id: 'customer-schedule', enabled: false }], null, 2));
  write(tmp, 'memory.db', 'fake-db');
}

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), '9bizclaw-migration-'));

  try {
    const backupOnly = path.join(tmpRoot, 'backup-only');
    fs.mkdirSync(backupOnly, { recursive: true });
    seedFree2350LikeWorkspace(backupOnly);
    workspace._setWorkspaceCacheForTest(backupOnly);
    workspace.backupWorkspace({ force: true, reason: 'guard-full-backup' });
    const b1 = latestBackupRoot(backupOnly);
    if (!b1) {
      fail('backup creation', 'no backup folder created');
    } else {
      assertFile(b1, 'backup-manifest.json', '"formatVersion": 2');
      assertFile(b1, 'knowledge/cong-ty/files/catalog.pdf', 'fake-pdf-content');
      assertFile(b1, 'knowledge/san-pham/files/product.txt', 'product-knowledge-file');
      assertFile(b1, 'skills/custom/premium-customer-skill.md', 'keep-this-custom-skill');
      assertFile(b1, 'skills/operations/telegram-ceo.md', 'old-template-skill-copy');
      assertFile(b1, 'brand-assets/logo.png', 'fake-logo');
      assertFile(b1, 'media-assets/product/product.png', 'fake-product-image');
      assertFile(b1, 'media-assets/index.json', 'product_1');
      assertFile(b1, 'custom-crons.json', 'customer-cron');
      assertFile(b1, 'memory.db', 'fake-db');
      ok('full backup includes knowledge files, skills, media, cron, and DB');
    }

    const migrated = path.join(tmpRoot, 'migrated');
    fs.mkdirSync(migrated, { recursive: true });
    seedFree2350LikeWorkspace(migrated);
    workspace._setWorkspaceCacheForTest(migrated);
    workspace.seedWorkspace();

    assertFile(migrated, 'knowledge/cong-ty/files/catalog.pdf', 'fake-pdf-content');
    assertFile(migrated, 'knowledge/san-pham/files/product.txt', 'product-knowledge-file');
    assertFile(migrated, 'skills/custom/premium-customer-skill.md', 'keep-this-custom-skill');
    assertFile(migrated, 'custom-crons.json', 'customer-cron');
    assertFile(migrated, 'media-assets/product/product.png', 'fake-product-image');

    const b2 = latestBackupRoot(migrated);
    if (!b2) {
      fail('pre-upgrade backup', 'seedWorkspace did not create a pre-upgrade backup');
    } else {
      assertFile(b2, 'AGENTS.md', 'customer-old-agent-rule');
      assertFile(b2, 'skills/operations/telegram-ceo.md', 'old-template-skill-copy');
      assertFile(b2, 'knowledge/cong-ty/files/catalog.pdf', 'fake-pdf-content');
      ok('pre-upgrade backup captures old free workspace before template refresh');
    }

    const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf-8');
    if (/RMDir\s+\/r\s+"\$APPDATA\\9bizclaw"\b/i.test(installer)) {
      fail('installer cleanup', 'uninstaller may remove the whole AppData workspace');
    } else if (/(?:RMDir|Delete)\b[^\r\n]*(?:knowledge|skills|media-assets|brand-assets|memory\.db|custom-crons|zalo-blocklist)/i.test(installer)) {
      fail('installer cleanup', 'installer delete command targets user-owned data paths');
    } else {
      ok('installer cleanup does not target user knowledge/skills/data');
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    if (pkg.build?.appId !== 'vn.9biz.claw' || pkg.build?.productName !== '9BizClaw') {
      fail('app identity', 'appId/productName changed from v2.3.50 identity');
    } else {
      ok('app identity matches v2.3.50 update path');
    }
  } finally {
    workspace._setWorkspaceCacheForTest(null);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }

  if (failures) process.exit(1);
}

run();
