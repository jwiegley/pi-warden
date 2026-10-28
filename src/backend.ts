import type { AuthReport, BackendSpec, TypeSafeOptions } from "pi-typesafe";
import { DEFAULT_BACKEND, DECISIONS_BACKENDS, authState, backendHost, describeAuth, resolveBackend } from "pi-typesafe";

/** The judgment backend: a registry name ("typesafe", "openrouter", "commandcode") or a caller-supplied endpoint object. */
export type JudgmentBackend = BackendSpec;

/** The registry names a judgment backend setting may use; an endpoint object is never named by the environment. */
export const BACKEND_NAMES: readonly string[] = Object.keys(DECISIONS_BACKENDS);

/** The judgment destination as the config carries it, plus the refusal that turns judgments off when the configured value was refused. */
export interface BackendSetting {
  /** The spec judgments go to; undefined only when the configured value was refused. */
  readonly typesafeBackend: JudgmentBackend | undefined;
  /** Why the configured value was refused: the once-per-session notice and `/warden status` quote it. */
  readonly backendRefusal: string | undefined;
}

/** What a raw `typesafeBackend` value resolves to: the spec judgments go to, or the refusal that turns them off. Exactly one is set. */
export type BackendResolution =
  | { readonly typesafeBackend: JudgmentBackend; readonly backendRefusal?: undefined }
  | { readonly typesafeBackend?: undefined; readonly backendRefusal: string };

/** Why no judge is available: consent not given, the backend refused, no key for the backend, a saved 401 or 403, or the request budget spent. */
export type JudgmentsOffReason = "no_consent" | "bad_backend" | "no_key" | "key_rejected" | "budget";

/**
 * Resolve a raw config value to the spec judgments go to, kept as written, or to the refusal that turns judgments off.
 * pi-typesafe validates the spec again on every call. An unknown name or an object it refuses is never silently mapped
 * to the default backend: a mistyped value must not send judgments to api.typesafe.ai.
 */
export function resolveJudgmentBackend(raw: unknown): BackendResolution {
  if (raw === undefined || raw === null) return { typesafeBackend: DEFAULT_BACKEND };
  try {
    resolveBackend(raw as BackendSpec);
  } catch (error) {
    return { backendRefusal: error instanceof Error ? error.message : String(error) };
  }
  return { typesafeBackend: raw as JudgmentBackend };
}

/** The name messages show for a backend: the registry name, or an endpoint's validated label. */
export function backendName(backend: JudgmentBackend | undefined): string {
  return backend === undefined ? DEFAULT_BACKEND : typeof backend === "string" ? backend : resolveBackend(backend).label;
}

/**
 * How pi-warden names its own login in every hint: the command it registers for consent, a key, and the TypeSafe key
 * store. It reaches pi-typesafe as `loginHint`, because pi-warden uses pi-typesafe as a library and never loads the
 * extension that registers `/typesafe`, so every message pi-typesafe writes must name this command instead.
 */
export const LOGIN_HINT = "/warden enable";

/**
 * Whether `/warden enable` asks for and stores this backend's key, and so whether pi-warden judges with a key from
 * pi-typesafe's store for it. Only the TypeSafe key is ever asked for: every other backend's credential stays in the
 * environment, in that backend's own variable, so pi-warden never prompts for it, never writes it to disk, and never
 * judges with a key stored for it. That is policy, not a limit of pi-typesafe: from 0.12 on its login store keeps a key
 * for any backend and reads it once the variable is unset, and upstream pi-warden offers it for every registry name.
 * True only for "typesafe"; an endpoint object always names its own variable, and a refused backend (undefined) names
 * no store.
 */
export function loginStoresKey(backend: JudgmentBackend | undefined): boolean {
  return backend === DEFAULT_BACKEND;
}

/**
 * Why `/warden enable` cannot go on for this backend, or undefined when it can. A backend whose key lives only in the
 * environment needs its variable exported first; otherwise the command would leave the key to pi-typesafe's
 * `ensureApiKey`, which from 0.12 on prompts for any backend's key and stores it. The variable itself decides: a key
 * that some other pi-typesafe consumer stored for the backend, which 0.12 and later read after the variable, does not
 * count.
 */
