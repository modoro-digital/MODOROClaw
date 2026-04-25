import assert from "node:assert/strict";
import test from "node:test";
import {
  clearModoroZaloRuntimeHealthState,
  getModoroZaloRuntimeHealthState,
  markModoroZaloConnected,
  registerModoroZaloReconnectHandler,
  requestModoroZaloReconnect,
} from "./runtime-health.ts";

test("requestModoroZaloReconnect records degraded state and notifies handlers", () => {
  clearModoroZaloRuntimeHealthState();
  let reconnectReason = "";
  const dispose = registerModoroZaloReconnectHandler("default", (reason) => {
    reconnectReason = reason;
  });

  const requested = requestModoroZaloReconnect({
    accountId: "default",
    reason: "500 auth_unavailable: no auth available",
  });

  const state = getModoroZaloRuntimeHealthState("default");
  assert.equal(requested, true);
  assert.equal(reconnectReason, "500 auth_unavailable: no auth available");
  assert.equal(state?.connected, false);
  assert.equal(state?.lastError, "500 auth_unavailable: no auth available");

  dispose();
  clearModoroZaloRuntimeHealthState();
});

test("markModoroZaloConnected clears prior degraded state", () => {
  clearModoroZaloRuntimeHealthState();
  requestModoroZaloReconnect({
    accountId: "default",
    reason: "500 auth_unavailable: no auth available",
  });

  markModoroZaloConnected({
    accountId: "default",
    at: 42,
    reconnectAttempts: 0,
  });

  const state = getModoroZaloRuntimeHealthState("default");
  assert.equal(state?.connected, true);
  assert.equal(state?.lastConnectedAt, 42);
  assert.equal(state?.lastEventAt, 42);
  assert.equal(state?.lastError, null);
  assert.equal(state?.reconnectAttempts, 0);

  clearModoroZaloRuntimeHealthState();
});
