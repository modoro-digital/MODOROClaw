import type { ReplyPayload } from "../../api.js";

export const MODORO_ZALO_ACPX_PERMISSION_MODES = [
  "approve-all",
  "approve-reads",
  "deny-all",
] as const;
export type ModoroZaloAcpxPermissionMode = (typeof MODORO_ZALO_ACPX_PERMISSION_MODES)[number];

export const MODORO_ZALO_ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"] as const;
export type ModoroZaloAcpxNonInteractivePermissions =
  (typeof MODORO_ZALO_ACPX_NON_INTERACTIVE_POLICIES)[number];

export type ModoroZaloAcpxConfig = {
  enabled?: boolean;
  command?: string;
  agent?: string;
  cwd?: string;
  timeoutSeconds?: number;
  permissionMode?: ModoroZaloAcpxPermissionMode;
  nonInteractivePermissions?: ModoroZaloAcpxNonInteractivePermissions;
};

export type ResolvedModoroZaloAcpxConfig = {
  enabled: boolean;
  command: string;
  agent: string;
  cwd: string;
  timeoutSeconds?: number;
  permissionMode: ModoroZaloAcpxPermissionMode;
  nonInteractivePermissions: ModoroZaloAcpxNonInteractivePermissions;
};

export type ModoroZaloAcpBindingRecord = {
  accountId: string;
  conversationId: string;
  sessionName: string;
  sessionKey: string;
  agent: string;
  cwd: string;
  boundAt: number;
  updatedAt: number;
};

export type ModoroZaloAcpEnsureResult = {
  sessionName: string;
  agent: string;
  cwd: string;
};

export type ModoroZaloAcpPromptResult = {
  text: string;
  statusText?: string;
};

export type ModoroZaloAcpStatusResult = {
  summary: string;
  details?: Record<string, unknown>;
};

export type ModoroZaloAcpCommandResult =
  | { handled: false }
  | {
      handled: true;
      payload: ReplyPayload;
      binding?: ModoroZaloAcpBindingRecord | null;
    };
