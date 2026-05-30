/**
 * Gateway bootstrap — the U2 verification entry.
 *
 * Proves the service starts, manages a session end-to-end through the single internal
 * path, and tears down without orphaning browser processes. Run inside the container
 * (headful under Xvfb); defaults to a benign public page so it exercises lifecycle, not
 * anti-bot (that's the U1 gate's job).
 */
import { Gateway } from "./index.js";

const TARGET = process.env.BGW_SMOKE_URL ?? "https://example.com/";

async function main(): Promise<void> {
  const gateway = Gateway.create();
  console.log(
    `[gateway] up — maxSessions=${gateway.config.maxSessions} core=${JSON.stringify(gateway.config.core)}`,
  );

  try {
    const result = await gateway.withSession(async (session) => {
      console.log(`[gateway] session ${session.id} open (active=${gateway.sessions.activeCount})`);
      return session.core.render(TARGET, { clearanceTimeoutMs: 15_000 });
    });

    const title = JSON.stringify(result.title).slice(0, 60);
    console.log(
      `[gateway] rendered ${TARGET} — status=${result.status} textLen=${result.text.length} title=${title}`,
    );
    console.log(`[gateway] active sessions after release: ${gateway.sessions.activeCount}`);

    if (gateway.sessions.activeCount !== 0) {
      throw new Error("session leaked after withSession returned");
    }
    if (result.text.length < 100) {
      throw new Error(`unexpectedly empty render (textLen=${result.text.length})`);
    }
  } finally {
    await gateway.shutdown();
    console.log(`[gateway] shutdown complete — active sessions: ${gateway.sessions.activeCount}`);
  }

  console.log("[gateway] SMOKE OK ✅");
}

main().catch((err) => {
  console.error("[gateway] SMOKE FAILED ❌", err);
  process.exit(1);
});
