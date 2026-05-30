#!/usr/bin/env node
/**
 * U3 policy integration proof (AE6). Run in-container (headful under Xvfb). Proves the
 * navigation-layer allowlist holds regardless of entry path and that actions are audited:
 *   1. allowlisted host renders real content
 *   2. non-allowlisted host blocked via the verb-layer render()
 *   3. non-allowlisted host blocked via a RAW CDP Page.navigate (below the verb layer)
 *   4. unknown consumer rejected before a session opens
 *   5. audit attributes allow/block to the consumer and logs the rejection
 */
import { Gateway, loadConfig } from "../dist/gateway/index.js";
import { PolicyEngine, ConsumerRegistry, InMemoryAuditSink } from "../dist/policy/index.js";

const ALLOWED = "https://example.com/";
const BLOCKED = "https://www.iana.org/"; // not in the allowlist

const audit = new InMemoryAuditSink();
const policy = new PolicyEngine({
  registry: new ConsumerRegistry([{ id: "agent-1", token: "tok-agent-1", allow: ["example.com"] }]),
  audit,
});
const gateway = Gateway.create(loadConfig(), undefined, policy);

let failures = 0;
const check = (label, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("=== browse-gateway :: policy + egress proof (U3/U4 — AE6, R19) ===");

try {
  await gateway.withConsumerSession("tok-agent-1", async (session, consumer) => {
    console.log(`[policy] consumer=${consumer.id} allow=[${[...consumer.allowlist.rules].join(", ")}]`);

    const allowed = await session.core.render(ALLOWED, { clearanceTimeoutMs: 10_000 });
    console.log(`  allowed   ${ALLOWED} -> status=${allowed.status} textLen=${allowed.text.length}`);
    // example.com is a deliberately tiny page (~129 chars), below assess()'s content-rich
    // threshold — so prove the allow by status 200 + its known content, not by assess().
    check(
      "allowlisted host renders real content",
      allowed.status === 200 && allowed.text.includes("Example Domain"),
    );

    const blocked = await session.core.render(BLOCKED, { clearanceTimeoutMs: 6_000 });
    console.log(`  blocked   ${BLOCKED} -> status=${blocked.status} textLen=${blocked.text.length}`);
    check("non-allowlisted host blocked at verb layer (render)", blocked.text.length < 100);

    // Raw CDP Page.navigate — simulates the future drive()/CDP-attach path. Must also be blocked.
    const ctx = session.core.context;
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Page.navigate", { url: BLOCKED }).catch(() => {});
    await page.waitForTimeout(4_000);
    const rawText = String(await page.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
    let rawHost = "";
    try { rawHost = new URL(page.url()).hostname; } catch { rawHost = ""; }
    console.log(`  raw-CDP   Page.navigate -> url=${page.url()} textLen=${rawText.length}`);
    check("raw CDP Page.navigate to off-allowlist blocked", rawText.length < 100 && !rawHost.includes("iana.org"));
    await page.close().catch(() => {});
  });

  let rejected = false;
  try {
    await gateway.withConsumerSession("bad-token", async () => {});
  } catch (e) {
    rejected = e?.code === "UNAUTHENTICATED";
  }
  check("unknown consumer rejected before a session opens", rejected);

  const agent1 = audit.forConsumer("agent-1");
  const hasAllow = agent1.some((r) => r.decision === "allow" && r.host === "example.com");
  const hasBlock = agent1.some((r) => r.decision === "block");
  const hasReject = audit.records.some((r) => r.decision === "auth-reject" && r.consumerId === null);
  console.log(`  audit: ${audit.records.length} records — agent-1 allow=${hasAllow} block=${hasBlock} auth-reject=${hasReject}`);
  check("audit attributes allow+block to agent-1 and logs the rejection", hasAllow && hasBlock && hasReject);
} finally {
  await gateway.shutdown();
}

// U4 / R19: egress deny wins. "ops" explicitly allowlists the metadata IP, yet the egress
// filter must still block it — proving the filter overrides the allowlist, not just that the
// metadata server is unreachable (we assert on the audited egress reason, not a timeout).
const metaAudit = new InMemoryAuditSink();
const metaGateway = Gateway.create(
  loadConfig(),
  undefined,
  new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "ops", token: "tok-ops", allow: ["169.254.169.254", "example.com"] }]),
    audit: metaAudit,
  }),
);
try {
  await metaGateway.withConsumerSession("tok-ops", async (session) => {
    const r = await session.core.render("http://169.254.169.254/latest/meta-data/", { clearanceTimeoutMs: 5_000 });
    console.log(`  metadata 169.254.169.254 -> status=${r.status} textLen=${r.text.length}`);
    check("allowlisted metadata IP blocked by egress (deny wins)", r.text.length < 100);
  });
} finally {
  await metaGateway.shutdown();
}
const egressBlock = metaAudit
  .forConsumer("ops")
  .find((r) => r.decision === "block" && /egress/.test(r.reason ?? ""));
check("egress block is audited with an egress reason", Boolean(egressBlock));

console.log(`\n=== POLICY GATE: ${failures === 0 ? "PASS ✅" : "FAIL ❌"} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
