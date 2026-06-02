/**
 * Patchright + real-Chrome browser core, headful under Xvfb — the spike-proven stealth
 * config and U1's shipping vehicle (see `steel-rejected-u1-vehicle`).
 */
import { chromium } from "patchright";
import { assertLocalCdpOnly } from "../security/cdp.js";
import { hostFromUrl } from "../security/url.js";
import { isCleared, isVisiblyBlocked, hasCloudflareHint, type PageSignal } from "./detect.js";
import {
  buildLaunchOptions,
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

/**
 * A snapshot ref looks like `e4` (top frame) or a frame-prefixed `f1e2`; anything else is a raw
 * selector. Drive verbs reference snapshot refs by default; a selector is the escape hatch.
 */
const REF_PATTERN = /^[a-z]?\d*e\d+$/i;

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

/** Capture the title/text/html a page currently renders, tolerant of mid-navigation races. */
async function snapshot(page: PatchrightPage): Promise<PageSignal> {
  const { title, text } = await pollSignal(page);
  const html = String(await page.content().catch(() => ""));
  return { title, text, html };
}

export class PatchrightBrowserCore implements BrowserCore {
  readonly kind = "patchright";
  readonly #context: PatchrightContext;
  readonly #resolved: ResolvedCoreOptions;
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

  private constructor(context: PatchrightContext, resolved: ResolvedCoreOptions) {
    this.#context = context;
    this.#resolved = resolved;
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
    return new PatchrightBrowserCore(context, resolved);
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
    let status: number | null = null;
    try {
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.#resolved.navigationTimeoutMs,
      });
      status = resp ? resp.status() : null;
    } catch {
      // A challenge/redirect/dead-exit may abort the navigation; snapshot whatever rendered and
      // leave status null so the drive layer treats it as a failed nav.
    }
    this.#lastDocStatus = status; // keep a subsequent snapshot()/action consistent with this nav
    // Give a client-side challenge (Cloudflare et al.) time to auto-solve, like render() does. A page
    // still blocked after the budget is surfaced by navFailed (the snapshot tree still carries the
    // phrase), so a proxied first navigate rotates to a fresh exit instead of pinning the blocked one.
    await this.#settle(page, clearanceTimeoutMs, pollIntervalMs);
    // Carry the CF vendor-hint signal (the HTML half of retrieve's CF detection) as a scrubbed
    // boolean, so drive's escalation recognizes a CF interstitial that shows no visible CF phrase.
    const html = String(await page.content().catch(() => ""));
    return { ...(await this.#snapshotOf(page)), status, cfHint: hasCloudflareHint(html) };
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
    await this.#settle(page);
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
    await this.#settle(page);
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
  ): Promise<void> {
    // Let any navigation the prior action triggered reach domcontentloaded, so its response status is
    // captured and the snapshot reflects the landed page (resolves immediately if nothing navigated).
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    let signal = await pollSignal(page);
    let waited = 0;
    while (isVisiblyBlocked(signal) && waited < clearanceTimeoutMs) {
      await page.waitForTimeout(pollIntervalMs);
      waited += pollIntervalMs;
      signal = await pollSignal(page);
    }
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
