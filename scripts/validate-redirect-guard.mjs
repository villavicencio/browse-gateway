#!/usr/bin/env node
/**
 * Navigation-guard server-redirect proof (nav-guard CDP-Fetch rewrite).
 *
 * Proves, through the REAL PatchrightBrowserCore (createBrowserCore + setNavigationGuard, no mocks),
 * that the CDP-Fetch interception that replaced context.route re-fires the guard on EVERY server-3xx
 * hop — closing the documented redirect bypass where route.continue() auto-followed redirects without
 * re-invoking the guard (docs/solutions/architecture-patterns/nav-guard-redirect-bypass.md).
 *
 * Pure Chrome/CDP behavior (no anti-bot), so it runs headless on the Mac with patched Chromium AND
 * headful-under-Xvfb in-container. It deliberately installs a SIMPLE host-allow guard (allow the
 * owner host, block others) rather than the policy guard, because the policy egress filter denies all
 * loopback as anti-SSRF — the policy DECISIONS are unit-tested separately; this proves the core's
 * interception WIRING. The container stealth gate (validate-stealth.mjs) is the separate Q2 check
 * that this CDP backend did not regress the anti-bot fingerprint.
 *
 *   BGW_VALIDATE_HEADLESS=0   run headful (default headless; set 0 in-container under Xvfb)
 *   BGW_CHANNEL=chrome        browser channel ("" = patched chromium, the default here)
 *   BGW_NO_SANDBOX=1          pass --no-sandbox (root in container)
 */
import http from "node:http";
import { createBrowserCore } from "../dist/browser/index.js";

const OWNER = "127.0.0.1"; // the credential/owner host the guard clamps to
const OTHER = "localhost"; // a different hostname on the same loopback — the "sibling"/off-host

