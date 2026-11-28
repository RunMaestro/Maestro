/**
 * Codex Transport
 *
 * A Codex turn runs on one of two transports:
 *
 *   - `app-server`  `codex app-server` (JSON-RPC over stdio): the default. It
 *                   streams reasoning and accepts `turn/steer` while a turn runs,
 *                   so the Steer button can reach it.
 *   - `exec`        `codex exec --json`: an explicit choice only. It never returns
 *                   reasoning text, and the only transport some surfaces support.
 *
 * The setting is stored per agent as `codexTransport`. A missing or malformed
 * value means the default (`app-server`); an explicit `exec` is stored as `exec`
 * and never collapsed to unset, or it would silently flip back to the default.
 * It is a PREFERENCE, not a guarantee: the app-server spawner still falls back
 * to `exec` for turns it cannot carry (images, Auto Run, Cue). SSH agents run
 * app-server on the remote host (`codex-app-server/ssh-launch.ts`).
 * See `docs/agent-guides/CODEX-APP-SERVER.md`.
 */

export type CodexTransport = 'exec' | 'app-server';

/** The transport a Codex agent uses when none is stored (or the stored value is malformed). */
export const CODEX_DEFAULT_TRANSPORT: CodexTransport = 'app-server';

/** Every transport. */
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
 * The transport an agent's turns should use. A Codex agent resolves to its
 * stored transport, or to `CODEX_DEFAULT_TRANSPORT` when none (or a malformed
 * value) is stored. A non-Codex agent that somehow carries the field is always
 * `exec`, so it is never routed to a Codex spawner.
 */
export function resolveCodexTransport(
	source: CodexTransportSource | null | undefined
): CodexTransport {
	if (source?.toolType !== 'codex') return 'exec';
	return isCodexTransport(source.codexTransport) ? source.codexTransport : CODEX_DEFAULT_TRANSPORT;
}
