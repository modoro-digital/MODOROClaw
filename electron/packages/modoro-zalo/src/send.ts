import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseModoroZaloTarget } from "./normalize.js";
import { runOpenzcaAccountCommand } from "./openzca-account.js";
import { getModoroZaloRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedModoroZaloAccount } from "./types.js";
import { parseOpenzcaMessageRefs } from "./message-refs.js";

type SendTextOptions = {
  cfg: CoreConfig;
  account: ResolvedModoroZaloAccount;
  to: string;
  text: string;
};

type SendMediaOptions = {
  cfg: CoreConfig;
  account: ResolvedModoroZaloAccount;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaPath?: string;
  mediaLocalRoots?: readonly string[];
};

type SendTypingOptions = {
  account: ResolvedModoroZaloAccount;
  to: string;
};

export type ModoroZaloSendReceipt = {
  messageId: string;
  msgId?: string;
  cliMsgId?: string;
  kind: "text" | "media";
  textPreview?: string;
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function stripMediaPrefix(value: string): string {
  return value.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

function expandHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return path.resolve(expandHomePath(override));
  }
  return path.join(os.homedir(), ".openclaw");
}

type ResolvedMediaRoot = {
  resolvedPath: string;
  realPath: string;
};

function resolveConfiguredRootPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty mediaLocalRoots entry is not allowed");
  }

  if (trimmed.startsWith("file://")) {
    let parsed: string;
    try {
      parsed = fileURLToPath(trimmed);
    } catch {
      throw new Error(`Invalid file:// URL in mediaLocalRoots: ${input}`);
    }
    if (!path.isAbsolute(parsed)) {
      throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
    }
    return path.resolve(parsed);
  }

  const expanded = expandHomePath(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`mediaLocalRoots entries must be absolute paths: ${input}`);
  }
  return path.resolve(expanded);
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  const rootWithSep = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;
  if (process.platform === "win32") {
    const candidateLower = normalizedCandidate.toLowerCase();
    const rootLower = normalizedRoot.toLowerCase();
    const rootWithSepLower = rootWithSep.toLowerCase();
    return candidateLower === rootLower || candidateLower.startsWith(rootWithSepLower);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSep);
}

async function resolveMediaRoots(localRoots?: readonly string[]): Promise<ResolvedMediaRoot[]> {
  const stateDir = resolveStateDir();
  const roots = [
    ...(localRoots ?? []),
    path.join(stateDir, "workspace"),
    path.join(stateDir, "media"),
    path.join(stateDir, "agents"),
    path.join(stateDir, "sandboxes"),
  ];

  const deduped = new Set<string>();
  const resolved: ResolvedMediaRoot[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const resolvedPath = resolveConfiguredRootPath(trimmed);
    if (deduped.has(resolvedPath)) {
      continue;
    }
    deduped.add(resolvedPath);
    let realPath = resolvedPath;
    try {
      realPath = await fs.realpath(resolvedPath);
    } catch {
      // Keep unresolved root for future directories that may not exist yet.
    }
    resolved.push({
      resolvedPath,
      realPath: path.resolve(realPath),
    });
  }
  return resolved;
}

function normalizeLocalSourcePath(source: string): string {
  const stripped = stripMediaPrefix(source);
  if (/^file:\/\//i.test(stripped)) {
    try {
      return fileURLToPath(stripped);
    } catch {
      return stripped;
    }
  }
  return expandHomePath(stripped);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveAllowedLocalFile(params: {
  candidate: string;
  roots: ResolvedMediaRoot[];
}): Promise<string | null> {
  const resolvedCandidate = path.resolve(params.candidate);

  for (const root of params.roots) {
    const relativeToRoot = path.relative(root.resolvedPath, resolvedCandidate);
    if (
      !relativeToRoot ||
      relativeToRoot.startsWith("..") ||
      path.isAbsolute(relativeToRoot)
    ) {
      continue;
    }

    const candidateFromRealRoot = path.resolve(root.realPath, relativeToRoot);
    if (!isPathInsideRoot(candidateFromRealRoot, root.realPath)) {
      continue;
    }

    try {
      const realPath = await fs.realpath(candidateFromRealRoot);
      if (!isPathInsideRoot(realPath, root.realPath)) {
        continue;
      }
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) {
        continue;
      }
      return realPath;
    } catch {
      continue;
    }
  }

  return null;
}

