import type { CoreConfig } from "../types.js";
import {
  type ModoroZaloAcpxNonInteractivePermissions,
  type ModoroZaloAcpxPermissionMode,
  type ResolvedModoroZaloAcpxConfig,
} from "./types.js";

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTimeoutSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizePermissionMode(value: unknown): ModoroZaloAcpxPermissionMode | undefined {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all"
    ? value
    : undefined;
}

function normalizeNonInteractivePermissions(
  value: unknown,
): ModoroZaloAcpxNonInteractivePermissions | undefined {
  return value === "deny" || value === "fail" ? value : undefined;
}

export function resolveModoroZaloAcpxConfig(params: {
  cfg: CoreConfig;
  accountId: string;
}): ResolvedModoroZaloAcpxConfig {
  const rootConfig = params.cfg.channels?.["modoro-zalo"]?.acpx;
  const accountConfig = params.cfg.channels?.["modoro-zalo"]?.accounts?.[params.accountId]?.acpx;

  return {
    enabled: accountConfig?.enabled ?? rootConfig?.enabled ?? true,
    command:
      normalizeText(accountConfig?.command) ??
      normalizeText(rootConfig?.command) ??
      normalizeText(process.env.MODORO_ZALO_ACPX_COMMAND) ??
      "acpx",
    agent:
      normalizeText(accountConfig?.agent) ??
      normalizeText(rootConfig?.agent) ??
      normalizeText(process.env.MODORO_ZALO_ACPX_AGENT) ??
      "codex",
    cwd:
      normalizeText(accountConfig?.cwd) ??
      normalizeText(rootConfig?.cwd) ??
      normalizeText(process.env.MODORO_ZALO_ACPX_CWD) ??
      process.cwd(),
    timeoutSeconds:
      normalizeTimeoutSeconds(accountConfig?.timeoutSeconds) ??
      normalizeTimeoutSeconds(rootConfig?.timeoutSeconds),
    permissionMode:
      normalizePermissionMode(accountConfig?.permissionMode) ??
      normalizePermissionMode(rootConfig?.permissionMode) ??
      "approve-all",
    nonInteractivePermissions:
      normalizeNonInteractivePermissions(accountConfig?.nonInteractivePermissions) ??
      normalizeNonInteractivePermissions(rootConfig?.nonInteractivePermissions) ??
      "fail",
  };
}
