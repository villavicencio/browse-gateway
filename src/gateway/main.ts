/**
 * Gateway bootstrap — the U2 verification entry.
 *
 * Proves the service starts, manages a session end-to-end through the single internal
 * path, and tears down without orphaning browser processes. Run inside the container
 * (headful under Xvfb); defaults to a benign public page so it exercises lifecycle, not
 * anti-bot (that's the U1 gate's job).
 */
import { Gateway } from "./index.js";
import { SecretStore } from "../security/index.js";
import { smokeLine, smokeErrorLine, safeUrlForLog } from "./smoke-log.js";

const TARGET = process.env.BGW_SMOKE_URL ?? "https://example.com/";
// Even dev/CI smoke output is not exempt from R9: EVERY line goes through the redacting smoke logger so
// no BGW_* secret reaches stdout/stderr — in a config dump, the target URL, a page title, or a nested
// launch-error cause (audit #5). Secrets loaded once from process.env at startup.
const secrets = new SecretStore();
const log = (msg: string) => console.log(smokeLine(msg, secrets));

async function main(): Promise<void> {
  const gateway = Gateway.create();
  log(`[gateway] up — maxSessions=${gateway.config.maxSessions} core=${JSON.stringify(gateway.config.core)}`);

  try {
    const result = await gateway.withSession(async (session) => {
      log(`[gateway] session ${session.id} open (active=${gateway.sessions.activeCount})`);
      return session.core.render(TARGET, { clearanceTimeoutMs: 15_000 });
    });

    // Do NOT log the raw page title — it is arbitrary TARGET-controlled content that can reflect a
    // token from the smoke URL (not a loaded BGW secret, so redaction can't catch it) and JSON-escaping
    // + truncating it before redaction would defeat exact-value scrubbing anyway. A length is a safe,
    // sufficient render signal alongside status/textLen. safeUrlForLog logs the URL as origin only.
    log(`[gateway] rendered ${safeUrlForLog(TARGET)} — status=${result.status} textLen=${result.text.length} titleLen=${result.title.length}`);
    log(`[gateway] active sessions after release: ${gateway.sessions.activeCount}`);

    if (gateway.sessions.activeCount !== 0) {
      throw new Error("session leaked after withSession returned");
    }
    if (result.text.length < 100) {
      throw new Error(`unexpectedly empty render (textLen=${result.text.length})`);
    }
  } finally {
    await gateway.shutdown();
    log(`[gateway] shutdown complete — active sessions: ${gateway.sessions.activeCount}`);
  }

  log("[gateway] SMOKE OK ✅");
}

main().catch((err) => {
  // smokeErrorLine preserves the FULL error (incl. the wrapped browser-launch `cause` — the actionable
  // root the smoke gate needs) via util.inspect, then redacts. err.stack alone would hide the cause.
  console.error(smokeErrorLine("[gateway] SMOKE FAILED ❌", err, secrets));
  process.exit(1);
});
