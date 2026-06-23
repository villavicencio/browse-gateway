/**
 * Patchright + real-Chrome browser core, headful under Xvfb — the spike-proven stealth
 * config and U1's shipping vehicle (see `steel-rejected-u1-vehicle`).
 */
import { chromium } from "patchright";
import { assertLocalCdpOnly } from "../security/cdp.js";
import { hostFromUrl } from "../security/url.js";
import { isCleared, isVisiblyBlocked, hasCloudflareHint, hasPerimeterXHint, MIN_CONTENT_LENGTH, type PageSignal } from "./detect.js";
import {
  DETECT_LIVE_CAPTCHA_JS,
  injectTokenJs,
  awaitSolvableCaptcha,
  type CaptchaSolver,
  type LiveCaptcha,
} from "./captcha.js";
import {
  buildLaunchOptions,
  buildLocalStorageSeedScript,
  resolveCoreOptions,
  type ResolvedCoreOptions,
} from "./launch-options.js";
import type {
  BrowserCore,
  BrowserCoreOptions,
  DriveTarget,
  NavigationDecision,
  NavigationGuard,
  PageSnapshot,
  RenderOptions,
  RenderResult,
  StorageState,
  WaitCondition,
} from "./types.js";

type PatchrightContext = Awaited<
  ReturnType<typeof chromium.launchPersistentContext>
>;
type PatchrightPage = Awaited<ReturnType<PatchrightContext["newPage"]>>;
type PatchrightLocator = ReturnType<PatchrightPage["locator"]>;
type RouteHandler = Parameters<PatchrightContext["route"]>[1];

const DEFAULT_CLEARANCE_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Per-action timeout for interactive drive verbs (click/type/select/wait). */
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;
/**
 * Hard ceiling on a `waitFor({ timeMs })` delay. Kept well under the idle-reaper TTL so a single
 * wait can't hold the session open past the point where the reaper would close it under the caller.
 */
const MAX_WAIT_MS = 60_000;
/**
 * How long `navigate()` polls a visible anti-bot interstitial waiting for it to auto-solve before
 * snapshotting. The poll runs ONLY while a block phrase is showing, so a clean (or dead/blank) page
 * incurs no wait — only an actual challenge costs latency. Mirrors render()'s clearance loop with a
 * drive-tuned budget; overridable per call via `RenderOptions.clearanceTimeoutMs`.
 */
const DEFAULT_DRIVE_CLEARANCE_TIMEOUT_MS = 15_000;
// Interactive-CAPTCHA widgets inject their response field from an async script that runs AFTER
// navigate() resolves (waitUntil "domcontentloaded"). Poll up to this long for the field to render
// before concluding there's nothing to solve — otherwise a one-shot detect always loses the race.
const CAPTCHA_RENDER_POLL_MS = 250;
const CAPTCHA_RENDER_TIMEOUT_MS = 2_000;

/**
 * A snapshot ref looks like `e4` (top frame) or a frame-prefixed `f1e2`; anything else is a raw
 * selector. Drive verbs reference snapshot refs by default; a selector is the escape hatch.
 */
const REF_PATTERN = /^[a-z]?\d*e\d+$/i;

/** Visible body text — the post-inject advancement signal (catches same-page/AJAX callback updates). */
const BODY_TEXT_JS = "document.body ? document.body.innerText : ''";

/** Resolve a {@link DriveTarget}'s `target` to a Playwright selector: a ref -> `aria-ref=`, else passthrough. */
export function targetToSelector(target: string): string {
  const t = target.trim();
  return REF_PATTERN.test(t) ? `aria-ref=${t}` : t;
}

/** Title + visible text only — the cheap signal the clearance poll needs each iteration. */
async function pollSignal(page: PatchrightPage): Promise<Pick<PageSignal, "title" | "text">> {
  const title = await page.title().catch(() => "");
  const text = String(
    await page
      .evaluate("document.body ? document.body.innerText : ''")
      .catch(() => ""),
  );
  return { title, text };
}

/**
 * Concatenated HTML of every child frame. `page.content()` serializes only the TOP document, so a
 * challenge rendered inside a child frame (PerimeterX's `px-captcha-modal`) is invisible to it.
 * Playwright reads a child frame's document even cross-origin (verified), so the press-&-hold copy is
 * recoverable here. Each frame is fetched best-effort — a detached/navigating frame yields "".
 */
