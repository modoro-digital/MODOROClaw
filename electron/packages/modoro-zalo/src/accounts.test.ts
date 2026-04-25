import assert from "node:assert/strict";
import test from "node:test";
import { resolveDefaultModoroZaloAccountId, resolveModoroZaloAccount } from "./accounts.ts";

test("resolveDefaultModoroZaloAccountId uses configured defaultAccount", () => {
  const cfg = {
    channels: {
      ["modoro-zalo"]: {
        defaultAccount: "work",
        accounts: {
          default: { profile: "default" },
          work: { profile: "work" },
        },
      },
    },
  };
  assert.equal(resolveDefaultModoroZaloAccountId(cfg), "work");
});

test("resolveModoroZaloAccount ignores defaultAccount marker while merging config", () => {
  const cfg = {
    channels: {
      ["modoro-zalo"]: {
        defaultAccount: "work",
        allowFrom: ["10001"],
        accounts: {
          work: { profile: "work" },
        },
      },
    },
  };
  const account = resolveModoroZaloAccount({
    cfg,
    accountId: "work",
  });
  assert.deepEqual(account.config.allowFrom, ["10001"]);
  assert.equal(account.profile, "work");
});

test("resolveModoroZaloAccount marks acpx-only config as explicit", () => {
  const account = resolveModoroZaloAccount({
    cfg: {
      channels: {
        ["modoro-zalo"]: {
          accounts: {
            default: {
              acpx: {
                enabled: false,
              },
            },
          },
        },
      },
    },
    accountId: "default",
  });

  assert.equal(account.configured, true);
});