async function resolveMediaSource(params: {
  source: string;
  mediaLocalRoots?: readonly string[];
}): Promise<{ source: string; sourceType: "url" | "path" }> {
  const normalized = stripMediaPrefix(params.source);
  if (!normalized) {
    return { source: "", sourceType: "path" };
  }
  if (isHttpUrl(normalized)) {
    return { source: normalized, sourceType: "url" };
  }

  const local = normalizeLocalSourcePath(normalized);
  const roots = await resolveMediaRoots(params.mediaLocalRoots);
  const candidates: string[] = [];
  if (path.isAbsolute(local)) {
    candidates.push(path.resolve(local));
  } else {
    const relative = local.replace(/^\.[/\\]+/, "");
    candidates.push(path.resolve(local));
    for (const root of roots) {
      candidates.push(path.resolve(root.resolvedPath, local));
      if (relative && relative !== local) {
        candidates.push(path.resolve(root.resolvedPath, relative));
      }
    }
  }

  const seen = new Set<string>();
  const attempted: string[] = [];
  const blocked: string[] = [];
  for (const candidate of candidates) {
    const normalizedCandidate = path.resolve(candidate);
    if (seen.has(normalizedCandidate)) {
      continue;
    }
    seen.add(normalizedCandidate);
    attempted.push(normalizedCandidate);
    if (!(await fileExists(normalizedCandidate))) {
      continue;
    }

    const allowedPath = await resolveAllowedLocalFile({
      candidate: normalizedCandidate,
      roots,
    });
    if (allowedPath) {
      return { source: allowedPath, sourceType: "path" };
    }
    blocked.push(normalizedCandidate);
  }

  if (blocked.length > 0) {
    throw new Error(
      "Modoro Zalo local media path is outside allowed roots. " +
        `Source="${params.source}" Existing candidates: ${blocked.slice(0, 4).join(" | ")}. ` +
        'Set "channels.modoro-zalo.mediaLocalRoots" (or per-account mediaLocalRoots) to allow more paths.',
    );
  }

  throw new Error(
    `Modoro Zalo media file not found for source "${params.source}". Tried: ${attempted.slice(0, 8).join(" | ")}`,
  );
}

type MediaCommand = "upload" | "image" | "video" | "voice";

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "heic",
  "heif",
  "avif",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "webm", "mkv"]);
const AUDIO_EXTENSIONS = new Set(["aac", "mp3", "m4a", "wav", "ogg", "opus", "flac"]);

function extractFileExtension(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const fileName = withoutQuery.split("/").pop() ?? withoutQuery;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return "";
  }
  return fileName.slice(dot + 1).toLowerCase();
}

function resolveMediaCommand(source: string): MediaCommand {
  const ext = extractFileExtension(source);
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "voice";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  return "upload";
}

function buildOpenzcaMediaArgs(params: {
  target: { threadId: string; isGroup: boolean };
  source: string;
  mediaCommand: MediaCommand;
  message?: string;
}): string[] {
  const { target, source, mediaCommand } = params;
  const args = ["msg", mediaCommand];
  if (mediaCommand === "upload") {
    if (isHttpUrl(source)) {
      args.push(target.threadId, "--url", source);
    } else {
      args.push(source, target.threadId);
    }
  } else {
    args.push(target.threadId);
    if (isHttpUrl(source)) {
      args.push("--url", source);
    } else {
      args.push(source);
    }
    const caption = params.message?.trim();
    if (mediaCommand === "video" && caption) {
      args.push("--message", caption);
    }
  }
  if (target.isGroup) {
    args.push("--group");
  }
  return args;
}

function logOutbound(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): void {
  try {
    const logger = getModoroZaloRuntime().logging.getChildLogger({ subsystem: "modoro-zalo/outbound" });
    logger[level]?.(message, meta);
  } catch {
    // Runtime may be unavailable during early boot/tests; ignore.
  }
}

