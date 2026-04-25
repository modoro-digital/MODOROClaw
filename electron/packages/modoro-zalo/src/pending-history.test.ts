import assert from "node:assert/strict";
import test from "node:test";
import {
  appendModoroZaloPendingGroupHistoryEntry,
  buildModoroZaloPendingGroupHistoryKey,
  buildModoroZaloPendingHistoryContext,
  clearModoroZaloPendingGroupHistory,
  readModoroZaloPendingGroupHistoryEntries,
  resetModoroZaloPendingGroupHistoryForTests,
} from "./pending-history.ts";

test("pending group history keeps only the latest N entries", () => {
  resetModoroZaloPendingGroupHistoryForTests();
  const key = buildModoroZaloPendingGroupHistoryKey({
    accountId: "default",
    threadId: "group-1",
  });

  appendModoroZaloPendingGroupHistoryEntry({
    historyKey: key,
    limit: 2,
    nowMs: 10_000,
    entry: {
      sender: "A",
      body: "one",
      timestamp: 9_000,
      mediaPaths: [],
      mediaUrls: [],
      mediaTypes: [],
    },
  });
  appendModoroZaloPendingGroupHistoryEntry({
    historyKey: key,
    limit: 2,
    nowMs: 10_000,
    entry: {
      sender: "B",
      body: "two",
      timestamp: 9_200,
      mediaPaths: [],
      mediaUrls: [],
      mediaTypes: [],
    },
  });
  appendModoroZaloPendingGroupHistoryEntry({
    historyKey: key,
    limit: 2,
    nowMs: 10_000,
    entry: {
      sender: "C",
      body: "three",
      timestamp: 9_400,
      mediaPaths: [],
      mediaUrls: [],
      mediaTypes: [],
    },
  });

  const history = readModoroZaloPendingGroupHistoryEntries({
    historyKey: key,
    nowMs: 10_000,
  });
  assert.equal(history.length, 2);
  assert.equal(history[0]?.body, "two");
  assert.equal(history[1]?.body, "three");
});

test("pending group history prunes expired entries by ttl", () => {
  resetModoroZaloPendingGroupHistoryForTests();
  const key = buildModoroZaloPendingGroupHistoryKey({
    accountId: "default",
    threadId: "group-2",
  });

  appendModoroZaloPendingGroupHistoryEntry({
    historyKey: key,
    limit: 5,
    ttlMs: 1_000,
    nowMs: 5_000,
    entry: {
      sender: "A",
      body: "old",
      timestamp: 2_500,
      mediaPaths: [],
      mediaUrls: [],
      mediaTypes: [],
    },
  });
  appendModoroZaloPendingGroupHistoryEntry({
    historyKey: key,
    limit: 5,
    ttlMs: 1_000,
    nowMs: 5_000,
    entry: {
      sender: "B",
      body: "fresh",
      timestamp: 4_500,
      mediaPaths: [],
      mediaUrls: [],
      mediaTypes: [],
    },
  });

  const history = readModoroZaloPendingGroupHistoryEntries({
    historyKey: key,
    ttlMs: 1_000,
    nowMs: 5_400,
  });
  assert.equal(history.length, 1);
  assert.equal(history[0]?.body, "fresh");
});

test("pending history context wraps history before current message", () => {
  const context = buildModoroZaloPendingHistoryContext({
    entries: [
      {
        sender: "A",
        body: "older",
        timestamp: 1_000,
        mediaPaths: [],
        mediaUrls: [],
        mediaTypes: [],
      },
      {
        sender: "B",
        body: "newer",
        timestamp: 2_000,
        mediaPaths: [],
        mediaUrls: [],
        mediaTypes: [],
      },
    ],
    currentMessage: "current",
    formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
  });

  assert.match(context, /\[Chat messages since your last reply - for context\]/);
  assert.match(context, /A: older/);
  assert.match(context, /B: newer/);
  assert.match(context, /\[Current message\]/);
  assert.match(context, /current/);
});

test("clear removes history key", () => {
  resetModoroZaloPendingGroupHistoryForTests();
  const key = buildModoroZaloPendingGroupHistoryKey({
    accountId: "default",
    threadId: "group-3",
  });
  appendModoroZaloPendingGroupHistoryEntry({
    historyKey: key,
    limit: 2,
    entry: {
      sender: "A",
      body: "one",
      timestamp: 1_000,
      mediaPaths: [],
      mediaUrls: [],
      mediaTypes: [],
    },
  });

  clearModoroZaloPendingGroupHistory(key);
  const history = readModoroZaloPendingGroupHistoryEntries({ historyKey: key });
  assert.equal(history.length, 0);
});
