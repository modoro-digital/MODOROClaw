'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { getWorkspace, getBrandAssetsDir, BRAND_ASSET_FORMATS, BRAND_ASSET_MAX_SIZE } = require('./workspace');
const { isPathSafe, writeJsonAtomic } = require('./util');
const { call9RouterVision } = require('./nine-router');

const MEDIA_TYPES = ['brand', 'product', 'generated', 'knowledge_image', 'pdf_page'];
const MEDIA_VISIBILITIES = ['public', 'internal', 'private'];
const MEDIA_IMAGE_FORMATS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const MEDIA_MAX_SIZE = 100 * 1024 * 1024;
const MEDIA_INDEX_VERSION = 1;
const PDF_RENDER_ERROR_VI = 'Không thể render PDF scan bằng engine hiện tại';

const DEFAULT_VISIBILITY = {
  brand: 'internal',
  product: 'public',
  generated: 'internal',
  knowledge_image: 'public',
  pdf_page: 'public',
};

function getMediaRoot() {
  return path.join(getWorkspace(), 'media-assets');
}

function getMediaFilesDir(type = 'misc') {
  const safeType = MEDIA_TYPES.includes(type) ? type : 'misc';
  return path.join(getMediaRoot(), safeType);
}

function getMediaIndexPath() {
  return path.join(getMediaRoot(), 'index.json');
}

function ensureMediaFolders() {
  fs.mkdirSync(getMediaRoot(), { recursive: true });
  for (const type of MEDIA_TYPES) fs.mkdirSync(getMediaFilesDir(type), { recursive: true });
}

function defaultVisibilityForType(type) {
  return DEFAULT_VISIBILITY[type] || 'internal';
}

function safeName(input) {
  return String(input || 'asset')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'asset';
}

function normalizeType(type) {
  return MEDIA_TYPES.includes(type) ? type : 'knowledge_image';
}

function normalizeVisibility(visibility, type) {
  if (MEDIA_VISIBILITIES.includes(visibility)) return visibility;
  return defaultVisibilityForType(type);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean).slice(0, 30);
  if (typeof tags === 'string') return tags.split(/[,\n]/).map(t => t.trim()).filter(Boolean).slice(0, 30);
  return [];
}

function readIndex() {
  ensureMediaFolders();
  const fp = getMediaIndexPath();
  if (!fs.existsSync(fp)) return { version: MEDIA_INDEX_VERSION, assets: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return {
      version: parsed.version || MEDIA_INDEX_VERSION,
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
    };
  } catch (e) {
    try {
      const backup = fp + '.corrupt-' + Date.now();
      fs.copyFileSync(fp, backup);
      console.warn('[media] index.json corrupt, backed up to', backup, e.message);
    } catch {}
    return { version: MEDIA_INDEX_VERSION, assets: [] };
  }
}

