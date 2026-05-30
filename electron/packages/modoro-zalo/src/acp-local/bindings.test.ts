import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModoroZaloAcpBindingRecord,
  listModoroZaloAcpBindings,
  removeModoroZaloAcpBinding,
  resolveModoroZaloAcpBinding,
  upsertModoroZaloAcpBinding,
} from "./bindings.ts";

async function makeStateDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("createModoroZaloAcpBindingRecord derives stable session identifiers", () => {
  const first = createModoroZaloAcpBindingRecord({
    accountId: "default",
    conversationId: "group:123",
    agent: "Codex Main",
    cwd: "/workspace",
    now: 100,
  });
  const second = createModoroZaloAcpBindingRecord({
    accountId: "default",
    conversationId: "group:123",
    agent: "Other Agent",
    cwd: "/workspace",
    now: 200,
  });

  assert.equal(first.sessionName, second.sessionName);
  assert.match(first.sessionName, /^modoro-zalo:default:[a-f0-9]{16}$/);
  assert.match(first.sessionKey, /^agent:codex-main:modoro-zalo-acp:[a-f0-9]{16}$/);
  assert.match(second.sessionKey, /^agent:other-agent:modoro-zalo-acp:[a-f0-9]{16}$/);
});

test("binding store round-trips records through stateDir", async (t) => {
  const stateDir = await makeStateDir("modoro-zalo-acp-bindings-");
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

  const resolved = await resolveModoroZaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.deepEqual(resolved, record);

  const listed = await listModoroZaloAcpBindings({ stateDir });
  assert.deepEqual(listed, [record]);

  const removed = await removeModoroZaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.deepEqual(removed, record);

  const afterRemove = await resolveModoroZaloAcpBinding({
    stateDir,
    accountId: "default",
    conversationId: "user:42",
  });
  assert.equal(afterRemove, null);
});
