import { createHash } from "node:crypto";

const MODORO_ZALO_OUTBOUND_RECENT_TTL_MS = 15_000;
const MAX_MODORO_ZALO_OUTBOUND_RECENT_SIGNATURES = 5_000;

type ModoroZaloOutboundDedupeEntry = {
  ticketId: number;
  signature: string;
  createdAt: number;
};

export type ModoroZaloOutboundDedupeTicket = {
  id: number;
  signature: string;
};

export type AcquireModoroZaloOutboundDedupeResult =
  | {
      acquired: true;
      ticket: ModoroZaloOutboundDedupeTicket;
    }
  | {
      acquired: false;
      reason: "inflight" | "recent";
    };

const inflightBySignature = new Map<string, ModoroZaloOutboundDedupeEntry>();
const inflightByTicket = new Map<number, ModoroZaloOutboundDedupeEntry>();
const recentBySignature = new Map<string, number>();
let nextTicketId = 0;

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "").trim();
}

function buildSignature(params: {
  accountId: string;
  sessionKey?: string;
  target: string;
  kind: "text" | "media";
  text?: string;
  mediaRef?: string;
  sequence?: number;
  idempotencyContext?: string;
}): string {
  const accountId = normalizeIdentity(params.accountId);
  const sessionKey = normalizeIdentity(params.sessionKey) || "-";
  const target = normalizeIdentity(params.target);
  const idempotencyContext = normalizeIdentity(params.idempotencyContext) || "-";
  const sequence =
    Number.isFinite(params.sequence) && typeof params.sequence === "number"
      ? String(Math.max(1, Math.floor(params.sequence)))
      : "1";

  const hash = createHash("sha256");
  hash.update(accountId, "utf8");
  hash.update("\u001f", "utf8");
  hash.update(sessionKey, "utf8");
  hash.update("\u001f", "utf8");
  hash.update(target, "utf8");
  hash.update("\u001f", "utf8");
  hash.update(params.kind, "utf8");
  hash.update("\u001f", "utf8");
  hash.update(idempotencyContext, "utf8");
  hash.update("\u001f", "utf8");
  hash.update(sequence, "utf8");
  hash.update("\u001f", "utf8");
  hash.update(params.text ?? "", "utf8");
  hash.update("\u001f", "utf8");
  hash.update(params.mediaRef ?? "", "utf8");
  return hash.digest("hex");
}

function evictRecentOverflow(): void {
  while (recentBySignature.size > MAX_MODORO_ZALO_OUTBOUND_RECENT_SIGNATURES) {
    const oldest = recentBySignature.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    recentBySignature.delete(oldest);
  }
}

function pruneExpired(nowMs = Date.now()): void {
  for (const [signature, expiresAt] of recentBySignature.entries()) {
    if (expiresAt <= nowMs) {
      recentBySignature.delete(signature);
    }
  }

  // Safety net for leaked inflight entries if a process crashes mid-send.
  const staleCutoff = nowMs - MODORO_ZALO_OUTBOUND_RECENT_TTL_MS * 4;
  for (const [signature, entry] of inflightBySignature.entries()) {
    if (entry.createdAt < staleCutoff) {
      inflightBySignature.delete(signature);
      inflightByTicket.delete(entry.ticketId);
    }
  }
}

export function acquireModoroZaloOutboundDedupeSlot(
  params: {
    accountId: string;
    sessionKey?: string;
    target: string;
    kind: "text" | "media";
    text?: string;
    mediaRef?: string;
    sequence?: number;
    idempotencyContext?: string;
  },
  nowMs = Date.now(),
): AcquireModoroZaloOutboundDedupeResult {
  pruneExpired(nowMs);
  const signature = buildSignature(params);

  const recentUntil = recentBySignature.get(signature);
  if (typeof recentUntil === "number" && recentUntil > nowMs) {
    return { acquired: false, reason: "recent" };
  }

  if (inflightBySignature.has(signature)) {
    return { acquired: false, reason: "inflight" };
  }

  nextTicketId += 1;
  const entry: ModoroZaloOutboundDedupeEntry = {
    ticketId: nextTicketId,
    signature,
    createdAt: nowMs,
  };
  inflightBySignature.set(signature, entry);
  inflightByTicket.set(entry.ticketId, entry);
  return {
    acquired: true,
    ticket: {
      id: entry.ticketId,
      signature,
    },
  };
}

export function releaseModoroZaloOutboundDedupeSlot(params: {
  ticket: ModoroZaloOutboundDedupeTicket;
  sent: boolean;
  nowMs?: number;
}): void {
  const nowMs = params.nowMs ?? Date.now();
  const entry = inflightByTicket.get(params.ticket.id);
  if (!entry || entry.signature !== params.ticket.signature) {
    return;
  }
  inflightByTicket.delete(entry.ticketId);
  inflightBySignature.delete(entry.signature);
  if (params.sent) {
    recentBySignature.set(entry.signature, nowMs + MODORO_ZALO_OUTBOUND_RECENT_TTL_MS);
    evictRecentOverflow();
  }
}

export function resetModoroZaloOutboundDedupeForTests(): void {
  inflightBySignature.clear();
  inflightByTicket.clear();
  recentBySignature.clear();
  nextTicketId = 0;
}
