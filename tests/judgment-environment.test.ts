import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { ConfigPanel } from "../src/panel.js";
import { judgmentsOffText } from "../src/extension.js";
import { buildAuditPrompt } from "../src/audit.js";
import { LOGIN_HINT } from "../src/backend.js";
import { authState, describeAuth } from "pi-typesafe";
import { ensureApiKey } from "pi-typesafe/ui";
import {
  BACKEND_ENV, DEFAULT_BACKEND_ENV, DEFAULT_CONSENT_ENV, UNREADABLE_REFUSAL, UNREADABLE_WRITE,
  applyBackendEnvironment, applyManagedDefaults, applyProjectOverrides, applyUserOverrides, backendSource, consentOrigin,
  consentWithdrawn, defaultConfig, explicitConsentNote, judgmentConsent, loadConfig, managedDefaultsSet,
  setUserSetting, userConfigPath, writeUserConfig,
} from "../src/config.js";

let temporary: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedConsent = process.env[DEFAULT_CONSENT_ENV];
const savedBackend = process.env[DEFAULT_BACKEND_ENV];
const savedBackendEnv = process.env[BACKEND_ENV];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/** A config as a deployment leaves it: consent on and a backend chosen, both recorded in the file or not. */
const managed: NodeJS.ProcessEnv = { [DEFAULT_CONSENT_ENV]: "1", [DEFAULT_BACKEND_ENV]: "openrouter" };

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "pi-warden-judgment-env-"));
  process.env.PI_CODING_AGENT_DIR = temporary;
});
beforeEach(() => {
  delete process.env[DEFAULT_CONSENT_ENV];
  delete process.env[DEFAULT_BACKEND_ENV];
  delete process.env[BACKEND_ENV];
});
after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedConsent === undefined) delete process.env[DEFAULT_CONSENT_ENV]; else process.env[DEFAULT_CONSENT_ENV] = savedConsent;
  if (savedBackend === undefined) delete process.env[DEFAULT_BACKEND_ENV]; else process.env[DEFAULT_BACKEND_ENV] = savedBackend;
  if (savedBackendEnv === undefined) delete process.env[BACKEND_ENV]; else process.env[BACKEND_ENV] = savedBackendEnv;
  await rm(temporary, { recursive: true, force: true });
});

test("managed defaults fill only what the user file leaves unset", () => {
  const defaults = defaultConfig();
  assert.equal(managedDefaultsSet(managed), true);
  assert.equal(managedDefaultsSet({}), false);

  const bare = applyManagedDefaults(defaults, undefined, managed);
  assert.equal(bare.typesafe, true, "the default consents when the file records no choice");
  assert.equal(bare.typesafeBackend, "openrouter", "the default backend applies when the file names none");

  const savedOff = applyUserOverrides(defaults, { typesafe: false });
  assert.equal(applyManagedDefaults(savedOff, { typesafe: false }, managed).typesafe, false, "a saved choice wins over the consent default");
  const savedNull = applyUserOverrides(defaults, { typesafe: null });
  assert.equal(applyManagedDefaults(savedNull, { typesafe: null }, managed).typesafe, true, "null records no choice");
  const savedBackend = applyUserOverrides(defaults, { typesafeBackend: "commandcode" });
  assert.equal(applyManagedDefaults(savedBackend, { typesafeBackend: "commandcode" }, managed).typesafeBackend, "commandcode", "a saved backend wins over the backend default");
  const backendNull = applyUserOverrides(defaults, { typesafeBackend: null });
  assert.equal(applyManagedDefaults(backendNull, { typesafeBackend: null }, managed).typesafeBackend, "openrouter", "null records no choice");

  const off = applyUserOverrides(defaults, { enabled: false });
  assert.equal(applyManagedDefaults(off, { enabled: false }, managed).typesafe, false, "a file that turns pi-warden off takes no default consent");
  assert.equal(applyManagedDefaults(off, { enabled: false }, managed).typesafeBackend, "openrouter", "the backend default sends nothing by itself");

  const none = applyManagedDefaults(defaults, undefined, {});
  assert.equal(none.typesafe, false);
  assert.equal(none.typesafeBackend, "typesafe");
});

test("PI_WARDEN_BACKEND replaces the file and the default, and a name it does not know refuses", async () => {
  const chosen = applyUserOverrides(defaultConfig(), { typesafeBackend: "commandcode" });
  assert.equal(applyBackendEnvironment(chosen, { [BACKEND_ENV]: "openrouter" }).typesafeBackend, "openrouter");
  assert.equal(applyBackendEnvironment(chosen, { [BACKEND_ENV]: "  " }).typesafeBackend, "commandcode", "blank keeps the file's choice");

  const refused = applyBackendEnvironment(chosen, { [BACKEND_ENV]: "smoke-test" });
  assert.equal(refused.typesafeBackend, undefined, "a refused name turns judgments off");
  assert.match(refused.backendRefusal ?? "", /PI_WARDEN_BACKEND must name one of/);
  assert.doesNotMatch(refused.backendRefusal ?? "", /smoke-test/, "the refusal never quotes the value");

  // The variable outranks both the file and the managed default, in the order loadConfig applies them.
  const path = userConfigPath();
  await mkdir(join(temporary, "pi-warden"), { recursive: true });
  await writeFile(path, JSON.stringify({ typesafe: true, typesafeBackend: "commandcode" }));
  try {
    const config = loadConfig({ env: { ...managed, [BACKEND_ENV]: "typesafe" } });
    assert.equal(config.typesafeBackend, "typesafe");
    assert.equal(config.typesafe, true, "the run's consent is untouched");

    const fromDefault = loadConfig({ env: managed });
    assert.equal(fromDefault.typesafeBackend, "commandcode", "without the variable the file wins over the default");
  } finally {
    await rm(path, { force: true });
  }
});

