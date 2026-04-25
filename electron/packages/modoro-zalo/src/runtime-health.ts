import { clearModoroZaloProbeCacheForAccount } from "./probe.js";

export type ModoroZaloRuntimeHealthState = {
  connected?: boolean | null;
  reconnectAttempts?: number | null;
  lastConnectedAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

type ModoroZaloReconnectHandler = (reason: string) => void;

const runtimeHealthByAccount = new Map<string, ModoroZaloRuntimeHealthState>();
const reconnectHandlers = new Map<string, Set<ModoroZaloReconnectHandler>>();

function normalizeAccountId(accountId: string): string {
  return accountId.trim();
}

export function clearModoroZaloRuntimeHealthState(accountId?: string): void {
  const normalized = accountId ? normalizeAccountId(accountId) : "";
  if (!normalized) {
    runtimeHealthByAccount.clear();
    reconnectHandlers.clear();
    return;
  }
  runtimeHealthByAccount.delete(normalized);
  reconnectHandlers.delete(normalized);
}

export function getModoroZaloRuntimeHealthState(
  accountId: string,
): ModoroZaloRuntimeHealthState | undefined {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return undefined;
  }
  const state = runtimeHealthByAccount.get(normalized);
  return state ? { ...state } : undefined;
}

export function patchModoroZaloRuntimeHealthState(
  accountId: string,
  patch: ModoroZaloRuntimeHealthState,
): ModoroZaloRuntimeHealthState | undefined {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return undefined;
  }
  const current = runtimeHealthByAccount.get(normalized) ?? {};
  const next = {
    ...current,
    ...patch,
  };
  runtimeHealthByAccount.set(normalized, next);
  return { ...next };
}

export function recordModoroZaloStreamActivity(accountId: string, at = Date.now()): void {
  patchModoroZaloRuntimeHealthState(accountId, {
    lastEventAt: at,
  });
}

export function markModoroZaloConnected(params: {
  accountId: string;
  at?: number;
  reconnectAttempts?: number | null;
}): void {
  const at = params.at ?? Date.now();
  clearModoroZaloProbeCacheForAccount(params.accountId);
  patchModoroZaloRuntimeHealthState(params.accountId, {
    connected: true,
    reconnectAttempts: params.reconnectAttempts ?? 0,
    lastConnectedAt: at,
    lastEventAt: at,
    lastError: null,
  });
}

export function markModoroZaloDisconnected(params: {
  accountId: string;
  reason?: string | null;
  reconnectAttempts?: number | null;
}): void {
  patchModoroZaloRuntimeHealthState(params.accountId, {
    connected: false,
    reconnectAttempts: params.reconnectAttempts,
    ...(params.reason !== undefined ? { lastError: params.reason } : {}),
  });
}

export function registerModoroZaloReconnectHandler(
  accountId: string,
  handler: ModoroZaloReconnectHandler,
): () => void {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return () => {};
  }
  const handlers = reconnectHandlers.get(normalized) ?? new Set<ModoroZaloReconnectHandler>();
  handlers.add(handler);
  reconnectHandlers.set(normalized, handlers);
  return () => {
    const current = reconnectHandlers.get(normalized);
    if (!current) {
      return;
    }
    current.delete(handler);
    if (current.size === 0) {
      reconnectHandlers.delete(normalized);
    }
  };
}

export function requestModoroZaloReconnect(params: { accountId: string; reason: string }): boolean {
  const normalized = normalizeAccountId(params.accountId);
  if (!normalized) {
    return false;
  }
  clearModoroZaloProbeCacheForAccount(normalized);
  markModoroZaloDisconnected({
    accountId: normalized,
    reason: params.reason,
  });
  const handlers = reconnectHandlers.get(normalized);
  if (!handlers || handlers.size === 0) {
    return false;
  }
  for (const handler of handlers) {
    try {
      handler(params.reason);
    } catch {
      // Ignore reconnect hook failures; the caller already has the original error.
    }
  }
  return true;
}
