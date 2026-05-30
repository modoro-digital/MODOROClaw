import type {
  BaseProbeResult,
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
} from "../api.js";
import type { ModoroZaloAcpxConfig } from "./acp-local/types.js";

export type ModoroZaloGroupConfig = {
  enabled?: boolean;
  requireMention?: boolean;
  allowFrom?: Array<string | number>;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  systemPrompt?: string;
};

export type ModoroZaloActionConfig = {
  reactions?: boolean;
  messages?: boolean;
  groups?: boolean;
  pins?: boolean;
  memberInfo?: boolean;
  groupMembers?: boolean;
};

export type ModoroZaloThreadBindingsConfig = {
  enabled?: boolean;
  spawnSubagentSessions?: boolean;
  ttlHours?: number;
};

export type ModoroZaloAccountConfig = {
  name?: string;
  enabled?: boolean;
  profile?: string;
  zcaBinary?: string;
  acpx?: ModoroZaloAcpxConfig;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, ModoroZaloGroupConfig>;
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  blockStreaming?: boolean;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  mediaMaxMb?: number;
  mediaLocalRoots?: string[];
  sendTypingIndicators?: boolean;
  threadBindings?: ModoroZaloThreadBindingsConfig;
  actions?: ModoroZaloActionConfig;
};

export type ModoroZaloConfig = ModoroZaloAccountConfig & {
  defaultAccount?: string;
  accounts?: Record<string, ModoroZaloAccountConfig>;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    "modoro-zalo"?: ModoroZaloConfig;
  };
};

export type ResolvedModoroZaloAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  profile: string;
  zcaBinary: string;
  configured: boolean;
  config: ModoroZaloAccountConfig;
};

export type ModoroZaloProbe = BaseProbeResult<string> & {
  profile: string;
  binary: string;
};

export type OpenzcaRawPayload = Record<string, unknown>;

export type ModoroZaloInboundMention = {
  uid: string;
  pos?: number;
  len?: number;
  type?: number;
  text?: string;
};

export type ModoroZaloInboundMessage = {
  messageId: string;
  msgId?: string;
  cliMsgId?: string;
  threadId: string;
  toId?: string;
  dmPeerId?: string;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  quoteMsgId?: string;
  quoteCliMsgId?: string;
  quoteSender?: string;
  quoteText?: string;
  mentions: ModoroZaloInboundMention[];
  mentionIds: string[];
  mediaPaths: string[];
  mediaUrls: string[];
  mediaTypes: string[];
  raw: OpenzcaRawPayload;
};
