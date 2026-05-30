#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

function disableNetwork() {
  const blocked = new Set(['child_process', 'cluster', 'worker_threads']);
  const blockedCall = () => {
    throw new Error('network access is disabled in attachment analyzer');
  };
  try {
    const net = require('net');
    net.connect = blockedCall;
    net.createConnection = blockedCall;
  } catch {}
  try {
    const tls = require('tls');
    tls.connect = blockedCall;
  } catch {}
  try {
    const http = require('http');
    http.request = blockedCall;
    http.get = blockedCall;
  } catch {}
  try {
    const https = require('https');
    https.request = blockedCall;
    https.get = blockedCall;
  } catch {}
  try {
    const dgram = require('dgram');
    dgram.createSocket = blockedCall;
  } catch {}
  try {
    const dns = require('dns');
    dns.lookup = blockedCall;
    dns.resolve = blockedCall;
    dns.resolve4 = blockedCall;
    dns.resolve6 = blockedCall;
  } catch {}
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (blocked.has(request) || blocked.has(String(request || '').replace(/^node:/, ''))) {
      throw new Error(`blocked module in attachment analyzer: ${request}`);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function addModulePaths() {
  const roots = moduleRoots();
  for (const dir of roots) {
    if (fs.existsSync(dir) && !module.paths.includes(dir)) module.paths.push(dir);
  }
}

function moduleRoots() {
  const envPaths = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  return [
    ...envPaths,
    path.join(__dirname, '..', 'node_modules'),
    path.join(__dirname, '..', 'vendor', 'node_modules'),
    path.join(process.cwd(), 'node_modules'),
  ];
}

function isInsideDir(absPath, dirPath) {
  const rel = path.relative(path.resolve(dirPath), path.resolve(absPath));
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function restrictFileSystem(attachmentPath, inputPath) {
  const allowedFiles = new Set([path.resolve(attachmentPath), path.resolve(inputPath)]);
  const allowedDirs = [
    path.resolve(__dirname),
    ...moduleRoots().map(p => path.resolve(p)),
  ].filter(dir => fs.existsSync(dir));
  const original = {
    createReadStream: fs.createReadStream,
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    open: fs.open,
    openSync: fs.openSync,
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    readdir: fs.readdir,
    readdirSync: fs.readdirSync,
    realpathSync: fs.realpathSync,
    stat: fs.stat,
    statSync: fs.statSync,
  };
  const allowed = rawPath => {
    if (typeof rawPath !== 'string') return true;
    const abs = path.resolve(rawPath);
    return allowedFiles.has(abs) || allowedDirs.some(dir => isInsideDir(abs, dir));
  };
  const assertAllowed = rawPath => {
    if (!allowed(rawPath)) throw new Error('filesystem access outside attachment sandbox is disabled');
  };
  fs.existsSync = function patchedExistsSync(rawPath) {
    if (!allowed(rawPath)) return false;
    return original.existsSync.apply(this, arguments);
  };
  fs.readFileSync = function patchedReadFileSync(rawPath) {
    assertAllowed(rawPath);
    return original.readFileSync.apply(this, arguments);
  };
  fs.readFile = function patchedReadFile(rawPath) {
    assertAllowed(rawPath);
    return original.readFile.apply(this, arguments);
  };
  fs.createReadStream = function patchedCreateReadStream(rawPath) {
    assertAllowed(rawPath);
    return original.createReadStream.apply(this, arguments);
  };
  fs.openSync = function patchedOpenSync(rawPath) {
    assertAllowed(rawPath);
    return original.openSync.apply(this, arguments);
  };
  fs.open = function patchedOpen(rawPath) {
    assertAllowed(rawPath);
    return original.open.apply(this, arguments);
  };
  fs.statSync = function patchedStatSync(rawPath) {
    assertAllowed(rawPath);
    return original.statSync.apply(this, arguments);
  };
  fs.stat = function patchedStat(rawPath) {
    assertAllowed(rawPath);
    return original.stat.apply(this, arguments);
  };
  fs.lstatSync = function patchedLstatSync(rawPath) {
    assertAllowed(rawPath);
    return original.lstatSync.apply(this, arguments);
  };
  fs.readdirSync = function patchedReaddirSync(rawPath) {
    assertAllowed(rawPath);
    return original.readdirSync.apply(this, arguments);
  };
  fs.readdir = function patchedReaddir(rawPath) {
    assertAllowed(rawPath);
    return original.readdir.apply(this, arguments);
  };
  fs.realpathSync = function patchedRealpathSync(rawPath) {
    assertAllowed(rawPath);
    return original.realpathSync.apply(this, arguments);
  };
}

function limitText(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[truncated ${text.length - maxChars} chars]`;
}

function stripXmlText(xml) {
  return String(xml || '')
    .replace(/<a:br\s*\/>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function promptInjectionSignals(text) {
  const lower = String(text || '').toLowerCase();
  const patterns = [
    'ignore previous',
    'new system prompt',
    'developer mode',
    'you are now',
    'act as',
    'jailbreak',
    '[system]',
    '{{',
  ];
  return patterns.filter(p => lower.includes(p));
}

async function parsePdf(filePath, maxChars) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(fs.readFileSync(filePath));
  const content = limitText(data.text || '', maxChars);
  return {
    type: 'pdf',
    pages: data.numpages || 0,
    content,
    promptInjectionSignals: promptInjectionSignals(content),
  };
}

async function parseDocx(filePath, maxChars) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const content = limitText(result.value || '', maxChars);
  return {
    type: 'docx',
    content,
    warnings: (result.messages || []).map(m => String(m.message || m).slice(0, 300)),
    promptInjectionSignals: promptInjectionSignals(content),
  };
}

function parseWorkbook(filePath, maxChars) {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath, { cellDates: true, WTF: false });
  const sheets = {};
  let combined = '';
  for (const name of workbook.SheetNames || []) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      defval: '',
      raw: false,
    }).slice(0, 500);
    sheets[name] = rows;
    combined += `\n# ${name}\n` + rows.map(row => row.join('\t')).join('\n');
  }
  const content = limitText(combined.trim(), maxChars);
  return {
    type: 'xlsx',
    sheetNames: workbook.SheetNames || [],
    sheets,
    content,
    promptInjectionSignals: promptInjectionSignals(content),
  };
}

async function parsePptx(filePath, maxChars) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const ai = Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bi = Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return ai - bi;
    });
  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    slides.push({ name, text: stripXmlText(xml) });
  }
  const content = limitText(slides.map((s, i) => `Slide ${i + 1}: ${s.text}`).join('\n'), maxChars);
  return {
    type: 'pptx',
    slideCount: slides.length,
    slides,
    content,
    promptInjectionSignals: promptInjectionSignals(content),
  };
}

