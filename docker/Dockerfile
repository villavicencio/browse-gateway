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

# The entrypoint provisions the Xvfb display, then exec's the command (the kill-gate by
# default). Run with `--init` so a proper init reaps the browser's child processes.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "scripts/validate-stealth.mjs"]
