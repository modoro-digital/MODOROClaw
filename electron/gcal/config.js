/**
 * Google Calendar config — read/write gcal-config.json in workspace.
 *
 * Default: { workingHours: { start: "08:00", end: "18:00" },
 *            slotDurationMinutes: 30, daysAhead: 7, reminderMinutes: 15 }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  workingHours: { start: '08:00', end: '18:00' },
  slotDurationMinutes: 30,
  daysAhead: 7,
  reminderMinutes: 15,
};

/** Resolve config path — ~/.openclaw/gcal-config.json */
function configPath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.openclaw', 'gcal-config.json');
}

function read() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so missing fields are always present
    return { ...DEFAULTS, ...parsed, workingHours: { ...DEFAULTS.workingHours, ...(parsed.workingHours || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(cfg) {
  const merged = { ...DEFAULTS, ...cfg, workingHours: { ...DEFAULTS.workingHours, ...(cfg.workingHours || {}) } };
  const filePath = configPath();
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

module.exports = { read, write, DEFAULTS };
