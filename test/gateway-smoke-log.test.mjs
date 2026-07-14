/**
 * Smoke-log helpers (audit #5) — redaction of the U2 smoke entrypoint's stdout/stderr. Imported from a
 * SEPARATE module so these run WITHOUT executing gateway/main.js's `main()` (which launches a browser).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { smokeLine, smokeErrorLine, safeUrlForLog } from "../dist/gateway/smoke-log.js";
import { SecretStore } from "../dist/security/index.js";

test("smokeLine: a loaded secret is scrubbed from an arbitrary line (config dump / page title carrier)", () => {
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: "sup3r-secret-pw" }));
  const out = smokeLine(`[gateway] up core={"note":"sup3r-secret-pw"} title="reflected sup3r-secret-pw"`, secrets);
  assert.ok(!out.includes("sup3r-secret-pw"), "the secret is redacted wherever it appears in the line");
  assert.ok(out.includes("[REDACTED]"), "redaction marker present");
});

test("smokeErrorLine: preserves a nested Error.cause (diagnostics) AND redacts a secret hidden in it", () => {
  // Mirrors SessionManagerError: a static wrapper message with the real driver failure in `cause`.
  const proxyUrl = "http://u:sup3r-secret-pw@proxy.example:8080";
  const secrets = new SecretStore(() => ({ BGW_PROXY_URL: proxyUrl }));
  const cause = new Error(`net::ERR_PROXY_CONNECTION_FAILED connecting via ${proxyUrl}`);
  const wrapper = new Error("browser core failed to launch", { cause });
  wrapper.code = "CORE_LAUNCH";
  const out = smokeErrorLine("[gateway] SMOKE FAILED ❌", wrapper, secrets);
  assert.ok(out.includes("browser core failed to launch"), "wrapper message present");
  assert.ok(out.includes("ERR_PROXY_CONNECTION_FAILED"), "root-cause diagnostic PRESERVED (not just the wrapper stack)");
  assert.ok(out.includes("CORE_LAUNCH"), "custom error field preserved");
  assert.ok(!out.includes("sup3r-secret-pw"), "the secret embedded in the nested cause is redacted");
  assert.ok(!out.includes(proxyUrl), "the full proxy URL in the cause is redacted");
});

test("smokeErrorLine: a secret in a nested cause's CUSTOM field with quotes/backslash is redacted (pre-serialization)", () => {
  // The escaping hazard: util.inspect would turn `abc"def\ghi` into an escaped form that no longer
  // matches the stored value, so inspect-THEN-redact would miss it. Redacting the RAW string first fixes it.
  const secret = 'abc"def\\ghi-long-proxy-pass';
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const cause = new Error("driver spawn failed");
  cause.detail = secret; // secret in a custom STRING field of the cause (not just the message)
  const wrapper = new Error("browser core failed to launch", { cause });
  const out = smokeErrorLine("X", wrapper, secrets);
  assert.ok(!out.includes(secret), "raw secret in a nested custom field is redacted");
  assert.ok(!out.includes('abc\\"def'), "the inspect-escaped form of the secret does not leak either");
  assert.ok(out.includes("driver spawn failed"), "cause diagnostics preserved");
  assert.ok(out.includes("[REDACTED]"), "redaction marker present");
});

test("smokeErrorLine: redacts across a DEEP cause chain and terminates (bounded + cycle-safe)", () => {
  const secret = "deep-chain-secret-value";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const c3 = new Error(`level-3 leaked ${secret}`);
  const c2 = new Error("level-2", { cause: c3 });
  const c1 = new Error("level-1", { cause: c2 });
  const top = new Error("top", { cause: c1 });
  const out = smokeErrorLine("X", top, secrets);
  assert.ok(!out.includes(secret), "a secret three causes deep is still redacted");
  assert.ok(out.includes("level-2") && out.includes("level-1"), "intermediate cause diagnostics preserved");
  // Cycle guard: a self-referential cause must not infinite-loop.
  const a = new Error("a-loop");
  a.cause = a;
  assert.ok(smokeErrorLine("X", a, secrets).includes("a-loop"), "self-referential cause terminates");
});

test("smokeErrorLine: redacts secrets in NESTED objects, arrays, and KEYS, and in non-Error throws", () => {
  const secret = 'nested"secret\\value-long';
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const err = new Error("boom");
  err.meta = { token: secret, list: ["ok", secret], [secret]: "value-under-a-secret-key" };
  const out = smokeErrorLine("X", err, secrets);
  assert.ok(!out.includes(secret), "secret nested in an object field, an array, and used AS a key is redacted");
  assert.ok(!out.includes('nested\\"secret'), "the escaped form of the secret does not leak");
  // A non-Error throw (a plain object) with a nested secret.
  const out2 = smokeErrorLine("X", { detail: { pw: secret }, list: [secret] }, secrets);
  assert.ok(!out2.includes(secret), "secret in a thrown plain object is redacted");
});

test("smokeErrorLine: a throwing/secret getter is neither invoked nor leaked, and never crashes the logger", () => {
  const secret = "getter-held-secret-value";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const err = new Error("boom");
  Object.defineProperty(err, "token", { enumerable: true, get() { throw new Error(`leak ${secret}`); } });
  Object.defineProperty(err, "sekret", { enumerable: true, get() { return secret; } });
  let out;
  assert.doesNotThrow(() => { out = smokeErrorLine("X", err, secrets); }, "a throwing getter must not crash the logger");
  assert.ok(!out.includes(secret), "getters are not invoked, so neither the thrown nor the returned secret can leak");
  assert.ok(out.includes("[getter]"), "getter properties are marked, not evaluated");
});

test("smokeErrorLine: never coerces a non-string name, never invokes a cause or array-index getter", () => {
  const secret = 'coerce"secret\\value-long';
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));

  // (a) No stack + a non-string `name` whose toString() WOULD escape the secret — must not be coerced.
  const e = new Error("boom");
  Object.defineProperty(e, "stack", { value: undefined, configurable: true }); // force the header path
  Object.defineProperty(e, "name", { value: { toString: () => secret }, configurable: true, enumerable: false });
  const outA = smokeErrorLine("X", e, secrets);
  assert.ok(!outA.includes(secret), "a non-string name is never template-coerced into an un-redacted secret");

  // (b) A `cause` defined as a getter must be marked, not invoked (no throw, no leak).
  const g = new Error("boom2");
  Object.defineProperty(g, "cause", { enumerable: false, configurable: true, get() { throw new Error(`leak ${secret}`); } });
  let outB;
  assert.doesNotThrow(() => { outB = smokeErrorLine("X", g, secrets); });
  assert.ok(!outB.includes(secret) && outB.includes("[getter]"), "a cause getter is marked, not invoked");

  // (c) An array-index getter must be marked, not invoked.
  const h = new Error("boom3");
  const arr = [];
  Object.defineProperty(arr, 0, { enumerable: true, configurable: true, get() { return secret; } });
  h.items = arr;
  const outC = smokeErrorLine("X", h, secrets);
  assert.ok(!outC.includes(secret) && outC.includes("[getter]"), "an array-index getter is marked, not invoked");
});

test("smokeErrorLine: a lazy stack is NOT read when name/message aren't primitive strings (no toString-coercion leak)", () => {
  const secret = 'stack"coerce\\secret-long-value';
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  let toStringCalled = false;
  const e = new Error("boom");
  // A data-valued (non-string) `name` whose toString would escape the secret. `stack` is left LAZY
  // (never accessed here), so reading it would invoke V8's formatter and coerce this name.
  Object.defineProperty(e, "name", {
    configurable: true,
    enumerable: false,
    value: { toString() { toStringCalled = true; return JSON.stringify(secret); } },
  });
  const out = smokeErrorLine("X", e, secrets);
  assert.equal(toStringCalled, false, "the non-string name's toString is never invoked (stack not read)");
  assert.ok(!out.includes(secret), "the raw secret never reaches the log");
  assert.ok(!out.includes(JSON.stringify(secret)), "nor the escaped form the toString would have produced");
});

test("smokeErrorLine: a function field with a hostile name getter is not invoked", () => {
  const secret = "fn-name-getter-secret-value";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const fn = function () {};
  Object.defineProperty(fn, "name", { configurable: true, get() { return secret; } });
  const e = new Error("boom");
  e.handler = fn; // a function stored in a custom error field
  const out = smokeErrorLine("X", e, secrets);
  assert.ok(!out.includes(secret), "a function's name getter is not invoked, so its secret can't leak");
  assert.ok(out.includes("[Function anonymous]"), "the function renders with a safe placeholder name");
});

test("smokeErrorLine: a normal Error surfaces REAL stack frames (diagnostics preserved on the supported runtime)", () => {
  const secrets = new SecretStore(() => ({}));
  const out = smokeErrorLine("X", new Error("ordinary boom"), secrets);
  assert.ok(out.includes("ordinary boom"), "the message is present");
  assert.match(out, /\n\s*at /, "actual call-site stack frames are present (not just the header) — even on Node 24");
});

test("smokeErrorLine: a HOSTILE own stack getter fails the native-identity check and is never invoked", () => {
  const secret = "hostile-stack-getter-secret-value";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  let called = false;
  const e = new Error("boom"); // primitive name/message, so only the getter identity gates invocation
  Object.defineProperty(e, "stack", { configurable: true, get() { called = true; return JSON.stringify(secret); } });
  const out = smokeErrorLine("X", e, secrets);
  assert.equal(called, false, "a non-native stack getter is never invoked (identity check)");
  assert.ok(!out.includes(secret) && !out.includes(JSON.stringify(secret)), "neither raw nor escaped secret leaks");
  assert.ok(out.includes("boom"), "the composed header still carries the message");
});

test("smokeErrorLine: a data-valued stack holding an ESCAPED secret is redacted (JSON + util.inspect forms)", () => {
  const secret = 'stack"held\\secret-long-value';
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const jsonForm = JSON.stringify(secret).slice(1, -1);
  const inspectForm = inspect(secret, { maxStringLength: Infinity }).slice(1, -1);
  const e = new Error("boom");
  // Both serializer-escaped forms placed directly in a materialized (data) stack.
  Object.defineProperty(e, "stack", { configurable: true, value: `Error: boom\n  json=${jsonForm} inspect=${inspectForm}` });
  const out = smokeErrorLine("X", e, secrets);
  assert.ok(!out.includes(secret), "raw secret absent");
  assert.ok(!out.includes(jsonForm), "the JSON-escaped form in the data stack is redacted");
  assert.ok(!out.includes(inspectForm), "the util.inspect-escaped form in the data stack is redacted");
});

test("smokeErrorLine: a Proxy-wrapped Error cannot leak via a stack get-trap (Reflect.apply on the captured getter)", () => {
  const secret = 'proxy"trap\\secret-long-value';
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const real = new Error("boom");
  const nativeDesc = Object.getOwnPropertyDescriptor(new Error(), "stack"); // genuine native descriptor
  let trapCalled = false;
  const proxy = new Proxy(real, {
    get(target, prop, recv) {
      if (prop === "stack") { trapCalled = true; return JSON.stringify(secret); } // hostile get-trap
      return Reflect.get(target, prop, recv);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "stack") return nativeDesc; // report the GENUINE native descriptor to pass the identity check
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const out = smokeErrorLine("X", proxy, secrets);
  assert.equal(trapCalled, false, "the stack get-trap is never invoked (Reflect.apply targets the captured native getter, not v.stack)");
  assert.ok(!out.includes(secret) && !out.includes(JSON.stringify(secret).slice(1, -1)), "no secret leaks");
});

test("smokeErrorLine: redacts secrets inside AggregateError.errors", () => {
  const secret = "aggregate-member-secret-value";
  const secrets = new SecretStore(() => ({ BGW_PROXY_PASSWORD: secret }));
  const agg = new AggregateError([new Error(`member leaked ${secret}`), new Error("ok")], "all sub-tasks failed");
  const out = smokeErrorLine("X", agg, secrets);
  assert.ok(!out.includes(secret), "a secret inside an AggregateError member error is redacted");
  assert.ok(out.includes("all sub-tasks failed"), "the aggregate message is preserved");
});

test("safeUrlForLog: origin only — userinfo/query/fragment AND path elided; http(s)-only", () => {
  // Path is ELIDED, not echoed: a path segment can itself be a secret (reset/signed token).
  assert.equal(
    safeUrlForLog("https://user:pass@site.example/reset/secret-token-123?token=xyz#frag"),
    "https://site.example/<path>",
    "userinfo/query/fragment dropped and the path is elided (not echoed)",
  );
  assert.equal(safeUrlForLog("https://example.com/"), "https://example.com", "root path → bare origin");
  assert.equal(safeUrlForLog("http://host.example:8080/a/b"), "http://host.example:8080/<path>", "non-default port kept, path elided");
  // Non-http(s) schemes carry arbitrary payloads — never log them.
  assert.equal(safeUrlForLog("data:text/plain,secret-token-123"), "<non-http-url>");
  assert.equal(safeUrlForLog("javascript:alert(document.cookie)"), "<non-http-url>");
  assert.equal(safeUrlForLog("file:///etc/passwd"), "<non-http-url>");
  assert.equal(safeUrlForLog("not a url"), "<unparseable-url>");
});