export async function sendTextModoroZalo(options: SendTextOptions): Promise<ModoroZaloSendReceipt> {
  const { account, to, text } = options;
  const target = parseModoroZaloTarget(to);
  // === 9BizClaw GROUP-DETECT PATCH ===
  // message tool may send target without "group:" prefix, causing
  // parseModoroZaloTarget to return isGroup=false for actual groups.
  // Look up openzca groups.json to correct this.
  if (!target.isGroup && target.threadId) {
    try {
      const __gdFs = require("node:fs");
      const __gdPath = require("node:path");
      const __gdHome = require("node:os").homedir();
      const __gdGroupsFile = __gdPath.join(__gdHome, ".openzca", "profiles", "default", "cache", "groups.json");
      if (__gdFs.existsSync(__gdGroupsFile)) {
        const __gdGroups = JSON.parse(__gdFs.readFileSync(__gdGroupsFile, "utf-8"));
        if (Array.isArray(__gdGroups) && __gdGroups.some((g: any) => String(g?.groupId) === target.threadId)) {
          (target as any).isGroup = true;
        }
      }
    } catch (__gdErr) { try { logOutbound("warn", "GROUP-DETECT lookup failed", { err: String(__gdErr) }); } catch {} }
  }
  // === END 9BizClaw GROUP-DETECT PATCH ===
  const body = text.trim();
  if (!body) {
    return { messageId: "empty", kind: "text" };
  }

  // === 9BizClaw OUTPUT-FILTER PATCH v6 ===
  // Scan outbound Zalo text for sensitive patterns + AI failure modes.
  // See main.js ensureZaloOutputFilterFix for v6 changelog vs v5.
  try {
    const __ofFs = require("node:fs");
    const __ofPath = require("node:path");
    const __ofOs = require("node:os");
    // Policy kill-switch: if Dashboard says Zalo is off/paused, this target
    // is blocklisted, or this group is outside the allowlist, abort RIGHT
    // BEFORE send. This catches in-flight replies generated before the CEO
    // flipped a switch and keeps customer-facing behavior fail-closed.
    try {
      const __ofHome = __ofOs.homedir();
      const __ofAppDir = "9bizclaw";
      const __ofWorkspaceDirs: string[] = [];
      if (process.env['9BIZ_WORKSPACE']) {
        __ofWorkspaceDirs.push(process.env['9BIZ_WORKSPACE']);
      }
      if (process.platform === "darwin") {
        __ofWorkspaceDirs.push(__ofPath.join(__ofHome, "Library", "Application Support", __ofAppDir));
      } else if (process.platform === "win32") {
        const __ofAppData = process.env.APPDATA || __ofPath.join(__ofHome, "AppData", "Roaming");
        __ofWorkspaceDirs.push(__ofPath.join(__ofAppData, __ofAppDir));
      } else {
        const __ofConfig = process.env.XDG_CONFIG_HOME || __ofPath.join(__ofHome, ".config");
        __ofWorkspaceDirs.push(__ofPath.join(__ofConfig, __ofAppDir));
      }
      __ofWorkspaceDirs.push(__ofPath.join(__ofHome, ".openclaw", "workspace"));
      const __ofPausePaths: string[] = [];
      const __ofBlocklistPaths: string[] = [];
      const __ofSeenWs = new Set<string>();
      for (const __ofWsDir of __ofWorkspaceDirs) {
        const __ofResolvedWs = __ofPath.resolve(__ofWsDir);
        if (__ofSeenWs.has(__ofResolvedWs)) continue;
        __ofSeenWs.add(__ofResolvedWs);
        __ofPausePaths.push(__ofPath.join(__ofResolvedWs, "zalo-paused.json"));
        __ofBlocklistPaths.push(__ofPath.join(__ofResolvedWs, "zalo-blocklist.json"));
      }
      const __ofConfigPaths = [
        __ofPath.join(__ofHome, ".openclaw", "openclaw.json"),
      ];
      let __ofTransportBlocked = false;
      let __ofBlockReason = "";
      for (const __ofPause of __ofPausePaths) {
        try {
          if (!__ofFs.existsSync(__ofPause)) continue;
          const __ofPauseData = JSON.parse(__ofFs.readFileSync(__ofPause, "utf-8"));
          if (__ofPauseData?.permanent) {
            __ofTransportBlocked = true;
            __ofBlockReason = "paused-permanent";
            break;
          }
          if (__ofPauseData?.pausedUntil && new Date(__ofPauseData.pausedUntil) > new Date()) {
            __ofTransportBlocked = true;
            __ofBlockReason = "paused";
            break;
          }
        } catch {
          __ofTransportBlocked = true;
          __ofBlockReason = "pause-parse-error";
          break;
        }
      }
      let __ofZaloCfg: any = null;
      if (!__ofTransportBlocked) {
        for (const __ofCfgPath of __ofConfigPaths) {
          try {
            if (!__ofFs.existsSync(__ofCfgPath)) continue;
            const __ofCfg = JSON.parse(__ofFs.readFileSync(__ofCfgPath, "utf-8"));
            __ofZaloCfg = __ofCfg?.channels?.["modoro-zalo"] || {};
            if (__ofCfg?.channels?.["modoro-zalo"]?.enabled === false) {
              __ofTransportBlocked = true;
              __ofBlockReason = "disabled";
              break;
            }
          } catch {
            __ofTransportBlocked = true;
            __ofBlockReason = "config-parse-error";
            break;
          }
        }
      }
      if (!__ofTransportBlocked) {
        let __ofBlockedUsers: string[] = [];
        for (const __ofBlockPath of __ofBlocklistPaths) {
          try {
            if (!__ofFs.existsSync(__ofBlockPath)) continue;
            const __ofRaw = JSON.parse(__ofFs.readFileSync(__ofBlockPath, "utf-8"));
            if (!Array.isArray(__ofRaw)) {
              __ofTransportBlocked = true;
              __ofBlockReason = "blocklist-invalid";
              break;
            }
            __ofBlockedUsers = __ofRaw.map((x: any) => String(x || "").trim()).filter(Boolean);
            break;
          } catch {
            __ofTransportBlocked = true;
            __ofBlockReason = "blocklist-parse-error";
            break;
          }
        }
        const __ofTargetId = String(target.threadId || "").trim();
        if (!__ofTransportBlocked && __ofTargetId) {
          if (target.isGroup) {
            const __ofGroupPolicy = __ofZaloCfg?.groupPolicy || "open";
            const __ofGroupAllowFrom = Array.isArray(__ofZaloCfg?.groupAllowFrom)
              ? __ofZaloCfg.groupAllowFrom.map((x: any) => String(x))
              : ["*"];
            const __ofAllowAll = __ofGroupPolicy !== "allowlist" || __ofGroupAllowFrom.includes("*");
            if (!__ofAllowAll && !__ofGroupAllowFrom.includes(__ofTargetId)) {
              __ofTransportBlocked = true;
              __ofBlockReason = "group-not-allowed";
            }
          } else if (__ofBlockedUsers.includes(__ofTargetId)) {
            __ofTransportBlocked = true;
            __ofBlockReason = "user-blocked";
          }
        }
      }
      if (__ofTransportBlocked) {
        try {
          logOutbound("info", "transport gated by zalo policy", {
            accountId: account.accountId,
            to: target.threadId,
            isGroup: target.isGroup,
            reason: __ofBlockReason || "policy",
          });
        } catch {}
        return { messageId: "transport-gated", kind: "text" as const };
      }
    } catch (__ofGateErr) {
      try { logOutbound("error", "transport gate error — allowing send", { err: String(__ofGateErr) }); } catch {}
      // Gate itself errored — fail-OPEN so messages still deliver
    }
    // Internal groups skip the output filter — staff can see raw data.
    const __ofIsInternal = (() => {
      if (!target.isGroup) return false;
      try {
        const gs = (global as any).__mcReadGroupSettings?.() || {};
        return gs[String(target.threadId)]?.internal === true;
      } catch { return false; }
    })();
    if (__ofIsInternal) {
      try { logOutbound("info", "internal group — output filter skipped", { to: target.threadId }); } catch {}
    }
    // Patterns that MUST NEVER appear in a customer-facing Zalo reply.
    // Skipped for internal groups (staff can see technical details).
    if (!__ofIsInternal) {
    const __ofSanitized = body.replace(/[​-‏‪-‮﻿­⁠⁡-⁤⁪-⁯]/g, '');
    const __ofBlockPatterns: { name: string; re: RegExp }[] = [
      // --- Layer A: file paths + secrets ---
      { name: "file-path-memory", re: /\bmemory\/[\w\-./]*\.md\b/i },
      { name: "file-path-learnings", re: /\.learnings\/[\w\-./]*/i },
      { name: "file-path-core", re: /\b(?:SOUL|USER|MEMORY|AGENTS|IDENTITY|COMPANY|PRODUCTS|BOOTSTRAP|HEARTBEAT|TOOLS)\.md\b/i },
      { name: "file-path-config", re: /\bopenclaw\.json\b/i },
      { name: "line-ref", re: /#L\d+/i },
      { name: "unix-home", re: /~\/\.openclaw|~\/\.openzca/i },
      { name: "win-user-path", re: /[A-Z]:[\\\/]Users[\\\/]/i },
      { name: "api-key-sk", re: /\bsk-[a-zA-Z0-9_\-]{16,}/i },
      { name: "bearer-token", re: /\bBearer\s+[a-zA-Z0-9_\-.]{20,}/i },
      { name: "hex-token-48", re: /\b[a-f0-9]{48}\b/i },
      { name: "hex-token-partial", re: /\b[a-f0-9]{16,47}\b/i },
      { name: "botToken-field", re: /\bbotToken\b/i },
      { name: "apiKey-field", re: /\bapiKey\b/i },
      // --- Layer A1.5: bot "silent" tokens leaked as reply ---
      { name: "bot-silent-token", re: /^(NO_REPLY|SKIP|SILENT|DO_NOT_REPLY|IM_LANG|IM LẶNG|KHÔNG TRẢ LỜI|no.?reply|skip.?message)$/i },
      // --- Layer A2: OpenClaw system messages (compaction, context reset) ---
      { name: "compaction-notice", re: /(?:Auto-compaction|Compacting context|Context limit exceeded|reset our conversation)/i },
      { name: "compaction-emoji", re: /🧹/ },
      // --- Layer B: English chain-of-thought leakage ---
      // NOTE: "customer" removed from cot-en-the-actor — CS replies legitimately say "the customer".
      { name: "cot-en-the-actor", re: /\bthe (assistant|bot|model)\b/i },
      // NOTE: "we can / let me / let's / i'll" removed — code-switched Vietnamese CS replies
      // routinely include these. Only block patterns with zero CS use case.
      { name: "cot-en-we-modal", re: /\b(we need to|we have to|we should|i need to|i should)\b/i },
      { name: "cot-en-meta", re: /\b(internal reasoning|chain of thought|system prompt|instructions|prompt injection|tool call)\b/i },
      { name: "cot-en-narration", re: /\b(based on (the|our)|according to (the|my)|as (you|i) (can|mentioned)|in (the|this) conversation)\b/i },
      { name: "cot-en-reasoning-verbs", re: /\b(let me think|hmm,? let|first,? (i|let|we)|okay,? (so|let|i)|alright,? (so|let|i))\b/i },
      // --- Layer C: meta-commentary about file/tool operations ---
      { name: "meta-vi-file-ops", re: /(?<![a-zA-Z0-9_])(edit file|ghi (vào )?file|lưu (vào )?file|update file|append file|read file|đọc file|cập nhật file|sửa file|tạo file|xóa file)(?![a-zA-Z0-9_])/i },
      { name: "meta-vi-tool-name", re: /\b(tool (Edit|Write|Read|Bash|Grep|Glob)|use the (Edit|Write|Read) tool|công cụ (Edit|Write|Read|Bash))\b/i },
      // v3 fix: lookbehind/lookahead instead of \b. Vietnamese branch
      // (đã ...) was DEAD CODE in v2 because \b can't anchor on đ.
      { name: "meta-vi-memory-claim", re: /(?<![a-zA-Z0-9_])(đã (lưu|ghi|cập nhật|update) (vào |trong )?(bộ nhớ|memory|hồ sơ|file|database)|stored (in|to) memory|saved to (file|memory))(?![a-zA-Z0-9_])/i },
      { name: "meta-vi-tool-action", re: /\b(em (vừa|đã) (edit|write|read|chạy|gọi) (file|tool|công cụ)|em (vừa|đã) (cập nhật|sửa|đọc) (file|memory|database))\b/i },
      // v3 fix: lookbehind/lookahead instead of \b. Second branch (đã ...)
      // was DEAD CODE in v2. Also dropped bare "(rằng|là)" — keep only
      // "rằng" because "là" alone false-positives on legit business reports
      // like "đã cập nhật là 5 sản phẩm còn".
      { name: "meta-vi-fact-claim", re: /(?<![a-zA-Z0-9_])(em đã (cập nhật|ghi (nhận|chú)|lưu( lại)?) (rằng|thêm rằng|sở thích|preference|là anh|là chị|là mình)|đã (cập nhật|ghi nhận|lưu) (thêm )?rằng)(?![a-zA-Z0-9_])/i },
      // --- Layer D: all-Latin / no-Vietnamese-diacritic message ---
      // Threshold raised 40→200: product listings like "iPhone 15 Pro 256GB: 25,900,000 VND"
      // are all-Latin but legitimate CS replies. CoT leaks are long walls of English (>200c).
      { name: "no-vietnamese-diacritic", re: /^(?!.*https?:\/\/)(?=[\s\S]{200,})(?!.*[àáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸỴĐ]).+/s },
      // --- Layer A1.7: PII masking (Nghi dinh 13/2023) ---
      { name: "pii-cccd-cmnd", re: /(?:cccd|căn\s*cước|cmnd|chứng\s*minh\s*(?:nhân\s*dân|thư))[\s:=]*\d{9}(?:\d{3})?\b/i },
      { name: "pii-bank-account", re: /(?:stk|số\s*tài\s*khoản|account\s*(?:number|no\.?)|acct\s*#?)[\s:=]*\d{6,20}/i },
      { name: "pii-credit-card", re: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{1,4}\b/ },
      // --- Layer A1.4: API/LLM error leakage ---
      { name: "api-error-bracket", re: /\[Error\]/i },
      { name: "api-overloaded", re: /servers? (?:are |is )?(?:currently )?overloaded/i },
      { name: "api-rate-limit", re: /rate.?limit(?:ed|ing)?\b/i },
      { name: "api-try-again", re: /(?:please |pls )?try again later/i },
      { name: "api-internal-error", re: /(?:internal server error|502 bad gateway|503 service|429 too many)/i },
      { name: "api-quota-exceeded", re: /quota.?exceeded|usage.?limit/i },
      // --- Layer E: brand + internal name leakage ---
      { name: "brand-9bizclaw", re: /9bizclaw[\/\\.\-](?:dist|cli|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+9bizclaw/i },
      { name: "brand-openclaw", re: /openclaw[\/\\.\-](?:dist|cli|mjs|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+openclaw/i },
      { name: "brand-9router", re: /9router[\/\\.\-](?:dist|cli|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+9router/i },
      { name: "brand-openzca", re: /openzca[\/\\.\-](?:dist|cli|listen|json|ts|js|log|md)|(?:error|crashed|spawn|exception|stack(?:\s*trace)?)\s+openzca/i },
      // --- Layer F: prompt injection acknowledgment ---
      { name: "jailbreak-acknowledge", re: /\b(developer mode|jailbreak|ignore previous|forget instructions|role\s*play as|you are now|pretend to be)\b/i },
      { name: "system-prompt-leak", re: /\b(my (?:instructions|prompt|system prompt|rules)|here (?:are|is) my (?:rules|instructions))/i },
      // --- Layer G: cross-customer PII leakage ---
      { name: "list-all-customers", re: /(?:tất cả khách hàng|all customers|list customers|other customers?|khách khác cũng|khách hàng khác)/i },
      // --- Layer H: fake commerce commitments ---
      { name: "fake-order-confirm", re: /(?:đã\s+(?:xác\s*nhận|tạo|lưu|ghi\s*nhận)\s*đơn|đơn\s*(?:của\s+(?:anh|chị|mình|bạn))?\s*(?:đã|được)\s+(?:tạo|xác\s*nhận|lưu|ghi))/i },
      { name: "fake-shipping-fee", re: /(?:phí\s*ship|ship\s*phí|phí\s*vận\s*chuyển|tiền\s*ship)\s*[:=]?\s*\d{1,3}[.,]?\d{3}/i },
      { name: "fake-total-amount", re: /tổng\s*(?:tiền|cộng|đơn\s*hàng|thanh\s*toán|cần\s*thanh\s*toán)\s*[:=]?\s*\d{1,3}[.,]?\d{3}/i },
      { name: "fake-discount-percent", re: /(?:giảm\s*(?:giá)?|discount|khuyến\s*mãi|sale)\s*\d{1,2}\s*%/i },
      { name: "fake-booking-confirmed", re: /(?:đã\s*(?:đặt|book|giữ|xác\s*nhận))\s*(?:lịch|bàn|phòng|chỗ|slot|lịch\s*hẹn|cuộc\s*hẹn)/i },
      { name: "fake-payment-received", re: /(?:đã\s*nhận\s*(?:thanh\s*toán|tiền|chuyển\s*khoản)|payment\s*received)/i },
    ];
    let __ofBlocked: string | null = null;
    for (const __ofP of __ofBlockPatterns) {
      if (__ofP.re.test(__ofSanitized)) {
        __ofBlocked = __ofP.name;
        break;
      }
    }
    if (__ofBlocked === "bot-silent-token") {
      logOutbound("info", "bot intended silence — suppressing send", { pattern: __ofBlocked });
      return { messageId: "silent", kind: "text" as const };
    }
    if (__ofBlocked) {
      // Log the blocked content to a dedicated audit file (never to main
      // stdout which could itself be exfiltrated). Write to workspace
      // logs/ dir so CEO can audit incidents.
      try {
        const __ofHome = __ofOs.homedir();
        // Resolve workspace logs dir cross-platform. Prefer 9BIZ_WORKSPACE
        // env (set by main.js at gateway spawn). Fallback to platform-specific
        // userData dir matching Electron's app.getPath('userData') which uses
        // the lowercase package.json `name` field "9bizclaw".
        const __ofAppDir = "9bizclaw";
        let __ofWsLogDir;
        if (process.env['9BIZ_WORKSPACE']) {
          __ofWsLogDir = __ofPath.join(process.env['9BIZ_WORKSPACE'], "logs");
        } else if (process.platform === "darwin") {
          __ofWsLogDir = __ofPath.join(__ofHome, "Library", "Application Support", __ofAppDir, "logs");
        } else if (process.platform === "win32") {
          const __ofAppData = process.env.APPDATA || __ofPath.join(__ofHome, "AppData", "Roaming");
          __ofWsLogDir = __ofPath.join(__ofAppData, __ofAppDir, "logs");
        } else {
          const __ofConfig = process.env.XDG_CONFIG_HOME || __ofPath.join(__ofHome, ".config");
          __ofWsLogDir = __ofPath.join(__ofConfig, __ofAppDir, "logs");
        }
        const __ofLogDir = __ofWsLogDir;
        __ofFs.mkdirSync(__ofLogDir, { recursive: true });
        const __ofAuditFile = __ofPath.join(__ofLogDir, "security-output-filter.jsonl");
        __ofFs.appendFileSync(
          __ofAuditFile,
          JSON.stringify({
            t: new Date().toISOString(),
            event: "zalo_output_blocked",
            pattern: __ofBlocked,
            to: to,
            accountId: account.accountId,
            bodyPreview: body.slice(0, 200),
            bodyLength: body.length,
          }) + "\n",
          "utf-8",
        );
      } catch {}
      logOutbound("warn", "output filter blocked sensitive content", {
        accountId: account.accountId,
        pattern: __ofBlocked,
        bodyLength: body.length,
      });
      // Replace body with a safe canned message. Don't throw — we still
      // want the customer to get a reply, just not the leaked content.
      // Pick a context-appropriate fallback so it doesn't always look the
      // same (which would be a tell that the filter fired).
      const __ofSafeMsgs = [
        "Dạ em xin lỗi, cho em một phút em rà lại thông tin rồi báo lại mình ạ.",
        "Dạ em ghi nhận rồi ạ. Em sẽ kiểm tra và phản hồi lại mình ngay.",
        "Dạ em đang xác nhận lại thông tin, mình chờ em xíu nha.",
      ];
      const __ofSafeMsg = __ofSafeMsgs[Math.floor(Math.random() * __ofSafeMsgs.length)] || __ofSafeMsgs[0];
      (options as any).text = __ofSafeMsg;
      return await (async () => {
        const __ofSafeBody = __ofSafeMsg;
        const __ofArgs = ["msg", "send", target.threadId, __ofSafeBody];
        if (target.isGroup) __ofArgs.push("--group");
        try {
          const __ofResult = await runOpenzcaAccountCommand({
            account,
            binary: account.zcaBinary,
            profile: account.profile,
            args: __ofArgs,
            timeoutMs: 20_000,
          });
          const __ofRefs = parseOpenzcaMessageRefs(__ofResult.stdout);
          return {
            messageId: __ofRefs.msgId || "ok",
            msgId: __ofRefs.msgId,
            cliMsgId: __ofRefs.cliMsgId,
            kind: "text" as const,
            textPreview: __ofSafeBody.slice(0, 80),
          };
        } catch (__ofErr) {
          return { messageId: "filter-blocked", kind: "text" as const };
        }
      })();
    }
    } // end if (!__ofIsInternal)
  } catch (__ofE) {
    try { logOutbound("error", "output filter error — falling through to normal send", { err: String(__ofE) }); } catch {}
  }
  // === END 9BizClaw OUTPUT-FILTER PATCH ===
  // === 9BizClaw ESCALATION-DETECT PATCH v2 ===
  try {
    const __escPatterns: RegExp[] = [
      /(?<![a-zA-Z0-9_])(chuyển (cho )?(sếp|quản lý|bộ phận|nhân viên|người phụ trách|người có thẩm quyền))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(ghi nhận (khiếu nại|phản ánh|yêu cầu|vấn đề))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])((đã |sẽ |để em |em xin |xin phép |cho em )?báo (lại )?(sếp|quản lý|CEO|ban giám đốc))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(sếp sẽ (liên hệ|gọi|phản hồi|trả lời|xử lý|hỗ trợ))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(em (sẽ|đã|xin) (chuyển|báo|hỏi|nhờ|liên hệ) (lại )?(sếp|quản lý|CEO|bộ phận|người phụ trách))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(ngoài khả năng|không thuộc phạm vi|vượt (ngoài )?thẩm quyền)(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(cần (sếp|quản lý|người|bộ phận) (hỗ trợ|xử lý|can thiệp|xem xét|quyết định))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(để em (hỏi|chuyển|báo|nhờ|liên hệ) (lại )?(sếp|quản lý|CEO|bên|người|phòng))(?![a-zA-Z0-9_])/i,
      /(?<![a-zA-Z0-9_])(em đã chuyển sếp|em đã chuyển cho sếp)(?![a-zA-Z0-9_])/i,
    ];
    let __escMatch: string | null = null;
    for (const __escRe of __escPatterns) {
      const __escM = body.match(__escRe);
      if (__escM) { __escMatch = __escM[0]; break; }
    }
    logOutbound("info", "escalation-scanner-check", {
      bodyLen: body.length,
      bodyPreview: body.slice(0, 120),
      matched: __escMatch || "none",
    });
    if (__escMatch) {
      try {
        const __escFs = require("node:fs");
        const __escPath = require("node:path");
        const __escHome = require("node:os").homedir();
        const __escAppDir = "9bizclaw";
        let __escWsDir: string;
        if (process.env['9BIZ_WORKSPACE']) {
          __escWsDir = process.env['9BIZ_WORKSPACE'];
        } else if (process.platform === "darwin") {
          __escWsDir = __escPath.join(__escHome, "Library", "Application Support", __escAppDir);
        } else if (process.platform === "win32") {
          const __escAppData = process.env.APPDATA || __escPath.join(__escHome, "AppData", "Roaming");
          __escWsDir = __escPath.join(__escAppData, __escAppDir);
        } else {
          const __escConfig = process.env.XDG_CONFIG_HOME || __escPath.join(__escHome, ".config");
          __escWsDir = __escPath.join(__escConfig, __escAppDir);
        }
        const __escLogDir = __escPath.join(__escWsDir, "logs");
        __escFs.mkdirSync(__escLogDir, { recursive: true });
        __escFs.appendFileSync(
          __escPath.join(__escLogDir, "escalation-queue.jsonl"),
          JSON.stringify({
            t: new Date().toISOString(),
            to: target.threadId,
            isGroup: !!target.isGroup,
            trigger: __escMatch,
            botReply: body.slice(0, 500),
          }) + "\n",
          "utf-8",
        );
        logOutbound("info", "escalation-queue-written", { trigger: __escMatch, to: target.threadId });
      } catch (__escWriteErr) {
        logOutbound("error", "escalation-queue-write-failed", { err: String(__escWriteErr), trigger: __escMatch });
      }
    }
  } catch (__escOuterErr) {
    logOutbound("error", "escalation-scanner-error", { err: String(__escOuterErr) });
  }
  // === END 9BizClaw ESCALATION-DETECT PATCH v2 ===

  const args = ["msg", "send", target.threadId, body];
  if (target.isGroup) {
    args.push("--group");
  }

  logOutbound("info", "sendText request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    textLength: body.length,
  });

  try {
    const result = await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 20_000,
    });
    const refs = parseOpenzcaMessageRefs(result.stdout);
    logOutbound("info", "sendText success", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
    });
    return {
      messageId: refs.msgId || "ok",
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
      kind: "text",
      textPreview: body,
    };
  } catch (error) {
    logOutbound("error", "sendText failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      error: String(error),
    });
    throw error;
  }
}

