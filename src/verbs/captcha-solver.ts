/**
 * Concrete {@link CaptchaSolver} backed by a hosted solving service that speaks the standard
 * `createTask` / `getTaskResult` request/poll task API (a protocol several hosted solving services
 * implement). Vendor-NEUTRAL on purpose: the endpoint is configuration (`BGW_CAPTCHA_API_URL`), the
 * key is a BYO secret (`BGW_CAPTCHA_API_KEY`), and the task-type vocabulary below is the shared
 * protocol — so swapping providers (or adding a second one for a captcha type the first doesn't serve)
 * is a config change, not a code change. No provider is named in this repo (public).
 *
 * Solves return a response TOKEN (reCAPTCHA `g-recaptcha-response`, Turnstile `cf-turnstile-response`,
 * hCaptcha `h-captcha-response`) — these are NOT IP-bound, so the solve is proxyless and the token
 * verifies after the page submits it. (CF *managed challenges* are a different tier handled by
 * residential-proxy escalation, not this solver.)
 *
 * Failure discipline (R8): every failure is a typed {@link CaptchaSolveError}, never a hang — a hard
 * deadline bounds the whole solve AND each individual HTTP request (via AbortController), so a stalled
 * vendor connection can't outlive the deadline. The API key is sent only in the request body and
 * never appears in an error message or log (R9).
 */
import type { SecretStore } from "../security/index.js";
import type { CaptchaChallenge, CaptchaKind, CaptchaSolver } from "../browser/captcha.js";
import { CAPTCHA_SOLVE_ERROR_CODES } from "../browser/captcha.js";

/** Standard task-type vocabulary for the createTask/getTaskResult protocol; proxyless token solves. */
const TASK_TYPE: Record<CaptchaKind, string | undefined> = {
  recaptcha: "ReCaptchaV2TaskProxyLess",
  turnstile: "AntiTurnstileTaskProxyLess",
  hcaptcha: "HCaptchaTaskProxyLess",
  unknown: undefined,
};

/** The task type this solver maps a kind to, or undefined if it can't solve it (issue #44). The single
 *  source of truth for solve support — `browser/captcha.isSolvableCaptchaKind` mirrors it (it can't import
 *  from this verbs layer), and a unit test asserts the two never diverge. */
export function solverTaskTypeFor(kind: CaptchaKind): string | undefined {
  return TASK_TYPE[kind];
}

// The known, non-secret solver error codes live with the CaptchaSolver contract (browser/captcha) so the
// browser core can allowlist them without a verbs->browser->verbs import cycle.
export type CaptchaSolveErrorCode = (typeof CAPTCHA_SOLVE_ERROR_CODES)[number];

export class CaptchaSolveError extends Error {
  readonly code: CaptchaSolveErrorCode;
  constructor(code: CaptchaSolveErrorCode, message: string) {
    super(message);
    this.name = "CaptchaSolveError";
    this.code = code;
  }
}

export interface HttpCaptchaSolverConfig {
  /** Solving-service base URL (createTask/getTaskResult posted here). From `BGW_CAPTCHA_API_URL`. */
  apiUrl: string;
  /** BYO solving-service key. From `BGW_CAPTCHA_API_KEY` (SecretStore). */
  apiKey: string;
  /** Hard deadline for a single solve (createTask + polling), ms. Default 120s. */
  timeoutMs?: number;
  /** Poll interval for getTaskResult, ms. Default 3s. */
  pollMs?: number;
  /** Per-window solve budget — refuse once `maxSolves` solves START within `windowMs`. Default: none. */
  budget?: { maxSolves: number; windowMs: number };
  /** Injected fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 3_000;

/**
 * Conservative default solve budget — a cost guard so a hostile/looping page can't run up spend. A
 * legitimate drive flow rarely hits more than one or two CAPTCHAs; 5 per minute leaves headroom while
 * capping a runaway. Shared by both entrypoints so the two can't drift.
 */
export const DEFAULT_CAPTCHA_BUDGET = { maxSolves: 5, windowMs: 60_000 } as const;

export class HttpCaptchaSolver implements CaptchaSolver {
  readonly #apiUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  readonly #budget?: { maxSolves: number; windowMs: number };
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** Solve start timestamps, kept only within the budget window (sliding-window rate limit). */
  #starts: number[] = [];

  constructor(config: HttpCaptchaSolverConfig) {
    this.#apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.#apiKey = config.apiKey;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#pollMs = config.pollMs ?? DEFAULT_POLL_MS;
    this.#budget = config.budget;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#now = config.now ?? Date.now;
  }

  async solve(challenge: CaptchaChallenge): Promise<string> {
    if (!this.#apiKey || !this.#apiUrl) {
      throw new CaptchaSolveError("not-configured", "no CAPTCHA solving service configured");
    }
    const type = TASK_TYPE[challenge.kind];
    if (!type) {
      throw new CaptchaSolveError("unsupported-kind", `no task type for CAPTCHA kind "${challenge.kind}"`);
    }
    if (!challenge.siteKey) {
      throw new CaptchaSolveError("missing-sitekey", `cannot solve ${challenge.kind}: no siteKey on the challenge`);
    }
    this.#chargeBudget();

    const deadline = this.#now() + this.#timeoutMs;
    const taskId = await this.#createTask(type, challenge, deadline);
    return this.#pollForToken(taskId, deadline);
  }

