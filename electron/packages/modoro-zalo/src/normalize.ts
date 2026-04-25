export function stripModoroZaloPrefix(value: string): string {
  return value
    .trim()
    .replace(/^(modoro-zalo|openzalo|ozl|zlu):/i, "")
    .trim();
}

export function normalizeModoroZaloId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeModoroZaloAllowEntry(raw: string): string {
  return stripModoroZaloPrefix(raw).toLowerCase();
}

export function normalizeModoroZaloMessagingTarget(input: string): string {
  const stripped = stripModoroZaloPrefix(input).replace(/^thread:/i, "").trim();
  if (!stripped) {
    return "";
  }

  const aliasMatch = stripped.match(/^([gu])-(.+)$/i);
  if (aliasMatch) {
    const kind = aliasMatch[1]?.toLowerCase() === "g" ? "group" : "user";
    const id = aliasMatch[2]?.trim() ?? "";
    return id ? `${kind}:${id}` : "";
  }

  if (/^g:/i.test(stripped)) {
    const id = stripped.replace(/^g:/i, "").trim();
    return id ? `group:${id}` : "";
  }
  if (/^(u:|dm:)/i.test(stripped)) {
    const id = stripped.replace(/^(u:|dm:)/i, "").trim();
    return id ? `user:${id}` : "";
  }

  const lowered = stripped.toLowerCase();
  if (lowered.startsWith("group:") || lowered.startsWith("user:")) {
    const id = stripped.replace(/^(group:|user:)/i, "").trim();
    if (!id) {
      return "";
    }
    return lowered.startsWith("group:") ? `group:${id}` : `user:${id}`;
  }

  const labeledIdMatch = stripped.match(/\((\d{3,})\)\s*$/);
  if (labeledIdMatch?.[1]) {
    return labeledIdMatch[1];
  }

  return stripped;
}

export function looksLikeModoroZaloTargetId(value: string): boolean {
  return normalizeModoroZaloMessagingTarget(value).length > 0;
}

export function parseModoroZaloTarget(raw: string): {
  threadId: string;
  isGroup: boolean;
} {
  const normalized = normalizeModoroZaloMessagingTarget(raw);
  if (!normalized) {
    throw new Error("Modoro Zalo target is required");
  }

  if (/^group:/i.test(normalized)) {
    const threadId = normalized.replace(/^group:/i, "").trim();
    if (!threadId) {
      throw new Error("Modoro Zalo group target is missing group id");
    }
    return { threadId, isGroup: true };
  }

  if (/^(dm|user):/i.test(normalized)) {
    const threadId = normalized.replace(/^(dm|user):/i, "").trim();
    if (!threadId) {
      throw new Error("Modoro Zalo user target is missing user id");
    }
    return { threadId, isGroup: false };
  }

  return {
    threadId: normalized,
    isGroup: false,
  };
}

function stripDirectTargetPrefix(value: string): string {
  return value.replace(/^(dm|user):/i, "").trim();
}

function stripGroupTargetPrefix(value: string): string {
  return value.replace(/^group:/i, "").trim();
}

export function resolveModoroZaloDirectPeerId(params: {
  dmPeerId?: string | null;
  senderId?: string | null;
  toId?: string | null;
  threadId?: string | null;
}): string {
  const candidates = [params.dmPeerId, params.senderId, params.toId, params.threadId];
  let groupAliasFallback = "";

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const normalized = normalizeModoroZaloMessagingTarget(candidate);
    if (!normalized) {
      continue;
    }

    if (/^group:/i.test(normalized)) {
      if (!groupAliasFallback) {
        groupAliasFallback = stripGroupTargetPrefix(normalized);
      }
      continue;
    }

    if (/^(dm|user):/i.test(normalized)) {
      const direct = stripDirectTargetPrefix(normalized);
      if (direct) {
        return direct;
      }
      continue;
    }

    return normalized;
  }

  if (groupAliasFallback) {
    return groupAliasFallback;
  }
  return "";
}

export function formatModoroZaloOutboundTarget(params: { threadId: string; isGroup: boolean }): string {
  return params.isGroup ? `group:${params.threadId}` : `user:${params.threadId}`;
}