test("PI_WARDEN_ENABLED grants, withdraws, or defers, and a near-miss fails closed", () => {
  const consented = applyUserOverrides(defaultConfig(), { typesafe: true });
  const withheld = defaultConfig();

  for (const value of ["1", "true", "yes", "on", "ON"]) {
    assert.equal(judgmentConsent(withheld, { PI_WARDEN_ENABLED: value }), true, `${value} grants consent`);
    assert.equal(consentWithdrawn({ PI_WARDEN_ENABLED: value }), false);
  }
  for (const value of ["0", "off", "false", "no", "maybe"]) {
    assert.equal(judgmentConsent(consented, { PI_WARDEN_ENABLED: value }), false, `${value} withdraws consent`);
    assert.equal(consentWithdrawn({ PI_WARDEN_ENABLED: value }), true);
  }
  assert.equal(judgmentConsent(consented, {}), true, "blank defers to the loaded config");
  assert.equal(judgmentConsent(withheld, {}), false);
  assert.equal(consentWithdrawn({ PI_WARDEN_ENABLED: "  " }), false, "blank is not a withdrawal");

  assert.equal(consentOrigin(consented, { typesafe: true }, { PI_WARDEN_ENABLED: "1" }), "PI_WARDEN_ENABLED");
  assert.equal(consentOrigin(consented, { typesafe: true }, {}), "/warden enable");
  assert.equal(consentOrigin(consented, {}, managed), DEFAULT_CONSENT_ENV);
  assert.equal(consentOrigin(consented, { typesafe: true }, { PI_WARDEN_ENABLED: "off" }), undefined, "a withdrawn process has no origin to show");

  assert.match(explicitConsentNote(true, { PI_WARDEN_ENABLED: "off" }), /still withdraws consent/);
  assert.match(explicitConsentNote(false, { PI_WARDEN_ENABLED: "1" }), /still consents/);
  assert.equal(explicitConsentNote(true, {}), "", "no note when the variable agrees or is unset");
});

test("an unreadable user file refuses judgments while defaults stand, and no write replaces it", async () => {
  const path = userConfigPath();
  await mkdir(join(temporary, "pi-warden"), { recursive: true });
  const unreadable = "{ not json";
  await writeFile(path, unreadable);

  const config = loadConfig({ env: managed });
  assert.equal(config.backendRefusal, UNREADABLE_REFUSAL, "the refusal is the file itself");
  assert.equal(config.typesafeBackend, undefined);
  assert.equal(config.typesafe, false, "no default consent stands in for the file");
  assert.equal(loadConfig({ env: {} }).backendRefusal, undefined, "without managed defaults the file is read as before");
  assert.equal(backendSource({}, managed, config), undefined, "the unreadable file is the origin of its own refusal");

  await assert.rejects(async () => { writeUserConfig({ typesafe: true }); }, (error: unknown) => error instanceof Error && error.message === UNREADABLE_WRITE);
  await assert.rejects(async () => { setUserSetting("typesafe", true); }, (error: unknown) => error instanceof Error && error.message === UNREADABLE_WRITE);
  assert.equal(await readFile(path, "utf8"), unreadable, "the file is left exactly as it was");

  // A dangling link is not an absent file: it may be a settings file the user meant to keep.
  await rm(path, { force: true });
  await symlink(join(temporary, "missing.json"), path);
  assert.equal(loadConfig({ env: managed }).backendRefusal, UNREADABLE_REFUSAL);

  await rm(path, { force: true });
  await writeFile(path, JSON.stringify({ typesafe: false }));
  assert.equal(loadConfig({ env: managed }).backendRefusal, undefined, "a readable file is honored");
  assert.equal(writeUserConfig({ typesafe: true }), path, "and it can be written again");
});

