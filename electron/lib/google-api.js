'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let app;
try { app = require('electron').app; } catch {}

const _activeChildren = new Set();
let _connectInFlight = null;
const GOOGLE_SERVICES = 'calendar,gmail,drive,contacts,tasks,sheets,docs,appscript';

function getGogConfigDir() {
  if (app) return path.join(app.getPath('userData'), 'gog');
  const homedir = require('os').homedir();
  if (process.platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'modoro-claw', 'gog');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'modoro-claw', 'gog');
  return path.join(homedir, '.config', 'modoro-claw', 'gog');
}

function getGogBinaryPath() {
  let vendorDir;
  try {
    const { getBundledVendorDir } = require('./boot');
    vendorDir = getBundledVendorDir();
  } catch {}
  if (!vendorDir) vendorDir = path.join(__dirname, '..', 'vendor');
  const bin = process.platform === 'win32'
    ? path.join(vendorDir, 'gog', 'gog.exe')
    : path.join(vendorDir, 'gog', 'gog');

  if (!fs.existsSync(bin)) return null;

  if (process.platform !== 'win32') {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      try { fs.chmodSync(bin, 0o755); } catch {}
    }
  }
  return bin;
}

function getGogAccount() {
  try {
    const p = path.join(getGogConfigDir(), 'account.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8')).email || '';
  } catch { return ''; }
}

function saveGogAccount(email) {
  const dir = getGogConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ email }));
}

function gogEnv() {
  const configDir = getGogConfigDir();
  try { fs.mkdirSync(configDir, { recursive: true }); } catch {}
  return {
    ...process.env,
    GOG_CONFIG_DIR: configDir,
    GOG_JSON: '1',
    GOG_TIMEZONE: 'Asia/Ho_Chi_Minh',
    GOG_ACCOUNT: getGogAccount(),
  };
}

async function gogExec(args, timeoutMs = 15000) {
  return gogSpawnAsync(args, timeoutMs);
}

function normalizeGogArgs(args) {
  const normalized = Array.isArray(args) ? args.slice() : [];
  if (!normalized.includes('--json') && !normalized.includes('-j')) {
    normalized.unshift('--json');
  }
  return normalized;
}

function gogSpawnAsync(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const bin = getGogBinaryPath();
    if (!bin) return reject(new Error('gog binary not found'));
    const child = spawn(bin, normalizeGogArgs(args), { env: gogEnv(), windowsHide: true });
    _activeChildren.add(child);
    let stdout = '', stderr = '';
    let settled = false;
    child.stdout?.on('data', d => stdout += d);
    child.stderr?.on('data', d => stderr += d);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      _activeChildren.delete(child);
      reject(new Error('Timeout after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeChildren.delete(child);
      if (code !== 0) return reject(new Error(stderr || `exit code ${code}`));
      try { resolve(JSON.parse(stdout)); } catch {
        resolve({ ok: true, raw: stdout.slice(0, 2000) });
      }
    });
    child.on('error', e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      _activeChildren.delete(child);
      reject(e);
    });
  });
}

function cleanupGogProcesses() {
  for (const child of _activeChildren) {
    try { child.kill(); } catch {}
  }
  _activeChildren.clear();
}

// --- Auth ---

async function authStatus() {
  try {
    const result = await gogExec(['auth', 'status'], 10000);
    const email = getGogAccount();
    return { connected: !!email, email, services: GOOGLE_SERVICES.split(','), raw: result };
  } catch {
    return { connected: false, email: '', services: [] };
  }
}

function validateOAuthClientSecret(clientSecretPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(clientSecretPath, 'utf-8'));
  } catch {
    throw new Error('File JSON không đọc được. Hãy tải lại OAuth Client JSON từ Google Cloud Console.');
  }

  if (parsed?.type === 'service_account' || parsed?.private_key || parsed?.client_email) {
    throw new Error('File này là Service Account JSON. Google Workspace cần OAuth Client ID loại Desktop app.');
  }

  const desktopClient = parsed?.installed || parsed?.native;
  if (!desktopClient || typeof desktopClient !== 'object') {
    throw new Error('File JSON không đúng loại. Hãy tạo OAuth Client ID với Application type là Desktop app.');
  }

  if (!desktopClient.client_id || !desktopClient.client_secret) {
    throw new Error('File OAuth Client thiếu client_id hoặc client_secret. Hãy tải lại file JSON từ OAuth Client Desktop app.');
  }

  return { ok: true, clientId: desktopClient.client_id };
}

