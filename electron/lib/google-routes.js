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

module.exports = handleGoogleRoute;
module.exports.isHomedirPathSafe = isHomedirPathSafe;

async function handleGoogleRoute(urlPath, params, req, res, jsonResp) {
  try {
    if (urlPath === '/status') {
      return jsonResp(res, 200, await googleApi.authStatus());
    }
    if (urlPath === '/calendar/events') {
      const r = await googleApi.listEvents(params.from, params.to, params.calendarId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/create') {
      if (!params.summary || !params.start || !params.end) return jsonResp(res, 400, { error: 'summary, start, end required' });
      const r = await googleApi.createEvent(params.summary, params.start, params.end, params.attendees, params.calendarId);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/calendar/delete') {
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
      const r = await googleApi.updateSheet(params.spreadsheetId, params.range, params.values, params);
      return jsonResp(res, 200, r);
    }
    if (urlPath === '/sheets/append') {
      if (!params.spreadsheetId || !params.range) return jsonResp(res, 400, { error: 'spreadsheetId and range required' });
      const r = await googleApi.appendSheet(params.spreadsheetId, params.range, params.values, params);
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