async function captureChildFrameHtml(page: PatchrightPage): Promise<string> {
  const children = page.frames().filter((f) => f !== page.mainFrame());
  if (children.length === 0) return "";
  const parts = await Promise.all(children.map((f) => f.content().catch(() => "")));
  return parts.join("\n");
}

/**
 * Restore captured session state into a freshly-launched context (KTD-3/4). Cookies go straight
 * into the jar via `addCookies` (the storageState cookie shape is exactly what `addCookies` takes,
 * so `expires`-in-seconds and the `sameSite` enum round-trip with no translation). localStorage
 * can't be set on the context directly — `launchPersistentContext` has no `storageState` option —
 * so it is seeded by an origin-guarded, idempotent init script (see `buildLocalStorageSeedScript`).
 * Best-effort and additive: an empty blob is a no-op (an ordinary cold session).
 */
async function applyRestoreState(
  context: PatchrightContext,
  state: StorageState,
): Promise<void> {
  if (state.cookies?.length) {
    await context.addCookies(state.cookies);
  }
  const origins = (state.origins ?? []).filter((o) => o.localStorage?.length);
  if (origins.length) {
    await context.addInitScript({ content: buildLocalStorageSeedScript(origins) });
  }
}

/** Capture the title/text/html a page currently renders, tolerant of mid-navigation races. */
async function snapshot(page: PatchrightPage): Promise<PageSignal> {
  const { title, text } = await pollSignal(page);
  const html = String(await page.content().catch(() => ""));
  // Only walk child frames when the top doc carries a PX marker (the px-captcha-modal element is in
  // the top document even while its challenge body is in the frame) — so an ordinary page with ad
  // iframes never pays the cost, and an iframe-served press-&-hold is still detectable.
  const frameHtml = hasPerimeterXHint(html) ? await captureChildFrameHtml(page) : "";
  return { title, text, html, frameHtml };
}

export class PatchrightBrowserCore implements BrowserCore {
  readonly kind = "patchright";
  readonly #context: PatchrightContext;
  readonly #resolved: ResolvedCoreOptions;
  /** Injected solver for the drive path; absent = a detected CAPTCHA is left to fail. */
  readonly #solver?: CaptchaSolver;
  #routeHandler?: RouteHandler;
  /** The single persistent page the interactive `drive` verbs act on (absent until navigate()). */
  #activePage?: PatchrightPage;
  /**
   * HTTP status of the active page's last main-frame navigation, kept current by a response listener
   * so it reflects click/submit-triggered navigations too — not just navigate(). Lets a post-action
   * snapshot carry a status, so a bare reputation block (4xx + thin) reached by an action is
   * detectable, not only a visible challenge phrase. `undefined` until the first navigation.
   */
  #lastDocStatus?: number | null;

  private constructor(
    context: PatchrightContext,
    resolved: ResolvedCoreOptions,
    solver?: CaptchaSolver,
  ) {
    this.#context = context;
    this.#resolved = resolved;
    this.#solver = solver;
  }

  static async launch(
    opts: BrowserCoreOptions = {},
  ): Promise<PatchrightBrowserCore> {
    const resolved = resolveCoreOptions(opts);
    const launchOptions = buildLaunchOptions(resolved);
    // R13/R17: never expose CDP off-localhost. Patchright drives Chromium over a pipe, so
    // this is a regression guard against a future change adding a public debugging address.
    assertLocalCdpOnly(launchOptions.args ?? []);
    const context = await chromium.launchPersistentContext(
      resolved.userDataDir,
      launchOptions,
    );
    // Seed any captured session state BEFORE the first navigation, so a vault session is logged-in
    // from its first goto. This runs against the live context (not a launch arg), like the solver.
    // It registers cookies + an init script only — no network request — so it predates and is
    // independent of the navigation guard the gateway installs next.
    if (opts.restoreState) {
      await applyRestoreState(context, opts.restoreState);
    }
    // The solver is a runtime dependency (not a launch arg) — pass it through to the instance.
    return new PatchrightBrowserCore(context, resolved, opts.solver);
  }

  /**
   * Serialize the context's cookies + per-origin localStorage for the vault to persist (KTD-3).
   * Playwright's `storageState()` shape is carried verbatim — its cookie/origin fields are exactly
   * {@link StorageState} — so what comes out here replays through {@link BrowserCoreOptions.restoreState}
   * with no translation. Context-wide (cookies are not per-page); safe to call with no active page.
   */
  async captureStorageState(): Promise<StorageState> {
    const { cookies, origins } = await this.#context.storageState();
    return { cookies, origins };
  }

