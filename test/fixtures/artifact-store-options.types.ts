// The TYPE-BOUNDARY fixture for `ArtifactStoreOptions` (Amendment 2 §7). It is deliberately OUTSIDE
// `tsconfig.json`'s `include` — the shipped build compiles `src` only — and is typechecked by the
// artifact-store test, which spawns `tsc --noEmit` over this file alone.
//
// The proof is the compiler's: every declaration below must typecheck, and each `@ts-expect-error`
// must be USED. So a boundary that stopped requiring a root from an enabled configuration fails on an
// unused expect-error, and one that still requires a root from a disabled configuration fails on a
// genuine error. Nothing here runs.
import type { ArtifactStoreOptions } from "../../src/artifacts/types.js";

// A disabled configuration requires NO root: this is the shape Amendment 2 §7 is about.
export const disabled: ArtifactStoreOptions = { enabled: false };
// It may still carry one — existing callers pass a root alongside `enabled: false` — plus any of the
// shared members.
export const disabledWithRoot: ArtifactStoreOptions = { enabled: false, root: "/srv/artifacts", ttlMs: 1_000 };
// An enabled configuration still requires a non-empty root, explicitly...
export const enabled: ArtifactStoreOptions = { enabled: true, root: "/srv/artifacts" };
// ...and by default, which is the source-compatible shape most callers already use.
export const defaultEnabled: ArtifactStoreOptions = { root: "/srv/artifacts" };

// @ts-expect-error an explicitly enabled configuration must still require a root
export const enabledWithoutRoot: ArtifactStoreOptions = { enabled: true };
// @ts-expect-error a default-enabled configuration must still require a root
export const defaultEnabledWithoutRoot: ArtifactStoreOptions = {};
