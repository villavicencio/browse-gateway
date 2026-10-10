/**
 * VIL-314 + VIL-136: how long a render's clearance poll may wait (`clearancePollLimitMs`), re-derived on
 * every poll round. A real-browser gate proves the end-to-end time (validate-failure-envelope), but cannot
 * isolate the decision, so the decision itself is pinned here, without a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearancePollLimitMs, UNCLEARABLE_CLEARANCE_POLL_MS } from "../dist/browser/patchright-core.js";

const plain = { title: "Not Found", text: "The requested page does not exist." };
const liveCf = { title: "Just a moment...", text: "Enable JavaScript and cookies to continue" };
const BUDGET = 20_000;

test("VIL-314: a navigation the gateway's own guard refused gets no poll at all, whatever the page shows", () => {
  for (const [signal, status] of [[plain, null], [plain, 200], [plain, 404], [liveCf, 403], [liveCf, 404], [liveCf, null]]) {
    assert.equal(clearancePollLimitMs(signal, status, BUDGET, true), 0, `${signal.title} / ${status}`);
  }
});

test("VIL-136 unchanged: an unclearable status with no live challenge gets the short ceiling", () => {
  for (const status of [404, 410, 429]) {
    assert.equal(clearancePollLimitMs(plain, status, BUDGET, false), UNCLEARABLE_CLEARANCE_POLL_MS, String(status));
  }
  assert.equal(clearancePollLimitMs(plain, 404, 500, false), 500, "never above the caller's own budget");
});

test("unchanged: a live challenge, a reputation 403, a dead nav and a 200 keep the full budget", () => {
  assert.equal(clearancePollLimitMs(liveCf, 404, BUDGET, false), BUDGET, "a live challenge on a 404 clears by waiting");
  assert.equal(clearancePollLimitMs(liveCf, 403, BUDGET, false), BUDGET);
  assert.equal(clearancePollLimitMs(plain, 403, BUDGET, false), BUDGET);
  assert.equal(clearancePollLimitMs(plain, null, BUDGET, false), BUDGET, "a dead nav that was NOT self-blocked keeps its wait");
  assert.equal(clearancePollLimitMs(plain, 200, BUDGET, false), BUDGET);
});