  async render(url: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const clearanceTimeoutMs =
      opts.clearanceTimeoutMs ?? DEFAULT_CLEARANCE_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const page = await this.#context.newPage();
    try {
      let status: number | null = null;
      try {
        const resp = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: this.#resolved.navigationTimeoutMs,
        });
        status = resp ? resp.status() : null;
      } catch {
        // Navigation may time out or be aborted by a challenge; assess whatever rendered.
      }

      // Poll until the challenge clears (markers gone + content) or we time out. Challenges —
      // Cloudflare especially — solve client-side on a variable delay, so a fixed wait
      // under-counts clearance; this loop is the fix for that flakiness. Each poll fetches
      // only title+text (cheap); the full HTML is serialized once at the end.
      let signal = await pollSignal(page);
      let waited = 0;
      while (!isCleared(signal, opts.clearedTextLength) && waited < clearanceTimeoutMs) {
        await page.waitForTimeout(pollIntervalMs);
        waited += pollIntervalMs;
        signal = await pollSignal(page);
      }
      const final = await snapshot(page);
      return { url, status, ...final, clearanceWaitedMs: waited };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async setNavigationGuard(guard: NavigationGuard): Promise<void> {
    const handler: RouteHandler = async (route) => {
      const request = route.request();
      const url = request.url();
      // Fail closed: if the guard throws, block.
      let decision: NavigationDecision = "block";
      try {
        decision = guard({
          url,
          host: hostFromUrl(url),
          resourceType: request.resourceType(),
          isNavigationRequest: request.isNavigationRequest(),
        });
      } catch {
        decision = "block";
      }
      if (decision === "allow") {
        await route.continue().catch(() => {});
      } else {
        await route.abort("blockedbyclient").catch(() => {});
      }
    };
    // Install the new handler BEFORE removing the old one so there is never an unguarded
    // window: Playwright tries the most-recently-added handler first, so the new guard wins
    // for any in-flight request during the swap. Intercept every request, context-wide
    // (Playwright routing uses CDP Fetch under the hood, so this also catches a raw CDP
    // Page.navigate — the below-the-verb-layer guarantee).
    const prev = this.#routeHandler;
    await this.#context.route("**/*", handler);
    this.#routeHandler = handler;
    if (prev) {
      await this.#context.unroute("**/*", prev).catch(() => {});
    }
  }

  // --- Interactive `drive` surface ------------------------------------------------------------
  // All of these act on a single persistent active page inside the same guarded context, so the
  // requests they trigger pass the installed navigation guard exactly like render() does. The
  // consumer reaches these through high-level verbs only — never raw CDP — so it cannot remove
  // the guard. Element targeting uses snapshot refs (aria-ref=) per `targetToSelector`.

