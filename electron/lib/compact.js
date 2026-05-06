'use strict';

// Session compaction — stubs so main.js can require this module.
// Auto-compaction is disabled in this build (compactAllSessions etc. are no-ops).
// The feature can be re-enabled by restoring lib/compact.js with a full implementation.

function noop(...args) { /* noop */ }
function promiseNoop(...args) { return Promise.resolve(); }

/** Compact all agent sessions above size threshold. */
async function compactAllSessions(options) {
  // Stub: auto-compaction disabled in this build
  return { compacted: 0, errors: [] };
}

/** Compact a single session file. */
async function compactSession(sessionPath, options) {
  return { path: sessionPath, compacted: false, originalSize: 0, newSize: 0 };
}

/** Get storage stats for all sessions. */
function getAllSessionStats(sessionsDir) {
  return { totalSessions: 0, totalSizeBytes: 0, oldestAt: null, newestAt: null };
}

/** Parse --compact CLI flag from agent startup args. */
function parseCompactCommand(args) {
  return null; // no compact command in this build
}

/** Register a callback to run before every LLM call. */
function setAutoCompactTrigger(fn) {
  // Stub: trigger disabled
}

let _autoCompactThreshold = 512 * 1024; // 512 KB default
let _autoCompactIntervalMs = 10 * 60 * 1000; // 10 min default

/** Auto-compact a session if it exceeds the threshold. */
async function autoCompactIfNeeded(sessionPath) {
  // Stub: disabled
}

module.exports = {
  compactAllSessions,
  compactSession,
  getAllSessionStats,
  parseCompactCommand,
  setAutoCompactTrigger,
  autoCompactIfNeeded,
};
