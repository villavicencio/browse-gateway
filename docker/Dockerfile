# browse-gateway browser core — Node + real Google Chrome + Xvfb + Patchright.
#
# Runs the browser HEADFUL under Xvfb (strict headless fails the anti-bot challenges this
# gateway exists to clear — see the private plan, R2/R6). The default command is the U1
# stealth-validation kill-gate; later units run the gateway service against the same image.
#
# Build/run as linux/amd64 (real Google Chrome ships amd64-only; that's also what the
# production host executes):
#   docker build --platform linux/amd64 -f docker/Dockerfile -t browse-gateway:u1 .
#   docker run --rm --platform linux/amd64 --shm-size=1g browse-gateway:u1
FROM node:22-bookworm-slim

# System dependencies: real Google Chrome, Xvfb (virtual display), tzdata (so the wall
# clock can match the proxy exit geo), and a desktop-realistic font set so pages render —
# and fingerprint — like a real machine, not a server. A sparse font list is an anti-bot
# tell; fonts-{dejavu,freefont,croscore,noto-core} add common desktop families (croscore
# is metric-compatible with Arial/Times/Courier). Chrome's transitive deps resolve via the .deb.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates wget gnupg tzdata \
        xvfb xauth \
        fonts-liberation fonts-noto-color-emoji fonts-unifont \
        fonts-dejavu fonts-freefont-ttf fonts-croscore fonts-noto-core \
    && wget -q -O /tmp/chrome.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Patchright drives the system Chrome via channel:"chrome"; its patched driver (not a
# bundled browser) provides the stealth, so skip the browser download entirely.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PATCHRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build

# A reap-safe PID 1, baked into the IMAGE (issue #131 piece 2).
#
# This used to be a comment asking whoever created the container to pass `--init`. A hand-written
# `docker run` dropped the flag, node became PID 1, and node never reaps reparented orphans — so every
# exited Chrome child became a permanent zombie. A zombie still answers `kill(-pgid, 0)`, so the
# teardown's group-empty confirmation could never confirm, sessions were retained in `#unconfirmed`
# forever, and the pool saturated at maxSessions with zero live browsers. A property of the image
# cannot be forgotten at the call site; a comment can.
#
# Its own layer, deliberately AFTER the Chrome layer: that block also fetches
# google-chrome-stable_current_amd64.deb, so editing it would let a PID-1 change move the browser
# version — and the browser version is the stealth surface.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# WebRTC must not gather ICE candidates outside the proxy (STUN over plain UDP reveals
# the host's real IP alongside the proxied one — "proxy detected" to anti-bot vendors).
# The managed-policy file is the mechanism that actually works on current Chrome: the
# --force-webrtc-ip-handling-policy launch switch is on the cmdline but IGNORED as of
# Chrome 149 (verified empirically: switch present, srflx still leaked; policy file
# present, zero non-proxied candidates). Installed for both branded Chrome and the
# Chromium fallback channels.
COPY docker/policies/webrtc-ip-handling.json /etc/opt/chrome/policies/managed/webrtc-ip-handling.json
COPY docker/policies/webrtc-ip-handling.json /etc/chromium/policies/managed/webrtc-ip-handling.json

# Headful under Xvfb; running as root in the container, so Chrome needs --no-sandbox.
# TZ: a US (Eastern) wall clock to match the residential proxy's `_country-us` exit — a
# UTC browser behind a US IP is a geo mismatch. ICU/V8 read TZ; the symlink keeps glibc
# consistent. (Static US per the deploy decision; revisit if exits broaden beyond US.)
ENV BGW_CHANNEL=chrome \
    BGW_NO_SANDBOX=1 \
    TZ=America/New_York \
    DISPLAY=:99
RUN ln -sf /usr/share/zoneinfo/America/New_York /etc/localtime && echo "America/New_York" > /etc/timezone

# tini is PID 1 and reaps reparented orphans; the entrypoint then provisions the Xvfb display and
# exec's the command (the kill-gate by default), so the command is tini's direct child and receives
# SIGTERM for its graceful drain. Reaping is now a property of the IMAGE — `--init` is still passed by
# the deploy path and is harmless (see below), but nothing depends on remembering it.
#
# `-s` (subreaper) matters only under DOUBLE init: `docker run --init` puts docker-init at PID 1, and
# without `-s` the inner tini prints "Tini is not running as PID 1 … zombie reaping won't work" on
# every boot — a false statement, in exactly the incident class this change closes. `-s` silences it
# and is a no-op when tini IS PID 1. Note the side effect: under double init, orphans reparent to the
# inner tini rather than to PID 1, so a runbook grepping for PPID 1 zombies needs updating.
#
# DO NOT add `-g` / TINI_KILL_PROCESS_GROUP. It forwards SIGTERM to the whole process group, which
# includes the Xvfb this entrypoint backgrounds — measured: Xvfb goes state S -> Z at T+0 while node is
# still draining, manufacturing the in-flight-work-dies-instantly symptom of issue #129 from a brand
# new cause. It also does not reach Chrome, which patchright spawns detached as its own group leader,
# so it buys nothing in exchange.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "scripts/validate-stealth.mjs"]
