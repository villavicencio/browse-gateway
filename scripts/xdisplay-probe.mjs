/**
 * Is there a LIVE X server on this display? (issue #133)
 *
 * The entrypoint used to answer this with `[ -S /tmp/.X11-unix/X99 ]` — "is there a file of type
 * socket at this path". A socket file outlives the server that made it, so after a restart the check
 * passed against the previous run's leftover while Xvfb had actually refused to start ("Server is
 * already active for display 99"). The container then served HTTP normally with no display at all,
 * and every browser launch failed.
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not check the Xvfb pid with `kill -0`. A SIGKILLed Xvfb becomes a zombie child of the
 *     entrypoint, and a zombie answers signal 0 — the exact lie that made issue #131 possible. Asking
 *     the kernel "does this pid exist" cannot distinguish a running server from a dead one.
 *   - It does not shell out to xdpyinfo/xset. The image installs `xvfb` and `xauth` only; no X client
 *     tools are present. node is guaranteed present, so the handshake is done here.
 *
 * The only honest test is to connect and complete the X11 connection setup: send the 12-byte setup
 * request and require reply byte 1 (Success). A dead socket refuses the connection; a non-X listener
 * fails the handshake.
 *
 *   node scripts/xdisplay-probe.mjs [display] [timeoutMs]
 *
 * Exit 0 when the server answered Success. Non-zero — with a reason — otherwise.
 */
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/**
 * `:99` and `:99.0` are the same display; the screen suffix is not part of the socket name. Getting
 * this wrong is silent: `${DISPLAY#*:}` in shell yields `99.0`, pointing at `/tmp/.X11-unix/X99.0`,
 * which never exists — so a cleanup keyed off it removes nothing and a probe keyed off it never
 * connects.
 */
export function socketPathFor(display) {
  const spec = String(display ?? ":99").trim();
  const colon = spec.indexOf(":");
  if (colon === -1) return undefined;
  // Anything BEFORE the colon is a host — `host:0` is a TCP display served by another machine, not a
  // local unix socket, and silently mapping it to /tmp/.X11-unix/X0 would probe the wrong server
  // entirely. Only a bare `:N` (or `:N.S`) is local.
  if (spec.slice(0, colon).length > 0) return undefined;
  const screenless = spec.slice(colon + 1).split(".")[0];
  if (!/^\d+$/.test(screenless)) return undefined;
  return `/tmp/.X11-unix/X${screenless}`;
}

/** X11 connection setup request: byte order, protocol 11.0, no auth. 12 bytes. */
function setupRequest() {
  const buf = Buffer.alloc(12);
  buf.write("l", 0, "ascii"); // little-endian
  buf.writeUInt16LE(11, 2); // protocol-major-version
  buf.writeUInt16LE(0, 4); // protocol-minor-version
  buf.writeUInt16LE(0, 6); // auth-protocol-name length
  buf.writeUInt16LE(0, 8); // auth-protocol-data length
  return buf;
}

/** One attempt: connect, handshake, read the first reply byte. Resolves a reason string, or null on success. */
export function probeOnce(path, connectTimeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (reason) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(reason);
    };
    const sock = connect(path);
    sock.setTimeout(connectTimeoutMs, () => done("timed out waiting for the X server to reply"));
    sock.on("error", (err) => done(`connect failed (${err.code ?? err.message})`));
    sock.on("connect", () => sock.write(setupRequest()));
    sock.on("data", (chunk) => {
      const status = chunk[0];
      if (status === 1) return done(null); // Success — a real X server accepted us
      if (status === 2) return done("X server replied Authenticate — it is alive but refusing this client");
      return done(`X server replied Failed (status byte ${status})`);
    });
    // A non-X listener typically accepts the connection then closes without replying.
    sock.on("end", () => done("socket closed without an X11 reply — not an X server"));
    sock.on("close", () => done("socket closed before an X11 reply — not an X server"));
  });
}

/** Poll until the server answers Success or the budget runs out. Returns null on success, else a reason. */
export async function waitForDisplay(display, timeoutMs = 5000) {
  const path = socketPathFor(display);
  if (path === undefined) return `display ${display} is not a local socket display`;
  const deadline = Date.now() + timeoutMs;
  let last = "never attempted";
  while (Date.now() < deadline) {
    last = await probeOnce(path);
    if (last === null) return null;
    await delay(100);
  }
  return `${last} (after ${timeoutMs}ms at ${path})`;
}

// Run as a script (not when imported by the gate).
if (process.argv[1] && process.argv[1].endsWith("xdisplay-probe.mjs")) {
  const display = process.argv[2] ?? process.env.DISPLAY ?? ":99";
  const timeoutMs = Number(process.argv[3] ?? 5000);
  const reason = await waitForDisplay(display, timeoutMs);
  if (reason === null) {
    console.log(`xdisplay-probe: ${display} is live (${socketPathFor(display)})`);
    process.exit(0);
  }
  console.error(`xdisplay-probe: ${display} is NOT usable — ${reason}`);
  process.exit(1);
}
