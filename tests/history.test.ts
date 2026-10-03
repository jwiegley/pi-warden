import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeContextEntries, latestCustomEntry, recentEntries, spineEntries } from "../src/history.js";
import { taskSpine } from "../src/shape.js";

/** A message entry as a host returns it once hydrated. */
const message = (id: string, role: "user" | "assistant", text: string) => ({ id, type: "message", message: { role, content: text } });
/** A custom message entry, the kind prefs and loops use. */
const custom = (id: string, customType: string, content: string) => ({ id, type: "custom_message", customType, content });

const contextWith = (sessionManager: Record<string, unknown>) => ({ sessionManager }) as unknown as ExtensionContext;

test("a bounded host is asked for a window and its whole branch is never hydrated", () => {
  const asked: Array<Record<string, unknown> | undefined> = [];
  const entries = [message("2", "user", "now the tests")];
  let branchCalls = 0;
  const ctx = contextWith({
    getRecentActiveEntries: (options?: Record<string, unknown>) => { asked.push(options); return entries; },
    getBranch: () => { branchCalls++; return [message("1", "user", "add a rate limiter")]; },
  });
  assert.deepEqual(recentEntries(ctx, { type: "message", messageRole: "user", limit: 1 }), entries);
  assert.deepEqual(asked, [{ type: "message", messageRole: "user", limit: 1 }], "the caller's limit wins over the default window");
  assert.deepEqual(recentEntries(ctx, { type: "message" }), entries);
  assert.deepEqual(asked.at(-1), { limit: 512, type: "message" }, "a call that names no window gets the bounded default");
  assert.equal(branchCalls, 0, "getBranch is not called at all");
});

test("a host without the bounded read keeps working, filtered and clamped to the window the caller asked for", () => {
  const branch = [
    { id: "0", type: "compaction", summary: "older work" },
    message("1", "user", "add a rate limiter"),
    message("2", "assistant", "here is the plan"),
    custom("3", "pi-warden-prefs", "prefer small diffs"),
    message("4", "user", "now the tests"),
  ];
  const ctx = contextWith({ getBranch: () => branch });
  assert.deepEqual(recentEntries(ctx, { type: "message", messageRole: "user", limit: 1 }).map(entry => entry.id), ["4"], "the newest matching entry");
  assert.deepEqual(recentEntries(ctx, { type: "message" }).map(entry => entry.id), ["1", "2", "4"], "every message, in branch order");
  assert.deepEqual(recentEntries(ctx, { limit: 2 }).map(entry => entry.id), ["3", "4"], "the newest entries of any type");
  assert.deepEqual(recentEntries(ctx).length, 5, "no options: the whole branch, as before");
  assert.deepEqual(recentEntries(contextWith({})), [], "a host with no read at all answers with nothing, not an error");
});

test("the spine's goal comes from the active ancestry, not from hydrating the branch", () => {
  const metadata = [
    { id: "a", type: "message", messageRole: "user" },
    { id: "b", type: "message", messageRole: "assistant" },
    { id: "c", type: "message", messageRole: "user" },
  ];
  const hydrated: Record<string, unknown> = {
    a: message("a", "user", "add a rate limiter"),
    b: message("b", "assistant", "here is the plan"),
    c: message("c", "user", "now the tests"),
  };
  const recent = [hydrated.b, hydrated.c];
  let branchCalls = 0;
  const ctx = contextWith({
    getActiveBranchMetadata: () => metadata,
    getEntry: (id: string) => hydrated[id],
    getRecentActiveEntries: () => recent,
    getBranch: () => { branchCalls++; return Object.values(hydrated); },
  });
  const entries = spineEntries(ctx);
  assert.deepEqual(entries.map((entry: { id: string }) => entry.id), ["a", "b", "c"], "the first user request leads, then the recent entries");
  assert.equal(branchCalls, 0);
  assert.equal(taskSpine(entries)?.goal, "add a rate limiter", "the goal is the branch's first user request");
  assert.equal(taskSpine(entries)?.task, "now the tests");

  // The same host, when the goal is already inside the recent window: it is not passed twice.
  const ctx2 = contextWith({
    getActiveBranchMetadata: () => metadata,
    getEntry: (id: string) => hydrated[id],
    getRecentActiveEntries: () => [hydrated.a, hydrated.b, hydrated.c],
    getBranch: () => [],
  });
  assert.deepEqual(spineEntries(ctx2).map((entry: { id: string }) => entry.id), ["a", "b", "c"]);

  // A metadata entry that says nothing about its role is hydrated to check it.
  const ctx3 = contextWith({
    getActiveBranchMetadata: () => [{ id: "x" }, { id: "y", type: "message", messageRole: "user" }],
    getEntry: (id: string) => (id === "x" ? message("x", "assistant", "hello there") : message("y", "user", "do the thing")),
    getRecentActiveEntries: () => [],
    getBranch: () => [],
  });
  assert.deepEqual(spineEntries(ctx3).map((entry: { id: string }) => entry.id), ["y"], "an assistant entry is not the goal");
});

test("a host without the metadata read gets the whole branch, exactly as taskSpine was always given", () => {
  const branch = [message("1", "user", "add a rate limiter"), message("2", "user", "now the tests")];
  const ctx = contextWith({ getBranch: () => branch });
  assert.deepEqual(spineEntries(ctx), branch);
  assert.deepEqual(spineEntries(contextWith({})), []);
});

test("context entries and the newest custom entry prefer the active-scoped reads", () => {
  const branch = [message("1", "user", "one"), message("2", "assistant", "two")];
  const active = [branch[1]];
  const ctx = contextWith({
    getActiveContextEntries: () => active,
    buildContextEntries: () => branch,
    getLatestCustomEntry: (customType: string, options?: unknown) => ({ ...custom("9", customType, "latest"), options }),
    getBranch: () => branch,
  });
  assert.deepEqual(activeContextEntries(ctx), active, "the active-context read wins over the compaction-unaware one");
  assert.deepEqual(activeContextEntries(contextWith({ buildContextEntries: () => branch, getBranch: () => branch })), branch);
  assert.deepEqual(activeContextEntries(contextWith({ getBranch: () => branch })), branch);
  assert.deepEqual(activeContextEntries(contextWith({})), []);
  assert.deepEqual((latestCustomEntry(ctx, "pi-warden-prefs") as unknown as { options?: unknown }).options, { scope: "active" }, "the helper asks the host for the active branch");
});

test("without the direct read, the newest custom entry is found by scanning the branch", () => {
  const branch = [custom("1", "pi-warden-prefs", "first"), custom("2", "pi-warden-loops", "other"), custom("3", "pi-warden-prefs", "second")];
  const ctx = contextWith({ getBranch: () => branch });
  assert.equal((latestCustomEntry(ctx, "pi-warden-prefs") as unknown as { content: string }).content, "second", "the newest of that type, not simply the last entry");
  assert.equal(latestCustomEntry(ctx, "pi-warden-absent"), undefined);
  assert.equal(latestCustomEntry(contextWith({}), "pi-warden-prefs"), undefined);
});
