import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveModoroZaloGroupCommandAuthorizers,
  resolveModoroZaloGroupToolPolicy,
  resolveModoroZaloToolsBySender,
} from "./policy.ts";

test("group command authorizers require explicit allowlists", () => {
  const result = resolveModoroZaloGroupCommandAuthorizers({
    senderId: "1471383327500481391",
    ownerAllowFrom: [],
    groupConfig: {
      requireMention: true,
    },
  });

  assert.deepEqual(result, {
    owner: { configured: false, allowed: false },
    group: { configured: false, allowed: false },
  });
});

test("group command authorizers allow owner allowFrom entries", () => {
  const result = resolveModoroZaloGroupCommandAuthorizers({
    senderId: "1471383327500481391",
    ownerAllowFrom: ["1471383327500481391"],
    groupConfig: {
      requireMention: true,
    },
  });

  assert.deepEqual(result, {
    owner: { configured: true, allowed: true },
    group: { configured: false, allowed: false },
  });
});

test("group command authorizers allow group-level allowFrom entries", () => {
  const result = resolveModoroZaloGroupCommandAuthorizers({
    senderId: "1471383327500481391",
    ownerAllowFrom: [],
    groupConfig: {
      allowFrom: ["1471383327500481391"],
    },
  });

  assert.deepEqual(result, {
    owner: { configured: false, allowed: false },
    group: { configured: true, allowed: true },
  });
});

test("toolsBySender supports exact match and wildcard", () => {
  const exact = resolveModoroZaloToolsBySender({
    toolsBySender: {
      "1471383327500481391": { allow: ["group:messaging"] },
      "*": { deny: ["group:fs"] },
    },
    senderId: "1471383327500481391",
  });
  assert.deepEqual(exact, { allow: ["group:messaging"] });

  const wildcard = resolveModoroZaloToolsBySender({
    toolsBySender: {
      "1471383327500481391": { allow: ["group:messaging"] },
      "*": { deny: ["group:fs"] },
    },
    senderId: "someone-else",
  });
  assert.deepEqual(wildcard, { deny: ["group:fs"] });
});

test("group tool policy precedence: group sender override > group tools > wildcard sender override > wildcard tools", () => {
  const groupSenderPolicy = resolveModoroZaloGroupToolPolicy({
    senderId: "1471383327500481391",
    groupConfig: {
      tools: { deny: ["group:runtime"] },
      toolsBySender: {
        "1471383327500481391": { allow: ["group:messaging"] },
      },
    },
    wildcardConfig: {
      toolsBySender: {
        "*": { deny: ["group:fs"] },
      },
      tools: { allow: ["group:search"] },
    },
  });
  assert.deepEqual(groupSenderPolicy, { allow: ["group:messaging"] });

  const groupToolsFallback = resolveModoroZaloGroupToolPolicy({
    senderId: "someone-else",
    groupConfig: {
      tools: { deny: ["group:runtime"] },
      toolsBySender: {
        "1471383327500481391": { allow: ["group:messaging"] },
      },
    },
    wildcardConfig: {
      toolsBySender: {
        "*": { deny: ["group:fs"] },
      },
      tools: { allow: ["group:search"] },
    },
  });
  assert.deepEqual(groupToolsFallback, { deny: ["group:runtime"] });

  const wildcardSenderFallback = resolveModoroZaloGroupToolPolicy({
    senderId: "anyone",
    groupConfig: undefined,
    wildcardConfig: {
      toolsBySender: {
        "*": { deny: ["group:fs"] },
      },
      tools: { allow: ["group:search"] },
    },
  });
  assert.deepEqual(wildcardSenderFallback, { deny: ["group:fs"] });
});
