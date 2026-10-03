/**
 * A hook that reads a session's history should not cost memory and time proportional to the session. Pi's session
 * manager offers two generations of read: `getBranch` and `buildContextEntries` materialize every entry, while the
 * newer reads can answer from an index and return only what a caller asks for. pi-warden uses the newer reads when the
 * host has them and falls back to the older ones, so one build runs on both.
 */
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
/** What a bounded read asks for: an entry type, a message role, and how many of the newest matches to keep. */
export interface RecentEntriesOptions {
  /** Keep only entries of this type, such as `"message"` or `"custom_message"`. */
  type?: string;
  /** Keep only message entries whose role is this. */
  messageRole?: string;
  /** Keep at most this many of the newest matching entries. */
  limit?: number;
}

/** The reads the newer session API adds; each is absent on a host that has not adopted it. */
interface BoundedSessionManager {
  getRecentActiveEntries?(options?: RecentEntriesOptions): SessionEntry[];
  getActiveBranchMetadata?(): ReadonlyArray<{ id: string; type?: string; messageRole?: string }>;
  getActiveContextEntries?(): SessionEntry[];
  getLatestCustomEntry?(customType: string, options?: { scope?: "active" | "all" }): SessionEntry | undefined;
}

/** How much recent history a bounded read asks for: enough for the spine, the task, and one approval question. */
const HISTORY_WINDOW = 512;

type SessionManager = ExtensionContext["sessionManager"] & BoundedSessionManager;

const managerOf = (ctx: ExtensionContext): SessionManager => ctx.sessionManager as SessionManager;

/** The newest matching entries of the active branch, bounded when the host can bound them. */
export function recentEntries(ctx: ExtensionContext, options: RecentEntriesOptions = {}): SessionEntry[] {
  const manager = managerOf(ctx);
  if (typeof manager.getRecentActiveEntries === "function") return manager.getRecentActiveEntries({ limit: HISTORY_WINDOW, ...options });
  const branch = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  const matched = branch.filter((entry): entry is SessionEntry => {
    if (entry === undefined) return false;
    if (options.type !== undefined && entry.type !== options.type) return false;
    if (options.messageRole !== undefined) return entry.type === "message" && entry.message.role === options.messageRole;
    return true;
  });
  return options.limit === undefined ? matched : matched.slice(-options.limit);
}

/**
 * taskSpine input without forcing a whole branch on a host that can read metadata: the active ancestry's first user
 * request, plus its newest user turns. A request retracted by re-editing it in /tree stays in the session file but is
 * not on the active branch, so the goal is the request the branch holds now. A message entry without a role in its
 * metadata is hydrated to check it. On a host without the metadata read the whole branch is passed, which is what
 * taskSpine has always been given.
 */
export function spineEntries(ctx: ExtensionContext): SessionEntry[] {
  const manager = managerOf(ctx);
  if (typeof manager.getActiveBranchMetadata !== "function" || typeof manager.getEntry !== "function")
    return typeof manager.getBranch === "function" ? manager.getBranch() : [];
  const recent = recentEntries(ctx, { type: "message", messageRole: "user", limit: 16 });
  let first: SessionEntry | undefined;
  for (const meta of manager.getActiveBranchMetadata()) {
    if (meta.type !== "message" || (meta.messageRole !== undefined && meta.messageRole !== "user")) continue;
    const entry = manager.getEntry(meta.id);
    if (entry?.type === "message" && entry.message.role === "user") { first = entry; break; }
  }
  return first && !recent.some(entry => entry.id === first.id) ? [first, ...recent] : recent;
}

/**
 * The entries still in the model's context, compaction-aware when the host says so: text a compaction summarized is no
 * longer in context, so nothing may point to it. Falls back to buildContextEntries(), then the whole branch.
 */
export function activeContextEntries(ctx: ExtensionContext): SessionEntry[] {
  const manager = managerOf(ctx);
  if (typeof manager.getActiveContextEntries === "function") return manager.getActiveContextEntries();
  if (typeof manager.buildContextEntries === "function") return manager.buildContextEntries();
  return typeof manager.getBranch === "function" ? manager.getBranch() : [];
}

/** The newest custom message of one type on the active branch, when the host can answer that directly. */
export function latestCustomEntry(ctx: ExtensionContext, customType: string): SessionEntry | undefined {
  const manager = managerOf(ctx);
  if (typeof manager.getLatestCustomEntry === "function") return manager.getLatestCustomEntry(customType, { scope: "active" });
  const branch = typeof manager.getBranch === "function" ? manager.getBranch() : [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "custom_message" && entry.customType === customType) return entry;
  }
  return undefined;
}
