/**
 * Assisted-login primitive (U6 / origin B2). Drives a target's login form ONCE, captures the
 * resulting session state, and returns it for the vault to persist (KTD-3). It is an operator-only
 * internal primitive — deliberately NOT an MCP tool (KTD-5): the consumer agent can't self-serve a
 * login capture. It is triggered operator-side (U8 `obscura vault login`) through the gateway's
 * `openConsumerSession` path, so the navigation guard is already installed and the flow stays
 * host-scoped below the verb layer.
 *
 * Recipe-driven, not heuristic: because it is operator-supplied, the caller provides the field
 * selectors and a success condition rather than the primitive guessing them — deterministic, with no
 * brittle "which input is the username" inference. The bug-prone orchestration (async-field polling,
 * the credential→2FA ordering, judging success on the SETTLED authenticated DOM rather than an
 * interim navigation status) is written against the {@link LoginDriver} abstraction so it is
 * exercised here without a browser; {@link coreLoginDriver} is the thin real adapter, proven live by
 * `scripts/validate-assisted-login.mjs`.
 */
import type { BrowserCore, FieldState, StorageState } from "../browser/index.js";
import { generateTotp } from "./totp.js";

/** Bounded window to wait for an async-rendered login/2FA field before giving up (fail closed). */
export const DEFAULT_FIELD_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for a field to render. */
export const DEFAULT_FIELD_POLL_MS = 250;

/**
 * Operator-supplied login description. Selectors are raw CSS/text selectors (the drive escape hatch),
 * since the operator knows the target's form. A success condition is REQUIRED — at least one of
 * {@link successText}/{@link successSelector} — because success is judged on the page, never on a
 * navigation status (a login error often 200s on the same URL).
 */
export interface LoginRecipe {
  loginUrl: string;
  /** Selector for the username/email input. */
  usernameField: string;
  /** Selector for the password input. */
  passwordField: string;
  /** Selector for the control that submits the credentials. */
  submit: string;
  /** Selector for the 2FA code input, present only when the target prompts for a second factor. */
  totpField?: string;
  /** Selector for the 2FA submit control; defaults to {@link submit} when omitted. */
  totpSubmit?: string;
  /** Text that appears on the authenticated, settled page. */
  successText?: string;
  /** Selector that exists ONLY once authenticated (e.g. a sign-out link). */
  successSelector?: string;
}

/** The secret material a login consumes. The TOTP seed is present only for 2FA-protected targets. */
export interface LoginCredentials {
  username: string;
  password: string;
  totpSeed?: string;
}

export interface AssistedLoginOptions {
  /** Override the per-field render window (default {@link DEFAULT_FIELD_TIMEOUT_MS}). */
  fieldTimeoutMs?: number;
  /** Override the field poll interval (default {@link DEFAULT_FIELD_POLL_MS}). */
  pollIntervalMs?: number;
  /** Pin the TOTP time (Unix seconds) — a deterministic-test hook; omitted = now. */
  totpAtSeconds?: number;
  /**
   * Skip the initial `navigate(loginUrl)` — the caller has ALREADY landed the login page. The gateway
   * login-runner uses this: it does the first navigate itself so it can run the direct-first /
   * escalate-on-block proxy decision (R7) and apply the right clearance budget before handing a
   * landed, committed-exit session to the login flow. Default false (the primitive navigates).
   */
  skipInitialNavigate?: boolean;
}

export interface AssistedLoginResult {
  /** The captured session state for the vault to persist + replay. */
  state: StorageState;
}

/**
 * The browser operations the orchestration needs, abstracted so the flow is unit-testable without a
 * real browser. {@link coreLoginDriver} adapts a {@link BrowserCore}; tests pass a scripted fake.
 */
export interface LoginDriver {
  navigate(url: string): Promise<void>;
  /** Tri-state read of a field — present? + current value (see {@link FieldState}). */
  readField(target: string): Promise<FieldState>;
  /** Type `text` into the field, replacing any current value. Does NOT submit. */
  fill(target: string, text: string): Promise<void>;
  /** Activate the submit control and let the page settle. */
  submit(target: string): Promise<void>;
  /** The settled page's visible text — the surface the success judge reads. */
  settledText(): Promise<string>;
  /** Whether an element matching `target` exists on the settled page. */
  hasElement(target: string): Promise<boolean>;
  /** Serialize the now-authenticated session state for the vault. */
  captureState(): Promise<StorageState>;
  /** Sleep `ms` between polls (real adapter waits; the fake can resolve instantly). */
  wait(ms: number): Promise<void>;
}