  async navigate(url: string, opts: RenderOptions = {}): Promise<PageSnapshot> {
    const clearanceTimeoutMs = opts.clearanceTimeoutMs ?? DEFAULT_DRIVE_CLEARANCE_TIMEOUT_MS;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const page = await this.#ensureActivePage();
    // Reset the tracked status; the active-page response listener (#ensureActivePage) repopulates it
    // from THIS nav's main-frame responses — INCLUDING a post-clearance reload. We deliberately do
    // NOT freeze status at the goto's first response: a CF interstitial answers 403 then reloads to
    // 200 once the challenge auto-solves, and capturing the 403 made navFailed misread the cleared
    // page as a hard block (4xx + thin tree), so proxied escalation discarded a working exit and
    // eventually reported "could not land a working proxied exit (403)".
    this.#lastDocStatus = null;
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.#resolved.navigationTimeoutMs,
      });
    } catch {
      // A challenge/redirect/dead-exit may abort the navigation; settle on whatever rendered. With no
      // main-frame response the listener leaves status null, so the drive layer treats it as a failed nav.
    }
    // Give a client-side challenge (Cloudflare et al.) time to auto-solve, like render() does, and —
    // once it clears via a full reload — wait for the real document to land content rather than the
    // blank inter-navigation moment. A page still blocked after the budget is surfaced by navFailed.
    await this.#settle(page, clearanceTimeoutMs, pollIntervalMs);
    // Carry the CF vendor-hint signal (the HTML half of retrieve's CF detection) as a scrubbed
    // boolean, so drive's escalation recognizes a CF interstitial that shows no visible CF phrase.
    const html = String(await page.content().catch(() => ""));
    return { ...(await this.#snapshotOf(page)), cfHint: hasCloudflareHint(html), pxHint: hasPerimeterXHint(html) };
  }

  async snapshot(): Promise<PageSnapshot> {
    return this.#snapshotOf(this.#requireActivePage());
  }

  async click(target: DriveTarget): Promise<void> {
    await this.#act("click", target, (loc) =>
      loc.click({ timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    );
  }

  async type(
    target: DriveTarget,
    text: string,
    opts: { submit?: boolean } = {},
  ): Promise<void> {
    await this.#act("type", target, async (loc) => {
      await loc.fill(text, { timeout: DEFAULT_ACTION_TIMEOUT_MS });
      if (opts.submit) await loc.press("Enter");
    });
  }

  async selectOption(target: DriveTarget, values: string[]): Promise<void> {
    await this.#act("selectOption", target, (loc) =>
      loc.selectOption(values, { timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    );
  }

  async pressKey(key: string): Promise<void> {
    const page = this.#requireActivePage();
    await page.keyboard.press(key);
    // A key press (Enter) can submit a form / trigger navigation — wait out any challenge it lands on.
    // If a submit-gated CAPTCHA was solved, replay the key once so the submit completes with the token.
    const replayNeeded = await this.#settle(page);
    if (replayNeeded) {
      await page.keyboard.press(key).catch(() => {});
      await this.#settle(page);
    }
  }

  async waitFor(condition: WaitCondition): Promise<void> {
    const page = this.#requireActivePage();
    if (condition.text) {
      await page
        .getByText(condition.text)
        .first()
        .waitFor({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
    } else if (condition.timeMs !== undefined) {
      // Clamp the fixed delay so one wait can't outlive the idle-reaper TTL and pin the session.
      await page.waitForTimeout(Math.min(Math.max(0, condition.timeMs), MAX_WAIT_MS));
    } else {
      throw new Error("waitFor requires either text or timeMs");
    }
  }

  async screenshot(): Promise<string> {
    const buf = await this.#requireActivePage().screenshot({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
    return buf.toString("base64");
  }

  async closeActivePage(): Promise<void> {
    await this.#activePage?.close().catch(() => {});
    this.#activePage = undefined;
    this.#lastDocStatus = undefined;
  }

  /**
   * Open (lazily) the single active page used by the drive verbs, with a listener that tracks its
   * last main-frame navigation status — so every snapshot (including post-action) can carry a status
   * for hard-block detection, even though only navigate() returns a goto response directly.
   */
  async #ensureActivePage(): Promise<PatchrightPage> {
    if (!this.#activePage) {
      const page = await this.#context.newPage();
      this.#lastDocStatus = undefined;
      page.on("response", (resp) => {
        try {
          if (resp.request().isNavigationRequest() && resp.frame() === page.mainFrame()) {
            this.#lastDocStatus = resp.status();
          }
        } catch {
          // a superseded/aborted response can throw on access — ignore; the next nav updates status
        }
      });
      this.#activePage = page;
    }
    return this.#activePage;
  }

  /** The active page, or a clear error when the consumer acts before navigating. */
  #requireActivePage(): PatchrightPage {
    if (!this.#activePage) {
      throw new Error("no active page — call navigate() to open one before acting");
    }
    return this.#activePage;
  }

  /** Run an action against a resolved locator, mapping driver errors to a clean, labeled message. */
  async #act(
    op: string,
    target: DriveTarget,
    fn: (loc: PatchrightLocator) => Promise<unknown>,
  ): Promise<void> {
    const page = this.#requireActivePage();
    const loc = page.locator(targetToSelector(target.target));
    try {
      await fn(loc);
    } catch (err) {
      const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      const label = target.element ? `${target.element} (${target.target})` : target.target;
      throw new Error(`drive ${op} failed for ${label}: ${first}`);
    }
    // A navigation-producing action (submit click, select with onchange) may land on a challenge —
    // wait it out so the post-action snapshot is the cleared page, not the interstitial.
    const replayNeeded = await this.#settle(page);
    if (replayNeeded) {
      // A CAPTCHA that appeared only on this action (e.g. a submit gated on reCAPTCHA) was rejected
      // before a token existed; the solve injected one but did not re-submit. Replay the action ONCE
      // so it completes with the token in place. Best-effort: a now-missing element just no-ops, and
      // the following settle won't re-solve (the response field is filled). (AE3/R8: continue, don't fail.)
      await fn(loc).catch(() => {});
      await this.#settle(page);
    }
  }

  /**
   * Poll the active page WHILE a visible anti-bot block phrase is showing, up to the clearance
   * budget, so a client-side challenge (triggered by a goto or a navigation-producing action) can
   * auto-solve before we snapshot. Runs only while a phrase is present — a clean or dead/blank page
   * returns immediately, so only an actual interstitial costs latency.
   */
  async #settle(
    page: PatchrightPage,
    clearanceTimeoutMs: number = DEFAULT_DRIVE_CLEARANCE_TIMEOUT_MS,
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ): Promise<boolean> {
    // Let any navigation the prior action triggered reach domcontentloaded, so its response status is
    // captured and the snapshot reflects the landed page (resolves immediately if nothing navigated).
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    let signal = await pollSignal(page);
    let waited = 0;
    let sawBlock = false;
    while (waited < clearanceTimeoutMs) {
      const blocked = isVisiblyBlocked(signal);
      if (blocked) sawBlock = true;
      // A never-blocked page settles the moment it isn't blocked (a clean/dead/blank page returns
      // fast — only an actual challenge costs latency). A page that WAS blocked must wait for the
      // REAL post-clearance document to land NON-THIN content (isCleared past MIN_CONTENT_LENGTH —
      // the same thinness bar navFailed's isHardBlock uses), not the blank/residual transitional
      // window a CF 403→200 reload leaves. Otherwise #settle exits on the transition, the snapshot
      // is thin, and (with the interstitial's status) navFailed misreads the cleared page as a hard
      // block. Bounded by the clearance budget, so a genuinely-thin cleared page still returns.
      const settled = sawBlock ? isCleared(signal, MIN_CONTENT_LENGTH) : !blocked;
      if (settled) break;
      await page.waitForTimeout(pollIntervalMs);
      waited += pollIntervalMs;
      signal = await pollSignal(page);
    }
    // After client-side challenges settle, an INTERACTIVE captcha (reCAPTCHA/Turnstile/hCaptcha)
    // may still be blocking the flow. Auto-solve it transparently when a solver is configured. Returns
    // true when the caller should replay the triggering action to complete a submit-gated flow.
    return this.#trySolveCaptcha(page);
  }

  /**
   * Transparent interactive-CAPTCHA solve on the drive path. Runs after the block-phrase settle.
   * Spends a solve ONLY on a genuine, blocking widget (a rendered widget whose response-token field
   * is still empty) — never speculatively. A solve/inject failure is swallowed so it can never break
   * the action: the page is simply left challenged and the post-action snapshot reports it as blocked
   * (the caller's existing navFailed path). Does NOT recurse into {@link #settle}; the response field
   * is populated on success, so a re-entry would no-op on the gate. Cost/rate limiting is the solver's
   * own budget (R8). render() (retrieve) never reaches here — its CF tier is cleared by proxy, not a solver.
   *
   * Returns `true` when a token was injected but the page did NOT advance on its own — i.e. the caller
   * should REPLAY the triggering action to complete the flow. This is the mid-flow case: a form whose
   * submit was rejected for lack of a token, where injecting the token alone re-submits nothing. When
   * the widget's own `data-callback` advances the page (URL changes during the post-inject wait), this
   * returns `false` so the caller does NOT replay — avoiding a double-submit. No solve / no token /
   * stale page all return `false`.
   */
  async #trySolveCaptcha(page: PatchrightPage): Promise<boolean> {
    if (!this.#solver) return false;
    // Resolve the widget, polling out its render race: navigate() resolves at domcontentloaded, but
    // the response field is injected by a later async script, so a one-shot detect sees the container
    // with no field yet and would skip forever (the next detect pass re-navigates and re-races).
    const challenge = await awaitSolvableCaptcha(
      async () => (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null,
      () => page.url(),
      (ms) => page.waitForTimeout(ms).catch(() => {}),
      { pollMs: CAPTCHA_RENDER_POLL_MS, timeoutMs: CAPTCHA_RENDER_TIMEOUT_MS },
    );
    if (!challenge) return false;
    let token: string;
    try {
      token = await this.#solver.solve(challenge);
    } catch (err) {
      // Vendor error / timeout / budget: leave the page challenged rather than throw under the verb,
      // but emit a diagnostic so a left-challenged drive page has a WHY (parity with retrieve's
      // block-reason). Log the typed code only — never the message (vendor strings) or the key (R9).
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error";
      process.stderr.write(`[browse-gateway] captcha solve failed (${code}); page left challenged\n`);
      return false;
    }
    if (!token) return false;
    // The solve can run up to the solver's deadline; if the page navigated or the widget changed in
    // the meantime, the token is bound to a now-stale (url, siteKey). Re-verify before injecting, so a
    // token minted for the old page isn't written into a different one.
    const after = (await page.evaluate(DETECT_LIVE_CAPTCHA_JS).catch(() => null)) as LiveCaptcha | null;
    if (!after || after.siteKey !== challenge.siteKey || page.url() !== challenge.url) return false;
    // Snapshot the visible page state before injecting, so we can tell the site's own continuation
    // (advance — do NOT replay) from a stalled submit (nothing happened — DO replay). The widget's own
    // mutations (its iframe, the hidden response textarea) don't change main-document innerText, so it
    // is a clean signal for site-driven advancement.
    const beforeText = String(await page.evaluate(BODY_TEXT_JS).catch(() => ""));
    // Inject in the page's MAIN world (a real <script>), NOT page.evaluate's isolated world: the field
    // set works either way (shared DOM), but firing the site's data-callback needs the page's own
    // `window` (e.g. grecaptcha's config), which the isolated world can't see. The script tag isn't
    // rendered, so it doesn't perturb the body-text advance signal.
    await page.addScriptTag({ content: injectTokenJs(challenge.kind, token) }).catch(() => {});
    // Give the site's own continuation (a data-callback) a moment to fire — a fixed wait, NOT a
    // re-settle (which would re-enter this method).
    await page.waitForTimeout(DEFAULT_POLL_INTERVAL_MS).catch(() => {});
    // "Advanced" = the site already moved the flow forward, by navigating (URL change) OR by an
    // in-place/AJAX update from the widget's data-callback (visible-text change). A URL-only check
    // misses same-page callbacks and would double-submit them. If nothing advanced, the triggering
    // action was rejected pre-token and the caller must replay it once.
    if (page.url() !== challenge.url) return false;
    const afterText = await page.evaluate(BODY_TEXT_JS).catch(() => null);
    return afterText !== null && afterText === beforeText; // unchanged ⇒ stalled ⇒ replay needed
  }

  /**
   * Ref-annotated accessibility snapshot via Patchright's `ariaSnapshot({ mode: "ai" })`.
   *
   * The double-cast is deliberate: Patchright's published `Locator.ariaSnapshot` type does not yet
   * expose the `{ mode: "ai" }` overload (the ref-annotated path, verified on 1.60 where the older
   * internal `_snapshotForAI` was removed), so we widen to the call shape we actually invoke. The
   * `.catch(() => "")` degrades to an empty tree if the method is missing on an older build — note
   * that this masks a Patchright-version mismatch as a blank snapshot rather than a hard error, so
   * keep the pinned version ≥ 1.60.
   */
  async #snapshotOf(page: PatchrightPage): Promise<PageSnapshot> {
    const root = page.locator("html");
    const aria = root.ariaSnapshot as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<string>;
    const tree = String(await aria.call(root, { mode: "ai" }).catch(() => ""));
    const title = await page.title().catch(() => "");
    return { url: page.url(), title, tree, status: this.#lastDocStatus ?? null };
  }

  /**
   * Low-level access to the owned browser context. Escape hatch for the policy layer's
   * integration checks and the future v1.1 drive()/CDP-attach surfaces — not part of the
   * vehicle-agnostic `BrowserCore` contract.
   */
  get context(): PatchrightContext {
    return this.#context;
  }

  async close(): Promise<void> {
    await this.#context.close().catch(() => {});
  }
}

/**
 * Vehicle-agnostic factory. Currently always returns the Patchright core; a future
 * session/viewer vehicle would branch here without changing callers.
 */
export function createBrowserCore(
  opts: BrowserCoreOptions = {},
): Promise<BrowserCore> {
  return PatchrightBrowserCore.launch(opts);
}
