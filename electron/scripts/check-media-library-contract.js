#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];

function assert(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail || 'assertion failed'}`);
}

function runContractChecks() {
  const workspace = require(path.join(__dirname, '..', 'lib', 'workspace'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '9biz-media-'));
  workspace._setWorkspaceCacheForTest(tmp);

  const media = require(path.join(__dirname, '..', 'lib', 'media-library'));
  const t = media._test || {};

  assert('exports listMediaAssets', typeof media.listMediaAssets === 'function');
  assert('exports importMediaFile', typeof media.importMediaFile === 'function');
  assert('exports searchMediaAssets', typeof media.searchMediaAssets === 'function');
  assert('exports describeMediaAsset', typeof media.describeMediaAsset === 'function');
  assert('exports renderPdfPagesToMedia', typeof media.renderPdfPagesToMedia === 'function');
  assert('exports getMediaRoot', typeof media.getMediaRoot === 'function');

  assert('product assets default public', t.defaultVisibilityForType?.('product') === 'public');
  assert('brand assets default internal', t.defaultVisibilityForType?.('brand') === 'internal');
  assert('generated assets default internal', t.defaultVisibilityForType?.('generated') === 'internal');
  assert('Vietnamese search normalizes d/d', t.normalizeSearchText?.('Do dep') === 'do dep');
  assert('Vietnamese search normalizes d/đ', t.normalizeSearchText?.('Đỏ đẹp') === 'do dep', t.normalizeSearchText?.('Đỏ đẹp'));

  const productPath = path.join(tmp, 'sample-product.png');
  fs.writeFileSync(productPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const asset = media.importMediaFile(productPath, {
    type: 'product',
    title: 'May loc nuoc Kangen',
    tags: ['kangen', 'loc nuoc'],
    description: 'Anh san pham may loc nuoc mau trang, dung de tu van khach Zalo.'
  });
  assert('import returns product asset', asset && asset.type === 'product', JSON.stringify(asset));
  assert('product import uses public visibility', asset && asset.visibility === 'public', JSON.stringify(asset));
  assert('import writes file inside media root', asset && String(asset.path || '').startsWith(media.getMediaRoot()), asset && asset.path);

  const hits = media.searchMediaAssets('khach hoi may loc nuoc trang', { audience: 'customer', limit: 3 });
  assert('search finds asset by description/tags', hits.some(h => h.id === asset.id), JSON.stringify(hits));
  const unrelatedHits = media.searchMediaAssets('noi that phong hop khong lien quan', { audience: 'customer', limit: 3 });
  assert('search does not return unrelated product assets', !unrelatedHits.some(h => h.id === asset.id), JSON.stringify(unrelatedHits));

  const brandPath = path.join(tmp, 'logo.png');
  fs.writeFileSync(brandPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const brand = media.importMediaFile(brandPath, { type: 'brand', title: 'Logo noi bo' });
  const customerHits = media.searchMediaAssets('logo noi bo', { audience: 'customer', limit: 5 });
  assert('customer search excludes internal brand assets', !customerHits.some(h => h.id === brand.id), JSON.stringify(customerHits));

  const knowledgePath = path.join(tmp, 'knowledge-image.png');
  fs.writeFileSync(knowledgePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const knowledgeAsset = media.registerExistingMediaFile(knowledgePath, {
    type: 'knowledge_image',
    visibility: 'public',
    source: 'knowledge-upload',
    status: 'ready',
  });
  const deleted = media.deleteMediaAsset(knowledgeAsset.id);
  assert('deleting knowledge media keeps source file', deleted.success && fs.existsSync(knowledgePath), JSON.stringify(deleted));
}

try {
  runContractChecks();
} catch (error) {
  failures.push(error.stack || error.message);
}

const cronApiSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-api.js'), 'utf8');
for (const route of ['/api/media/list', '/api/media/search', '/api/media/upload', '/api/media/describe', '/api/zalo/send-media']) {
  assert(`cron api exposes ${route}`, cronApiSource.includes(route));
}
assert('zalo send-media rejects raw file paths', cronApiSource.includes('send-media requires mediaId') && !/filePath\s*\|\|\s*imagePath/.test(cronApiSource));
assert('media list defaults to customer audience over HTTP', /audience:\s*params\.audience\s*\|\|\s*'customer'/.test(cronApiSource));

const channelsSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channels.js'), 'utf8');
assert('channels exports sendZaloMediaTo', /sendZaloMediaTo/.test(channelsSource));

const knowledgeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'knowledge.js'), 'utf8');
assert('knowledge merges media search results', knowledgeSource.includes('mergeMediaSearchResults'), 'media search is not merged into RAG search');
assert('knowledge renders PDF scans into media pages', knowledgeSource.includes('renderPdfPagesToMedia'), 'PDF scan renderer is not wired');
assert('knowledge PDF scan keeps upload visibility', /describePdfScanForKnowledge\(pdfPath,\s*filename,\s*options/.test(knowledgeSource) && /visibility:\s*options\.visibility/.test(knowledgeSource), 'PDF scan pages must inherit Knowledge visibility');
assert('knowledge search does not leak absolute media path', !/path:\s*asset\.path/.test(knowledgeSource), 'media search results must expose relPath only');

const dashboardIpcSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard-ipc.js'), 'utf8');
assert('knowledge image upload registers media asset', dashboardIpcSource.includes('registerExistingMediaFile(dst'), 'knowledge uploads do not register media assets');
assert('knowledge upload passes visibility to extractor', /extractTextFromFile\(dst,\s*finalName,\s*\{[^}]*visibility[^}]*\}/.test(dashboardIpcSource), 'PDF/image vision extraction must receive the selected Knowledge visibility');

const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'ui', 'dashboard.html'), 'utf8');
assert('dashboard has image assets page', dashboardSource.includes('page-image-assets'), 'missing image assets page');
assert('dashboard exposes product media grid', dashboardSource.includes('product-media-grid'), 'missing product media grid');

const mediaSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'media-library.js'), 'utf8');
assert('PDF page render uses unique output directory', /function\s+makePdfOutputDir/.test(mediaSource), 're-uploading a PDF with the same title must not overwrite old page assets');
assert('describeMediaAsset records provider failures', /catch\s*\(e\)\s*\{[\s\S]*needs_vision/.test(mediaSource), 'vision errors must not leave assets stuck in processing');

const imageGenSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'image-gen.js'), 'utf8');
assert('image generation rejects raw workspace paths', !/path\.isAbsolute\(name\)[\s\S]*path\.resolve\(ws,\s*name\)/.test(imageGenSource), 'image generation assets must resolve through brand assets or Media Library IDs/names only');

const googleRoutesSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-routes.js'), 'utf8');
for (const action of ['create', 'update', 'delete']) {
  assert(`calendar ${action} blocks Zalo-origin writes`, googleRoutesSource.includes(`Google Calendar ${action} not allowed from Zalo channel`));
}

if (failures.length) {
  console.error('[media-library-contract] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[media-library-contract] PASS media library, media API, and Zalo media contract');
