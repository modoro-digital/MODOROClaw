import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isKnownZaloNonFriend,
  readZaloStrangerPolicy,
  shouldBypassZaloDmAllowlistForStranger,
} from "./dm-policy.ts";

async function makeZaloPolicyFixture(policy: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "modoro-zalo-dm-policy-"));
  const workspace = path.join(root, "workspace");
  const friendsDir = path.join(root, ".openzca", "profiles", "default", "cache");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(friendsDir, { recursive: true });
  await fs.writeFile(path.join(workspace, "zalo-stranger-policy.json"), JSON.stringify({ mode: policy }));
  await fs.writeFile(
    path.join(friendsDir, "friends.json"),
    JSON.stringify([{ userId: "friend-1", displayName: "Known Friend" }]),
  );
  return { root, workspace };
}

test("stranger policy is read from workspace mode", async () => {
  const fixture = await makeZaloPolicyFixture("reply");
  try {
    assert.equal(readZaloStrangerPolicy({ workspaceDirs: [fixture.workspace] }), "reply");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("known non-friends bypass DM allowlist only when stranger replies are enabled", async () => {
  const fixture = await makeZaloPolicyFixture("reply");
  try {
    assert.equal(isKnownZaloNonFriend("stranger-1", { homeDir: fixture.root }), true);
    assert.equal(
      shouldBypassZaloDmAllowlistForStranger("stranger-1", {
        homeDir: fixture.root,
        workspaceDirs: [fixture.workspace],
      }),
      true,
    );
    assert.equal(
      shouldBypassZaloDmAllowlistForStranger("friend-1", {
        homeDir: fixture.root,
        workspaceDirs: [fixture.workspace],
      }),
      false,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("known non-friends do not bypass DM allowlist when stranger policy ignores them", async () => {
  const fixture = await makeZaloPolicyFixture("ignore");
  try {
    assert.equal(
      shouldBypassZaloDmAllowlistForStranger("stranger-1", {
        homeDir: fixture.root,
        workspaceDirs: [fixture.workspace],
      }),
      false,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
