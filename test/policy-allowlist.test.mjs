/**
 * U3 policy tests — allowlist matching, per-consumer scope/audit, and gateway enforcement.
 * Pure where possible; the gateway path uses a fake core (no real browser). The real
 * Fetch-interception proof (incl. raw CDP Page.navigate) runs in-container via
 * scripts/validate-policy.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PolicyEngine,
  PolicyError,
  Allowlist,
  ConsumerRegistry,
  InMemoryAuditSink,
  normalizeHost,
} from "../dist/policy/index.js";
import { Gateway } from "../dist/gateway/index.js";

const nav = (host) => ({
  url: `https://${host}/path`,
  host,
  resourceType: "document",
  isNavigationRequest: true,
});

function makeFactory() {
  const cores = [];
  const factory = async () => {
    const core = {
      kind: "fake",
      guard: null,
      closed: false,
      async setNavigationGuard(g) {
        this.guard = g;
      },
      async render(url) {
        return { url, status: 200, title: "t", text: "x".repeat(1000), html: "", clearanceWaitedMs: 0 };
      },
      async close() {
        this.closed = true;
      },
    };
    cores.push(core);
    return core;
  };
  return { factory, cores };
}

test("normalizeHost lowercases, trims, drops leading www.", () => {
  assert.equal(normalizeHost("  WWW.Example.COM "), "example.com");
});

test("Allowlist: exact (www-insensitive) and *.subdomain matching", () => {
  const a = new Allowlist(["example.com", "*.news.ycombinator.com"]);
  assert.equal(a.allows("example.com"), true);
  assert.equal(a.allows("www.example.com"), true);
  assert.equal(a.allows("evil.com"), false);
  assert.equal(a.allows("news.ycombinator.com"), true); // apex via *.
  assert.equal(a.allows("api.news.ycombinator.com"), true); // subdomain via *.
  assert.equal(a.allows("ycombinator.com"), false);
  assert.equal(a.allows(""), false);
});

test("ConsumerRegistry resolves by token; rejects duplicate tokens", () => {
  const r = new ConsumerRegistry([{ id: "a", token: "ta", allow: ["x.com"] }]);
  assert.equal(r.resolve("ta")?.id, "a");
  assert.equal(r.resolve("nope"), undefined);
  assert.throws(() => r.add({ id: "b", token: "ta", allow: [] }), /duplicate consumer token/);
});

test("authenticate: known token returns consumer + audits auth-ok", () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "agent-1", token: "tok", allow: ["example.com"] }]),
    audit,
  });
  const c = policy.authenticate("tok");
  assert.equal(c.id, "agent-1");
  assert.ok(audit.records.some((r) => r.decision === "auth-ok" && r.consumerId === "agent-1"));
});

test("authenticate: unknown token throws UNAUTHENTICATED + audits the rejection", () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({ registry: new ConsumerRegistry([]), audit });
  assert.throws(
    () => policy.authenticate("bad"),
    (e) => e instanceof PolicyError && e.code === "UNAUTHENTICATED",
  );
  assert.ok(
    audit.records.some((r) => r.decision === "auth-reject" && r.consumerId === null),
  );
});

test("guardFor: allows allowlisted host, blocks others, audits both", () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "agent-1", token: "tok", allow: ["example.com"] }]),
    audit,
  });
  const guard = policy.guardFor(policy.authenticate("tok"));
  assert.equal(guard(nav("example.com")), "allow");
  assert.equal(guard(nav("evil.com")), "block");
  const a = audit.forConsumer("agent-1");
  assert.ok(a.some((r) => r.action === "navigate" && r.decision === "allow" && r.host === "example.com"));
  assert.ok(a.some((r) => r.action === "navigate" && r.decision === "block" && r.host === "evil.com"));
});

test("guardFor: allowed subresources are not audited (signal-dense trail)", () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "agent-1", token: "tok", allow: ["example.com"] }]),
    audit,
  });
  const guard = policy.guardFor(policy.authenticate("tok"));
  guard({ url: "https://example.com/app.js", host: "example.com", resourceType: "script", isNavigationRequest: false });
  assert.equal(audit.forConsumer("agent-1").filter((r) => r.action === "navigate").length, 0);
});

test("per-consumer scope: each consumer's allowlist is independent", () => {
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([
      { id: "a", token: "ta", allow: ["alpha.com"] },
      { id: "b", token: "tb", allow: ["beta.com"] },
    ]),
  });
  const ga = policy.guardFor(policy.authenticate("ta"));
  const gb = policy.guardFor(policy.authenticate("tb"));
  assert.equal(ga(nav("alpha.com")), "allow");
  assert.equal(ga(nav("beta.com")), "block");
  assert.equal(gb(nav("beta.com")), "allow");
  assert.equal(gb(nav("alpha.com")), "block");
});

test("withConsumerSession: unknown consumer rejected before any session opens", async () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "agent-1", token: "tok", allow: ["example.com"] }]),
    audit,
  });
  const { factory, cores } = makeFactory();
  const gw = Gateway.create({ maxSessions: 2, core: {} }, factory, policy);
  await assert.rejects(
    gw.withConsumerSession("bad", async () => {}),
    (e) => e instanceof PolicyError && e.code === "UNAUTHENTICATED",
  );
  assert.equal(cores.length, 0, "no core created — session never opened");
  assert.equal(gw.sessions.activeCount, 0);
});

test("withConsumerSession: installs the consumer guard and attributes the audit", async () => {
  const audit = new InMemoryAuditSink();
  const policy = new PolicyEngine({
    registry: new ConsumerRegistry([{ id: "agent-1", token: "tok", allow: ["example.com"] }]),
    audit,
  });
  const { factory, cores } = makeFactory();
  const gw = Gateway.create({ maxSessions: 2, core: {} }, factory, policy);

  const result = await gw.withConsumerSession("tok", async (session, consumer) => {
    assert.equal(consumer.id, "agent-1");
    const guard = cores[0].guard;
    assert.equal(typeof guard, "function", "guard installed on the core");
    assert.equal(guard(nav("example.com")), "allow");
    assert.equal(guard(nav("evil.com")), "block");
    return session.core.render("https://example.com/");
  });

  assert.equal(result.status, 200);
  assert.equal(gw.sessions.activeCount, 0, "session released");
  assert.equal(cores[0].closed, true, "core closed");
  const agent1 = audit.forConsumer("agent-1");
  assert.ok(agent1.some((r) => r.decision === "auth-ok"));
  assert.ok(agent1.some((r) => r.decision === "allow" && r.host === "example.com"));
  assert.ok(agent1.some((r) => r.decision === "block" && r.host === "evil.com"));
});