export async function sendMediaModoroZalo(
  options: SendMediaOptions,
): Promise<ModoroZaloSendReceipt & { receipts: ModoroZaloSendReceipt[] }> {
  const { account, to, text, mediaUrl, mediaPath, mediaLocalRoots } = options;
  const target = parseModoroZaloTarget(to);
  // === 9BizClaw GROUP-DETECT PATCH (media) ===
  if (!target.isGroup && target.threadId) {
    try {
      const __gdFs = require("node:fs");
      const __gdPath = require("node:path");
      const __gdHome = require("node:os").homedir();
      const __gdGroupsFile = __gdPath.join(__gdHome, ".openzca", "profiles", "default", "cache", "groups.json");
      if (__gdFs.existsSync(__gdGroupsFile)) {
        const __gdGroups = JSON.parse(__gdFs.readFileSync(__gdGroupsFile, "utf-8"));
        if (Array.isArray(__gdGroups) && __gdGroups.some((g: any) => String(g?.groupId) === target.threadId)) {
          (target as any).isGroup = true;
        }
      }
    } catch {}
  }
  // === END 9BizClaw GROUP-DETECT PATCH (media) ===
  const rawSource = (mediaPath ?? mediaUrl ?? "").trim();
  if (!rawSource) {
    if (text?.trim()) {
      const receipt = await sendTextModoroZalo({
        cfg: options.cfg,
        account,
        to,
        text,
      });
      return {
        ...receipt,
        receipts: [receipt],
      };
    }
    return {
      messageId: "empty",
      kind: "media",
      receipts: [],
    };
  }

  const resolvedSource = await resolveMediaSource({
    source: rawSource,
    mediaLocalRoots,
  });
  const source = resolvedSource.source;
  const resolvedMediaCommand = resolveMediaCommand(source);
  let mediaCommand = resolvedMediaCommand;
  let args = buildOpenzcaMediaArgs({
    target,
    source,
    mediaCommand,
    message: text,
  });
  const sourceType = resolvedSource.sourceType;

  logOutbound("info", "sendMedia request", {
    accountId: account.accountId,
    to,
    threadId: target.threadId,
    isGroup: target.isGroup,
    sourceType,
    rawSource,
    source,
    mediaCommand: resolvedMediaCommand,
    hasCaption: Boolean(text?.trim()),
  });

  try {
    let result: Awaited<ReturnType<typeof runOpenzcaAccountCommand>>;
    try {
      result = await runOpenzcaAccountCommand({
        account,
        binary: account.zcaBinary,
        profile: account.profile,
        args,
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (mediaCommand !== "upload") {
        logOutbound("warn", "sendMedia primary command failed; retrying with upload", {
          accountId: account.accountId,
          threadId: target.threadId,
          isGroup: target.isGroup,
          sourceType,
          mediaCommand,
          source,
          error: String(error),
        });
        mediaCommand = "upload";
        args = buildOpenzcaMediaArgs({
          target,
          source,
          mediaCommand,
          message: text,
        });
        result = await runOpenzcaAccountCommand({
          account,
          binary: account.zcaBinary,
          profile: account.profile,
          args,
          timeoutMs: 60_000,
        });
      } else {
        throw error;
      }
    }
    const refs = parseOpenzcaMessageRefs(result.stdout);
    const mediaReceipt: ModoroZaloSendReceipt = {
      messageId: refs.msgId || "ok",
      msgId: refs.msgId,
      cliMsgId: refs.cliMsgId,
      kind: "media",
    };

    const receipts: ModoroZaloSendReceipt[] = [mediaReceipt];
    const captionSentInline = mediaCommand === "video" && Boolean(text?.trim());
    if (text?.trim() && !captionSentInline) {
      const captionReceipt = await sendTextModoroZalo({
        cfg: options.cfg,
        account,
        to,
        text,
      });
      receipts.push(captionReceipt);
    }

    const primary =
      [...receipts].reverse().find((entry) => Boolean(entry.msgId || entry.cliMsgId)) ||
      receipts[receipts.length - 1] ||
      mediaReceipt;

    logOutbound("info", "sendMedia success", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      sourceType,
      mediaCommand,
      msgId: primary.msgId,
      cliMsgId: primary.cliMsgId,
      receiptCount: receipts.length,
    });

    return {
      ...primary,
      receipts,
    };
  } catch (error) {
    logOutbound("error", "sendMedia failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      sourceType,
      mediaCommand,
      source,
      error: String(error),
    });
    throw error;
  }
}

