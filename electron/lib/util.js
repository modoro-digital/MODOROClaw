'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Check whether a filename resolves to a path inside baseDir (prevents traversal).
 * @param {string} baseDir - The root directory to constrain to
 * @param {string} filename - The filename or relative path to check
 * @returns {boolean} True if resolved path is within baseDir
 */
function isPathSafe(baseDir, filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('\0')) return false;
  const resolved = path.resolve(baseDir, filename);
  return resolved.startsWith(baseDir + path.sep) || resolved === baseDir;
}

let _atomicWriteCounter = 0;
/**
 * Atomically write JSON data to a file (write to tmp + rename).
 * @param {string} filePath - Destination file path
 * @param {*} data - Data to JSON.stringify and write
 * @returns {boolean} True on success
 * @throws {Error} On disk-full or unrecoverable write failure
 */
function writeJsonAtomic(filePath, data) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${++_atomicWriteCounter}`;
  try {
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
    fs.writeFileSync(tmp, serialized, 'utf-8');
    try {
      fs.renameSync(tmp, filePath);
    } catch (e1) {
      // Retry once after a brief pause. On Windows, AV scanners can hold
      // a short lock on the destination file. We use copyFile+unlink as
      // fallback instead of a second rename to avoid AV lock contention.
      try {
        fs.copyFileSync(tmp, filePath);
        try { fs.unlinkSync(tmp); } catch {}
      } catch (e2) {
        try {
          const msg = `[writeJsonAtomic] rename fail: ${filePath} — ${e2.message} (tmp=${tmp})`;
          if (typeof console !== 'undefined') console.error(msg);
        } catch {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        const err = new Error(
          `[writeJsonAtomic] failed to rename ${tmp} -> ${filePath}: ${e2.message}`
        );
        err.code = e2.code;
        err.original = e2;
        throw err;
      }
    }
    return true;
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } catch {}
    if (e.code === 'ENOSPC') {
      console.error('[writeJsonAtomic] DISK FULL — cannot write:', filePath);
    }
    throw e;
  }
}

/**
 * Tokenize a shell-like command string into arguments, respecting quotes.
 * @param {string} command - The shell command string to tokenize
 * @returns {string[]|null} Array of tokens, or null if quotes are unclosed
 */
function tokenizeShellish(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (escaped) cur += '\\';
  if (quote) return null;
  if (cur) tokens.push(cur);
  return tokens;
}

function sanitizeZaloText(text) {
  if (!text || typeof text !== 'string') return '';
  let out = String(text);
  out = out.replace(/```[\s\S]*?```/g, '');                       // code fences
  out = out.replace(/`([^`]+)`/g, '$1');                           // inline code
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');                   // **bold**
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');          // *italic*
  out = out.replace(/__([^_\n]+)__/g, '$1');                       // __bold__
  out = out.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1');              // _italic_
  out = out.replace(/^#{1,6}\s+/gm, '');                           // # headings
  out = out.replace(/^>\s*/gm, '');                                // > blockquote
  out = out.replace(/^\s*[-*+•·]\s*/gm, '');                        // - bullets + • · unicode
  out = out.replace(/^\s*\d+[.)]\s+/gm, '');                       // 1. numbered
  out = out.replace(/\|([^|\n]+)\|/g, '$1');                       // | table |
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, '');                    // HTML tags
  // Strip zero-width spaces, joiners, RLO/LRO bidi overrides
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '');
  // Strip ALL emoji — intentional per brand guidelines (no cheap emojis in Zalo replies)
  out = out.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  out = out.replace(/\n{3,}/g, '\n\n');                             // collapse newlines
  return out.trim();
}

function stripTelegramMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/```[a-z]*\n?/gi, '')               // fence open
    .replace(/```/g, '')                          // fence close
    .replace(/\*{1,2}([^*\n]+)\*{1,2}/g, '$1')   // *bold* / **bold**
    .replace(/`([^`\n]+)`/g, '$1')                // `code`
    .replace(/__([^_\n]+)__/g, '$1')              // __double__
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, '$1'); // _italic_ (skip snake_case)
}

module.exports = { isPathSafe, writeJsonAtomic, tokenizeShellish, sanitizeZaloText, stripTelegramMarkdown };
