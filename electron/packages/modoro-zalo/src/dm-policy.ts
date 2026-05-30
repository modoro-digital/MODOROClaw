import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type DmPolicyOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  profile?: string;
  workspaceDirs?: readonly string[];
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function resolveZaloWorkspaceDirs(options: DmPolicyOptions = {}): string[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const dirs: string[] = [];

  if (env["9BIZ_WORKSPACE"]) dirs.push(env["9BIZ_WORKSPACE"]);
  if (env.MODORO_WORKSPACE) dirs.push(env.MODORO_WORKSPACE);

  if (platform === "darwin") {
    dirs.push(path.join(homeDir, "Library", "Application Support", "9bizclaw"));
  } else if (platform === "win32") {
    const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");
    dirs.push(path.join(appData, "9bizclaw"));
  } else {
    const configDir = env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
    dirs.push(path.join(configDir, "9bizclaw"));
  }

  dirs.push(path.join(homeDir, ".openclaw", "workspace"));
  return uniqueStrings(dirs);
}

export function readZaloStrangerPolicy(options: DmPolicyOptions = {}): string {
  const dirs = options.workspaceDirs ? [...options.workspaceDirs] : resolveZaloWorkspaceDirs(options);

  for (const dir of dirs) {
    try {
      const policyPath = path.join(dir, "zalo-stranger-policy.json");
      if (!fs.existsSync(policyPath)) continue;
      const raw = readJsonFile(policyPath);
      if (!raw || typeof raw !== "object") continue;
      const mode = String((raw as { mode?: unknown; policy?: unknown }).mode ?? (raw as { policy?: unknown }).policy ?? "").trim();
      if (mode) return mode;
    } catch {
      continue;
    }
  }

  return "ignore";
}

export function isKnownZaloNonFriend(userId: string, options: DmPolicyOptions = {}): boolean {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return false;

  const homeDir = options.homeDir ?? os.homedir();
  const profile = options.profile || "default";
  const friendsPath = path.join(homeDir, ".openzca", "profiles", profile, "cache", "friends.json");

  try {
    if (!fs.existsSync(friendsPath)) return false;
    const friends = readJsonFile(friendsPath);
    if (!Array.isArray(friends) || friends.length === 0) return false;

    return !friends.some((friend: any) => {
      const ids = [friend?.userId, friend?.uid, friend?.id, friend?.userKey]
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      return ids.includes(normalizedUserId);
    });
  } catch {
    return false;
  }
}

export function shouldBypassZaloDmAllowlistForStranger(userId: string, options: DmPolicyOptions = {}): boolean {
  if (!isKnownZaloNonFriend(userId, options)) return false;
  const policy = readZaloStrangerPolicy(options);
  return policy === "reply" || policy === "greet-only";
}
