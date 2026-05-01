'use strict';
const path = require('path');
const googleApi = require('./google-api');

function isHomedirPathSafe(p) {
  if (!p || typeof p !== 'string') return false;
  const fs = require('fs');
  let resolved;
  try { resolved = fs.realpathSync(path.resolve(p)); } catch { resolved = path.resolve(p); }
  const home = require('os').homedir();
  const blocked = ['.ssh', '.gnupg', '.env', 'credentials', 'credential', 'secret', 'private', 'token', 'auth', 'oauth', 'keyring', 'keychain', '.key'];
  const norm = s => s.toLowerCase().replace(/\\/g, '/');
  const lower = norm(resolved);
  if (blocked.some(b => lower.includes(b))) return false;
  if (!lower.startsWith(norm(home))) return false;
  return true;
}

function columnToNumber(col) {
  let n = 0;
  for (const ch of String(col || '').toUpperCase()) {
    if (ch < 'A' || ch > 'Z') return 0;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function numberToColumn(n) {
  let out = '';
  let x = Number(n) || 0;
  while (x > 0) {
    const mod = (x - 1) % 26;
    out = String.fromCharCode(65 + mod) + out;
    x = Math.floor((x - mod) / 26);
  }
  return out || 'A';
}

function normalizeSheetValues(params) {
  const raw = params.valuesJson !== undefined ? params.valuesJson : params.values;
  if (raw === undefined || raw === null || raw === '') return raw;
  if (Array.isArray(raw)) return { ok: true, values: raw };
  if (typeof raw !== 'string') return { ok: true, values: raw };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, values: trimmed };
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.some(row => !Array.isArray(row))) {
        return { ok: false, error: 'values must be a JSON 2D array' };
      }
      return { ok: true, values: parsed };
    } catch (e) {
      return { ok: false, error: 'values must be valid JSON: ' + e.message };
    }
  }
  return { ok: true, values: raw };
}

