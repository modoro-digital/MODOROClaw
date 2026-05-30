import assert from "node:assert/strict";
import test from "node:test";
import { clearModoroZaloProbeCache, probeModoroZaloAuth } from "./probe.ts";

test("probeModoroZaloAuth caches successful probes", async () => {
  clearModoroZaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  const first = await probeModoroZaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  const second = await probeModoroZaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
});

test("probeModoroZaloAuth forceRefresh bypasses cache", async () => {
  clearModoroZaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  await probeModoroZaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  await probeModoroZaloAuth({
    account,
    forceRefresh: true,
    cacheTtlMs: 5_000,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(calls, 2);
});

test("probeModoroZaloAuth refreshes after cache expiration", async () => {
  clearModoroZaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  await probeModoroZaloAuth({
    account,
    cacheTtlMs: 500,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  await probeModoroZaloAuth({
    account,
    cacheTtlMs: 500,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(calls, 2);
});

test("probeModoroZaloAuth caches failures", async () => {
  clearModoroZaloProbeCache();
  let calls = 0;
  const runCommand = async () => {
    calls += 1;
    throw new Error("not logged in");
  };
  const account = {
    accountId: "default",
    profile: "default",
    zcaBinary: "openzca",
  };

  const first = await probeModoroZaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 1_000, runCommand: runCommand as never },
  });
  const second = await probeModoroZaloAuth({
    account,
    cacheTtlMs: 5_000,
    deps: { now: () => 2_000, runCommand: runCommand as never },
  });

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(calls, 1);
});
