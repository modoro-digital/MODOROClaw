#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const XLSX = require('xlsx');
const zaloMenu = require('../lib/zalo-menu');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zalo-menu-dry-run-'));

function fail(message) {
  console.error('[zalo-menu-dry-run] FAIL ' + message);
  process.exit(1);
}

try {
  zaloMenu.init({ getWorkspace: () => tmpRoot });

  // v2.4.10: feature disabled for client release. Default catalog must be EMPTY
  // (no 9BizClaw seed data). Clients populate via Dashboard once feature unhides.
  const catalog = zaloMenu.loadCatalog();
  assert.ok(Array.isArray(catalog.items), 'catalog items should be an array');
  assert.equal(catalog.items.length, 0, 'default catalog must be empty for client release (no 9BizClaw seed data)');

  // dryRunCommand must still function (unit-level), it just hits the empty-state path.
  const emptyList = zaloMenu.dryRunCommand('/menu');
  assert.equal(emptyList.handled, true, '/menu should be handled even with empty catalog');
  assert.match(emptyList.text, /chưa được cấu hình|liên hệ chủ shop/, 'empty catalog list should be a graceful placeholder');
  assert.doesNotMatch(emptyList.text, /9BizClaw|MODORO|premium|signature|starter/i, 'no 9BizClaw branding may leak');

  const unknownSlug = zaloMenu.dryRunCommand('/menu premium');
  assert.equal(unknownSlug.handled, true, '/menu <slug> should be handled even when slug is unknown');
  assert.match(unknownSlug.text, /Không tìm thấy/, 'unknown slug should return not-found message');

  const noQuote = zaloMenu.dryRunCommand('/baogia premium');
  assert.equal(noQuote.handled, true, '/baogia <slug> should be handled');
  assert.match(noQuote.text, /Không tìm thấy/, 'unknown slug in /baogia should return not-found');
  assert.doesNotMatch(noQuote.text, /SePay|QR|chuyển khoản|số tài khoản|thanh toán/i, 'quote output must exclude payment language');

  const natural = zaloMenu.dryRunCommand('menu premium');
  assert.equal(natural.handled, false, 'manual text without slash should not dispatch');

  const duplicate = zaloMenu.validateCatalog({
    items: [
      { slug: 'premium', title: 'A', description: 'A', priceLabel: 'A', enabled: true },
      { slug: 'premium', title: 'B', description: 'B', priceLabel: 'B', enabled: true },
    ],
  });
  assert.equal(duplicate.ok, false, 'duplicate slugs should fail validation');

  const paymentCatalog = zaloMenu.validateCatalog({
    items: [
      { slug: 'pay', title: 'Pay', description: 'Quét QR để thanh toán qua SePay', priceLabel: 'Chuyển khoản', enabled: true },
    ],
  });
  assert.equal(paymentCatalog.ok, false, 'catalog validation must reject payment terms in any field');

  const tooManyDirect = zaloMenu.saveCatalog({
    items: Array.from({ length: 501 }, (_, i) => ({
      slug: `direct-${i}`,
      title: `Direct ${i}`,
      description: 'Mô tả',
      priceLabel: '1đ',
      enabled: true,
    })),
  });
  assert.equal(tooManyDirect.ok, false, 'direct save must reject catalogs over the item cap');

  const wb = XLSX.utils.book_new();
  const rows = [
    ['slug', 'category', 'title', 'subtitle', 'description', 'priceLabel', 'ctaLabel', 'ctaCommand', 'sortOrder', 'enabled'],
    ['trial', 'Demo', 'Gói dùng thử', 'Test import', 'Mô tả import', '0đ', 'Xem premium', '/menu premium', 1, 'true'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Menu');
  const importPath = path.join(tmpRoot, 'menu-import.xlsx');
  XLSX.writeFile(wb, importPath);

  const preview = zaloMenu.previewImport(importPath);
  assert.equal(preview.ok, true, 'xlsx preview should be valid');
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].slug, 'trial');

  const applied = zaloMenu.applyImport(importPath);
  assert.equal(applied.ok, true, 'xlsx import should apply');
  assert.equal(zaloMenu.loadCatalog().items[0].slug, 'trial');

  const wbNoSort = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbNoSort, XLSX.utils.aoa_to_sheet([
    ['slug', 'title', 'description', 'priceLabel', 'enabled'],
    ['zebra', 'Zebra Plan', 'First row', '1đ', 'true'],
    ['alpha', 'Alpha Plan', 'Second row', '2đ', 'true'],
  ]), 'Menu');
  const noSortPath = path.join(tmpRoot, 'menu-no-sort.xlsx');
  XLSX.writeFile(wbNoSort, noSortPath);
  const noSortPreview = zaloMenu.previewImport(noSortPath);
  assert.equal(noSortPreview.ok, true, 'blank sortOrder import should be valid');
  assert.deepEqual(noSortPreview.items.map(item => item.slug), ['zebra', 'alpha'], 'blank sortOrder should preserve spreadsheet order');

  const oversizedPath = path.join(tmpRoot, 'oversized.xlsx');
  fs.writeFileSync(oversizedPath, Buffer.alloc(5 * 1024 * 1024 + 1));
  const oversized = zaloMenu.previewImport(oversizedPath);
  assert.equal(oversized.ok, false, 'oversized xlsx should be rejected before parsing');
  assert.match((oversized.errors || []).join(' '), /quá lớn|too large|size/i);

  const fakeXlsxPath = path.join(tmpRoot, 'fake.xlsx');
  fs.writeFileSync(fakeXlsxPath, 'not a zip workbook');
  const fakeXlsx = zaloMenu.previewImport(fakeXlsxPath);
  assert.equal(fakeXlsx.ok, false, 'fake .xlsx should be rejected by content sniffing');
  assert.match((fakeXlsx.errors || []).join(' '), /định dạng|format|xlsx/i);

  const xlsPath = path.join(tmpRoot, 'legacy.xls');
  fs.writeFileSync(xlsPath, 'legacy xls');
  const legacyXls = zaloMenu.previewImport(xlsPath);
  assert.equal(legacyXls.ok, false, 'legacy .xls should be rejected');
  assert.match((legacyXls.errors || []).join(' '), /xlsx/i);

  const wbTooMany = XLSX.utils.book_new();
  const manyRows = [['slug', 'title', 'description', 'priceLabel', 'enabled']];
  for (let i = 0; i < 501; i++) manyRows.push([`item-${i}`, `Item ${i}`, 'Mô tả', '1đ', 'true']);
  XLSX.utils.book_append_sheet(wbTooMany, XLSX.utils.aoa_to_sheet(manyRows), 'Menu');
  const tooManyPath = path.join(tmpRoot, 'too-many.xlsx');
  XLSX.writeFile(wbTooMany, tooManyPath);
  const tooMany = zaloMenu.previewImport(tooManyPath);
  assert.equal(tooMany.ok, false, 'xlsx with too many rows should be rejected');
  assert.match((tooMany.errors || []).join(' '), /quá nhiều|too many|row/i);

  const wbFormula = XLSX.utils.book_new();
  const formulaSheet = XLSX.utils.aoa_to_sheet([
    ['slug', 'title', 'description', 'priceLabel', 'enabled'],
    ['formula', 'Formula Plan', 'Mô tả', '1đ', 'true'],
  ]);
  formulaSheet.B2.f = 'HYPERLINK("https://example.com","Formula Plan")';
  XLSX.utils.book_append_sheet(wbFormula, formulaSheet, 'Menu');
  const formulaPath = path.join(tmpRoot, 'formula.xlsx');
  XLSX.writeFile(wbFormula, formulaPath);
  const formulaPreview = zaloMenu.previewImport(formulaPath);
  assert.equal(formulaPreview.ok, false, 'xlsx formulas should be rejected');

  const wbHyperlink = XLSX.utils.book_new();
  const hyperlinkSheet = XLSX.utils.aoa_to_sheet([
    ['slug', 'title', 'description', 'priceLabel', 'enabled'],
    ['link', 'Link Plan', 'Mô tả', '1đ', 'true'],
  ]);
  hyperlinkSheet.B2.l = { Target: 'https://example.com' };
  XLSX.utils.book_append_sheet(wbHyperlink, hyperlinkSheet, 'Menu');
  const hyperlinkPath = path.join(tmpRoot, 'hyperlink.xlsx');
  XLSX.writeFile(wbHyperlink, hyperlinkPath);
  const hyperlinkPreview = zaloMenu.previewImport(hyperlinkPath);
  assert.equal(hyperlinkPreview.ok, false, 'xlsx hyperlinks should be rejected');

  const badControl = zaloMenu.validateCatalog({
    items: [{ slug: 'bad', title: 'Bad\u0001Title', description: 'Mô tả', priceLabel: '1đ', enabled: true }],
  });
  assert.equal(badControl.ok, false, 'catalog validation must reject control characters');

  const longText = zaloMenu.validateCatalog({
    items: [{ slug: 'long', title: 'Long', description: 'x'.repeat(5001), priceLabel: '1đ', enabled: true }],
  });
  assert.equal(longText.ok, false, 'catalog validation must reject overlong fields');

  const dashboardIpc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf8');
  // v2.4.10 client-release gate: ensure the menu feature is wired off at the IPC layer.
  assert.match(dashboardIpc, /const ZALO_MENU_DISABLED\s*=\s*true/, 'ZALO_MENU_DISABLED flag must be true for client release');
  assert.match(dashboardIpc, /_zaloMenuDisabledResponse/, 'menu IPC handlers must short-circuit via the disabled response helper');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf8');
  assert.match(dashboardIpc, /zaloMenuImportSelections\s*=\s*new Map/, 'main process should keep import selections behind opaque tokens');
  assert.match(dashboardIpc, /return\s+\{\s*success:\s*true,\s*token:/, 'file picker should return an opaque token');
  assert.doesNotMatch(dashboardIpc, /return\s+\{\s*success:\s*true,\s*filePath:\s*result\.filePaths\[0\]/, 'file picker must not expose import file paths to renderer');
  assert.doesNotMatch(dashboardIpc, /extensions:\s*\['xlsx',\s*'xls'\]/, 'file picker must not offer legacy .xls import');
  assert.match(preload, /previewZaloMenuImport:\s*\(token\)/, 'preload preview API should accept token, not filePath');
  assert.match(preload, /applyZaloMenuImport:\s*\(token\)/, 'preload apply API should accept token, not filePath');
  assert.match(dashboardHtml, /@media \(max-width: 1280px\)[\s\S]*?\.zalo-split \{ grid-template-columns:1fr;/, 'Zalo overview should collapse to one column on smaller laptops');
  assert.match(dashboardHtml, /@media \(max-width: 1280px\)[\s\S]*?\.zalo-menu-grid \{ grid-template-columns:1fr;/, 'Zalo menu grid should collapse to one column on smaller laptops');
  assert.doesNotMatch(dashboardHtml, /src="\$\{esc\(/, 'Zalo avatar src attributes must use attribute escaping');
  assert.doesNotMatch(dashboardHtml, /openZaloUserMemory\('\$\{escJs/, 'inline Zalo user memory handlers must HTML-attribute escape JS strings');

  const dryRunHandler = dashboardIpc.match(/ipcMain\.handle\('dry-run-zalo-menu-command'[\s\S]*?\n\}\);/);
  assert.ok(dryRunHandler, 'dry-run IPC handler should exist');
  assert.doesNotMatch(dryRunHandler[0], /sendZalo|sendZaloTo|fetch\(|https?:|spawn\(|execFile|runOpenClaw|nineRouter/i, 'dry-run IPC handler must not send, dispatch, or call network/process side effects');

  console.log('[zalo-menu-dry-run] PASS');
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}
