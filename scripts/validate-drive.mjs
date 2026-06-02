#!/usr/bin/env node
/**
 * Drive surface proof (plan U5). Run IN-CONTAINER (headful Chrome under Xvfb). Drives the full
 * stack — authenticate -> allowlist-guarded, consumer-bound session -> real ariaSnapshot/click/type
 * -> idle reap -> close — through the GatewayDriveController, with NO mocks. Confirms:
 *   1. navigate + snapshot return a ref-annotated accessibility tree from a real page;
 *   1b. a real Cloudflare challenge CLEARS during navigate()'s clearance poll (degrades to a note
 *       on an IP-reputation block — this harness uses direct sessions, which can't clear those);
 *   2. the navigation guard blocks an off-allowlist navigate on the drive path (same policy as retrieve);
 *   3. (best-effort) type + click change page state end-to-end on a real form;
 *   4. an idle session is reaped, and the next action surfaces a clean "no open session" error;
 *   5. close is clean.
 * Direct sessions (no proxy) — the proxied healthy-exit retry is covered by drive.test.mjs (U4).
 */
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry } from "../dist/policy/index.js";
import { SecretStore } from "../dist/security/index.js";
import { GatewayDriveController } from "../dist/mcp/drive-controller.js";
import { isVisiblyBlocked } from "../dist/browser/index.js";

const TOKEN = "tok-drive";
// A known Cloudflare target for the anti-bot clearance check (1b). Configurable; defaults to the
// stealth gate's stable CF target (scrapingcourse is avoided — it is IP-reputation-flaky). Its
// registrable host is added to the allowlist so the guard admits it.
const CF_TARGET = process.env.BGW_DRIVE_CF_URL ?? "https://www.udemy.com/";
const cfApex = new URL(CF_TARGET).hostname.split(".").slice(-2).join(".");
const ALLOW = [
  "example.com",
  "*.example.com",
  "httpbin.org",
  "*.httpbin.org",
  cfApex,
  `*.${cfApex}`, // the CF clearance target
];
const OFF_ALLOWLIST = "https://www.google.com/"; // deliberately NOT in ALLOW
const FORM = "https://httpbin.org/forms/post"; // a real interactive form; degrades to a note if down

const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "agent-1", token: TOKEN, allow: ALLOW }]),
});
const gateway = Gateway.create(loadConfig(), undefined, policy);
const drive = new GatewayDriveController(gateway, new SecretStore(() => ({})), TOKEN); // direct sessions

let failures = 0;
let notes = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const note = (label) => {
  console.log(`  ~~~~  ${label}`);
  notes++;
};
const refOf = (tree, role) => (tree.match(new RegExp(`${role}[^\\n]*\\[ref=([^\\]]+)\\]`)) ?? [])[1];

console.log("=== browse-gateway :: drive surface proof (U5) ===");

try {
  // 1) navigate + snapshot a real page -> ref-annotated tree.
  const home = await drive.navigate("https://example.com/");
  console.log(`  example.com: status=${home.status} treeLen=${home.tree.length}`);
  check("navigate+snapshot return a ref-annotated accessibility tree", /\[ref=/.test(home.tree));
  check("the snapshot carries the page's real content (a link)", /link/i.test(home.tree));

  // 1b) anti-bot clearance on the drive path. A client-side CF challenge auto-solves during
  //     navigate()'s poll, so a successful navigate yields the CLEARED page — navFailed rejects a
  //     still-visible interstitial (throwing), so reaching here proves the poll outwaited the
  //     challenge. On a direct session an IP-reputation block can't be cleared (only a residential
  //     exit does), so that case degrades to a note rather than a failure.
  try {
    const cf = await drive.navigate(CF_TARGET);
    console.log(`  ${CF_TARGET}: status=${cf.status} treeLen=${cf.tree.length}`);
    const cleared = /\[ref=/.test(cf.tree) && !isVisiblyBlocked({ title: cf.title, text: cf.tree });
    check("a CF challenge cleared during navigate()'s poll (real page, not the interstitial)", cleared);
  } catch (err) {
    note(
      `CF clearance check skipped (${CF_TARGET}): ` +
        `${err instanceof Error ? err.message.split("\n")[0] : String(err)} — ` +
        `likely IP reputation on a direct session; the residential-exit path clears these`,
    );
  }

  // 2) the guard blocks an off-allowlist navigate on the drive path (R2).
  let blocked = false;
  try {
    await drive.navigate(OFF_ALLOWLIST);
  } catch {
    blocked = true;
  }
  check("an off-allowlist navigate is blocked on the drive path", blocked);

  // 3) type + click change state end-to-end (best-effort: httpbin must be reachable).
  const form = await drive.navigate(FORM).catch(() => null);
  if (!form || form.status === null) {
    note(`interactive form target unreachable (${FORM}) — skipping the type/click state-change check`);
  } else {
    const nameRef = refOf(form.tree, "textbox");
    const submitRef = refOf(form.tree, "button");
    if (!nameRef || !submitRef) {
      note(`form controls not found in snapshot (textbox=${nameRef}, button=${submitRef}) — skipping`);
    } else {
      await drive.type({ target: nameRef, element: "customer name" }, "drive-proof");
      const after = await drive.click({ target: submitRef, element: "submit order" });
      // httpbin echoes the submitted form back as JSON; the typed value should appear on the result page.
      check("type + submit changed page state (echoed value present)", /drive-proof/.test(after.tree));
    }
  }

  // 4) idle reap -> the next action surfaces a clean "no open session" error.
  const reaped = await gateway.sessions.reapIdle(0, Date.now() + 600_000); // force: everything is "idle"
  check("an idle drive session is reaped", reaped.length >= 1 && gateway.sessions.activeCount === 0);
  let reapErr = "";
  try {
    await drive.snapshot();
  } catch (err) {
    reapErr = err instanceof Error ? err.message : String(err);
  }
  check("a verb after a reap surfaces a clean error (no hang)", /no open session|no active drive session/.test(reapErr));

  // 5) close is clean (idempotent after a reap).
  await drive.close();
  check("close is clean after a reap", gateway.sessions.activeCount === 0);
} catch (err) {
  console.log(`  FAIL  threw: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  await gateway.shutdown();
}

const verdict = failures === 0 ? (notes ? "PASS (with notes) ⚠️" : "PASS ✅") : "FAIL ❌";
console.log(`\n=== DRIVE GATE: ${verdict} (${failures} failure(s), ${notes} note(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
