// CJS bundle entry for the Maestro desktop bridge host.
//
// esbuild bundles this to dist/mae/host.cjs so the Electron main process
// (ES2020 / CommonJS) can `require()` the ESNext/Bun-authored host without
// importing its TypeScript source (which uses Promise.withResolvers and bundler
// resolution that the main tsconfig does not accept). The main glue requires the
// bundle behind a hand-written .d.ts shim. See
// Plans/mae-feature-complete-goal.md section 10 (compilation-boundary).

export { startBridgeHost } from './mae-bridge-host';
export type { BridgeHost, BridgeHostOptions } from './mae-bridge-host';
export { createMaeHandlers } from './host-service';
export type { MaeHostDeps } from './host-service';
export type { BridgeHandlers, CueEntry, PlaybookEntry, SessionListEntry } from './bridge-core';
export type {
	CueGraphSessionLike,
	CueRunResultLike,
	PlaybookFileLike,
	StoredSessionLike,
} from './host-mappers';
