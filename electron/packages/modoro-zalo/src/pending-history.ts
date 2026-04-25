export const MODORO_ZALO_HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
export const MODORO_ZALO_CURRENT_MESSAGE_MARKER = "[Current message]";

export const DEFAULT_MODORO_ZALO_PENDING_GROUP_HISTORY_LIMIT = 10;
export const DEFAULT_MODORO_ZALO_PENDING_GROUP_HISTORY_TTL_MS = 10 * 60 * 1000;
const MAX_MODORO_ZALO_PENDING_GROUP_HISTORY_KEYS = 1000;

export type ModoroZaloPendingGroupHistoryEntry = {
  sender: string;
  body: string;
  timestamp: number;
  messageId?: string;
  mediaPaths: string[];
  mediaUrls: string[];
  mediaTypes: string[];
};

const pendingGroupHistories = new Map<string, ModoroZaloPendingGroupHistoryEntry[]>();

function evictOldHistoryKeys(maxKeys = MAX_MODORO_ZALO_PENDING_GROUP_HISTORY_KEYS): void {
  if (pendingGroupHistories.size <= maxKeys) {
    return;
  }
  const keysToDelete = pendingGroupHistories.size - maxKeys;
  const iterator = pendingGroupHistories.keys();
  for (let index = 0; index < keysToDelete; index += 1) {
    const key = iterator.next().value;
    if (typeof key === "string" && key) {
      pendingGroupHistories.delete(key);
    }
  }
}

function pruneExpiredEntries(params?: { nowMs?: number; ttlMs?: number }): void {
  const nowMs = params?.nowMs ?? Date.now();
  const ttlMs = params?.ttlMs ?? DEFAULT_MODORO_ZALO_PENDING_GROUP_HISTORY_TTL_MS;
  if (ttlMs <= 0) {
    pendingGroupHistories.clear();
    return;
  }

  for (const [historyKey, entries] of pendingGroupHistories.entries()) {
    const freshEntries = entries.filter((entry) => {
      if (!Number.isFinite(entry.timestamp)) {
        return true;
      }
      return nowMs - entry.timestamp <= ttlMs;
    });
    if (freshEntries.length === 0) {
      pendingGroupHistories.delete(historyKey);
      continue;
    }
    if (freshEntries.length !== entries.length) {
      pendingGroupHistories.set(historyKey, freshEntries);
    }
  }
}

export function buildModoroZaloPendingGroupHistoryKey(params: {
  accountId: string;
  threadId: string;
}): string {
  return `${params.accountId}:${params.threadId}`;
}

export function appendModoroZaloPendingGroupHistoryEntry(params: {
  historyKey: string;
  entry: ModoroZaloPendingGroupHistoryEntry;
  limit: number;
  nowMs?: number;
  ttlMs?: number;
}): ModoroZaloPendingGroupHistoryEntry[] {
  pruneExpiredEntries({ nowMs: params.nowMs, ttlMs: params.ttlMs });
  if (params.limit <= 0) {
    return [];
  }

  const history = pendingGroupHistories.get(params.historyKey) ?? [];
  history.push(params.entry);
  while (history.length > params.limit) {
    history.shift();
  }
  if (pendingGroupHistories.has(params.historyKey)) {
    pendingGroupHistories.delete(params.historyKey);
  }
  pendingGroupHistories.set(params.historyKey, history);
  evictOldHistoryKeys();
  return history.slice();
}

export function readModoroZaloPendingGroupHistoryEntries(params: {
  historyKey: string;
  nowMs?: number;
  ttlMs?: number;
}): ModoroZaloPendingGroupHistoryEntry[] {
  pruneExpiredEntries({ nowMs: params.nowMs, ttlMs: params.ttlMs });
  return (pendingGroupHistories.get(params.historyKey) ?? []).slice();
}

export function clearModoroZaloPendingGroupHistory(historyKey: string): void {
  pendingGroupHistories.delete(historyKey);
}

export function buildModoroZaloPendingHistoryContext(params: {
  entries: ModoroZaloPendingGroupHistoryEntry[];
  currentMessage: string;
  formatEntry: (entry: ModoroZaloPendingGroupHistoryEntry) => string;
  lineBreak?: string;
}): string {
  if (params.entries.length === 0) {
    return params.currentMessage;
  }
  const lineBreak = params.lineBreak ?? "\n";
  const historyText = params.entries.map(params.formatEntry).join(lineBreak);
  return [
    MODORO_ZALO_HISTORY_CONTEXT_MARKER,
    historyText,
    "",
    MODORO_ZALO_CURRENT_MESSAGE_MARKER,
    params.currentMessage,
  ].join(lineBreak);
}

export function resetModoroZaloPendingGroupHistoryForTests(): void {
  pendingGroupHistories.clear();
}