// --- loopback fixtures: a redirect chain, an allowed chain, a subresource, a popup, a control ----
const served = { exfil: 0, ownerC: 0, img: 0, popup: 0, ok: 0, workerFetch: 0 };
const server = http.createServer((req, res) => {
  const port = server.address().port;
  const ownerBase = `http://${OWNER}:${port}`;
  const otherBase = `http://${OTHER}:${port}`;
  const redirect = (to) => {
    res.writeHead(302, { Location: to });
    res.end(`redirecting to ${to}`);
  };
  const html = (body) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body>${body}</body></html>`);
  };
  switch (req.url) {
    // cross-host redirect chain: owner -> owner -> OFF-HOST (must be blocked at the last hop)
    case "/start": return redirect(`${ownerBase}/hop1`);
    case "/hop1": return redirect(`${otherBase}/exfil`);
    case "/exfil": served.exfil++; return html("EXFIL LANDED (should never happen)");
    // all-owner-host redirect chain: must be ALLOWED end-to-end (no regression to normal redirects)
    case "/owner-a": return redirect(`${ownerBase}/owner-b`);
    case "/owner-b": return redirect(`${ownerBase}/owner-c`);
    case "/owner-c": served.ownerC++; return html("OWNER FINAL");
    // a page on the owner host that embeds an OFF-HOST subresource (page renders, subresource blocked)
    case "/with-img": return html(`owner page<img src="${otherBase}/img.png">`);
    case "/img.png": served.img++; res.writeHead(200, { "Content-Type": "image/png" }); return res.end("x");
    // a page that opens a cross-host popup ON CLICK (auto-attach must guard the popup's navigation).
    // Headful Chrome popup-BLOCKS a script-driven window.open with no user gesture, so the open is
    // wired to a click the validator performs — otherwise the popup never opens and the check is vacuous.
    case "/popup-opener": return html(`<button id="openpop" onclick="window.open('${otherBase}/popup-target')">open</button>`);
    case "/popup-target": served.popup++; return html("POPUP LANDED (should never happen)");
    // a page that spawns a dedicated Worker (a separate auto-attached target) which fetches off-host:
    // proves the worker's request is guarded AND that Fetch interception does not deadlock the worker.
    case "/worker-opener": return html(`<script>new Worker(${JSON.stringify(`${ownerBase}/worker.js`)});</script>worker-opener`);
    case "/worker.js":
      res.writeHead(200, { "Content-Type": "application/javascript" });
      return res.end(`fetch(${JSON.stringify(`${otherBase}/worker-fetch`)}).catch(()=>{});`);
    case "/worker-fetch": served.workerFetch++; res.writeHead(200); return res.end("worker-fetch");
    // owner-host control: a plain allowed page
    case "/ok": served.ok++; return html("OK");
    default: res.writeHead(404); return res.end("nope");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const owner = (p) => `http://${OWNER}:${PORT}${p}`;

// --- the guard under test: allow the owner host, block everything else; log every decision -------
const guardLog = [];
const allowOwner = (nav) => {
  guardLog.push(nav);
  return nav.host === OWNER ? "allow" : "block";
};
const throwingGuard = () => {
  throw new Error("guard boom (fail-closed probe)");
};

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== browse-gateway :: navigation-guard server-redirect proof ===");
console.log(`owner host=${OWNER}  off-host=${OTHER}  port=${PORT}`);

const core = await createBrowserCore({
  headless: process.env.BGW_VALIDATE_HEADLESS !== "0",
  channel: process.env.BGW_CHANNEL ?? "",
  noSandbox: process.env.BGW_NO_SANDBOX === "1",
});

try {
  await core.setNavigationGuard(allowOwner);

  // 1) cross-host redirect chain is blocked at the off-host hop (the bug being fixed).
  const startAt = guardLog.length;
  await core.render(owner("/start"));
  const chainNav = guardLog.slice(startAt).filter((n) => n.isNavigationRequest);
  const chainHosts = chainNav.map((n) => n.host);
  check("cross-host redirect: off-host hop NOT served (no exfil)", served.exfil === 0);
  check(
    `per-hop re-fire: guard saw each hop host [${chainHosts.join(" -> ")}]`,
    chainHosts.length >= 3 && chainHosts.includes(OTHER) && chainHosts.filter((h) => h === OWNER).length >= 2,
  );
  // each main-frame hop must classify as a navigation (resourceType "document") — the basis of the
  // owner-host clamp; if a hop ever arrived as a non-Document type the clamp would silently exempt it.
  check("each redirect hop is classified as a navigation (document)", chainNav.every((n) => n.resourceType === "document"));

  // 2) all-owner-host redirect chain lands (normal redirects still work).
  const ownerChain = await core.render(owner("/owner-a"));
  check("allowed redirect chain lands at owner-final", served.ownerC === 1 && /OWNER FINAL/.test(ownerChain.text ?? ownerChain.html ?? ""));

  // 3) owner-host control page loads.
  const ok = await core.render(owner("/ok"));
  check("owner-host control page loads (status 200)", ok.status === 200);

  // 4) off-host SUBRESOURCE is blocked but the owner page still renders.
  const okBefore = served.ok;
  const withImg = await core.render(owner("/with-img"));
  check("owner page with off-host subresource renders (status 200)", withImg.status === 200);
  check("off-host subresource (img) NOT served", served.img === 0);
  void okBefore;

  // 5) cross-host POPUP navigation is guarded (auto-attach covers the new page). Assert the guard
  // actually SAW the popup target — a bare served.popup===0 could pass vacuously if the popup never
  // opened or simply hadn't navigated yet within the wait.
  const popupAt = guardLog.length;
  await core.navigate(owner("/popup-opener"));
  await core.click({ target: "#openpop" }); // a real gesture so headful Chrome actually opens the popup
  await sleep(1500); // give the popup time to open + attempt its blocked navigation
  const sawPopupNav = guardLog.slice(popupAt).some((n) => n.host === OTHER && n.isNavigationRequest);
  check("cross-host popup NOT served (auto-attach guards new pages)", served.popup === 0);
  check("the guard actually intercepted the popup's off-host navigation", sawPopupNav);
  await core.closeActivePage();

  // 5b) a dedicated Worker (separate auto-attached target) — its off-host fetch is guarded AND the
  // page/worker do not deadlock under Fetch interception.
  await core.navigate(owner("/worker-opener"));
  await sleep(1500);
  check("worker off-host fetch NOT served (worker target guarded, no deadlock)", served.workerFetch === 0);
  await core.closeActivePage();

  // 6) fail-closed: a throwing guard blocks even an owner-host request.
  await core.setNavigationGuard(throwingGuard);
  const okCountBefore = served.ok;
  await core.render(owner("/ok"));
  check("fail-closed: throwing guard blocks the owner-host request", served.ok === okCountBefore);
} finally {
  await core.close();
  server.close();
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exitCode = failures ? 1 : 0;
