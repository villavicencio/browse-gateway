# Test fixtures

HTML pages used by the block/failure classifier tests. Each file describes a **shape** the classifier
must handle — never a capture of a real site.

## Scrub rules (mandatory for every fixture added here)

The repo is public. A fixture must not carry provenance, so every one of these is a hard rule:

1. **No PROVENANCE strings.** No site name, product name, or logo text — not in markup, not in
   comments, not in the filename. A fixture is named for the SHAPE it exercises
   (`thin-429.html`), never for where the shape was first seen.

   **What this rule is about is provenance, not vocabulary.** It exists so a fixture cannot say
   *which site the gateway was pointed at*. It does **not** ban the structural identifiers a
   classifier keys on — a widget container class, a challenge script path, a response-field name.
   Those are the DOM contract under test: strip `class="g-recaptcha"` out of a CAPTCHA fixture and it
   stops being a CAPTCHA fixture, the same way deleting `<html>` would stop it being a page. A
   detector that matches a public, documented markup convention must be tested against that
   convention.

   The line: **a string that identifies a SITE is banned; a string the classifier MATCHES ON is
   required.** If a fixture needs the second, keep it and say in the header comment why it is
   load-bearing.

   > **This one has teeth beyond hygiene.** The protection-vendor hint scanners (`hasCloudflareHint`,
   > `hasPerimeterXHint`, `hasDataDomeHint`) match against the **raw HTML, comments included** — they
   > do not run the inert-context strip that the CAPTCHA widget detector uses. So a comment that merely
   > *names* a vendor while explaining that the fixture carries no vendor marker gives it one, and the
   > fixture silently classifies as that vendor's challenge. Observed while writing the VIL-121 suite:
   > three tests failed with `datadome-challenge` because two fixtures said "no CF/PX/DataDome marker"
   > in a comment. Describe the absence generically ("carries no protection-vendor marker") instead.
2. **No real hostnames.** Every link, form action, asset path, and absolute URL uses
   `example.invalid` (RFC 2606 reserves `.invalid`, so it can never resolve).
3. **No real identifiers.** Site keys, request/ray IDs, session ids, tokens, and account numbers are
   obviously-synthetic placeholders (`AAAA…`), never a value copied from a live page.
4. **No query text.** A fixture never embeds a search query, a research topic, or any other string
   that would say what the gateway was being used for.
5. **Generic challenge copy only.** Interstitial wording is written to trip the classifier's
   documented phrase list, not transcribed from a vendor's page.

A fixture that cannot be written under these rules does not belong in the repo; assert on the
classifier's inputs directly in the test instead.
