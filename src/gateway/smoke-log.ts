/**
 * Redacting log helpers for the U2 smoke entrypoint ({@link ./main.ts}; audit #5). Kept in a SEPARATE,
 * side-effect-free module so they are import-safe and unit-testable WITHOUT running `main()` (which
 * executes at module load). Every line the smoke entry emits goes through one of these, so dev/CI
 * output can never carry a BGW_* secret — in a config dump, a URL, a page title, or a nested
 * browser-launch error `cause`.
 */
import { redactSecrets } from "../security/index.js";
import type { SecretStore } from "../security/index.js";

/** Scrub every loaded secret from an arbitrary diagnostic line before it is printed. */
export function smokeLine(msg: string, secrets: SecretStore): string {
  return redactSecrets(msg, secrets);
}

const MAX_DEPTH = 6;
const MAX_ITEMS = 50; // cap breadth so a pathological error/array can't produce unbounded log output

// V8's native lazy-`stack` getter, captured once at load. Its identity is stable across Error
// instances, so an error's own `stack` accessor is invoked ONLY when it IS this function — a hostile
// override (`Object.defineProperty(err, "stack", { get })`) has a different identity and is never
// called. This is how frames are retained safely (incl. on Node 24, where Error.prepareStackTrace is
// the runtime's own built-in formatter, so an undefined-only gate would wrongly drop all frames).
const NATIVE_STACK_GET = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

/**
 * Read `key` as a DATA property (own, then up the prototype chain) WITHOUT invoking an accessor. Returns
 * `{ data }` for a data property, `{ getter: true }` for an accessor (so the caller can represent it
 * without evaluating it), or undefined if absent. This is how every field is read below — the sole
 * accessor we ever invoke is the standard `stack` (see the Error branch).
 */
function readData(obj: object, key: PropertyKey): { data: unknown } | { getter: true } | undefined {
  let o: object | null = obj;
  while (o) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d) return "value" in d ? { data: d.value } : { getter: true };
    o = Object.getPrototypeOf(o);
  }
  return undefined;
}

/**
 * Recursively render a value to a diagnostic string, scrubbing every raw string LEAF and KEY with
 * `redactSecrets` BEFORE serialization. `util.inspect`/JSON escaping would otherwise transform a secret
 * (a value containing `\` or `"`) into a form that no longer matches the stored value — so a plain
 * inspect-then-redact leaks it, and template-coercing an unknown value (`${x}`) would too. Every field
 * — object props, array indices, `name`/`message`/`cause` — is read via property DESCRIPTORS so a
 * CUSTOM getter is NEVER invoked (a throwing getter can't crash the logger; a secret-returning getter
 * can't leak). The ONE deliberate exception is the standard `stack` accessor (V8's own; the primary
 * diagnostic), read in a try/catch and redacted. Errors (stack + custom own fields + `cause` chain +
 * `AggregateError.errors`), arrays, plain objects, and non-Error throws are all handled; bounded by
 * depth, breadth, and a cycle guard so output stays finite.
 */
