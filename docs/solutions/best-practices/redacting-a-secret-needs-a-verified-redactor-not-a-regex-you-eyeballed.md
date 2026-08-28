---
title: Redacting a secret needs a verified redactor, not a regex you eyeballed
date: 2026-08-27
category: docs/solutions/best-practices
module: operator tooling, session hygiene
problem_type: best_practice
component: secrets
severity: high
applies_when:
  - "About to print a config file, env dump, or API response that may contain a credential"
  - "Writing a sed/grep redaction filter on macOS or any BSD userland"
  - "Pasting measurement or diagnostic output into a ticket, doc, or commit"
---

## Problem

A config file was printed through a redaction filter so its token would not reach session output.
The token printed in full anyway. The filter looked correct and produced plausible output — the file
rendered, the other fields were intact, nothing errored. It simply had not matched.

```sh
# the filter, on macOS
sed -e 's/\("[a-zA-Z]*[Tt]oken"\s*:\s*"\)[^"]*/\1<REDACTED>/g' config.json
```

## Root cause

**`\s` is a GNU extension.** BSD `sed` — the one macOS ships — has no `\s` class and treats it as a
literal `s`, so the pattern only matches a key followed by a literal `s` character. Nothing matched,
`sed` exited 0, and the unmodified line was passed straight through.

This is the failure family in `a-test-whose-stub-guarantees-the-assertion-proves-nothing.md`, applied
to a redactor: **a filter that cannot match is indistinguishable from a filter with nothing to redact.**
Both print clean-looking output and exit 0. There is no error to notice.

```sh
$ printf '{"healthToken": "abc123deadbeef"}\n' | sed -e 's/\("[a-zA-Z]*[Tt]oken"\s*:\s*"\)[^"]*/\1<REDACTED>/g'
{"healthToken": "abc123deadbeef"}      # silently unredacted

$ printf '{"healthToken": "abc123deadbeef"}\n' | sed -E 's/("[A-Za-z]*[Tt]oken"[[:space:]]*:[[:space:]]*")[^"]*/\1<REDACTED>/g'
{"healthToken": "<REDACTED>"}          # POSIX class, works on BSD and GNU
```

## Solution

**Prefer structural redaction over regex.** For JSON, redact by *key* with `jq` — it cannot be
defeated by whitespace, key order, escaping, or nesting:

```sh
jq '(.. | objects) |= with_entries(
      if (.key | test("token|secret|password|passphrase|credential|key$";"i"))
      then .value = "<REDACTED>" else . end)' config.json
```

**Then verify the redactor, do not eyeball it.** Two cheap checks, neither of which prints a secret:

```sh
RED=$(jq '…redaction…' "$CFG")
# 1. structural: no long hex/base64 run should survive
printf '%s' "$RED" | grep -Eq '[0-9a-f]{32,}' && echo "FAIL: hex run survived"
# 2. differential: no ACTUAL value from the file may appear in the output (-F, never echoed)
while IFS= read -r v; do
  [ -n "$v" ] && printf '%s' "$RED" | grep -Fq -- "$v" && echo "FAIL: a real secret survived"
done < <(jq -r '[.. | objects | to_entries[]
        | select(.key|test("token|secret|password";"i")) | .value | strings] | .[]' "$CFG")
```

Check 2 is the one that matters: it compares against the file's real values, so it catches a filter
that matched nothing as loudly as one that matched the wrong thing.

## Gotcha that will bite you

If a secret does reach session output, **the fix is rotation, not deletion.** Scrubbing the scrollback
does not un-disclose it. Rotate, verify the old credential is refused, and say so.

Related BSD/GNU divergences in the same class — all silent, none error:
`\s` `\d` `\w` (GNU only; use `[[:space:]]` `[[:digit:]]` `[[:alnum:]_]`), `sed -i` (BSD needs an
explicit backup-suffix argument), `grep -P` (absent on BSD).

## The general rule

> A redactor is a guard, and this repo's rule for guards applies to it: verify it can report bad news.
> Run it against a known secret and assert the secret is gone — *before* pointing it at real output.
> "It looked redacted" is not a check, because the failure mode is output that looks exactly right.