async function registerCredentials(clientSecretPath) {
  validateOAuthClientSecret(clientSecretPath);
  return gogExec(['auth', 'credentials', clientSecretPath], 10000);
}

async function connectAccount(email) {
  if (_connectInFlight) return _connectInFlight;
  _connectInFlight = (async () => {
    try {
      const result = await gogSpawnAsync(
        ['auth', 'add', email, '--services', GOOGLE_SERVICES],
        120000
      );
      saveGogAccount(email);
      return result;
    } finally {
      _connectInFlight = null;
    }
  })();
  return _connectInFlight;
}

async function disconnectAccount() {
  const email = getGogAccount();
  if (email) {
    try { await gogExec(['auth', 'remove', email], 10000); } catch {}
  }
  const accountFile = path.join(getGogConfigDir(), 'account.json');
  try { fs.unlinkSync(accountFile); } catch {}
  return { ok: true };
}

// --- Calendar ---

async function listEvents(from, to, calendarId) {
  const args = ['calendar', 'events', calendarId || 'primary'];
  if (from) args.push('--from', from);
  if (to) args.push('--to', to);
  return gogExec(args);
}

async function createEvent(summary, start, end, attendees, calendarId) {
  const args = ['calendar', 'create', calendarId || 'primary', '--summary', summary, '--from', start, '--to', end];
  if (attendees) {
    const list = Array.isArray(attendees) ? attendees.join(',') : attendees;
    args.push('--attendees', list);
  }
  return gogExec(args);
}

async function deleteEvent(eventId, calendarId) {
  return gogExec(['calendar', 'delete', calendarId || 'primary', eventId]);
}

async function getFreeBusy(from, to) {
  return gogExec(['calendar', 'freebusy', '--from', from, '--to', to]);
}

async function getFreeSlots(date, workStart, workEnd, slotMinutes) {
  workStart = workStart || '08:00';
  workEnd = workEnd || '18:00';
  slotMinutes = Math.max(1, parseInt(slotMinutes) || 30);
  const from = date + 'T' + workStart + ':00';
  const to = date + 'T' + workEnd + ':00';
  const busy = await getFreeBusy(from, to);
  const busyPeriods = (busy.calendars || busy.data || [])
    .flatMap(c => c.busy || [])
    .map(b => ({ start: new Date(b.start), end: new Date(b.end) }))
    .sort((a, b) => a.start - b.start);

  const slots = [];
  let cursor = new Date(from);
  const endTime = new Date(to);
  const slotMs = slotMinutes * 60000;
  while (cursor.getTime() + slotMs <= endTime.getTime()) {
    const slotEnd = new Date(cursor.getTime() + slotMs);
    const conflict = busyPeriods.some(b => cursor < b.end && slotEnd > b.start);
    if (!conflict) slots.push({ start: cursor.toISOString(), end: slotEnd.toISOString() });
    cursor = new Date(cursor.getTime() + slotMs);
  }
  return { slots };
}

// --- Gmail ---

async function listInbox(max) {
  return gogExec(['gmail', 'search', '--query', 'in:inbox', '--max', String(max || 20)]);
}

async function readEmail(id) {
  return gogExec(['gmail', 'get', id]);
}

async function sendEmail(to, subject, body) {
  return gogExec(['gmail', 'send', '--to', to, '--subject', subject, '--body', body], 30000);
}

async function replyEmail(id, body) {
  return gogExec(['gmail', 'reply', id, '--body', body], 30000);
}

// --- Drive ---

async function listFiles(query, max) {
  const args = query ? ['drive', 'search', query, '--max', String(max || 20)] : ['drive', 'ls', '--max', String(max || 20)];
  return gogExec(args);
}

async function uploadFile(filePath, folderId) {
  const args = ['drive', 'upload', filePath];
  if (folderId) args.push('--parent', folderId);
  return gogExec(args, 60000);
}

async function downloadFile(fileId, destPath, format) {
  const args = ['drive', 'download', fileId, '--out', destPath];
  if (format) args.push('--format', format);
  return gogExec(args, 60000);
}