function redactValue(v: unknown, secrets: SecretStore, depth: number, seen: WeakSet<object>): string {
  const scrub = (s: string): string => redactSecrets(s, secrets);
  switch (typeof v) {
    case "string":
      return JSON.stringify(scrub(v)); // scrub the RAW string, THEN quote — escaping a redacted string is safe
    case "number":
    case "boolean":
    case "bigint":
      return String(v);
    case "undefined":
      return "undefined";
    case "function": {
      // Read the function's `name` as DATA only — a hostile function can define a `name` GETTER that
      // returns an escaped secret; never invoke it.
      const n = readData(v as object, "name");
      const nm = n && "data" in n && typeof n.data === "string" ? scrub(n.data) : "anonymous";
      return `[Function ${nm}]`;
    }
    case "symbol":
      return scrub((v as symbol).toString());
  }
  if (v === null) return "null";
  const obj = v as object;
  if (seen.has(obj)) return "[circular]";
  if (depth <= 0) return "[…]";
  seen.add(obj);
  const child = (x: unknown): string => redactValue(x, secrets, depth - 1, seen);
  const slot = (found: ReturnType<typeof readData>): string =>
    !found ? "undefined" : "getter" in found ? "[getter]" : child(found.data);

  if (Array.isArray(v)) {
    const n = Math.min(v.length, MAX_ITEMS);
    const items: string[] = [];
    for (let i = 0; i < n; i++) items.push(slot(readData(v, i))); // per-index descriptor — never invoke an index getter
    if (v.length > MAX_ITEMS) items.push(`…(+${v.length - MAX_ITEMS})`);
    return `[${items.join(", ")}]`;
  }

  if (v instanceof Error) {
    const parts: string[] = [];
    // Header = the stack when it can be obtained SAFELY, else a composed name/message line.
    // The hazard: reading a LAZY `stack` accessor triggers V8's default formatter, which string-COERCES
    // `name`/`message` — so a data-valued `name` with a hostile `toString()` would leak an escaped
    // secret even with an ordinary Error. So only trust the stack when there is no coercion risk:
    //   • it is ALREADY materialized (a cached data-property string — no formatter runs), OR
    //   • it is a lazy accessor AND `name`/`message` are both PRIMITIVE strings (coercion is identity)
    //     AND no custom `Error.prepareStackTrace` can inject content.
    // Otherwise compose the header from descriptor-read fields — never invoking `stack` or coercing a
    // non-primitive. Either way the resulting string is redacted BEFORE it is emitted.
    const nameD = readData(v, "name");
    const msgD = readData(v, "message");
    const namePrim = nameD && "data" in nameD && typeof nameD.data === "string" ? nameD.data : undefined;
    const msgPrim = msgD && "data" in msgD && typeof msgD.data === "string" ? msgD.data : undefined;
    const stackDesc = Object.getOwnPropertyDescriptor(v, "stack");
    if (stackDesc && "value" in stackDesc && typeof stackDesc.value === "string") {
      // Already materialized — a cached data-property string; no formatter runs. Redact directly.
      parts.push(scrub(stackDesc.value));
    } else if (
      stackDesc &&
      typeof stackDesc.get === "function" &&
      stackDesc.get === NATIVE_STACK_GET &&
      namePrim !== undefined &&
      msgPrim !== undefined
    ) {
      // Identity-VERIFIED native lazy getter + PRIMITIVE name/message: the runtime formatter coerces
      // only those primitives (identity), producing real frames we can safely redact. Invoke the
      // CAPTURED native getter via Reflect.apply — NOT `v.stack`, which a Proxy-wrapped error could
      // intercept with a get-trap that returns an escaped secret. If the receiver isn't a real Error
      // (e.g. a Proxy has no [[ErrorData]]), the native getter throws → fall back to the composed
      // header. A hostile own `stack` getter fails the identity check and is never reached. (A
      // maliciously-installed GLOBAL Error.prepareStackTrace is a whole-process compromise, not
      // error-object-reachable, and outside this dev logger's threat model.)
      let stack: string | undefined;
      try {
        const s = Reflect.apply(stackDesc.get, v, []);
        if (typeof s === "string") stack = s;
      } catch {
        /* not a genuine Error receiver, or a throwing getter — compose the header instead */
      }
      parts.push(scrub(stack ?? `${namePrim}: ${msgPrim}`));
    } else {
      // Non-native/absent stack getter, or a non-primitive name/message → never invoke, never coerce.
      parts.push(`${slot(nameD)}: ${slot(msgD)}`);
    }
    // Custom own keys (incl. non-enumerable like AggregateError.errors, and Symbol keys); skip the
    // standard ones handled here. Each read via descriptor — a custom getter is marked, never invoked.
    for (const key of Reflect.ownKeys(v).slice(0, MAX_ITEMS)) {
      if (key === "stack" || key === "message" || key === "name" || key === "cause") continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      parts.push(`${scrub(String(key))}=${d && "value" in d ? child(d.value) : "[getter]"}`);
    }
    const cause = readData(v, "cause");
    if (cause && "data" in cause && cause.data !== undefined) parts.push(`[cause] ${child(cause.data)}`);
    else if (cause && "getter" in cause) parts.push("[cause] [getter]");
    return parts.join(" | ");
  }

  // Plain object or any other non-Error throw: walk own descriptors without invoking getters; redact keys too.
  const keys = Reflect.ownKeys(obj);
  const parts: string[] = [];
  for (const key of keys.slice(0, MAX_ITEMS)) {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    parts.push(`${scrub(String(key))}: ${d && "value" in d ? child(d.value) : "[getter]"}`);
  }
  if (keys.length > MAX_ITEMS) parts.push(`…(+${keys.length - MAX_ITEMS})`);
  return `{${parts.join(", ")}}`;
}

/**
 * Format a failure line preserving the FULL error — `Error.cause` chain, custom fields (e.g.
 * SessionManagerError's `code` + wrapped driver failure), arrays, `AggregateError.errors` — so the smoke
 * gate keeps its actionable diagnostics, while redacting every secret BEFORE serialization
 * (see {@link redactValue}). Wrapped so a pathological error can never crash the handler or leak via an
 * uncaught throw.
 */
export function smokeErrorLine(prefix: string, err: unknown, secrets: SecretStore): string {
  let body: string;
  try {
    body = redactValue(err, secrets, MAX_DEPTH, new WeakSet());
  } catch {
    body = "[error could not be safely serialized]";
  }
  return `${prefix} ${body}`;
}

/**
 * Render a URL for logging as its ORIGIN only. A smoke URL (BGW_SMOKE_URL) can carry secrets a
 * BGW-secret redactor would NOT catch — `user:pass@` userinfo, a signed `?token=` query, OR a
 * credential in the PATH (a reset/signed path segment) — and a `data:`/`javascript:` URL can carry an
 * arbitrary payload. So: accept only http(s), emit `scheme://host`, and ELIDE any non-root path (its
 * presence is flagged, its contents never logged). Any other scheme or an unparseable string yields a
 * fixed placeholder — the raw string is never echoed.
 */
export function safeUrlForLog(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "<unparseable-url>";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "<non-http-url>";
  const path = u.pathname === "/" || u.pathname === "" ? "" : "/<path>";
  return `${u.origin}${path}`;
}
