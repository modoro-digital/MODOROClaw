import assert from "node:assert/strict";
import test from "node:test";
import { runOpenzcaAccountCommand } from "./openzca-account.ts";
import {
  clearModoroZaloRuntimeHealthState,
  getModoroZaloRuntimeHealthState,
  registerModoroZaloReconnectHandler,
} from "./runtime-health.ts";

const account = {
  accountId: "default",
  enabled: true,
  configured: true,
  profile: "default",
  zcaBinary: "openzca",
  config: {},
};

test("runOpenzcaAccountCommand triggers reconnect on auth failures", async () => {
  clearModoroZaloRuntimeHealthState();
  let reconnectReason = "";
  const dispose = registerModoroZaloReconnectHandler("default", (reason) => {
    reconnectReason = reason;
  });

  await assert.rejects(
    runOpenzcaAccountCommand({
      account,
      binary: "openzca",
      profile: "default",
      args: ["msg", "send", "123", "hi"],
      deps: {
        runCommand: async () => {
          throw new Error("500 auth_unavailable: no auth available");
        },
      },
    }),
    /auth_unavailable/i,
  );

  const state = getModoroZaloRuntimeHealthState("default");
  assert.equal(reconnectReason, "500 auth_unavailable: no auth available");
  assert.equal(state?.connected, false);
  assert.equal(state?.lastError, "500 auth_unavailable: no auth available");

  dispose();
  clearModoroZaloRuntimeHealthState();
});

test("runOpenzcaAccountCommand ignores non-auth failures", async () => {
  clearModoroZaloRuntimeHealthState();
  let called = false;
  const dispose = registerModoroZaloReconnectHandler("default", () => {
    called = true;
  });

  await assert.rejects(
    runOpenzcaAccountCommand({
      account,
      binary: "openzca",
      profile: "default",
      args: ["msg", "send", "123", "hi"],
      deps: {
        runCommand: async () => {
          throw new Error("rate limited");
        },
      },
    }),
    /rate limited/i,
  );

  assert.equal(called, false);
  assert.equal(getModoroZaloRuntimeHealthState("default"), undefined);

  dispose();
  clearModoroZaloRuntimeHealthState();
});
