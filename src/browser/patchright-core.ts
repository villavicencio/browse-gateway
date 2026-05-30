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
  NavigationDecision,
  NavigationGuard,
  RenderOptions,
  RenderResult,
} from "./types.js";

type PatchrightContext = Awaited<
  ReturnType<typeof chromium.launchPersistentContext>
>;
type PatchrightPage = Awaited<ReturnType<PatchrightContext["newPage"]>>;
type RouteHandler = Parameters<PatchrightContext["route"]>[1];

const DEFAULT_CLEARANCE_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

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