export async function sendTypingModoroZalo(options: SendTypingOptions): Promise<void> {
  const { account, to } = options;
  const target = parseModoroZaloTarget(to);
  // === 9BizClaw GROUP-DETECT PATCH (typing) ===
  if (!target.isGroup && target.threadId) {
    try {
      const __gdFs = require("node:fs");
      const __gdPath = require("node:path");
      const __gdHome = require("node:os").homedir();
      const __gdGroupsFile = __gdPath.join(__gdHome, ".openzca", "profiles", "default", "cache", "groups.json");
      if (__gdFs.existsSync(__gdGroupsFile)) {
        const __gdGroups = JSON.parse(__gdFs.readFileSync(__gdGroupsFile, "utf-8"));
        if (Array.isArray(__gdGroups) && __gdGroups.some((g: any) => String(g?.groupId) === target.threadId)) {
          (target as any).isGroup = true;
        }
      }
    } catch {}
  }
  // === END 9BizClaw GROUP-DETECT PATCH (typing) ===
  const args = ["msg", "typing", target.threadId];
  if (target.isGroup) {
    args.push("--group");
  }

  try {
    await runOpenzcaAccountCommand({
      account,
      binary: account.zcaBinary,
      profile: account.profile,
      args,
      timeoutMs: 10_000,
    });
  } catch (error) {
    logOutbound("warn", "sendTyping failed", {
      accountId: account.accountId,
      threadId: target.threadId,
      isGroup: target.isGroup,
      error: String(error),
    });
    throw error;
  }
}