export function enableKeyRefusal(backend: JudgmentBackend, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (loginStoresKey(backend)) return undefined;
  const { label, keyEnv } = resolveBackend(backend);
  if (env[keyEnv]?.trim()) return undefined;
  return `Cannot enable judgments: no ${label} key. Set ${keyEnv} in the environment; ${LOGIN_HINT} stores a TypeSafe key only.`;
}

/**
 * The key sentence of `/warden status`. Given pi-warden's login hint, pi-typesafe's describeAuth offers `/warden enable`
 * for every backend, which is right only for TypeSafe, the one key that command asks for. Every other backend's
 * sentence names its variable alone: a missing key waits for that variable, and a store other users can read asks for
 * the chmod and nothing more. A key pi-typesafe 0.12 and later would read from its store for that backend counts as
 * missing, because pi-warden judges such a backend with its variable alone; the sentence says that key is not used.
 */
export function describeKey(backend: JudgmentBackend): AuthReport {
  const state = authState({ backend, loginHint: LOGIN_HINT });
  if (loginStoresKey(backend)) return describeAuth(state, LOGIN_HINT);
  const { label, keyEnv } = resolveBackend(backend);
  const since = state.lastFailure ? ` Last failure: ${state.lastFailure.message}${state.lastFailure.at ? ` (${state.lastFailure.at})` : ""}` : "";
  const until = `every Jev judgment is skipped until ${keyEnv} is set in the environment`;
  if (state.kind === "missing") return { level: "error", text: `${label} key: missing — ${until}.${since}` };
  if (state.kind === "stored") return { level: "error", text: `${label} key: missing — ${until}. The key stored for ${label} in pi-typesafe/auth.json is not used.${since}` };
  if (state.kind === "unusable") return { level: "error", text: `${label} key: unusable (${withoutLoginStep(state.reason)}) — ${until}.${since}` };
  return describeAuth(state, LOGIN_HINT);
}

/** pi-typesafe's refusal of a store other users can read, without the step after chmod that names `/warden enable`. */
function withoutLoginStep(reason: string | undefined): string {
  if (reason === undefined) return "unknown reason";
  const step = `, then run ${LOGIN_HINT} again.`;
  return reason.endsWith(step) ? `${reason.slice(0, -step.length)}.` : reason;
}

/** One phrase naming where judgments go — the label, the host, and the model sent — for consent text and status lines. */
export function describeBackend(backend: JudgmentBackend | undefined): string {
  const resolved = resolveBackend(backend);
  return `${resolved.label} at ${backendHost(backend)}, model ${resolved.defaultModel ?? "none configured"}`;
}

/** Adapt the consent text to the active backend by substituting the destination host. */
export function disclosureFor(backend: JudgmentBackend | undefined, disclosure: string): string {
  return backend === undefined || backend === DEFAULT_BACKEND ? disclosure : disclosure.replace(backendHost(DEFAULT_BACKEND), backendHost(backend));
}

/**
 * Build the options forwarded to `createTypeSafe`.
 * The caller must gate on `authState({ backend }).usable` before calling `createTypeSafe`, and for a backend whose key
 * stays in the environment (loginStoresKey false) also on that key coming from its variable: with no apiKey here,
 * createTypeSafe reads the variable first and then falls back to a key stored for the backend, which pi-warden must not
 * use. The extension's judgmentsOffReason is that gate; it runs in the same synchronous step as createTypeSafe.
 * No transport: pi-typesafe 0.13.1 replays the body itself on Bun, which is the fix our own fetch restated.
 */
export function judgeOptions(config: { maxRequests: number; timeoutMs: number; typesafeBackend: JudgmentBackend }): TypeSafeOptions {
  return {
    maxRequests: config.maxRequests,
    timeoutMs: config.timeoutMs,
    loginHint: LOGIN_HINT,
    ...(config.typesafeBackend === DEFAULT_BACKEND ? {} : { backend: config.typesafeBackend }),
  };
}
