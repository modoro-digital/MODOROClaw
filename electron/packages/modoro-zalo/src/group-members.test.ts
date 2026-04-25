import assert from "node:assert/strict";
import test from "node:test";

type NormalizeModoroZaloGroupMembers = (payload: unknown) => Array<{
  id: string;
  name?: string;
  displayName?: string;
  zaloName?: string;
  raw?: unknown;
}>;

async function loadModule(): Promise<{
  normalizeModoroZaloGroupMembers: NormalizeModoroZaloGroupMembers;
}> {
  const loaded = (await import("./group-members.js").catch(() => ({}))) as {
    normalizeModoroZaloGroupMembers?: NormalizeModoroZaloGroupMembers;
  };
  assert.equal(typeof loaded.normalizeModoroZaloGroupMembers, "function");
  return {
    normalizeModoroZaloGroupMembers: loaded.normalizeModoroZaloGroupMembers!,
  };
}

test("preserves id, displayName, zaloName, and preferred name for openzca group members rows", async () => {
  const { normalizeModoroZaloGroupMembers } = await loadModule();

  assert.deepStrictEqual(
    normalizeModoroZaloGroupMembers([
      {
        userId: "123",
        displayName: "Alice Group Alias",
        zaloName: "Alice Nguyen",
      },
    ]),
    [
      {
        id: "123",
        name: "Alice Group Alias",
        displayName: "Alice Group Alias",
        zaloName: "Alice Nguyen",
        raw: {
          userId: "123",
          displayName: "Alice Group Alias",
          zaloName: "Alice Nguyen",
        },
      },
    ],
  );
});

test("keeps richer fields when the same member id appears multiple times", async () => {
  const { normalizeModoroZaloGroupMembers } = await loadModule();

  assert.deepStrictEqual(
    normalizeModoroZaloGroupMembers([
      { userId: "123", displayName: "Alice Alias" },
      { id: "123", zaloName: "Alice Nguyen" },
    ]),
    [
      {
        id: "123",
        name: "Alice Alias",
        displayName: "Alice Alias",
        zaloName: "Alice Nguyen",
        raw: { id: "123", zaloName: "Alice Nguyen" },
      },
    ],
  );
});

test("can read nested user fields when member rows are wrapped", async () => {
  const { normalizeModoroZaloGroupMembers } = await loadModule();

  assert.deepStrictEqual(
    normalizeModoroZaloGroupMembers([
      {
        user: {
          id: "456",
          displayName: "Bob Alias",
          username: "bob.nguyen",
        },
      },
    ]),
    [
      {
        id: "456",
        name: "Bob Alias",
        displayName: "Bob Alias",
        zaloName: "bob.nguyen",
        raw: {
          user: {
            id: "456",
            displayName: "Bob Alias",
            username: "bob.nguyen",
          },
        },
      },
    ],
  );
});
