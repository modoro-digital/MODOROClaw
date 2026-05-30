import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPENZCA_LISTEN_ARGS } from "./listen-args.ts";
import {
  getOpenzcaCredentialsPath,
  sleepWithAbortOrCredentialChange,
} from "./monitor.ts";

test("openzca listen args use supervised raw mode", () => {
  assert.deepEqual(OPENZCA_LISTEN_ARGS, ["listen", "--raw", "--supervised"]);
  assert.equal(OPENZCA_LISTEN_ARGS.includes("--keep-alive"), false);
});

test("reconnect sleep wakes early when openzca credentials change", async () => {
  let reads = 0;
  const startedAt = Date.now();
  const result = await sleepWithAbortOrCredentialChange(
    1000,
    new AbortController().signal,
    () => (++reads >= 3 ? "v2" : "v1"),
    "v1",
    5,
  );

  assert.equal(result.reason, "credentials-changed");
  assert.equal(result.version, "v2");
  assert.ok(Date.now() - startedAt < 500);
});

test("openzca credentials path is profile-specific", () => {
  assert.match(
    getOpenzcaCredentialsPath("default", "C:\\Users\\CEO"),
    /[\\/]Users[\\/]CEO[\\/]\.openzca[\\/]profiles[\\/]default[\\/]credentials\.json$/,
  );
});

test("monitor resolves openzca self id only on first attempt or credentials change", async () => {
  // Each `openzca me id` triggers a full Zalo login via loginWithStoredCredentials.
  // Resolving on EVERY reconnect causes Zalo to rate-limit and displace the listener WS
  // (root cause of the v2.4.10 listener-flapping regression).
  //
  // Required contract:
  //   1. selfId is resolved on first attempt (selfId === undefined).
  //   2. selfId is re-resolved when credentials.json changes (account switch).
  //   3. selfId is NOT resolved on every reconnect when credentials are stable.
  const source = await readFile(new URL("./monitor.ts", import.meta.url), "utf8");

  assert.match(
    source,
    /lastSelfIdResolvedAtVersion/,
    "monitor must track which credentials version selfId was resolved against",
  );
  assert.match(
    source,
    /if\s*\(\s*selfId\s*===\s*undefined\s*\|\|\s*lastSelfIdResolvedAtVersion\s*!==\s*credentialsVersion\s*\)[\s\S]{0,400}?runOpenzcaCommand[\s\S]{0,200}?"me",\s*"id"/,
    "me id resolution must be guarded by `selfId === undefined || lastSelfIdResolvedAtVersion !== credentialsVersion`",
  );
});
