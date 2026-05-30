import assert from "node:assert/strict";
import test from "node:test";
import { collectModoroZaloStatusIssues, resolveModoroZaloAccountState } from "./status.ts";

test("resolveModoroZaloAccountState handles disabled/configured transitions", () => {
  assert.equal(resolveModoroZaloAccountState({ enabled: false, configured: false }), "disabled");
  assert.equal(resolveModoroZaloAccountState({ enabled: true, configured: false }), "not configured");
  assert.equal(resolveModoroZaloAccountState({ enabled: true, configured: true }), "configured");
});

test("collectModoroZaloStatusIssues skips disabled accounts", () => {
  const issues = collectModoroZaloStatusIssues([
    {
      accountId: "default",
      enabled: false,
      configured: false,
      lastError: "ignored",
    },
  ]);
  assert.equal(issues.length, 0);
});

test("collectModoroZaloStatusIssues reports unconfigured accounts", () => {
  const issues = collectModoroZaloStatusIssues([
    {
      accountId: "default",
      enabled: true,
      configured: false,
    },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, "config");
  assert.match(issues[0]?.message ?? "", /not configured/i);
});

test("collectModoroZaloStatusIssues reports probe/runtime failures", () => {
  const issues = collectModoroZaloStatusIssues([
    {
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      probe: { ok: false, error: "auth expired" },
      lastError: "listener crashed",
    },
  ]);
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.kind, "runtime");
  assert.match(issues[0]?.message ?? "", /auth check failed/i);
  assert.equal(issues[1]?.kind, "runtime");
  assert.match(issues[1]?.message ?? "", /channel error/i);
});

test("collectModoroZaloStatusIssues reports disconnected runtime separately", () => {
  const issues = collectModoroZaloStatusIssues([
    {
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: false,
      reconnectAttempts: 2,
      lastError: "500 auth_unavailable: no auth available",
    },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.kind, "runtime");
  assert.match(issues[0]?.message ?? "", /disconnected/i);
  assert.match(issues[0]?.message ?? "", /reconnectAttempts=2/i);
  assert.match(issues[0]?.message ?? "", /no auth available/i);
});