  /** Enforce the sliding-window budget at solve start, so a hostile page can't run up cost. */
  #chargeBudget(): void {
    const budget = this.#budget;
    if (!budget) return;
    const now = this.#now();
    this.#starts = this.#starts.filter((t) => now - t < budget.windowMs);
    if (this.#starts.length >= budget.maxSolves) {
      throw new CaptchaSolveError(
        "budget-exhausted",
        `CAPTCHA solve budget exhausted (${budget.maxSolves} per ${budget.windowMs}ms)`,
      );
    }
    this.#starts.push(now);
  }

  async #createTask(type: string, challenge: CaptchaChallenge, deadline: number): Promise<string> {
    const body = {
      clientKey: this.#apiKey,
      task: { type, websiteURL: challenge.url, websiteKey: challenge.siteKey },
    };
    const json = await this.#post("createTask", body, deadline);
    if (json.errorId) {
      throw new CaptchaSolveError("vendor-error", `createTask failed: ${json.errorCode ?? "?"} ${json.errorDescription ?? ""}`.trim());
    }
    if (!json.taskId) {
      throw new CaptchaSolveError("vendor-error", "createTask returned no taskId");
    }
    return String(json.taskId);
  }

  async #pollForToken(taskId: string, deadline: number): Promise<string> {
    for (;;) {
      if (this.#now() >= deadline) {
        throw new CaptchaSolveError("timeout", `solve did not complete within ${this.#timeoutMs}ms`);
      }
      // Clamp the wait to the remaining budget so the loop can't overshoot the deadline by a full poll.
      await this.#sleep(Math.min(this.#pollMs, Math.max(0, deadline - this.#now())));
      const json = await this.#post("getTaskResult", { clientKey: this.#apiKey, taskId }, deadline);
      if (json.errorId) {
        throw new CaptchaSolveError("vendor-error", `getTaskResult failed: ${json.errorCode ?? "?"} ${json.errorDescription ?? ""}`.trim());
      }
      if (json.status === "ready") {
        const token =
          json.solution?.gRecaptchaResponse ?? json.solution?.token ?? json.solution?.captchaResponse ?? "";
        if (!token) throw new CaptchaSolveError("vendor-error", "solve ready but no token in solution");
        return String(token);
      }
      // any other status ("processing"/"idle") → keep polling until the deadline
    }
  }

  /**
   * POST JSON to a protocol endpoint, hard-bounded by `deadline`. A per-request AbortController fires
   * at the remaining budget so a stalled/black-holed vendor connection can't hang past the deadline
   * (fetch's own defaults are minutes-long) — without it, a single hung request would wedge the
   * awaiting drive action indefinitely. Network/abort/parse errors become a typed error (never a raw
   * throw); the request body (which carries the key) is never put in a message.
   */
  async #post(path: string, body: unknown, deadline: number): Promise<{ errorId?: number; errorCode?: string; errorDescription?: string; taskId?: string | number; status?: string; solution?: Record<string, unknown> }> {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new CaptchaSolveError("timeout", `solve did not complete within ${this.#timeoutMs}ms`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let resp: Response;
    try {
      resp = await this.#fetch(`${this.#apiUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Abort = we hit the deadline mid-request; otherwise a transport failure. Never surface the
      // request (it carries the key) — report only the failure shape.
      if (controller.signal.aborted) {
        throw new CaptchaSolveError("timeout", `${path}: exceeded the ${this.#timeoutMs}ms solve deadline`);
      }
      throw new CaptchaSolveError("vendor-error", `${path}: request failed (${err instanceof Error ? err.name : "network error"})`);
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new CaptchaSolveError("vendor-error", `${path}: HTTP ${resp.status}`);
    }
    return (await resp.json().catch(() => {
      throw new CaptchaSolveError("vendor-error", `${path}: invalid JSON response`);
    })) as Record<string, never>;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/**
 * Build an {@link HttpCaptchaSolver} from BYO config, or `undefined` when not configured (the key
 * lives in the SecretStore, R9; the endpoint is plain config so no provider is named in the repo).
 * Both must be present — like {@link proxyFromSecrets}, an unconfigured solver is simply absent, so a
 * detected CAPTCHA is left to fail rather than silently dead-ending. `apiUrl` is resolved by the
 * caller from config/env (`BGW_CAPTCHA_API_URL`) so this module reads no `process.env` directly.
 */
export function httpCaptchaSolverFromSecrets(
  secrets: SecretStore,
  apiUrl: string | undefined,
  opts: Omit<HttpCaptchaSolverConfig, "apiKey" | "apiUrl"> = {},
): HttpCaptchaSolver | undefined {
  const apiKey = secrets.get("BGW_CAPTCHA_API_KEY");
  if (!apiKey || !apiUrl) return undefined;
  return new HttpCaptchaSolver({ apiKey, apiUrl, ...opts });
}