function fitSheetRangeToValues(range, values) {
  if (!Array.isArray(values) || !values.length) return range;
  const rowCount = values.length;
  const colCount = Math.max(1, ...values.map(row => Array.isArray(row) ? row.length : 1));
  const text = String(range || '');
  const match = text.match(/^(.*!|)(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?$/i);
  if (!match) return range;
  const prefix = match[1] || '';
  const startCol = match[3].toUpperCase();
  const startRow = parseInt(match[5], 10);
  const currentEndCol = (match[7] || startCol).toUpperCase();
  const currentEndRow = parseInt(match[9] || match[5], 10);
  const minEndColNumber = columnToNumber(startCol) + colCount - 1;
  const endCol = numberToColumn(Math.max(columnToNumber(currentEndCol), minEndColNumber));
  const endRow = Math.max(currentEndRow, startRow + rowCount - 1);
  return `${prefix}${startCol}${startRow}:${endCol}${endRow}`;
}

module.exports = handleGoogleRoute;
module.exports.isHomedirPathSafe = isHomedirPathSafe;
module.exports._test = { normalizeSheetValues, fitSheetRangeToValues };

async function handleGoogleRoute(urlPath, params, req, res, jsonResp) {
  try {
    const sourceChannel = (req.headers['x-source-channel'] || '').toLowerCase();
    const isZalo = sourceChannel === 'zalo';

    if (urlPath === '/status') {
      return jsonResp(res, 200, await googleApi.authStatus());
    }
    if (urlPath === '/health') {
      return jsonResp(res, 200, await googleApi.serviceHealth());
    }
    if (urlPath === '/calendar/events') {
      const r = await googleApi.listEvents(params.from, params.to, params.calendarId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/create') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Calendar create not allowed from Zalo channel' });
      if (!params.summary || !params.start || !params.end) return jsonResp(res, 400, { error: 'summary, start, end required' });
      const r = await googleApi.createEvent(params.summary, params.start, params.end, params.attendees, params.calendarId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/update') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Calendar update not allowed from Zalo channel' });
      if (!params.eventId) return jsonResp(res, 400, { error: 'eventId required' });
      const updates = {
        summary: params.summary,
        start: params.start,
        end: params.end,
        description: params.description,
        location: params.location,
        attendees: params.attendees,
        sendUpdates: params.sendUpdates,
      };
      const hasUpdate = Object.entries(updates).some(([key, value]) => key !== 'sendUpdates' && value !== undefined);
      if (!hasUpdate) return jsonResp(res, 400, { error: 'at least one update field required' });
      const r = await googleApi.updateEvent(params.eventId, updates, params.calendarId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/delete') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Calendar delete not allowed from Zalo channel' });
      if (!params.eventId) return jsonResp(res, 400, { error: 'eventId required' });
      const r = await googleApi.deleteEvent(params.eventId, params.calendarId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/freebusy') {
      if (!params.from || !params.to) return jsonResp(res, 400, { error: 'from and to required' });
      const r = await googleApi.getFreeBusy(params.from, params.to);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/free-slots') {
      if (!params.date) return jsonResp(res, 400, { error: 'date required (YYYY-MM-DD)' });
      const r = await googleApi.getFreeSlots(params.date, params.workStart, params.workEnd, params.slotMinutes);
      return jsonResp(res, 200, r);
    }
    // Gmail
    if (urlPath === '/gmail/inbox') {
      const r = await googleApi.listInbox(params.max);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/gmail/read') {
      if (!params.id) return jsonResp(res, 400, { error: 'id required' });
      const r = await googleApi.readEmail(params.id);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/gmail/send') {
      if ((req.headers['x-source-channel'] || '').toLowerCase() === 'zalo') return jsonResp(res, 403, { error: 'Gmail send not allowed from Zalo channel' });
      if (!params.to || !params.subject || !params.body) return jsonResp(res, 400, { error: 'to, subject, body required' });
      const r = await googleApi.sendEmail(params.to, params.subject, params.body);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/gmail/reply') {
      if ((req.headers['x-source-channel'] || '').toLowerCase() === 'zalo') return jsonResp(res, 403, { error: 'Gmail reply not allowed from Zalo channel' });
      if (!params.id || !params.body) return jsonResp(res, 400, { error: 'id, body required' });
      const r = await googleApi.replyEmail(params.id, params.body);
      return jsonResp(res, 200, r);
    }
    // Drive
    if (urlPath === '/drive/list') {
      const r = await googleApi.listFiles(params.query, params.max);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/drive/upload') {
      if (!params.filePath) return jsonResp(res, 400, { error: 'filePath required' });
      if (!isHomedirPathSafe(params.filePath)) return jsonResp(res, 403, { error: 'filePath blocked by path validation' });
      const r = await googleApi.uploadFile(params.filePath, params.folderId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/drive/download') {
      if (!params.fileId || !params.destPath) return jsonResp(res, 400, { error: 'fileId and destPath required' });
      if (!isHomedirPathSafe(params.destPath)) return jsonResp(res, 403, { error: 'destPath blocked by path validation' });
      const r = await googleApi.downloadFile(params.fileId, params.destPath, params.format);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/drive/share') {
      if (!params.fileId || !params.email) return jsonResp(res, 400, { error: 'fileId and email required' });
      const r = await googleApi.shareFile(params.fileId, params.email, params.role);
      return jsonResp(res, 200, r);
    }
    // Docs
    if (urlPath === '/docs/list') {
      const r = await googleApi.listDocs(params.max);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/info') {
      if (!params.docId) return jsonResp(res, 400, { error: 'docId required' });
      const r = await googleApi.getDocInfo(params.docId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/read') {
      if (!params.docId) return jsonResp(res, 400, { error: 'docId required' });
      const r = await googleApi.readDoc(params.docId, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/create') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Docs create not allowed from Zalo channel' });
      if (!params.title) return jsonResp(res, 400, { error: 'title required' });
      if (params.file && !isHomedirPathSafe(params.file)) return jsonResp(res, 403, { error: 'file blocked by path validation' });
      const r = await googleApi.createDoc(params.title, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/write') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Docs write not allowed from Zalo channel' });
      if (!params.docId) return jsonResp(res, 400, { error: 'docId required' });
      if (params.text === undefined && !params.file) return jsonResp(res, 400, { error: 'text or file required' });
      if (params.file && !isHomedirPathSafe(params.file)) return jsonResp(res, 403, { error: 'file blocked by path validation' });
      const r = await googleApi.writeDoc(params.docId, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/insert') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Docs insert not allowed from Zalo channel' });
      if (!params.docId) return jsonResp(res, 400, { error: 'docId required' });
      if (params.content === undefined && !params.file) return jsonResp(res, 400, { error: 'content or file required' });
      if (params.file && !isHomedirPathSafe(params.file)) return jsonResp(res, 403, { error: 'file blocked by path validation' });
      const r = await googleApi.insertDoc(params.docId, params.content, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/find-replace') {
      if (isZalo) return jsonResp(res, 403, { error: 'Google Docs find-replace not allowed from Zalo channel' });
      if (!params.docId || !params.find) return jsonResp(res, 400, { error: 'docId and find required' });
      if (params.contentFile && !isHomedirPathSafe(params.contentFile)) return jsonResp(res, 403, { error: 'contentFile blocked by path validation' });
      const r = await googleApi.findReplaceDoc(params.docId, params.find, params.replace, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/docs/export') {
      if (!params.docId) return jsonResp(res, 400, { error: 'docId required' });
      if (params.out && !isHomedirPathSafe(params.out)) return jsonResp(res, 403, { error: 'out blocked by path validation' });
      const r = await googleApi.exportDoc(params.docId, params);
      return jsonResp(res, 200, r);
    }
    // Contacts
    if (urlPath === '/contacts/list' || urlPath === '/contacts/search') {
      const r = await googleApi.listContacts(params.query);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/contacts/create') {
      if (!params.name) return jsonResp(res, 400, { error: 'name required' });
      const r = await googleApi.createContact(params.name, params.phone, params.email);
      return jsonResp(res, 200, r);
    }
    // Tasks
    if (urlPath === '/tasks/lists') {
      const r = await googleApi.listTaskLists(params.max);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/tasks/list') {
      const r = await googleApi.listTasks(params.listId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/tasks/create') {
      if (!params.title) return jsonResp(res, 400, { error: 'title required' });
      const r = await googleApi.createTask(params.title, params.due, params.listId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/tasks/complete') {
      if (!params.taskId) return jsonResp(res, 400, { error: 'taskId required' });
      const r = await googleApi.completeTask(params.taskId, params.listId);
      return jsonResp(res, 200, r);
    }
    // Sheets
    if (urlPath === '/sheets/list') {
      const r = await googleApi.listSheets(params.max);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/sheets/metadata') {
      if (!params.spreadsheetId) return jsonResp(res, 400, { error: 'spreadsheetId required' });
      const r = await googleApi.getSheetMetadata(params.spreadsheetId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/sheets/get') {
      if (!params.spreadsheetId || !params.range) return jsonResp(res, 400, { error: 'spreadsheetId and range required' });
      const r = await googleApi.getSheet(params.spreadsheetId, params.range, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/sheets/update') {
      if (!params.spreadsheetId || !params.range) return jsonResp(res, 400, { error: 'spreadsheetId and range required' });
      const parsedValues = normalizeSheetValues(params);
      if (parsedValues && !parsedValues.ok) return jsonResp(res, 400, { error: parsedValues.error });
      const values = parsedValues ? parsedValues.values : params.values;
      const range = fitSheetRangeToValues(params.range, values);
      const r = await googleApi.updateSheet(params.spreadsheetId, range, values, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/sheets/append') {
      if (!params.spreadsheetId || !params.range) return jsonResp(res, 400, { error: 'spreadsheetId and range required' });
      const parsedValues = normalizeSheetValues(params);
      if (parsedValues && !parsedValues.ok) return jsonResp(res, 400, { error: parsedValues.error });
      const values = parsedValues ? parsedValues.values : params.values;
      const r = await googleApi.appendSheet(params.spreadsheetId, params.range, values, params);
      return jsonResp(res, 200, r);
    }
    // Apps Script, useful for automations around Google Sheets/AppSheet data.
    if (urlPath === '/appscript/run') {
      if (!params.scriptId || !params.functionName) return jsonResp(res, 400, { error: 'scriptId and functionName required' });
      const r = await googleApi.runAppScript(params.scriptId, params.functionName, params.params, params.devMode);
      return jsonResp(res, 200, r);
    }
    return jsonResp(res, 404, { error: 'unknown google route: ' + urlPath });
  } catch (e) {
    return jsonResp(res, 500, { error: e.message });
  }
};
