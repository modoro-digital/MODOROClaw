import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureModoroZaloAcpxSession,
  getModoroZaloAcpxStatus,
  promptModoroZaloAcpxSession,
} from "./client.ts";
import type { ResolvedModoroZaloAcpxConfig } from "./types.ts";

const baseConfig: ResolvedModoroZaloAcpxConfig = {
  enabled: true,
  command: "acpx",
  agent: "codex",
  cwd: "/workspace",
  permissionMode: "approve-all",
  nonInteractivePermissions: "fail",
};

test("ensureModoroZaloAcpxSession falls back to sessions new when ensure returns no ids", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const result = await ensureModoroZaloAcpxSession(
    {
      config: baseConfig,
      sessionName: "modoro-zalo:default:abc123",
      agent: "codex",
      cwd: "/workspace",
    },
    {
      runCommand: async (options) => {
        calls.push({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
        });
        return calls.length === 1
          ? { stdout: "{\"type\":\"noop\"}\n", stderr: "", exitCode: 0 }
          : { stdout: "{\"acpxSessionId\":\"sess-1\"}\n", stderr: "", exitCode: 0 };
      },
    },
  );

  assert.equal(result.sessionName, "modoro-zalo:default:abc123");
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.args.includes("sessions"));
  assert.ok(calls[0]?.args.includes("ensure"));
  assert.ok(calls[1]?.args.includes("new"));
});

test("promptModoroZaloAcpxSession uses acpx permission flags and aggregates output", async () => {
  let seenArgs: string[] = [];

  const result = await promptModoroZaloAcpxSession(
    {
      config: baseConfig,
      sessionName: "modoro-zalo:default:abc123",
      agent: "codex",
      cwd: "/workspace",
      text: "hello",
    },
    {
      runStreaming: async (options) => {
        seenArgs = options.args;
        await options.onJsonLine?.({
          type: "agent_message_chunk",
          content: "Hello ",
        });
        await options.onJsonLine?.({
          type: "agent_message_chunk",
          content: "world",
        });
        await options.onJsonLine?.({
          type: "tool_call",
          title: "shell",
          status: "running",
        });
        return { exitCode: 0, stderr: "" };
      },
    },
  );

  assert.equal(result.text, "Hello world");
  assert.equal(result.statusText, "shell (running)");
  assert.ok(seenArgs.includes("--approve-all"));
  assert.ok(!seenArgs.includes("--permission-mode"));
  assert.ok(seenArgs.includes("--non-interactive-permissions"));
  assert.ok(seenArgs.includes("fail"));
});

test("getModoroZaloAcpxStatus summarizes structured status output", async () => {
  const result = await getModoroZaloAcpxStatus(
    {
      config: baseConfig,
      sessionName: "modoro-zalo:default:abc123",
      agent: "codex",
      cwd: "/workspace",
    },
    {
      runCommand: async () => ({
        stdout:
          "{\"status\":\"running\",\"acpxSessionId\":\"sess-1\",\"acpxRecordId\":\"rec-1\",\"pid\":123}\n",
        stderr: "",
        exitCode: 0,
      }),
    },
  );

  assert.equal(result.summary, "status=running acpxSessionId=sess-1 acpxRecordId=rec-1 pid=123");
});
