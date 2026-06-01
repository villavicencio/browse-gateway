/**
 * Per-consumer identity and allowlist scope (R18). Each consumer presents a credential
 * (token) and carries its own {@link Allowlist} plus ACL tags. Tokens are secrets — they
 * are used only to resolve identity and never appear in audit records (which key on `id`).
 */
import { Allowlist } from "./allowlist.js";

/** Declarative consumer definition, e.g. loaded from a secrets store at runtime. */
export interface ConsumerSpec {
  id: string;
  token: string;
  /** Allowlist rules scoped to this consumer (exact host, `*.domain`, or bare `*` = allow-all). */
  allow: string[];
  tags?: string[];
}

export interface Consumer {
  readonly id: string;
  readonly token: string;
  readonly allowlist: Allowlist;
  readonly tags: readonly string[];
}

export class ConsumerRegistry {
  readonly #byToken = new Map<string, Consumer>();

  constructor(specs: Iterable<ConsumerSpec> = []) {
    for (const spec of specs) this.add(spec);
  }

  add(spec: ConsumerSpec): void {
    if (!spec.token) throw new Error(`consumer ${spec.id} has no token`);
    if (this.#byToken.has(spec.token)) {
      throw new Error(`duplicate consumer token for id ${spec.id}`);
    }
    this.#byToken.set(spec.token, {
      id: spec.id,
      token: spec.token,
      allowlist: new Allowlist(spec.allow),
      tags: spec.tags ?? [],
    });
  }

  /** Resolve a consumer by credential, or `undefined` if the token is unknown. */
  resolve(token: string): Consumer | undefined {
    return token ? this.#byToken.get(token) : undefined;
  }

  get size(): number {
    return this.#byToken.size;
  }
}
