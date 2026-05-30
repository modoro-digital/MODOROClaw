'use strict';
const fs = require('fs');
const path = require('path');

let _getWorkspace;
function init(deps) { _getWorkspace = deps.getWorkspace; }

function _leavePath() {
  const ws = _getWorkspace();
  return ws ? path.join(ws, 'leave-requests.json') : null;
}

function _readLeaves() {
  const p = _leavePath();
  if (!p || !fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function _writeLeaves(leaves) {
  const p = _leavePath();
  if (!p) throw new Error('workspace not available');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(leaves, null, 2) + '\n', 'utf-8');
}

function _nextId(leaves) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).replace(/-/g, '');
  const todayLeaves = leaves.filter(l => l.id && l.id.startsWith('LV-' + today));
  const seq = String(todayLeaves.length + 1).padStart(3, '0');
  return 'LV-' + today + '-' + seq;
}

const VALID_TYPES = new Set(['annual', 'sick', 'personal']);

function requestLeave({ employee, type, from, to, note }) {
  if (!employee) throw new Error('employee required');
  if (!type || !VALID_TYPES.has(type)) throw new Error('type must be annual, sick, or personal');
  if (!from || !to) throw new Error('from and to dates required');
  const leaves = _readLeaves();
  const leave = {
    id: _nextId(leaves),
    employee,
    type,
    from,
    to,
    note: note || '',
    status: 'pending',
    approvedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  leaves.push(leave);
  _writeLeaves(leaves);
  return leave;
}

function listLeave({ month, employee } = {}) {
  let leaves = _readLeaves();
  if (month) {
    leaves = leaves.filter(l => (l.from && l.from.startsWith(month)) || (l.to && l.to.startsWith(month)));
  }
  if (employee) {
    const q = String(employee).toLowerCase();
    leaves = leaves.filter(l => (l.employee || '').toLowerCase().includes(q));
  }
  leaves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return leaves;
}

function approveLeave({ requestId, approvedBy }) {
  if (!requestId) throw new Error('requestId required');
  const leaves = _readLeaves();
  const leave = leaves.find(l => l.id === requestId);
  if (!leave) throw new Error('leave request not found: ' + requestId);
  leave.status = 'approved';
  leave.approvedBy = approvedBy || null;
  leave.updatedAt = new Date().toISOString();
  _writeLeaves(leaves);
  return leave;
}

function _countDays(from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (isNaN(start) || isNaN(end)) return 1;
  const diff = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  return diff > 0 ? diff : 1;
}

function leaveSummary({ month }) {
  if (!month) throw new Error('month required (YYYY-MM)');
  const leaves = listLeave({ month });
  const byEmployee = {};
  for (const l of leaves) {
    const name = l.employee || 'Unknown';
    if (!byEmployee[name]) byEmployee[name] = { employee: name, approved: 0, pending: 0, rejected: 0, totalDays: 0 };
    const entry = byEmployee[name];
    if (l.status === 'approved') entry.approved++;
    else if (l.status === 'pending') entry.pending++;
    else if (l.status === 'rejected') entry.rejected++;
    entry.totalDays += _countDays(l.from, l.to);
  }
  return { month, entries: Object.values(byEmployee) };
}

module.exports = { init, requestLeave, listLeave, approveLeave, leaveSummary };
