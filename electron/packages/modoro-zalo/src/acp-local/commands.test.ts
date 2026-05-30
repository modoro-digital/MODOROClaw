import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  handleModoroZaloAcpCommand,
  parseModoroZaloAcpCommand,
} from "./commands.ts";
import {
  createModoroZaloAcpBindingRecord,
  resolveModoroZaloAcpBinding,
  upsertModoroZaloAcpBinding,
} from "./bindings.ts";

async function makeStateDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRuntime(stateDir: string) {
  return {
    state: {
      resolveStateDir: () => stateDir,
    },
  } as const;
}

function bindStateDirForTest(t: test.TestContext, stateDir: string): void {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(() => {
    if (previous == null) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = previous;
  });
}

function textOf(result: Awaited<ReturnType<typeof handleModoroZaloAcpCommand>>): string {
  if (!result.handled) {
    return "";
  }
  return result.payload.text ?? "";
}

test("parseModoroZaloAcpCommand supports positional agent and cwd tokens", () => {
  assert.deepEqual(parseModoroZaloAcpCommand("/acp on codex cwd=/workspace"), {
    action: "on",
    agent: "codex",
    cwd: "/workspace",
  });
  assert.deepEqual(parseModoroZaloAcpCommand("/acp"), {
    action: "status",
  });
});

test("handleModoroZaloAcpCommand rejects enabling ACP when disabled in config", async (t) => {
  const stateDir = await makeStateDir("modoro-zalo-acp-commands-");
  bindStateDirForTest(t, stateDir);
  t.after(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const result = await handleModoroZaloAcpCommand({
    commandBody: "/acp on",
    account: {
      accountId: "default",
      config: {},
    } as never,
    cfg: {
      channels: {
        "modoro-zalo": {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: makeRuntime(stateDir) as never,
    conversationId: "user:42",
    hasSubagentBinding: false,
  });

  assert.equal(result.handled, true);
  assert.match(textOf(result), /disabled/i);
});

test("handleModoroZaloAcpCommand status reports disabled bound session metadata", async (t) => {
  const stateDir = await makeStateDir("modoro-zalo-acp-commands-");
  bindStateDirForTest(t, stateDir);
  t.after(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const record = createModoroZaloAcpBindingRecord({
    accountId: "default",
    conversationId: "group:123",
    agent: "codex",
    cwd: "/workspace",
  });
  await upsertModoroZaloAcpBinding({ stateDir, record });

  const result = await handleModoroZaloAcpCommand({
    commandBody: "/acp status",
    account: {
      accountId: "default",
      config: {},
    } as never,
    cfg: {
      channels: {
        "modoro-zalo": {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: makeRuntime(stateDir) as never,
    conversationId: "group:123",
    hasSubagentBinding: false,
  });

  assert.equal(result.handled, true);
  assert.match(textOf(result), /currently disabled/i);
  assert.match(textOf(result), /session=/i);
});

test("handleModoroZaloAcpCommand off removes bindings even when ACPX is disabled", async (t) => {
  const stateDir = await makeStateDir("modoro-zalo-acp-commands-");
  bindStateDirForTest(t, stateDir);
  t.after(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const record = createModoroZaloAcpBindingRecord({
    accountId: "default",
    conversationId: "user:42",
    agent: "codex",
    cwd: "/workspace",
  });
  await upsertModoroZaloAcpBinding({ stateDir, record });

  const result = await handleModoroZaloAcpCommand({
    commandBody: "/acp off",
    account: {
      accountId: "default",
      config: {},
    } as never,
    cfg: {
      channels: {
        "modoro-zalo": {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: makeRuntime(stateDir) as never,
    conversationId: "user:42",
    hasSubagentBinding: false,
  });

  assert.equal(result.handled, true);
  assert.match(textOf(result), /now off/i);

  const resolved = await resolveModoroZaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.equal(resolved, null);
});
