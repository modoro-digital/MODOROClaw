import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModoroZaloOutboundTarget,
  normalizeModoroZaloMessagingTarget,
  resolveModoroZaloDirectPeerId,
} from "./normalize.ts";

test("resolveModoroZaloDirectPeerId prefers sender when dmPeerId is group alias", () => {
  const resolved = resolveModoroZaloDirectPeerId({
    dmPeerId: "g-1471383327500481391",
    senderId: "1471383327500481391",
    toId: "self-1",
    threadId: "g-1471383327500481391",
  });

  assert.equal(resolved, "1471383327500481391");
});

test("resolveModoroZaloDirectPeerId supports user aliases", () => {
  const resolved = resolveModoroZaloDirectPeerId({
    dmPeerId: "modoro-zalo:user:20002",
    senderId: "10001",
  });

  assert.equal(resolved, "20002");
});

test("resolveModoroZaloDirectPeerId falls back to id when only group alias is available", () => {
  const resolved = resolveModoroZaloDirectPeerId({
    dmPeerId: "modoro-zalo:g-20002",
  });

  assert.equal(resolved, "20002");
});

test("formatModoroZaloOutboundTarget uses explicit user/group prefixes", () => {
  const direct = formatModoroZaloOutboundTarget({
    threadId: "20002",
    isGroup: false,
  });
  const group = formatModoroZaloOutboundTarget({
    threadId: "30003",
    isGroup: true,
  });

  assert.equal(direct, "user:20002");
  assert.equal(group, "group:30003");
});

test("normalizeModoroZaloMessagingTarget accepts ozl prefix", () => {
  const normalized = normalizeModoroZaloMessagingTarget("ozl:group:888");
  assert.equal(normalized, "group:888");
});