function writeIndex(index) {
  const clean = {
    version: MEDIA_INDEX_VERSION,
    assets: Array.isArray(index.assets) ? index.assets : [],
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(getMediaIndexPath(), clean);
  return clean;
}

function makeAssetId(type, name) {
  const hash = crypto.createHash('sha1')
    .update(`${type}:${name}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 10);
  return `media_${type}_${hash}`;
}

function resolveUniqueFilename(dir, filename) {
  const parsed = path.parse(safeName(filename));
  const base = parsed.name || 'asset';
  const ext = parsed.ext || '.bin';
  let candidate = `${base}${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${i++}${ext}`;
  }
  return candidate;
}

function makePdfOutputDir(title, pdfPath) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const hash = crypto.createHash('sha1')
    .update(`${pdfPath}:${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return path.join(getMediaFilesDir('pdf_page'), `${safeName(title)}-${stamp}-${hash}`);
}

function mimeForFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}

function localizeMediaError(error) {
  const msg = String(error?.message || error || '').trim();
  if (!msg) return 'Có lỗi không xác định khi xử lý file.';
  if (/unsupported image format|Input file contains unsupported image format/i.test(msg)) {
    return `${PDF_RENDER_ERROR_VI}. File PDF này có thể là PDF scan/ảnh và thư viện render PDF không hỗ trợ trực tiếp định dạng bên trong.`;
  }
  if (/PDF scan support requires sharp/i.test(msg)) {
    return 'Thiếu thư viện xử lý PDF scan. Vui lòng cài lại bản build đầy đủ hoặc cập nhật app.';
  }
  if (/Vision provider unavailable|returned empty/i.test(msg)) {
    return 'Chưa đọc được nội dung ảnh/PDF bằng AI vision. Kiểm tra 9Router/model vision rồi thử lại.';
  }
  if (/does not represent a valid image|valid image/i.test(msg)) {
    return `Model vision không nhận ảnh được vì dữ liệu ảnh không hợp lệ. Chi tiết gốc: ${msg}`;
  }
  if (/media file too large/i.test(msg)) {
    return 'File quá lớn. Giới hạn hiện tại là 100MB mỗi file.';
  }
  if (/only image files are supported/i.test(msg)) {
    return 'Khu vực này chỉ nhận ảnh sản phẩm/thương hiệu. PDF hãy upload ở tab Tài liệu.';
  }
  if (/source file not found|media file not found|PDF file not found/i.test(msg)) {
    return 'Không tìm thấy file trên máy. Vui lòng chọn lại file rồi thử lại.';
  }
  return msg;
}

function pathInsideWorkspace(absPath) {
  const ws = path.resolve(getWorkspace());
  const resolved = path.resolve(absPath);
  return resolved === ws || resolved.startsWith(ws + path.sep);
}

function toRelPath(absPath) {
  if (!pathInsideWorkspace(absPath)) return null;
  return path.relative(getWorkspace(), absPath).replace(/\\/g, '/');
}

function upsertAsset(asset) {
  const index = readIndex();
  const i = index.assets.findIndex(a => a.id === asset.id);
  const now = new Date().toISOString();
  const next = { ...asset, updatedAt: now };
  if (i >= 0) index.assets[i] = { ...index.assets[i], ...next };
  else index.assets.unshift({ ...next, createdAt: asset.createdAt || now });
  writeIndex(index);
  return next;
}

function importMediaFile(sourcePath, options = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('source file not found');
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) throw new Error('source is not a file');
  if (stat.size > MEDIA_MAX_SIZE) throw new Error('media file too large');

  const type = normalizeType(options.type);
  const visibility = normalizeVisibility(options.visibility, type);
  const originalName = safeName(options.name || options.originalName || path.basename(sourcePath));
  const ext = path.extname(originalName).toLowerCase();
  if (type !== 'pdf_page' && ext && !MEDIA_IMAGE_FORMATS.includes(ext)) {
    throw new Error('only image files are supported for media assets');
  }

  ensureMediaFolders();
  const dstDir = getMediaFilesDir(type);
  const finalName = resolveUniqueFilename(dstDir, originalName);
  if (!isPathSafe(dstDir, finalName)) throw new Error('invalid filename');
  const dst = path.join(dstDir, finalName);
  fs.copyFileSync(sourcePath, dst);

  const now = new Date().toISOString();
  const asset = {
    id: makeAssetId(type, finalName),
    type,
    visibility,
    title: String(options.title || path.parse(finalName).name).trim(),
    filename: finalName,
    path: dst,
    relPath: toRelPath(dst),
    mime: mimeForFile(finalName),
    size: fs.statSync(dst).size,
    tags: normalizeTags(options.tags),
    aliases: normalizeTags(options.aliases),
    sku: options.sku ? String(options.sku).trim() : '',
    description: options.description ? String(options.description).trim() : '',
    source: options.source || 'upload',
    status: options.status || (options.description ? 'ready' : 'indexed'),
    error: '',
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {},
    createdAt: now,
    updatedAt: now,
  };
  return upsertAsset(asset);
}

function registerExistingMediaFile(absPath, options = {}) {
  if (!absPath || !fs.existsSync(absPath)) throw new Error('media file not found');
  const type = normalizeType(options.type);
  const stat = fs.statSync(absPath);
  const now = new Date().toISOString();
  const asset = {
    id: options.id || makeAssetId(type, path.basename(absPath)),
    type,
    visibility: normalizeVisibility(options.visibility, type),
    title: String(options.title || path.parse(absPath).name).trim(),
    filename: path.basename(absPath),
    path: absPath,
    relPath: toRelPath(absPath),
    mime: mimeForFile(absPath),
    size: stat.size,
    tags: normalizeTags(options.tags),
    aliases: normalizeTags(options.aliases),
    sku: options.sku ? String(options.sku).trim() : '',
    description: options.description ? String(options.description).trim() : '',
    source: options.source || 'existing',
    status: options.status || (options.description ? 'ready' : 'indexed'),
    error: options.error || '',
    metadata: options.metadata && typeof options.metadata === 'object' ? options.metadata : {},
    createdAt: options.createdAt || now,
    updatedAt: now,
  };
  return upsertAsset(asset);
}

function listMediaAssets(filters = {}) {
  const { type, visibility, audience } = filters;
  return readIndex().assets.filter(asset => {
    if (type && asset.type !== type) return false;
    if (visibility && asset.visibility !== visibility) return false;
    if (audience === 'customer' && asset.visibility !== 'public') return false;
    if (audience === 'internal' && asset.visibility === 'private') return false;
    return true;
  });
}

function normalizeSearchText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function assetSearchHaystack(asset) {
  return normalizeSearchText([
    asset.title,
    asset.filename,
    asset.sku,
    ...(asset.tags || []),
    ...(asset.aliases || []),
    asset.description,
    JSON.stringify(asset.metadata || {}),
  ].filter(Boolean).join(' '));
}

function stripPdfStreamNewline(buf, start, end) {
  let s = start;
  let e = end;
  if (buf[s] === 0x0d && buf[s + 1] === 0x0a) s += 2;
  else if (buf[s] === 0x0a || buf[s] === 0x0d) s += 1;
  while (e > s && (buf[e - 1] === 0x0a || buf[e - 1] === 0x0d || buf[e - 1] === 0x20)) e -= 1;
  return [s, e];
}

function extractDctImagesFromPdf(pdfPath, maxImages = Infinity) {
  const buf = fs.readFileSync(pdfPath);
  const streamToken = Buffer.from('stream', 'latin1');
  const endToken = Buffer.from('endstream', 'latin1');
  const images = [];
  let pos = 0;
  while (images.length < maxImages) {
    const streamAt = buf.indexOf(streamToken, pos);
    if (streamAt < 0) break;
    const endAt = buf.indexOf(endToken, streamAt + streamToken.length);
    if (endAt < 0) break;
    const objMarkerAt = buf.lastIndexOf(Buffer.from(' obj', 'latin1'), streamAt);
    let objStart = objMarkerAt;
    while (objStart > 0 && buf[objStart] !== 0x0a && buf[objStart] !== 0x0d) objStart--;
    const dict = buf.slice(Math.max(0, objStart), streamAt).toString('latin1');
    const isImage = /\/Subtype\s*\/Image/.test(dict);
    const isJpeg = /\/DCTDecode/.test(dict);
    const isFlateWrapped = /\/FlateDecode/.test(dict);
    if (isImage && isJpeg) {
      let [dataStart, dataEnd] = stripPdfStreamNewline(buf, streamAt + streamToken.length, endAt);
      let data = buf.slice(dataStart, dataEnd);
      if (isFlateWrapped) {
        try { data = zlib.inflateSync(data); }
        catch {
          try { data = zlib.inflateRawSync(data); } catch {}
        }
      }
      if (!(data[0] === 0xff && data[1] === 0xd8)) {
        const jpgStart = data.indexOf(Buffer.from([0xff, 0xd8]));
        const jpgEnd = data.lastIndexOf(Buffer.from([0xff, 0xd9]));
        if (jpgStart >= 0 && jpgEnd > jpgStart) data = data.slice(jpgStart, jpgEnd + 2);
      }
      if (data.length > 2048 && data[0] === 0xff && data[1] === 0xd8) {
        images.push({ buffer: data, index: images.length + 1 });
      }
    }
    pos = endAt + endToken.length;
  }
  return images;
}

function scoreAsset(queryTerms, asset) {
  const haystack = assetSearchHaystack(asset);
  if (!haystack) return 0;
  let score = 0;
  let matched = false;
  for (const term of queryTerms) {
    if (!term) continue;
    if (haystack.includes(term)) {
      matched = true;
      score += term.length > 3 ? 3 : 1;
    }
  }
  if (!matched) return 0;
  if (asset.type === 'product') score += 0.25;
  if (asset.status === 'ready') score += 0.25;
  return score;
}

function searchMediaAssets(query, options = {}) {
  const normalized = normalizeSearchText(query);
  if (!normalized || normalized.length < 2) return [];
  const terms = Array.from(new Set(normalized.split(' ').filter(t => t.length > 1)));
  const limit = Math.min(Math.max(parseInt(options.limit || 5, 10) || 5, 1), 20);
  return listMediaAssets(options)
    .map(asset => ({ ...asset, score: scoreAsset(terms, asset) }))
    .filter(asset => asset.score > 0)
    .sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}

function findMediaAsset(idOrName) {
  const key = String(idOrName || '').trim();
  if (!key) return null;
  return readIndex().assets.find(a => a.id === key || a.filename === key || a.relPath === key) || null;
}

function updateMediaAsset(id, patch = {}) {
  const asset = findMediaAsset(id);
  if (!asset) throw new Error('media asset not found');
  const next = {
    ...asset,
    ...patch,
    type: normalizeType(patch.type || asset.type),
    visibility: normalizeVisibility(patch.visibility || asset.visibility, patch.type || asset.type),
    tags: patch.tags !== undefined ? normalizeTags(patch.tags) : asset.tags,
    aliases: patch.aliases !== undefined ? normalizeTags(patch.aliases) : asset.aliases,
    updatedAt: new Date().toISOString(),
  };
  return upsertAsset(next);
}

function shouldKeepSourceFileOnDelete(asset) {
  if (!asset) return false;
  if (asset.type === 'knowledge_image' || asset.type === 'pdf_page') return true;
  return ['knowledge-upload', 'pdf_scan', 'pdf_embedded_image'].includes(asset.source);
}

function deleteMediaAsset(idOrName, options = {}) {
  const asset = findMediaAsset(idOrName);
  if (!asset) return { success: false, error: 'media asset not found' };
  const unlinkFile = options.unlinkFile !== undefined ? !!options.unlinkFile : !shouldKeepSourceFileOnDelete(asset);
  try {
    if (unlinkFile && asset.path && pathInsideWorkspace(asset.path) && fs.existsSync(asset.path)) {
      fs.unlinkSync(asset.path);
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
  const index = readIndex();
  index.assets = index.assets.filter(a => a.id !== asset.id);
  writeIndex(index);
  return { success: true, id: asset.id, unlinked: unlinkFile };
}

async function describeMediaAsset(idOrAsset, options = {}) {
  const asset = typeof idOrAsset === 'object' ? idOrAsset : findMediaAsset(idOrAsset);
  if (!asset) throw new Error('media asset not found');
  if (!asset.path || !fs.existsSync(asset.path)) throw new Error('media file not found');
  updateMediaAsset(asset.id, { status: 'processing', error: '' });
  const prompt = options.prompt || [
    'Bạn là hệ thống đọc tài sản hình ảnh cho trợ lý bán hàng Việt Nam.',
    'Hãy mô tả chính xác nội dung ảnh bằng tiếng Việt có dấu.',
    'Nếu là ảnh sản phẩm, nêu loại sản phẩm, màu sắc, chữ/giá/nhãn nhìn thấy, cách khách có thể hỏi về ảnh này.',
    'Nếu là logo/mascot/tài sản thương hiệu, mô tả để hệ thống dùng làm reference tạo ảnh, không bịa thông tin ngoài ảnh.',
    'Trả lời 250-500 từ, chỉ nội dung mô tả.'
  ].join('\n');
  let description = '';
  try {
    description = await call9RouterVision(asset.path, prompt, {
      maxTokens: options.maxTokens || 1200,
      temperature: 0.1,
      timeoutMs: options.timeoutMs || 45000,
      throwOnError: true,
    });
  } catch (e) {
    updateMediaAsset(asset.id, {
      status: 'needs_vision',
      error: localizeMediaError(e),
    });
    throw e;
  }
  if (!description) {
    return updateMediaAsset(asset.id, {
      status: 'needs_vision',
      error: 'Vision provider unavailable or returned empty result',
    });
  }
  return updateMediaAsset(asset.id, {
    description: String(description).trim(),
    status: 'ready',
    error: '',
  });
}

async function renderPdfPagesToMedia(pdfPath, options = {}) {
  if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error('PDF file not found');
  const type = 'pdf_page';
  const visibility = normalizeVisibility(options.visibility, type);
  const title = String(options.title || path.parse(pdfPath).name).trim();
  const outDir = makePdfOutputDir(title, pdfPath);
  fs.mkdirSync(outDir, { recursive: true });

  let sharp;
  try { sharp = require('sharp'); } catch {}

  if (sharp) {
    try {
      const baseInput = sharp(pdfPath, { density: options.density || 144, limitInputPixels: false });
      const meta = await baseInput.metadata();
      const pages = Math.max(1, Number(meta.pages || meta.pageHeight && meta.height ? Math.ceil(meta.height / meta.pageHeight) : 1));
      const maxPages = options.maxPages === Infinity ? pages : Math.min(pages, Math.max(1, parseInt(options.maxPages || pages, 10) || pages));
      const assets = [];

      for (let page = 0; page < maxPages; page++) {
        const fileName = `page-${String(page + 1).padStart(4, '0')}.png`;
        const outPath = path.join(outDir, fileName);
        await sharp(pdfPath, { density: options.density || 144, page, pages: 1, limitInputPixels: false })
          .png()
          .toFile(outPath);
        const asset = registerExistingMediaFile(outPath, {
          type,
          visibility,
          title: `${title} - trang ${page + 1}`,
          source: 'pdf_scan',
          status: 'indexed',
          tags: options.tags || [],
          metadata: {
            pdfSource: pdfPath,
            pdfFilename: path.basename(pdfPath),
            page: page + 1,
            totalPages: pages,
            renderMethod: 'sharp',
          },
        });
        assets.push(asset);
        if (options.describe !== false) {
          try { assets[assets.length - 1] = await describeMediaAsset(asset); } catch (e) {
            assets[assets.length - 1] = updateMediaAsset(asset.id, { status: 'needs_vision', error: localizeMediaError(e) });
          }
        }
      }
      return { pages, processed: assets.length, assets, method: 'sharp' };
    } catch (e) {
      console.warn('[media] sharp PDF render failed, trying embedded JPEG fallback:', e.message);
    }
  }

  const embeddedImages = extractDctImagesFromPdf(pdfPath, options.maxPages === Infinity ? Infinity : Math.max(1, parseInt(options.maxPages || 9999, 10) || 9999));
  if (embeddedImages.length === 0) {
    throw new Error(`${PDF_RENDER_ERROR_VI}. Không tìm thấy ảnh JPEG nhúng trong PDF để dùng làm fallback.`);
  }

  const assets = [];
  const totalPages = embeddedImages.length;
  for (const img of embeddedImages) {
    const basePageName = `page-${String(img.index).padStart(4, '0')}`;
    let fileName = `${basePageName}.jpg`;
    let outPath = path.join(outDir, fileName);
    let renderMethod = 'embedded_jpeg';
    if (sharp) {
      try {
        fileName = `${basePageName}.png`;
        outPath = path.join(outDir, fileName);
        await sharp(img.buffer).rotate().toColorspace('srgb').png().toFile(outPath);
        renderMethod = 'embedded_jpeg_normalized_png';
      } catch {
        fileName = `${basePageName}.jpg`;
        outPath = path.join(outDir, fileName);
        fs.writeFileSync(outPath, img.buffer);
      }
    } else {
      fs.writeFileSync(outPath, img.buffer);
    }
    const asset = registerExistingMediaFile(outPath, {
      type,
      visibility,
      title: `${title} - trang ${img.index}`,
      source: 'pdf_embedded_image',
      status: 'indexed',
      tags: options.tags || [],
      metadata: {
        pdfSource: pdfPath,
        pdfFilename: path.basename(pdfPath),
        page: img.index,
        totalPages,
        renderMethod,
      },
    });
    assets.push(asset);
    if (options.describe !== false) {
      try { assets[assets.length - 1] = await describeMediaAsset(asset); } catch (e) {
        assets[assets.length - 1] = updateMediaAsset(asset.id, { status: 'needs_vision', error: localizeMediaError(e) });
      }
    }
  }
  return { pages: totalPages, processed: assets.length, assets, method: 'embedded_jpeg' };
}

function backfillLegacyBrandAssets() {
  const dir = getBrandAssetsDir();
  if (!fs.existsSync(dir)) return [];
  const existing = readIndex().assets;
  const byPath = new Set(existing.map(a => path.resolve(a.path || '')));
  const added = [];
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const ext = path.extname(name).toLowerCase();
    if (!BRAND_ASSET_FORMATS.includes(ext)) continue;
    try {
      if (!fs.statSync(fp).isFile()) continue;
      if (byPath.has(path.resolve(fp))) continue;
      added.push(registerExistingMediaFile(fp, {
        type: name.startsWith('img_') || fp.includes(path.join('brand-assets', 'generated')) ? 'generated' : 'brand',
        visibility: name.startsWith('img_') ? 'internal' : 'internal',
        source: 'legacy_brand_assets',
        status: 'indexed',
      }));
    } catch {}
  }
  return added;
}

function listBrandAssetNames() {
  backfillLegacyBrandAssets();
  return listMediaAssets({ type: 'brand' })
    .filter(a => a.path && fs.existsSync(a.path))
    .map(a => a.filename);
}

module.exports = {
  MEDIA_TYPES,
  MEDIA_VISIBILITIES,
  MEDIA_IMAGE_FORMATS,
  MEDIA_MAX_SIZE,
  getMediaRoot,
  getMediaFilesDir,
  getMediaIndexPath,
  ensureMediaFolders,
  importMediaFile,
  registerExistingMediaFile,
  listMediaAssets,
  searchMediaAssets,
  findMediaAsset,
  updateMediaAsset,
  deleteMediaAsset,
  describeMediaAsset,
  renderPdfPagesToMedia,
  backfillLegacyBrandAssets,
  listBrandAssetNames,
  localizeMediaError,
  _test: {
    defaultVisibilityForType,
    normalizeSearchText,
    extractDctImagesFromPdf,
  },
};
