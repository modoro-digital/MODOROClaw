#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const googleApi = require('../lib/google-api');

const root = path.join(__dirname, '..');
const files = {
  api: path.join(root, 'lib', 'google-api.js'),
  routes: path.join(root, 'lib', 'google-routes.js'),
  ipc: path.join(root, 'lib', 'dashboard-ipc.js'),
  preload: path.join(root, 'preload.js'),
  dashboard: path.join(root, 'ui', 'dashboard.html'),
};

const failures = [];
const read = file => fs.readFileSync(file, 'utf8');
const assertIncludes = (name, text, needle) => {
  if (!text.includes(needle)) failures.push(`${name}: missing ${needle}`);
};

const api = read(files.api);
const routes = read(files.routes);
const ipc = read(files.ipc);
const preload = read(files.preload);
const dashboard = read(files.dashboard);

assertIncludes('google-api updateEvent function', api, 'async function updateEvent(');
assertIncludes('google-api gog calendar update', api, "'calendar', 'update'");
assertIncludes('google-api export updateEvent', api, 'updateEvent,');
assertIncludes('google-routes calendar update route', routes, "urlPath === '/calendar/update'");
assertIncludes('dashboard-ipc update handler', ipc, "ipcMain.handle('google-calendar-update'");
assertIncludes('preload update bridge', preload, 'googleCalendarUpdate:');
assertIncludes('dashboard editable calendar', dashboard, 'editable: true');
assertIncludes('dashboard selectable calendar', dashboard, 'selectable: true');
assertIncludes('dashboard eventDrop handler', dashboard, 'eventDrop: handleCalEventDropOrResize');
assertIncludes('dashboard eventResize handler', dashboard, 'eventResize: handleCalEventDropOrResize');
assertIncludes('dashboard date select handler', dashboard, 'select: handleCalDateSelect');
assertIncludes('dashboard edit modal', dashboard, 'cal-edit-modal');
assertIncludes('dashboard edit save', dashboard, 'submitCalEdit');
assertIncludes('dashboard edit delete', dashboard, 'deleteCalEditEvent');
assertIncludes('dashboard theme', dashboard, 'Executive Neutral premium theme');

try {
  const args = googleApi._test.buildUpdateEventArgs('evt_123', {
    summary: 'Demo',
    start: '2026-04-30T09:00:00+07:00',
    end: '2026-04-30T10:00:00+07:00',
    attendees: ['a@example.com', 'b@example.com'],
    sendUpdates: 'none',
  }, 'primary');
  assert.deepStrictEqual(args.slice(0, 4), ['calendar', 'update', 'primary', 'evt_123']);
  assert.deepStrictEqual(args.slice(args.indexOf('--summary'), args.indexOf('--summary') + 2), ['--summary', 'Demo']);
  assert.deepStrictEqual(args.slice(args.indexOf('--from'), args.indexOf('--from') + 2), ['--from', '2026-04-30T09:00:00+07:00']);
  assert.deepStrictEqual(args.slice(args.indexOf('--to'), args.indexOf('--to') + 2), ['--to', '2026-04-30T10:00:00+07:00']);
  assert.deepStrictEqual(args.slice(args.indexOf('--attendees'), args.indexOf('--attendees') + 2), ['--attendees', 'a@example.com,b@example.com']);
  assert.deepStrictEqual(args.slice(args.indexOf('--send-updates'), args.indexOf('--send-updates') + 2), ['--send-updates', 'none']);
  assert.throws(
    () => googleApi._test.buildUpdateEventArgs('evt_123', { sendUpdates: 'none' }, 'primary'),
    /at least one update field required/
  );
  assert.throws(
    () => googleApi._test.buildUpdateEventArgs('', { summary: 'Demo' }, 'primary'),
    /eventId required/
  );
} catch (err) {
  failures.push(`google-api updateEvent argv behavior: ${err.message}`);
}

if (failures.length) {
  console.error('[google-calendar-route] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[google-calendar-route] PASS calendar update route and interactive UI wiring');
