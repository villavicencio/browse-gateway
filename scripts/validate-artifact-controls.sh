#!/usr/bin/env bash
# Task G RED-control matrix for scripts/validate-artifact.mjs.
#
# A gate is worth exactly as much as its ability to report bad news, and this repo's rule is that you
# must have WATCHED it do so. This script is that evidence, reproducibly: it builds the shipping image,
# then a set of deliberately sabotaged variants, and runs the gate against each.
#
# Two kinds of control, and the difference matters:
#
#   * DIST-PATCH controls sabotage the REAL shipping code path by patching the built `dist` in an
#     overlay image. What goes RED is production code, not a harness branch. The contract's two named
#     controls (muted listener, forced capture failure) are both of this kind. Each patch asserts its
#     anchor text is present BEFORE editing and absent/changed after, so a refactor that moves the code
#     fails the BUILD loudly instead of silently producing an unsabotaged image that "passes".
#
#   * HARNESS controls (BGW_ARTIFACT_GATE_RED=...) sabotage the PREMISE of exactly one leg, never the
#     assertion, so the assertion is what reports the failure.
#
# Every control must drive the gate to a non-zero exit AND fail its own target leg. A control that
# leaves the gate green has proven its leg is vacuous — two of this gate's legs were caught that way.
#
# Usage:  bash scripts/validate-artifact-controls.sh [--skip-build]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_TAG="browse-gateway:artifact-gate-base"
GATE_TAG="browse-gateway:artifact-gate"
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT

RUN_FLAGS=(--rm --platform linux/amd64 --shm-size=1g --init --add-host bill-fixture.test:127.0.0.1)

if [[ "${1:-}" != "--skip-build" ]]; then
  echo "==> building the shipping image"
  docker build --platform linux/amd64 -f "$REPO_ROOT/docker/Dockerfile" -t "$BASE_TAG" "$REPO_ROOT" >/dev/null || exit 1
  docker tag "$BASE_TAG" "$GATE_TAG"
fi

# --- dist-patch control images ----------------------------------------------------------------
# MUTED LISTENER: the persistent download listener is never installed, so a real Chrome download is
# emitted to nobody. This is the contract's named control, and it is also the exact shape the
# `captureEnabled` defect had in production before it was wired.
cat > "$CTX/muted-listener.Dockerfile" <<EOF
FROM $GATE_TAG
RUN grep -q 'page.on("download", (download) => this.#routeDownload(download, page));' /app/dist/browser/patchright-core.js \\
 && sed -i 's|page.on("download", (download) => this.#routeDownload(download, page));|/* MUTED LISTENER (RED control) */;|' /app/dist/browser/patchright-core.js \\
 && ! grep -q 'page.on("download"' /app/dist/browser/patchright-core.js
EOF

# FORCED CAPTURE FAILURE: the operation refuses every download it is offered. `registerDownload`
# returning exact `false` is a legitimate refusal in the ownership contract, so this exercises the
# refusal path rather than a synthetic throw. The contract's second named control.
cat > "$CTX/forced-capture-failure.Dockerfile" <<EOF
FROM $GATE_TAG
RUN grep -q "registerDownload(download) {" /app/dist/artifacts/index.js \\
 && sed -i '0,/registerDownload(download) {/s//registerDownload(download) { if (globalThis.__FORCE_CAPTURE_FAILURE) return false;/' /app/dist/artifacts/index.js \\
 && grep -q "__FORCE_CAPTURE_FAILURE" /app/dist/artifacts/index.js
RUN printf 'globalThis.__FORCE_CAPTURE_FAILURE = true;\\n' > /app/force-fail.cjs
ENV NODE_OPTIONS="--require /app/force-fail.cjs"
EOF

# UNWIRED captureEnabled: reverts the Task G fix in the built output. Regression control — if this
# ever stops going RED, the fix has been silently undone.
cat > "$CTX/unwire-capture.Dockerfile" <<EOF
FROM $GATE_TAG
RUN grep -q "config.core.captureEnabled = true;" /app/dist/mcp/runtime.js \\
 && sed -i 's|config.core.captureEnabled = true;|void 0; /* UNWIRED (RED control) */|' /app/dist/mcp/runtime.js \\
 && ! grep -q "config.core.captureEnabled = true" /app/dist/mcp/runtime.js
