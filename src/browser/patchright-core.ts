/**
 * Patchright + real-Chrome browser core, headful under Xvfb — the spike-proven stealth
 * config and U1's shipping vehicle (see `steel-rejected-u1-vehicle`).
 */
import { chromium } from "patchright";
import { assertLocalCdpOnly } from "../security/cdp.js";
import { hostFromUrl } from "../security/url.js";
import { isCleared, type PageSignal } from "./detect.js";
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
    void opts; // reserved for future per-call clearance tuning; nav uses the core timeout today
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
    return { ...(await this.#snapshotOf(page)), status };
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
    await this.#requireActivePage().keyboard.press(key);
  }

  async waitFor(condition: WaitCondition): Promise<void> {
    const page = this.#requireActivePage();
    if (condition.text) {
      await page
        .getByText(condition.text)
        .first()
        .waitFor({ timeout: DEFAULT_ACTION_TIMEOUT_MS });
    } else if (condition.timeMs !== undefined) {
      await page.waitForTimeout(condition.timeMs);
    }
  }

  async screenshot(): Promise<string> {
    const buf = await this.#requireActivePage().screenshot();
    return buf.toString("base64");
  }

  async closeActivePage(): Promise<void> {
    await this.#activePage?.close().catch(() => {});
    this.#activePage = undefined;
  }

  /** Open (lazily) the single active page used by the drive verbs. */
  async #ensureActivePage(): Promise<PatchrightPage> {
    if (!this.#activePage) this.#activePage = await this.#context.newPage();
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
    const loc = this.#requireActivePage().locator(targetToSelector(target.target));
    try {
      await fn(loc);
    } catch (err) {
      const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
      const label = target.element ? `${target.element} (${target.target})` : target.target;
      throw new Error(`drive ${op} failed for ${label}: ${first}`);
    }
  }

  /** Ref-annotated accessibility snapshot via Patchright's `ariaSnapshot({ mode: "ai" })`. */
  async #snapshotOf(page: PatchrightPage): Promise<PageSnapshot> {
    const root = page.locator("html");
    const aria = root.ariaSnapshot as unknown as (
      opts: Record<string, unknown>,
    ) => Promise<string>;
    const tree = String(await aria.call(root, { mode: "ai" }).catch(() => ""));
    const title = await page.title().catch(() => "");
    return { url: page.url(), title, tree };
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
