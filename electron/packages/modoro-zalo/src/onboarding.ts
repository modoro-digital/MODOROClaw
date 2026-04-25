import {
  type ChannelSetupDmPolicy,
  type DmPolicy,
  type OpenClawConfig,
  type WizardPrompter,
  DEFAULT_ACCOUNT_ID,
  addWildcardAllowFrom,
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptAccountId,
} from "../api.js";
import {
  listModoroZaloAccountIds,
  resolveDefaultModoroZaloAccountId,
  resolveModoroZaloAccount,
} from "./accounts.js";
import { normalizeModoroZaloAllowEntry } from "./normalize.js";

const channel = "modoro-zalo" as const;

type ModoroZaloAccountOverrides = Partial<Record<typeof channel, string>>;
type ModoroZaloOnboardingStatus = {
  channel: typeof channel;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
};
type ModoroZaloOnboardingAdapter = {
  channel: typeof channel;
  getStatus: (ctx: {
    cfg: OpenClawConfig;
    options?: unknown;
    accountOverrides: ModoroZaloAccountOverrides;
  }) => Promise<ModoroZaloOnboardingStatus>;
  configure: (ctx: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    accountOverrides: ModoroZaloAccountOverrides;
    shouldPromptAccountIds: boolean;
  }) => Promise<{ cfg: OpenClawConfig; accountId?: string }>;
  dmPolicy?: ChannelSetupDmPolicy;
  disable?: (cfg: OpenClawConfig) => OpenClawConfig;
};

function setModoroZaloDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.["modoro-zalo"]?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "modoro-zalo": {
        ...cfg.channels?.["modoro-zalo"],
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setModoroZaloAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "modoro-zalo": {
          ...cfg.channels?.["modoro-zalo"],
          allowFrom,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "modoro-zalo": {
        ...cfg.channels?.["modoro-zalo"],
        accounts: {
          ...cfg.channels?.["modoro-zalo"]?.accounts,
          [accountId]: {
            ...cfg.channels?.["modoro-zalo"]?.accounts?.[accountId],
            allowFrom,
          },
        },
      },
    },
  };
}

function parseModoroZaloAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => normalizeModoroZaloAllowEntry(entry))
    .filter(Boolean);
}

async function promptModoroZaloAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultModoroZaloAccountId(params.cfg);
  const resolved = resolveModoroZaloAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist Modoro Zalo DM senders by user ID.",
      "Examples:",
      "- 123456789",
      "- 987654321",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/modoro-zalo", "modoro-zalo")}`,
    ].join("\n"),
    "Modoro Zalo allowlist",
  );

  const entry = await params.prompter.text({
    message: "Modoro Zalo allowFrom (user ids)",
    placeholder: "123456789, 987654321",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parts = parseModoroZaloAllowFromInput(raw);
      if (parts.length === 0) {
        return "Invalid entries";
      }
      return undefined;
    },
  });

  const parts = parseModoroZaloAllowFromInput(String(entry));
  const unique = mergeAllowFromEntries(undefined, parts);
  return setModoroZaloAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelSetupDmPolicy = {
  label: "Modoro Zalo",
  channel,
  policyKey: "channels[\"modoro-zalo\"].dmPolicy",
  allowFromKey: "channels[\"modoro-zalo\"].allowFrom",
  getCurrent: (cfg) => cfg.channels?.["modoro-zalo"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setModoroZaloDmPolicy(cfg, policy),
  promptAllowFrom: promptModoroZaloAllowFrom,
};

function setModoroZaloProfileAndBinary(params: {
  cfg: OpenClawConfig;
  accountId: string;
  profile: string;
  zcaBinary: string;
}): OpenClawConfig {
  const { cfg, accountId, profile, zcaBinary } = params;
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        "modoro-zalo": {
          ...cfg.channels?.["modoro-zalo"],
          enabled: true,
          profile,
          zcaBinary,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      "modoro-zalo": {
        ...cfg.channels?.["modoro-zalo"],
        enabled: true,
        accounts: {
          ...cfg.channels?.["modoro-zalo"]?.accounts,
          [accountId]: {
            ...cfg.channels?.["modoro-zalo"]?.accounts?.[accountId],
            enabled: cfg.channels?.["modoro-zalo"]?.accounts?.[accountId]?.enabled ?? true,
            profile,
            zcaBinary,
          },
        },
      },
    },
  };
}

export const modoroZaloOnboardingAdapter: ModoroZaloOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listModoroZaloAccountIds(cfg).some((accountId) => {
      const account = resolveModoroZaloAccount({ cfg, accountId });
      return account.configured;
    });
    return {
      channel,
      configured,
      statusLines: [`Modoro Zalo: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "personal account via openzca CLI",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides["modoro-zalo"]?.trim();
    const defaultAccountId = resolveDefaultModoroZaloAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Modoro Zalo",
        currentId: accountId,
        listAccountIds: listModoroZaloAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveModoroZaloAccount({ cfg, accountId });

    const profileInput = await prompter.text({
      message: "openzca profile",
      placeholder: accountId,
      initialValue: resolved.config.profile?.trim() || accountId,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const profile = String(profileInput).trim();

    const customBinary = await prompter.confirm({
      message: "Use custom openzca binary path?",
      initialValue: Boolean(
        resolved.config.zcaBinary?.trim() &&
          resolved.config.zcaBinary?.trim() !== "openzca",
      ),
    });

    let zcaBinary = resolved.config.zcaBinary?.trim() || "openzca";
    if (customBinary) {
      const binaryInput = await prompter.text({
        message: "openzca binary path",
        placeholder: "openzca",
        initialValue: zcaBinary,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      zcaBinary = String(binaryInput).trim();
    } else {
      zcaBinary = "openzca";
    }

    const next = setModoroZaloProfileAndBinary({
      cfg,
      accountId,
      profile,
      zcaBinary,
    });

    await prompter.note(
      [
        "Next steps:",
        `1. Login: openzca --profile ${profile} auth login`,
        "2. Restart gateway if needed.",
        "3. Send a DM to test pairing/access policy.",
        `Docs: ${formatDocsLink("/channels/modoro-zalo", "modoro-zalo")}`,
      ].join("\n"),
      "Modoro Zalo next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      "modoro-zalo": { ...cfg.channels?.["modoro-zalo"], enabled: false },
    },
  }),
};