EOF

# REVERTED DISPOSAL EVIDENCE: puts the confirmation predicate back to "both promises must resolve",
# which against a real driver is unsatisfiable — cancel() and delete() are mutually exclusive. This is
# the regression control for the defect-2 fix, and it is what entitles the gate header to call three
# specific legs that fix's alarm. If it ever stops going RED, either the evidence is no longer being
# consulted or those legs have stopped depending on it.
cat > "$CTX/revert-disposal-evidence.Dockerfile" <<EOF
FROM $GATE_TAG
RUN grep -q 'settle(reported || this.#stagedBytesGone())' /app/dist/artifacts/index.js \\
 && sed -i 's@settle(reported || this.#stagedBytesGone())@settle(reported) /* EVIDENCE REVERTED (RED control) */@' /app/dist/artifacts/index.js \\
 && ! grep -q 'settle(reported || this.#stagedBytesGone())' /app/dist/artifacts/index.js
EOF

DIST_CONTROLS=(muted-listener forced-capture-failure unwire-capture revert-disposal-evidence)
for c in "${DIST_CONTROLS[@]}"; do
  printf '==> building control image: %-24s ' "$c"
  if docker build --platform linux/amd64 -f "$CTX/$c.Dockerfile" -t "browse-gateway:red-$c" "$CTX" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "BUILD FAILED — the patch anchor no longer matches the built output."
    echo "    This is a REAL failure: the control cannot sabotage what it can no longer find, and a"
    echo "    control that silently stops sabotaging is worse than no control. Re-derive the anchor."
    exit 1
  fi
done

HARNESS_CONTROLS=(foreign-owner shared-controller second-fetch-fresh-id inline-as-attachment
                  serve-pdf-as-notpdf serve-small-oversize skip-cleanup)

run_gate() { # $1=label  $2=image  $3=env (may be empty)
  local label="$1" image="$2" envarg="${3:-}" out; out="$(mktemp)"
  if [[ -n "$envarg" ]]; then
    docker run "${RUN_FLAGS[@]}" -e "$envarg" "$image" node scripts/validate-artifact.mjs >"$out" 2>&1
  else
    docker run "${RUN_FLAGS[@]}" "$image" node scripts/validate-artifact.mjs >"$out" 2>&1
  fi
  local code=$? passes fails first
  passes=$(grep -c "^  PASS" "$out"); fails=$(grep -c "^  FAIL" "$out")
  first=$(grep "^  FAIL" "$out" | head -1 | sed 's/^  FAIL  //' | cut -c1-58)
  printf '%-26s exit=%-3s pass=%-4s fail=%-4s %s\n' "$label" "$code" "$passes" "$fails" "$first"
  rm -f "$out"
  return $code
}

echo
echo "=== BASELINE ==="
matrix_failed=0
if ! run_gate BASELINE "$GATE_TAG" ""; then
  echo "    !! BASELINE FAILED — the shipping tree is not green"
  matrix_failed=1
fi
echo
echo "=== DIST-PATCH CONTROLS (real shipping code sabotaged; each MUST exit non-zero) ==="
for c in "${DIST_CONTROLS[@]}"; do
  if run_gate "$c" "browse-gateway:red-$c" ""; then
    echo "    !! $c LEFT THE GATE GREEN — that leg proves nothing"
    matrix_failed=1
  fi
done
echo
echo "=== HARNESS PREMISE CONTROLS (each MUST exit non-zero) ==="
for c in "${HARNESS_CONTROLS[@]}"; do
  if run_gate "$c" "$GATE_TAG" "BGW_ARTIFACT_GATE_RED=$c"; then
    echo "    !! $c LEFT THE GATE GREEN — that leg proves nothing"
    matrix_failed=1
  fi
done

exit "$matrix_failed"
