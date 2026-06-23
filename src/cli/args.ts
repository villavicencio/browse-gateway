/**
 * Minimal hand-rolled argument dispatcher for the `obscura` CLI (KTD2). A handful of subcommands with
 * simple shapes don't justify a parsing dependency; this stays a small, fully-validated table.
 * Pure: argv in, a parsed invocation (or a usage error) out — no I/O, no process.exit.
 */

export type OwlCommand = "keys" | "connect" | "status" | "vault";
export type KeysSubcommand = "new" | "list" | "revoke";
export type VaultSubcommand = "import" | "login" | "status" | "revoke";
export type Subcommand = KeysSubcommand | VaultSubcommand;

export interface Invocation {
  command: OwlCommand;
  /** `keys` and `vault` have subcommands; `connect`/`status` do not. */
  subcommand?: Subcommand;
  positionals: string[];
  flags: {
    /** `keys new --allow <rule>` — repeatable and/or comma-separated; absent = command default. */
    allow?: string[];
    /** `keys new|revoke --apply` — restart the gateway now instead of staging only. */
    apply?: boolean;
    /** `connect --full` — append the opt-in stealth gate to the verify. */
    full?: boolean;
    /** `status --stealth` — include the opt-in stealth gate. */
    stealth?: boolean;
    /** `vault <sub> --consumer <id>` — the consumer the entry is keyed under. */
    consumer?: string;
    /** `vault <sub> --host <host>` — the host the entry is keyed under. */
    host?: string;
    /** `vault import --session <path>` — local file holding the captured storageState JSON. */
    session?: string;
    /** `vault login --recipe <path>` — local file holding the login recipe JSON. */
    recipe?: string;
    /** `vault import|login --creds <path>` — local file holding the credentials JSON. */
    creds?: string;
    /** `vault import --exit <id>` — bind the imported session to a held sticky exit. */
    exit?: string;
  };
}

export type ParseResult = { ok: true; invocation: Invocation } | { ok: false; error?: string };

/** Boolean flag names derived from the Invocation interface — adding one there widens this. */
type BooleanFlagName = { [K in keyof Invocation["flags"]]-?: NonNullable<Invocation["flags"][K]> extends boolean ? K : never }[keyof Invocation["flags"]];
/** Single-value (string) flag names — everything that takes a value and is not the accumulating list. */
type StringFlagName = { [K in keyof Invocation["flags"]]-?: NonNullable<Invocation["flags"][K]> extends string ? K : never }[keyof Invocation["flags"]];

interface FlagSpec {
  takesValue: boolean;
  /** Comma-split + accumulate into the `allow` list (only `--allow`); else last-value-wins string. */
  multi?: boolean;
}

interface CommandSpec {
  subcommands?: Partial<Record<Subcommand, Record<string, FlagSpec>>>;
  flags?: Record<string, FlagSpec>;
}

const VALUE: FlagSpec = { takesValue: true };
const BOOL: FlagSpec = { takesValue: false };

/** What each command accepts. Anything outside this table is a usage error, not a silent ignore. */
const SPEC: Record<OwlCommand, CommandSpec> = {
  keys: {
    subcommands: {
      new: { allow: { takesValue: true, multi: true }, apply: BOOL },
      list: {},
      revoke: { apply: BOOL },
    },
  },
  connect: { flags: { full: BOOL } },
  status: { flags: { stealth: BOOL } },
  vault: {
    subcommands: {
      status: {},
      import: { consumer: VALUE, host: VALUE, session: VALUE, creds: VALUE, exit: VALUE },
      login: { consumer: VALUE, host: VALUE, recipe: VALUE, creds: VALUE },
      revoke: { consumer: VALUE, host: VALUE },
    },
  },
};

function isCommand(word: string): word is OwlCommand {
  return word === "keys" || word === "connect" || word === "status" || word === "vault";
}

export function usage(): string {
  return [
    "usage: obscura <command>",
    "",
    "  keys new <consumer> [--allow <rule>] [--apply]   mint + install a consumer key",
    "  keys list                                        configured consumers (never tokens)",
    "  keys revoke <consumer> [--apply]                 remove a consumer key",
    "  connect [--full]                                 tunnel + register + verify, one command",
    "  status [--stealth]                               tunnel / gateway / consumer health",
    "  vault status                                     stored login entries (never secrets)",
    "  vault import --consumer <id> --host <h> --session <f> --creds <f> [--exit <id>]",
    "                                                   store a hand-captured session + creds",
    "  vault login --consumer <id> --host <h> --recipe <f> --creds <f>",
    "                                                   capture a login on-host into the vault",
    "  vault revoke --consumer <id> --host <h>          crypto-shred a stored entry",
  ].join("\n");
}

/** Parse `process.argv.slice(2)`. Never throws; bad input comes back as `{ok: false}`. */
export function parseCliArgs(argv: string[]): ParseResult {
  const [head, ...rest] = argv;
  if (head === undefined) return { ok: false };
  if (!isCommand(head)) return { ok: false, error: `unknown command: ${head}` };

  const spec = SPEC[head];
  let flagSpecs: Record<string, FlagSpec>;
  let subcommand: Subcommand | undefined;
  let args = rest;

  if (spec.subcommands) {
    const [sub, ...subRest] = rest;
    const subSpecs = sub === undefined ? undefined : spec.subcommands[sub as Subcommand];
    if (sub === undefined || subSpecs === undefined) {
      const known = Object.keys(spec.subcommands).join("|");
      return { ok: false, error: `usage: obscura ${head} <${known}>` };
    }
    subcommand = sub as Subcommand;
    flagSpecs = subSpecs;
    args = subRest;
  } else {
    flagSpecs = spec.flags ?? {};
  }

  const positionals: string[] = [];
  const flags: Invocation["flags"] = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const flagSpec = flagSpecs[name];
    if (!flagSpec) return { ok: false, error: `unknown flag for ${head}${subcommand ? ` ${subcommand}` : ""}: --${name}` };
    if (!flagSpec.takesValue) {
      if (eq !== -1) return { ok: false, error: `--${name} takes no value` };
      flags[name as BooleanFlagName] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = args[i + 1];
      // Never eat a following flag as the value (`--allow --apply` is a mistake, not a rule).
      if (value !== undefined && value.startsWith("--")) value = undefined;
      else i++;
    }
    if (value === undefined || value === "") return { ok: false, error: `--${name} requires a value` };
    if (flagSpec.multi) {
      const list = value.split(",").map((s) => s.trim()).filter(Boolean);
      // Explicit-but-empty (`--allow ,`) must not silently fall back to the allow-all default.
      if (list.length === 0) return { ok: false, error: `--${name} requires at least one non-empty rule` };
      flags.allow = [...(flags.allow ?? []), ...list];
    } else {
      // Single-value flag — last one wins (a repeated `--host` is an operator slip, not an accumulation).
      flags[name as StringFlagName] = value;
    }
  }

  return { ok: true, invocation: { command: head, ...(subcommand ? { subcommand } : {}), positionals, flags } };
}
