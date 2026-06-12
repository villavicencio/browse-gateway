#!/usr/bin/env node
/**
 * `obscura` — the boutique front door over the browse-gateway plumbing. One command to mint a
 * consumer key (`keys`), one to connect a Mac to the gateway end-to-end (`connect`), one to read
 * the system's health at a glance (`status`). Dispatch only — each command lives in its module.
 */
import { parseCliArgs, usage } from "./args.js";
import { fail } from "./brand.js";

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    if (parsed.error) console.error(fail(parsed.error));
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const { invocation } = parsed;
  switch (invocation.command) {
    case "keys":
      console.error(fail("keys: not implemented yet"));
      process.exitCode = 1;
      return;
    case "connect":
      console.error(fail("connect: not implemented yet"));
      process.exitCode = 1;
      return;
    case "status":
      console.error(fail("status: not implemented yet"));
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  console.error(fail(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
