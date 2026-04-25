import assert from "node:assert/strict";
import test from "node:test";
import {
  doesModoroZaloCommandTargetDifferentBot,
  resolveModoroZaloCommandBody,
} from "./inbound-command.ts";

const ownMentionRegexes = [/@Thu(?:\b|$)/i];

test("resolveModoroZaloCommandBody strips own leading mention command", () => {
  assert.equal(
    resolveModoroZaloCommandBody({
      rawBody: "@Thu /new",
      mentionRegexes: ownMentionRegexes,
    }),
    "/new",
  );
});

test("resolveModoroZaloCommandBody strips attached own mention command", () => {
  assert.equal(
    resolveModoroZaloCommandBody({
      rawBody: "@Thu/new",
      mentionRegexes: ownMentionRegexes,
    }),
    "/new",
  );
});

test("resolveModoroZaloCommandBody keeps foreign leading mention command intact", () => {
  assert.equal(
    resolveModoroZaloCommandBody({
      rawBody: "@Mon /new",
      mentionRegexes: ownMentionRegexes,
    }),
    "@Mon /new",
  );
});

test("doesModoroZaloCommandTargetDifferentBot detects a foreign slash target", () => {
  assert.equal(
    doesModoroZaloCommandTargetDifferentBot({
      commandBody: "/new @Mon",
      mentionRegexes: ownMentionRegexes,
    }),
    true,
  );
});

test("doesModoroZaloCommandTargetDifferentBot allows an own slash target", () => {
  assert.equal(
    doesModoroZaloCommandTargetDifferentBot({
      commandBody: "/new @Thu",
      mentionRegexes: ownMentionRegexes,
    }),
    false,
  );
});

test("doesModoroZaloCommandTargetDifferentBot allows a bot user id target", () => {
  assert.equal(
    doesModoroZaloCommandTargetDifferentBot({
      commandBody: "/new @12345",
      mentionRegexes: ownMentionRegexes,
      botUserId: "12345",
    }),
    false,
  );
});

test("resolveModoroZaloCommandBody strips a spaced native mention from mention metadata", () => {
  assert.equal(
    resolveModoroZaloCommandBody({
      rawBody: "@Hà Thư /new",
      mentionRegexes: [],
      mentions: [{ uid: "bot-1", text: "@Hà Thư" }],
      botUserId: "bot-1",
    }),
    "/new",
  );
});

test("doesModoroZaloCommandTargetDifferentBot allows a spaced native slash target from mention metadata", () => {
  assert.equal(
    doesModoroZaloCommandTargetDifferentBot({
      commandBody: "/new @Hà Thư",
      mentionRegexes: [],
      mentions: [{ uid: "bot-1", text: "@Hà Thư" }],
      botUserId: "bot-1",
    }),
    false,
  );
});
