#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'ui', 'dashboard.html'), 'utf8');

const failures = [];

function mustInclude(label, needle) {
  if (!dashboard.includes(needle)) failures.push(`${label}: missing ${needle}`);
}

function mustNotInclude(label, needle) {
  if (dashboard.includes(needle)) failures.push(`${label}: still contains ${needle}`);
}

mustInclude('shared button loading primitive', 'function setBtnLoading(button, loading, label)');
mustInclude('shared inline state primitive', 'function renderInlineState(target, state)');
mustInclude('shared confirm dialog primitive', 'function showConfirmDialog(options)');
mustInclude('shared input dialog primitive', 'function showInputDialog(options)');
mustInclude('toast variant map', 'const TOAST_VARIANTS =');
mustInclude('toast warning support', 'warning:');
mustInclude('knowledge upload queue state', 'let knowledgeUploadQueue = []');
mustInclude('knowledge upload queue renderer', 'function renderKnowledgeUploadQueue()');
mustInclude('knowledge busy dropzone', 'function setKnowledgeUploadBusy(isBusy)');
mustInclude('knowledge visibility modal', 'function showKnowledgeVisibilityDialog(docId, currentVisibility)');
mustInclude('media status helper', 'function getMediaStatusMeta(status)');
mustInclude('media action loading', 'async function withMediaButtonLoading(button, task)');
mustInclude('google list state helper', 'function renderGoogleListState(el, state)');
mustInclude('gmail inline error target', 'gmail-compose-error');
mustInclude('calendar action helper', 'async function runCalendarAction(button, busyLabel, task)');
mustInclude('embed failure action helper', 'function renderEmbedFailure(loader, name, label)');

mustNotInclude('knowledge visibility prompt', 'const next = prompt(');
mustNotInclude('gmail reply success alert', "alert('Đã gửi trả lời')");
mustNotInclude('gmail send success alert', "alert('Đã gửi email')");
mustNotInclude('gmail send error alert', "alert('Lỗi gửi email:");
mustNotInclude('calendar create error alert', "alert('Lỗi tạo sự kiện:");
mustNotInclude('calendar update error alert', "alert('Lỗi cập nhật sự kiện:");
mustNotInclude('calendar delete error alert', "alert('Lỗi xóa sự kiện:");
mustNotInclude('calendar drag error alert', "alert('Lỗi cập nhật thời gian");

if (failures.length) {
  console.error('[dashboard-ux-qol] FAIL');
  for (const failure of failures) console.error('  - ' + failure);
  process.exit(1);
}

console.log('[dashboard-ux-qol] PASS dashboard UX loading, empty, error, confirm, and media states');