/**
 * Sleep one poll step, CLAMPED to the time left in the window, and return the new elapsed total.
 * Without the clamp `fieldTimeoutMs` is not a true upper bound — a loop checks the deadline then
 * sleeps the full `pollIntervalMs`, overshooting by up to one interval (and the real core caps a
 * single wait at 60s, so a large interval blocks far past the configured timeout). Callers invoke
 * this only while `waited < fieldTimeoutMs`, so the step is always > 0 and the loop still advances.
 */
async function sleepStep(
  driver: LoginDriver,
  waited: number,
  fieldTimeoutMs: number,
  pollIntervalMs: number,
): Promise<number> {
  const step = Math.min(pollIntervalMs, fieldTimeoutMs - waited);
  await driver.wait(step);
  return waited + step;
}

/** Poll a field into existence within the bounded window, returning its final {@link FieldState}
 *  (which may still be `present: false` if it never rendered). */
async function pollField(
  driver: LoginDriver,
  target: string,
  fieldTimeoutMs: number,
  pollIntervalMs: number,
): Promise<FieldState> {
  let waited = 0;
  let state = await driver.readField(target);
  while (!state.present && waited < fieldTimeoutMs) {
    waited = await sleepStep(driver, waited, fieldTimeoutMs, pollIntervalMs);
    state = await driver.readField(target);
  }
  return state;
}

/** Wait for `target` to render, then fill it ONLY if empty (a pre-filled value — browser-remembered
 *  — is left intact). Throws a clear, secret-free error if the field never renders. */
async function fillWhenReady(
  driver: LoginDriver,
  target: string,
  value: string,
  label: string,
  fieldTimeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const state = await pollField(driver, target, fieldTimeoutMs, pollIntervalMs);
  if (!state.present) {
    throw new Error(`the ${label} field never rendered within ${fieldTimeoutMs}ms`);
  }
  if (state.value === "") await driver.fill(target, value);
}

/** Success = every CONFIGURED condition holds on the settled page (AND). Judged on the DOM, never on
 *  a navigation status. At least one condition is guaranteed configured by {@link assistedLogin}. */
async function judgeSuccess(driver: LoginDriver, recipe: LoginRecipe): Promise<boolean> {
  if (recipe.successSelector && !(await driver.hasElement(recipe.successSelector))) return false;
  if (recipe.successText && !(await driver.settledText()).includes(recipe.successText)) return false;
  return true;
}

/**
 * Poll the success condition within the bounded window. A submit can complete via fetch / client-side
 * render, so the authenticated DOM is NOT necessarily present the instant `submit()` returns — a
 * one-shot judge would misread an async (SPA) login as failed. Returns true as soon as success holds,
 * false if the window elapses.
 */
async function pollSuccess(
  driver: LoginDriver,
  recipe: LoginRecipe,
  fieldTimeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  let waited = 0;
  for (;;) {
    if (await judgeSuccess(driver, recipe)) return true;
    if (waited >= fieldTimeoutMs) return false;
    waited = await sleepStep(driver, waited, fieldTimeoutMs, pollIntervalMs);
  }
}

/**
 * After a credential submit the page resolves — possibly asynchronously — to EITHER the authenticated
 * state OR a 2FA gate. Poll for whichever lands first within the window, checking success before the
 * 2FA field each round so a straight-to-dashboard login wins. `"neither"` = the window elapsed with
 * no resolution (e.g. rejected credentials), surfaced as a failed login by the caller.
 */
async function settleAfterSubmit(
  driver: LoginDriver,
  recipe: LoginRecipe,
  totpField: string | undefined,
  fieldTimeoutMs: number,
  pollIntervalMs: number,
): Promise<"success" | "twofa" | "neither"> {
  let waited = 0;
  for (;;) {
    if (await judgeSuccess(driver, recipe)) return "success";
    if (totpField && (await driver.readField(totpField)).present) return "twofa";
    if (waited >= fieldTimeoutMs) return "neither";
    waited = await sleepStep(driver, waited, fieldTimeoutMs, pollIntervalMs);
  }
}