test("a session snapshot decides whether the user file might exist, so an outside edit lands at the next session", async () => {
  const path = userConfigPath();
  await mkdir(join(temporary, "pi-warden"), { recursive: true });
  await writeFile(path, "{ not json");
  try {
    // The file was absent when the session read it: a file that appears later does not refuse judgments mid-session.
    const absent = loadConfig({ env: managed, userRaw: { value: undefined, mayExist: false } });
    assert.equal(absent.backendRefusal, undefined);
    assert.equal(absent.typesafe, true, "the managed defaults stand, as they did when the session started");
    assert.equal(absent.typesafeBackend, "openrouter");
    // The file could not be read when the session read it: removing it later does not let the defaults in mid-session.
    await rm(path, { force: true });
    assert.equal(loadConfig({ env: managed, userRaw: { value: undefined, mayExist: true } }).backendRefusal, UNREADABLE_REFUSAL);
    // A snapshot that does not say checks the file when the config loads.
    assert.equal(loadConfig({ env: managed, userRaw: { value: undefined } }).backendRefusal, undefined, "the file is gone now");
    await writeFile(path, "{ not json");
    assert.equal(loadConfig({ env: managed, userRaw: { value: undefined } }).backendRefusal, UNREADABLE_REFUSAL);
  } finally {
    await rm(path, { force: true });
  }
});

test("a project file may name only rules files inside the project", () => {
  const project = applyProjectOverrides(defaultConfig(), { rules: { files: ["notes.md", "/etc/passwd", "../outside.md", "docs/spec.md"] } });
  assert.deepEqual(project.rules.files, ["notes.md", "docs/spec.md"], "absolute and climbing entries are dropped");
  assert.equal(project.warnings.filter(warning => warning.includes("rules.files entry")).length, 2, "each dropped entry is named once");
  assert.ok(project.warnings.some(warning => warning.includes("/etc/passwd")), "the warning names what was dropped");

  const user = applyUserOverrides(defaultConfig(), { rules: { files: ["/etc/passwd"] } });
  assert.deepEqual(user.rules.files, ["/etc/passwd"], "the user file itself may name any path");
});

test("the config panel keeps a refused save pending and shows the reason", async () => {
  const path = userConfigPath();
  await mkdir(join(temporary, "pi-warden"), { recursive: true });
  await writeFile(path, "{ not json");

  const panel = new ConfigPanel(defaultConfig(), theme, { close: () => {}, unfocus: () => {} }, () => {});
  panel.handleInput("enter");
  panel.handleInput("s");
  assert.equal(await readFile(path, "utf8"), "{ not json", "a refused save leaves the file alone");
  assert.ok(panel.render(1000).join("\n").includes(UNREADABLE_WRITE), "the write refusal is visible in the panel notice");

  // Fixing the file by hand lets the same pending edit save.
  await rm(path, { force: true });
  panel.handleInput("s");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { enabled: false }, "the edit was still pending");
  assert.ok(!panel.render(1000).join("\n").includes(UNREADABLE_WRITE), "the reason is cleared");
});

test("the once-per-session notice says why judgments are off", () => {
  assert.match(
    judgmentsOffText("bad_backend", { typesafeBackend: undefined, backendRefusal: UNREADABLE_REFUSAL }, false),
    /cannot be read as a JSON object/,
    "an unreadable user file is reported as itself, not as a refused backend value",
  );
  const setting = { typesafeBackend: "typesafe" as const, backendRefusal: undefined };
  delete process.env.PI_WARDEN_ENABLED;
  assert.match(judgmentsOffText("no_consent", setting, false), /Run \/warden enable\./);
  process.env.PI_WARDEN_ENABLED = "off";
  try {
    assert.match(judgmentsOffText("no_consent", setting, false), /PI_WARDEN_ENABLED withdraws consent in this process/, "a withdrawn process is not told to run /warden enable");
  } finally {
    delete process.env.PI_WARDEN_ENABLED;
  }
});

test("every hint pi-warden writes names its own login, and pi-typesafe's text follows it", async () => {
  const setting = { typesafeBackend: "typesafe" as const, backendRefusal: undefined };
  assert.match(judgmentsOffText("no_key", setting, false), /or run \/warden enable\./);
  assert.doesNotMatch(judgmentsOffText("no_key", setting, false), /\/typesafe/);
  assert.match(judgmentsOffText("key_rejected", setting, false), /key saved by \/warden enable/);
  assert.doesNotMatch(judgmentsOffText("key_rejected", setting, false), /\/typesafe/);

  // pi-typesafe writes the status line and the login refusal; the hint is how they name pi-warden's command.
  const status = describeAuth(authState({ backend: "typesafe", loginHint: LOGIN_HINT }), LOGIN_HINT);
  assert.match(status.text, /\/warden enable or TYPESAFE_API_KEY/);
  assert.doesNotMatch(status.text, /\/typesafe/);
  const savedOpenrouter = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await assert.rejects(
      ensureApiKey({ hasUI: true } as never, { backend: "openrouter", loginHint: LOGIN_HINT }),
      (error: unknown) => error instanceof Error && /\/warden enable stores a TypeSafe key only/.test(error.message),
    );
  } finally {
    if (savedOpenrouter === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = savedOpenrouter;
  }

  // The audit prompt asks for a tool pi-warden does not load, and no longer sends the agent after a command that is not there.
  assert.doesNotMatch(buildAuditPrompt(process.cwd(), []), /\/typesafe/);
});
