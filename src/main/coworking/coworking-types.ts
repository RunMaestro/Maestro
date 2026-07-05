/**
 * Shared types for the coworking subsystem.
 *
 * Coworking exposes the active AI tab's session terminals to the agent as MCP
 * tools (`list_terminals`, `read_terminal`). The MCP server runs as a stdio
 * subprocess spawned by the agent's MCP client; it talks back to Maestro main
 * via a private Unix-domain-socket / named-pipe IPC bridge.
 */

import type { CoworkingBrowserEntry } from '../../shared/coworkingBrowser';
export type {
	BrowserConfirmPolicy,
	BrowserInteractionKind,
	BrowserOp,
	BrowserOpResult,
	CoworkingBrowserEntry,
	CoworkingBrowserInput,
} from '../../shared/coworkingBrowser';

/** Public name of the MCP server entry written into each agent's user-level config. */
export const COWORKING_MCP_SERVER_NAME = 'maestro-coworking';

/** Env var name read by the MCP-server subprocess to find the IPC bridge socket. */
export const COWORKING_SOCKET_ENV_VAR = 'MAESTRO_COWORKING_SOCKET';

/**
 * Env var name carrying the OWNING Maestro window's bridge socket path, injected
 * per-spawn by ProcessManager into the agent CLI env. Takes precedence over
 * COWORKING_SOCKET_ENV_VAR, which lives in the shared user-level MCP config as a
 * single global value (last install wins). Agent CLIs that propagate parent env
 * to their MCP subprocess (Claude Code, OpenCode) therefore bind to the bridge of
 * the window that spawned them, even with multiple windows open or a stale global
 * config. CLIs that do NOT propagate env (Codex) fall back to
 * COWORKING_SOCKET_ENV_VAR and are single-window only.
 */
export const COWORKING_SOCKET_OVERRIDE_ENV_VAR = 'MAESTRO_COWORKING_SOCKET_OVERRIDE';

/**
 * Env var name carrying the Maestro session id of the agent process that owns
 * this MCP subprocess. Set by the main process at agent-CLI spawn time; relied
 * on at handshake to bind the bridge connection to one Maestro session, so an
 * agent can never read another agent's terminals regardless of UI focus.
 */
export const COWORKING_SESSION_ID_ENV_VAR = 'MAESTRO_COWORKING_SESSION_ID';

/**
 * Description of a terminal tab as advertised to the agent via `list_terminals`.
 * Mirrors `TerminalTab` (renderer-side) but only the MCP-relevant fields and
 * uses the public readable id (`term:N`) instead of the internal UUID.
 */
export interface CoworkingTerminalEntry {
	/** Public readable id, e.g. "term:3". Stable, never reused on close. */
	id: string;
	/** Working directory of the underlying shell (best-effort, may be empty). */
	cwd: string;
	/** Display title (user-defined name, or "Terminal N" auto-generated). */
	title: string;
}

/**
 * Internal registry record. `tabUuid` is the canonical TerminalTab.id used
 * to fetch buffers from the renderer; `sessionId` is the owning Maestro
 * session (a.k.a. "agent" in user-facing language). The renderer pushes
 * these via the preload bridge whenever tabs open / close / rename, and
 * whenever the active session changes.
 */
export interface CoworkingTerminalRecord extends CoworkingTerminalEntry {
	tabUuid: string;
	sessionId: string;
}

/**
 * Server spec written into each agent's user-level MCP config.
 * Stable across Maestro upgrades because both `command` and `socketPath`
 * are absolute paths under the OS userData dir.
 */
export interface CoworkingMcpServerSpec {
	/** Absolute path to the bundled coworking-mcp-server.js. */
	command: string;
	/** Args passed to the command. Almost always [scriptPath]. */
	args: string[];
	/** Env vars the agent's MCP client must inject when spawning the server. */
	env: Record<string, string>;
}

/** Per-agent install status for the Coworking Setup panel. */
export interface CoworkingInstallStatus {
	agentId: string;
	configPath: string;
	installed: boolean;
}

/** Bridge RPC method names. Kept as string literals for backwards-compat. */
export type CoworkingBridgeMethod =
	| 'hello'
	| 'listTerminals'
	| 'readTerminal'
	| 'listBrowsers'
	| 'getBrowserUrl'
	| 'readBrowser'
	| 'browserInteract';

export interface CoworkingBridgeRequest {
	id: number;
	method: CoworkingBridgeMethod;
	params?: Record<string, unknown>;
}

export interface CoworkingBridgeResponse {
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
}

/** Format a numeric coworkingId into the public readable form. */
export function formatCoworkingId(coworkingId: number): string {
	return `term:${coworkingId}`;
}

/** Parse a public coworking id back into the numeric coworkingId. Returns null on bad input. */
export function parseCoworkingId(id: string): number | null {
	if (!id.startsWith('term:')) return null;
	const n = Number(id.slice('term:'.length));
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

// ─── Browser coworking ───────────────────────────────────────────────────────
//
// The browser contract types (op / result / input / entry) live in
// src/shared/coworkingBrowser so the renderer responder and preload bridge share
// one source of truth; they are re-exported at the top of this file. Only the
// main-process-internal record type and the id helpers live here.

/** Internal registry record. `tabUuid` is the renderer BrowserTab.id used to
 *  drive the live webview; `sessionId` is the owning Maestro session.
 *  `hiddenFromAgent` mirrors the per-tab eye toggle: hidden records keep their
 *  stable `browser:N` id (so unhiding never renumbers) but are excluded from
 *  every agent-facing list/read/interact lookup in the registry. */
export interface CoworkingBrowserRecord extends CoworkingBrowserEntry {
	tabUuid: string;
	hiddenFromAgent?: boolean;
	sessionId: string;
}

/** Format a numeric browser id into the public readable form. */
export function formatBrowserId(browserId: number): string {
	return `browser:${browserId}`;
}

/** Parse a public browser id back into the numeric id. Returns null on bad input. */
export function parseBrowserId(id: string): number | null {
	if (!id.startsWith('browser:')) return null;
	const n = Number(id.slice('browser:'.length));
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}
