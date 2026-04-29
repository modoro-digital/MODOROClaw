'use strict';

function entryToZaloId(entry) {
  if (entry && typeof entry === 'object') {
    return entry.userId ?? entry.uid ?? entry.id ?? entry.userKey;
  }
  return entry;
}

function normalizeZaloBlocklist(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    const id = String(entryToZaloId(entry) ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function resolveZaloBlocklistSave({ existingBlocklist, incomingBlocklist, userBlocklistTouched }) {
  const existing = normalizeZaloBlocklist(existingBlocklist);
  if (!Array.isArray(incomingBlocklist)) {
    return { blocklist: existing, shouldWrite: false, preservedExisting: false };
  }

  const incoming = normalizeZaloBlocklist(incomingBlocklist);
  if (existing.length > 0 && incoming.length === 0 && userBlocklistTouched !== true) {
    return { blocklist: existing, shouldWrite: false, preservedExisting: true };
  }

  return {
    blocklist: incoming,
    shouldWrite: !sameArray(existing, incoming),
    preservedExisting: false,
  };
}

module.exports = {
  normalizeZaloBlocklist,
  resolveZaloBlocklistSave,
};