function parseText(filePath, detectedType, maxChars) {
  const content = limitText(fs.readFileSync(filePath, 'utf8'), maxChars);
  return {
    type: detectedType,
    content,
    promptInjectionSignals: promptInjectionSignals(content),
  };
}

async function main() {
  addModulePaths();
  disableNetwork();

  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('input json path required');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const filePath = path.resolve(String(input.path || ''));
  const maxChars = Math.min(Number(input.maxChars) || 80000, 200000);
  const detectedType = String(input.detectedType || '').toLowerCase();

  if (!fs.existsSync(filePath)) throw new Error('attachment file not found');
  restrictFileSystem(filePath, inputPath);

  let result;
  if (detectedType === 'pdf') result = await parsePdf(filePath, maxChars);
  else if (detectedType === 'docx') result = await parseDocx(filePath, maxChars);
  else if (detectedType === 'xlsx' || detectedType === 'xls') result = parseWorkbook(filePath, maxChars);
  else if (detectedType === 'pptx') result = await parsePptx(filePath, maxChars);
  else if (['txt', 'csv', 'md'].includes(detectedType)) result = parseText(filePath, detectedType, maxChars);
  else throw new Error(`unsupported attachment type: ${detectedType}`);

  process.stdout.write(JSON.stringify(result));
}

main().catch(error => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
