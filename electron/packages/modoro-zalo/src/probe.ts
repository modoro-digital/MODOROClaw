import { runOpenzcaCommand } from "./openzca.js";
import type { ModoroZaloProbe, ResolvedModoroZaloAccount } from "./types.js";

const PROBE_CACHE_TTL_MS = 15_000;
const MAX_PROBE_CACHE_SIZE = 64;

type ProbeCacheEntry = {
  probe: ModoroZaloProbe;
  expiresAt: number;
};

const probeCache = new Map<string, ProbeCacheEntry>();

function toErrorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function buildProbeCacheKey(account: ResolvedModoroZaloAccount): string {
  return [account.accountId.trim(), account.profile.trim(), account.zcaBinary.trim()].join("|");
}

function clearCachedProbeByPrefix(prefix: string): void {
  for (const key of probeCache.keys()) {
    if (key.startsWith(prefix)) {
      probeCache.delete(key);
    }
  }
}

function readCachedProbe(key: string, now: number): ModoroZaloProbe | null {
  const cached = probeCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= now) {
    probeCache.delete(key);
    return null;
  }
  return cached.probe;
}

function writeCachedProbe(key: string, probe: ModoroZaloProbe, now: number, ttlMs: number): void {
  probeCache.set(key, {
    probe,
    expiresAt: now + ttlMs,
  });
  if (probeCache.size > MAX_PROBE_CACHE_SIZE) {
    const oldest = probeCache.keys().next().value;
    if (oldest) {
      probeCache.delete(oldest);
    }
  }
}

export function clearModoroZaloProbeCache(): void {
  probeCache.clear();
}

export function clearModoroZaloProbeCacheForAccount(accountId: string): void {
  const normalized = accountId.trim();
  if (!normalized) {
    return;
  }
  clearCachedProbeByPrefix(`${normalized}|`);
}

export async function probeModoroZaloAuth(params: {
  account: ResolvedModoroZaloAccount;
  timeoutMs?: number;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
  deps?: {
    now?: () => number;
    runCommand?: typeof runOpenzcaCommand;
  };
}): Promise<ModoroZaloProbe> {
  const { account, timeoutMs, forceRefresh, cacheTtlMs, deps } = params;
  const now = deps?.now ?? Date.now;
  const runCommand = deps?.runCommand ?? runOpenzcaCommand;
  const ttlMs = Math.max(0, cacheTtlMs ?? PROBE_CACHE_TTL_MS);
  const base: ModoroZaloProbe = {
    ok: false,
    profile: account.profile,
    binary: account.zcaBinary,
  };
  const cacheKey = buildProbeCacheKey(account);
  if (!forceRefresh && ttlMs > 0) {
    const cached = readCachedProbe(cacheKey, now());
    if (cached) {
      return cached;
    }
  }

  try {
    await runCommand({
      binary: account.zcaBinary,
      profile: account.profile,
      args: ["auth", "status"],
      timeoutMs: timeoutMs ?? 8_000,
    });
    const probe: ModoroZaloProbe = {
      ...base,
      ok: true,
    };
    if (ttlMs > 0) {
      writeCachedProbe(cacheKey, probe, now(), ttlMs);
    }
    return probe;
  } catch (err) {
    const probe: ModoroZaloProbe = {
      ...base,
      error: toErrorText(err),
    };
    if (ttlMs > 0) {
      writeCachedProbe(cacheKey, probe, now(), ttlMs);
    }
    return probe;
  }
}