async function shareFile(fileId, email, role) {
  return gogExec(['drive', 'share', fileId, '--to', 'user', '--email', email, '--role', role || 'reader']);
}

// --- Contacts ---

async function listContacts(query) {
  return query ? gogExec(['contacts', 'search', query]) : gogExec(['contacts', 'list']);
}

async function createContact(name, phone, email) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const given = parts.shift() || name;
  const family = parts.join(' ');
  const args = ['contacts', 'create', '--given', given];
  if (family) args.push('--family', family);
  if (phone) args.push('--phone', phone);
  if (email) args.push('--email', email);
  return gogExec(args);
}

// --- Tasks ---

function firstArrayFromResult(result, keys) {
  for (const key of keys) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result)) return result;
  return [];
}

async function listTaskLists(max) {
  return gogExec(['tasks', 'lists', 'list', '--max', String(max || 100)]);
}

async function resolveTaskListId(listId) {
  if (listId) return listId;
  const result = await listTaskLists(1);
  const lists = firstArrayFromResult(result, ['taskLists', 'tasklists', 'lists']);
  const first = lists[0];
  const resolved = first?.id || first?.tasklistId || first?.taskListId;
  if (!resolved) throw new Error('Không tìm thấy Google Task list nào để thao tác.');
  return resolved;
}

async function listTasks(listId) {
  const taskListId = await resolveTaskListId(listId);
  return gogExec(['tasks', 'list', taskListId]);
}

async function createTask(title, due, listId) {
  const taskListId = await resolveTaskListId(listId);
  const args = ['tasks', 'add', taskListId, '--title', title];
  if (due) args.push('--due', due);
  return gogExec(args);
}

async function completeTask(taskId, listId) {
  const taskListId = await resolveTaskListId(listId);
  return gogExec(['tasks', 'done', taskListId, taskId]);
}

// --- Sheets ---

async function getSheet(spreadsheetId, range, opts) {
  const args = ['sheets', 'get', spreadsheetId, range];
  if (opts?.render) args.push('--render', opts.render);
  if (opts?.dimension) args.push('--dimension', opts.dimension);
  return gogExec(args);
}

async function updateSheet(spreadsheetId, range, values, opts) {
  const args = ['sheets', 'update', spreadsheetId, range];
  if (Array.isArray(values)) args.push('--values-json', JSON.stringify(values));
  else if (values) args.push(String(values));
  if (opts?.input) args.push('--input', opts.input);
  if (opts?.copyValidationFrom) args.push('--copy-validation-from', opts.copyValidationFrom);
  return gogExec(args, 30000);
}

async function appendSheet(spreadsheetId, range, values, opts) {
  const args = ['sheets', 'append', spreadsheetId, range];
  if (Array.isArray(values)) args.push('--values-json', JSON.stringify(values));
  else if (values) args.push(String(values));
  if (opts?.input) args.push('--input', opts.input);
  if (opts?.insert) args.push('--insert', opts.insert);
  if (opts?.copyValidationFrom) args.push('--copy-validation-from', opts.copyValidationFrom);
  return gogExec(args, 30000);
}

async function getSheetMetadata(spreadsheetId) {
  return gogExec(['sheets', 'metadata', spreadsheetId]);
}

async function runAppScript(scriptId, functionName, params, devMode) {
  const args = ['appscript', 'run', scriptId, functionName];
  if (params !== undefined) args.push('--params', typeof params === 'string' ? params : JSON.stringify(params));
  if (devMode) args.push('--dev-mode');
  return gogExec(args, 60000);
}

module.exports = {
  getGogBinaryPath, getGogConfigDir, getGogAccount,
  gogExec, gogSpawnAsync, gogEnv, cleanupGogProcesses,
  authStatus, validateOAuthClientSecret, registerCredentials, connectAccount, disconnectAccount,
  listEvents, createEvent, deleteEvent, getFreeBusy, getFreeSlots,
  listInbox, readEmail, sendEmail, replyEmail,
  listFiles, uploadFile, downloadFile, shareFile,
  listContacts, createContact,
  listTaskLists, listTasks, createTask, completeTask,
  getSheet, updateSheet, appendSheet, getSheetMetadata, runAppScript,
};
