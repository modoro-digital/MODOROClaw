import assert from "node:assert/strict";
import test from "node:test";
import { buildModoroZaloAcpPromptText, runModoroZaloAcpBoundTurn } from "./turn.ts";

test("buildModoroZaloAcpPromptText includes media and quoted reply context", () => {
  const prompt = buildModoroZaloAcpPromptText({
    BodyForAgent: "Summarize this",
    MediaPaths: ["./a.png"],
    MediaUrls: ["https://example.com/b.png"],
    ReplyToBody: "Previous message",
  });

  assert.match(prompt, /Summarize this/);
  assert.match(prompt, /Media paths:/);
  assert.match(prompt, /- \.\/a\.png/);
  assert.match(prompt, /Media URLs:/);
  assert.match(prompt, /https:\/\/example\.com\/b\.png/);
  assert.match(prompt, /Quoted message: Previous message/);
});

test("runModoroZaloAcpBoundTurn returns an error payload when ACP is disabled", async () => {
  const result = await runModoroZaloAcpBoundTurn({
    cfg: {
      channels: {
        "modoro-zalo": {
          acpx: {
            enabled: false,
          },
        },
      },
    },
    runtime: {} as never,
    accountId: "default",
    binding: {
      accountId: "default",
      conversationId: "user:42",
      sessionName: "modoro-zalo:default:abc123",
      sessionKey: "agent:codex:modoro-zalo-acp:abc123",
      agent: "codex",
      cwd: "/workspace",
      boundAt: Date.now(),
      updatedAt: Date.now(),
    },
    ctxPayload: {
      BodyForAgent: "hello",
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.text, "ACP is disabled for this account.");
});