/**
 * Drive `recipe` to completion against `driver` and return the captured session state.
 *
 * Flow: navigate → fill username + password (each polled into existence, filled only when empty) →
 * submit. Judge success on the settled DOM; only if NOT yet authenticated AND the recipe declares a
 * 2FA field do we poll for it, fill a generated TOTP code, and submit again — so a no-2FA target
 * never pays the 2FA wait. A final failed judge throws (credentials rejected / unhandled step)
 * rather than capturing a half-authenticated state. Errors are secret-free; no code or credential is
 * ever logged here.
 */
export async function assistedLogin(
  driver: LoginDriver,
  recipe: LoginRecipe,
  creds: LoginCredentials,
  opts: AssistedLoginOptions = {},
): Promise<AssistedLoginResult> {
  if (!recipe.successText && !recipe.successSelector) {
    throw new Error("login recipe needs a success condition (successText or successSelector)");
  }
  const fieldTimeoutMs = opts.fieldTimeoutMs ?? DEFAULT_FIELD_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_FIELD_POLL_MS;
  // Guard the poll loops: a non-positive or non-finite interval never advances `waited`, so the bound
  // would never be reached — validate up front rather than spin forever on a bad override.
  if (!Number.isFinite(fieldTimeoutMs) || fieldTimeoutMs < 0) {
    throw new Error("assisted login: fieldTimeoutMs must be a finite, non-negative number");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("assisted login: pollIntervalMs must be a finite, positive number");
  }
  // Bind once so TS keeps it narrowed to `string` across the awaits in the 2FA branch below.
  const totpField = recipe.totpField;

  if (!opts.skipInitialNavigate) await driver.navigate(recipe.loginUrl);
  await fillWhenReady(driver, recipe.usernameField, creds.username, "username", fieldTimeoutMs, pollIntervalMs);
  await fillWhenReady(driver, recipe.passwordField, creds.password, "password", fieldTimeoutMs, pollIntervalMs);
  await driver.submit(recipe.submit);

  // Wait (within the window) for the post-submit page to resolve to authenticated OR a 2FA gate —
  // SPA-safe, since the DOM may update asynchronously after submit() returns.
  const phase = await settleAfterSubmit(driver, recipe, totpField, fieldTimeoutMs, pollIntervalMs);
  let success = phase === "success";
  if (phase === "twofa" && totpField) {
    if (!creds.totpSeed) {
      throw new Error("the target prompted for a 2FA code but no TOTP seed is configured for this entry");
    }
    const totp = await driver.readField(totpField); // settleAfterSubmit confirmed it is present
    if (totp.value === "") {
      await driver.fill(totpField, generateTotp(creds.totpSeed, opts.totpAtSeconds));
    }
    await driver.submit(recipe.totpSubmit ?? recipe.submit);
    // The 2FA submit can also render the dashboard asynchronously — poll, don't one-shot.
    success = await pollSuccess(driver, recipe, fieldTimeoutMs, pollIntervalMs);
  }
  if (!success) {
    throw new Error(
      "assisted login did not reach the authenticated page — credentials were rejected or a login step was not handled",
    );
  }
  return { state: await driver.captureState() };
}

/**
 * Adapt a {@link BrowserCore}'s drive surface to a {@link LoginDriver}. `fill`/`submit` map to the
 * core's `type`(no-submit)/`click`, which settle the page internally; `settledText` reads the
 * post-settle accessibility tree, the surface the success judge matches against.
 */
export function coreLoginDriver(core: BrowserCore): LoginDriver {
  return {
    async navigate(url) {
      await core.navigate(url);
    },
    readField(target) {
      return core.readField({ target });
    },
    async fill(target, text) {
      await core.type({ target }, text, { submit: false });
    },
    async submit(target) {
      await core.click({ target });
    },
    async settledText() {
      return (await core.snapshot()).tree;
    },
    async hasElement(target) {
      return (await core.readField({ target })).present;
    },
    captureState() {
      return core.captureStorageState();
    },
    async wait(ms) {
      await core.waitFor({ timeMs: ms });
    },
  };
}
