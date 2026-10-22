/**
 * Codex Transport
 *
 * A Codex turn runs on one of two transports:
 *
 *   - `exec`        `codex exec --json` (the default, and the only transport
 *                   every surface supports)
 *   - `app-server`  `codex app-server` (JSON-RPC over stdio), which accepts
 *                   `turn/steer` while a turn runs, so the Steer button can
 *                   reach it. Opt-in and experimental.
 *
 * The setting is stored per agent as `codexTransport`, with `undefined` meaning
 * `exec`. It is a PREFERENCE, not a guarantee: the app-server spawner still
 * falls back to `exec` for turns it cannot carry (images, Auto Run, Cue). SSH
 * agents run app-server on the remote host (`codex-app-server/ssh-launch.ts`).
 * See `docs/agent-guides/CODEX-APP-SERVER.md`.
 */

export type CodexTransport = 'exec' | 'app-server';

/** Every transport, default first. */
export const CODEX_TRANSPORTS: readonly CodexTransport[] = ['exec', 'app-server'];

/** Narrow an untrusted value (CLI flag, web bridge, persisted record) to a transport. */
export function isCodexTransport(value: unknown): value is CodexTransport {
	return value === 'exec' || value === 'app-server';
}

/** The fields a transport is resolved from, on a session or a spawn config. */
export interface CodexTransportSource {
	toolType?: string;
	codexTransport?: unknown;
}

/**
 * The transport an agent's turns should use. Anything that is not literally
 * `'app-server'` on a Codex agent resolves to `'exec'`, so a missing, stale, or
 * malformed value can never opt an agent in, and a non-Codex agent that somehow
 * carries the field is never routed to a Codex spawner.
 */
export function resolveCodexTransport(
	source: CodexTransportSource | null | undefined
): CodexTransport {
	if (source?.toolType !== 'codex') return 'exec';
	return source.codexTransport === 'app-server' ? 'app-server' : 'exec';
}
