import { normalizeModoroZaloId } from "./normalize.js";
import { runOpenzcaAccountJson } from "./openzca-account.js";
import type { ResolvedModoroZaloAccount } from "./types.js";

type MeInfo = {
  userId?: string | number;
  displayName?: string;
};

type FriendRow = {
  userId?: string | number;
  displayName?: string;
  username?: string;
  phone?: string;
};

type GroupRow = {
  groupId?: string | number;
  name?: string;
  totalMember?: number;
  type?: string;
};

export async function listModoroZaloDirectorySelf(params: {
  account: ResolvedModoroZaloAccount;
}): Promise<{ kind: "user"; id: string; name?: string; raw?: unknown } | null> {
  const { account } = params;
  const me = await runOpenzcaAccountJson<MeInfo>({
    account,
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["me", "info", "--json"],
    timeoutMs: 10_000,
  });

  const id = normalizeModoroZaloId(me?.userId);
  if (!id) {
    return null;
  }

  return {
    kind: "user",
    id,
    name: me?.displayName?.trim() || undefined,
    raw: me,
  };
}

export async function listModoroZaloDirectoryPeers(params: {
  account: ResolvedModoroZaloAccount;
  query?: string;
  limit?: number;
}): Promise<Array<{ kind: "user"; id: string; name?: string; raw?: unknown }>> {
  const { account, query, limit } = params;
  const rows = await runOpenzcaAccountJson<FriendRow[]>({
    account,
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["friend", "list", "--json"],
    timeoutMs: 20_000,
  });

  const q = query?.trim().toLowerCase() ?? "";
  const max = typeof limit === "number" && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const out: Array<{ kind: "user"; id: string; name?: string; raw?: unknown }> = [];

  for (const row of rows ?? []) {
    const id = normalizeModoroZaloId(row?.userId);
    if (!id) {
      continue;
    }
    const name = row?.displayName?.trim() || row?.username?.trim() || undefined;
    const haystack = [id, name, row?.phone].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }
    out.push({
      kind: "user",
      id,
      name,
      raw: row,
    });
    if (out.length >= max) {
      break;
    }
  }

  return out;
}

export async function listModoroZaloDirectoryGroups(params: {
  account: ResolvedModoroZaloAccount;
  query?: string;
  limit?: number;
}): Promise<Array<{ kind: "group"; id: string; name?: string; raw?: unknown }>> {
  const { account, query, limit } = params;
  const rows = await runOpenzcaAccountJson<GroupRow[]>({
    account,
    binary: account.zcaBinary,
    profile: account.profile,
    args: ["group", "list", "--json"],
    timeoutMs: 20_000,
  });

  const q = query?.trim().toLowerCase() ?? "";
  const max = typeof limit === "number" && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const out: Array<{ kind: "group"; id: string; name?: string; raw?: unknown }> = [];

  for (const row of rows ?? []) {
    const id = normalizeModoroZaloId(row?.groupId);
    if (!id) {
      continue;
    }
    const name = row?.name?.trim() || undefined;
    const haystack = [id, name].filter(Boolean).join(" ").toLowerCase();
    if (q && !haystack.includes(q)) {
      continue;
    }
    out.push({
      kind: "group",
      id,
      name,
      raw: row,
    });
    if (out.length >= max) {
      break;
    }
  }

  return out;
}
