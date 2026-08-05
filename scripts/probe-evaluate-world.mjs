#!/usr/bin/env node
/**
 * Settles one recurring question in two minutes, so nobody has to argue about it again:
 *
 *   Does `page.evaluate()` — the call `collectFingerprint` and every other injected browser script
 *   goes through — run in the PAGE'S OWN world, or in an isolated one?
 *
 * WHY IT KEEPS MATTERING. If it were the page's world, a hostile origin could replace any global
 * our scripts read: swap `console.debug` for a no-op and the CDP-presence probes report clean while
 * a protocol consumer is attached; install a setter on `Object.prototype` and an ordinary property
 * assignment throws mid-capture. Those are not hypotheticals — an adversarial review of the #100
 * probes raised both as high-severity findings, on a reading of the driver's source. Running this
 * refuted both in one shot: the driver's source has more than one execution path and the one
 * `page.evaluate` takes is not the one the grep found.
 *
 * The result is also load-bearing in the other direction. It is WHY reaching page globals or firing
 * a site's own callbacks (e.g. a CAPTCHA vendor's config) requires main-world injection via
 * `addScriptTag` — see docs/solutions. Isolated-world evaluation shares the DOM and nothing else.
 *
 * RE-RUN IT after any driver bump. This is a property of the driver, not of our code, and a version
 * change can flip it silently — at which point a whole class of probe becomes forgeable by the page.
 *
 *   docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:probe .
 *   docker run --rm --platform linux/amd64 --shm-size=1g --init browse-gateway:probe \
 *     node scripts/probe-evaluate-world.mjs
 *
 * Exit code: 0 = isolated (the safe answer), 1 = main world (a whole class of probe is forgeable),
 * 2 = the probe itself could not run.
 */
import http from "node:http";
import { createBrowserCore } from "../dist/browser/index.js";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  // The page sets a marker and replaces the two console sinks the CDP-presence probes use. If our
  // evaluation shared this world, the marker would be visible and the replacements would be the
  // functions our probes end up calling.
  res.end(
    `<!doctype html><meta charset=utf-8><title>evaluate-world probe</title><script>
      window.__PAGE_MARKER__ = "set-by-page";
      console.debug = function () { window.__DEBUG_CALLED__ = (window.__DEBUG_CALLED__ || 0) + 1; };
      console.groupEnd = function () { window.__GROUPEND_CALLED__ = (window.__GROUPEND_CALLED__ || 0) + 1; };
    </script><body>evaluate-world probe</body>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

let core;
let exitCode = 2;
try {
  core = await createBrowserCore({
    channel: process.env.BGW_CHANNEL ?? "chrome",
    noSandbox: process.env.BGW_NO_SANDBOX === "1",
  });
  // #onRequestPaused is fail-closed: with no guard installed every request is blocked, so the
  // fixture would never load and the probe would report nothing rather than an answer.
  await core.setNavigationGuard(() => "allow");
  const page = await core.context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const seen = await page.evaluate(`(() => ({
    marker: (typeof window.__PAGE_MARKER__ === 'undefined') ? null : window.__PAGE_MARKER__,
    debugIsNative: Function.prototype.toString.call(console.debug).indexOf('[native code]') >= 0,
    groupEndIsNative: Function.prototype.toString.call(console.groupEnd).indexOf('[native code]') >= 0,
  }))()`);

  // Fire both sinks the way the probes do, then ask whether the PAGE's replacements were invoked.
  // Reading the counters is a second evaluate, so a null here means the same thing as a null marker.
  await page.evaluate(`(() => { console.debug({}); console.groupEnd({}); return 1; })()`);
  const pageCounters = await page.evaluate(`(() => ({
    debugCalls: (typeof window.__DEBUG_CALLED__ === 'undefined') ? null : window.__DEBUG_CALLED__,
    groupEndCalls: (typeof window.__GROUPEND_CALLED__ === 'undefined') ? null : window.__GROUPEND_CALLED__,
  }))()`);

  console.log(JSON.stringify({ seen, pageCounters }, null, 2));
  console.log("");

  const isolated =
    seen.marker === null && seen.debugIsNative && seen.groupEndIsNative &&
    pageCounters.debugCalls === null && pageCounters.groupEndCalls === null;
  if (isolated) {
    console.log("ISOLATED world — page globals are invisible and its console replacements were never");
    console.log("invoked. A hostile page CANNOT forge what our injected scripts read.");
    exitCode = 0;
  } else {
    console.log("MAIN world — the page's globals are visible to our evaluation.");
    console.log("A hostile page CAN replace what our injected scripts read, so every probe that");
    console.log("reads a page-reachable global is forgeable and must be re-derived from pristine");
    console.log("intrinsics captured before page script runs.");
    exitCode = 1;
  }
} catch (err) {
  console.error("probe could not run:", err instanceof Error ? err.message : String(err));
} finally {
  if (core) await core.close().catch(() => {});
  server.close();
}
process.exit(exitCode);
