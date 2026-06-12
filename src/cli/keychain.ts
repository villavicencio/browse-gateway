/**
 * macOS Keychain storage for consumer tokens (KTD4): `keys new` deposits the literal token here;
 * `connect` discovers it without the operator ever re-handling it. One generic-password item per
 * consumer id under the `obscura` service, so multiple consumer keys on one Mac stay isolated.
 */
import { execCapture } from "./exec.js";

export interface Keychain {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export const KEYCHAIN_SERVICE = "obscura";

/** The real macOS Keychain via `security(1)`. */
export function macKeychain(service: string = KEYCHAIN_SERVICE): Keychain {
  return {
    async get(account) {
      const r = await execCapture("security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
      return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
    },
    async set(account, secret) {
      // -U updates in place when the item exists. The secret rides argv into a trusted system
      // binary — brief process-table presence, accepted for a local single-operator tool (R-Risk3).
      const r = await execCapture("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]);
      if (r.code !== 0) throw new Error(`keychain write failed for ${account} (exit ${r.code}): ${r.stderr.trim()}`);
    },
    async remove(account) {
      await execCapture("security", ["delete-generic-password", "-s", service, "-a", account]); // absent item is fine
    },
  };
}

/** In-memory fake for tests (and the only piece a non-mac host would need to swap). */
export function memoryKeychain(initial: Record<string, string> = {}): Keychain & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    async get(account) {
      return items.get(account) ?? null;
    },
    async set(account, secret) {
      items.set(account, secret);
    },
    async remove(account) {
      items.delete(account);
    },
  };
}
