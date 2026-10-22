// Shared helpers for CLI commands that drive the running desktop app over the
// WebSocket bridge. Most of these commands follow the same shape: resolve an
// agent, send a single `{ type, sessionId, ... }` message, expect a
// `{ success, error? }` reply, then report it (JSON or human-readable) and exit
// non-zero on failure. Centralizing that here keeps the per-command files thin
// and the behavior consistent across the whole CLI surface.

import { withMaestroClient } from './maestro-client';
import { MaestroNotRunningError } from './maestro-not-running';
import { resolveAgentId, readActiveAgentId } from './storage';
import type { DesktopTabEntry } from '../../shared/desktopTabs';

export type { DesktopTabEntry };
import { formatError, formatSuccess } from '../output/formatter';
import { ExitCode, exitCodeForError, exitWith } from '../exit-codes';
import { isQuiet } from '../output/verbosity';

export interface SimpleResult {
	success: boolean;
	error?: string;
	[key: string]: unknown;
}

/** Send one command to the desktop and return the typed result. */
export async function sendSimpleCommand<
	T extends Pick<SimpleResult, 'success' | 'error'> = SimpleResult,
>(payload: Record<string, unknown>, responseType: string): Promise<T> {
	return withMaestroClient((client) => client.sendCommand<T>(payload, responseType));
}

/**
 * Older handlers answer a failure with a generic `{ type: 'error', message }`
 * frame instead of their typed `*_result`. When that frame carries the
 * requestId the client resolves with it, so a caller must check for it rather
 * than read the missing typed fields as an empty success.
 */
export function errorFrameMessage(reply: unknown): string | null {
	if (reply && typeof reply === 'object' && (reply as { type?: unknown }).type === 'error') {
		const message = (reply as { message?: unknown }).message;
		return typeof message === 'string' && message ? message : 'Command failed';
	}
	return null;
}

/**
 * Print an error (JSON-aware) and exit non-zero. Never returns.
 *
 * `code` names the class of failure for a script: a bad invocation is
 * `InvalidUsage`, a bridge call that failed takes `exitCodeForError(error)`.
 * Left out, it is the general failure every caller of this had before.
 */
export function failCommand(
	message: string,
	json?: boolean,
	code: ExitCode = ExitCode.GeneralError
): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return exitWith(code);
}

/**
 * Report a caught failure and exit with the code its class names: a closed app
 * is `NotRunning`, an old build `Unsupported`, a hung renderer `Timeout`, and
 * anything else the general failure. The one spelling of
 * `catch (error) { failCommand(...) }` so no verb reports 1 for all of them.
 */
export function failFromError(error: unknown, json?: boolean): never {
	exitIfMaestroNotRunning(error, { json });
	return failCommand(
		error instanceof Error ? error.message : String(error),
		json,
		exitCodeForError(error)
	);
}

/**
 * One bridge round trip for a verb that needs the reply's fields.
 *
 * A transport failure exits with the code for it (an older app build, a hung
 * renderer), and a reply the app marked `success: false` exits with its error,
 * so the caller reads a reply that succeeded and nothing else.
 */
export async function sendBridgeCommand<T extends { success: boolean; error?: string }>(
	payload: Record<string, unknown>,
	responseType: string,
	json: boolean | undefined,
	timeoutMs?: number
): Promise<T> {
	let reply: T;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<T>(payload, responseType, timeoutMs)
		);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success)
		failCommand(reply.error || errorFrameMessage(reply) || 'Request failed', json);
	return reply;
}

export interface NotRunningReportOptions {
	/** Report as JSON. Verbs that only speak JSON pass `true`. */
	json?: boolean;
	/** Fields a verb's error envelope always carries (e.g. `{ type: 'error' }`). */
	jsonExtra?: Record<string, unknown>;
	/** Write the JSON to stderr, for verbs whose JSON errors already go there. */
	stderrJson?: boolean;
	/** Pretty-print the JSON, for verbs that already indent their output. */
	indent?: number;
}

/**
 * If `error` says the desktop app is absent, report it the ONE way every
 * app-dependent verb does - the fixed message, `code: MAESTRO_NOT_RUNNING`,
 * exit 3 - and exit. Otherwise return, so the caller's own handling runs
 * exactly as before.
 *
 * Put it first in any catch that wraps a bridge call. The point is that a
 * catch which re-words the error (`Failed to X: ${msg}`) or flattens it to a
 * string loses the type, and then nothing downstream can map it to exit 3.
 */
export function exitIfMaestroNotRunning(
	error: unknown,
	options: NotRunningReportOptions = {}
): void {
	if (!(error instanceof MaestroNotRunningError)) return;
	if (options.json) {
		const payload = JSON.stringify(
			{ ...options.jsonExtra, success: false, error: error.message, code: error.code },
			null,
			options.indent
		);
		if (options.stderrJson) console.error(payload);
		else console.log(payload);
	} else {
		console.error(formatError(error.message));
		console.error(error.hint);
	}
	exitWith(ExitCode.NotRunning);
}

/** Report a `{ success }` result: success line, or error + exit(1) on failure. */
export function reportResult(
	result: SimpleResult,
	options: {
		json?: boolean;
		successMessage: string;
		jsonExtra?: Record<string, unknown>;
		/** Commands returning a live snapshot preserve it on success and failure. */
		jsonResult?: Record<string, unknown>;
	}
): void {
	if (options.json && options.jsonResult) {
		console.log(JSON.stringify(options.jsonResult));
		if (!result.success) process.exit(1);
		return;
	}
	if (result.success) {
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...options.jsonExtra }));
		} else if (!isQuiet()) {
			// --quiet suppresses incidental success lines (JSON is never gated).
			console.log(formatSuccess(options.successMessage));
		}
		return;
	}
	failCommand(result.error || errorFrameMessage(result) || 'Command failed', options.json);
}

/** Resolve an agent ID (partial match) or fail loudly. Never returns on error. */
export function resolveAgentOrFail(agentId: string, json?: boolean): string {
	try {
		return resolveAgentId(agentId);
	} catch (error) {
		return failFromError(error, json);
	}
}

/**
 * Every open AI tab across all desktop agents, in tab-bar order within each
 * agent. Callers that care about position (tab reordering) rely on that
 * ordering, so do not sort the result.
 */
export async function listDesktopTabs(): Promise<DesktopTabEntry[]> {
	const res = await withMaestroClient((client) =>
		client.sendCommand<{ sessions?: DesktopTabEntry[] }>(
			{ type: 'list_desktop_sessions' },
			'desktop_sessions_list'
		)
	);
	return res.sessions ?? [];
}

/** The tab-id argument that means "whatever tab is on screen right now". */
export const ACTIVE_TAB_KEYWORD = 'active';

/**
 * Resolve one desktop tab by querying the running app's open-tab list. Accepts
 * an exact tab ID, a unique prefix, or the literal `active` - which means the
 * selected tab of `agentHint`'s agent, or of the agent the desktop currently
 * has focused when no hint is given. Throws on not-found or ambiguous prefix so
 * callers fail loudly.
 *
 * Returns the whole entry (not just the ids) because every tab verb that reads
 * before it writes - `tab show`, `tab thinking cycle` - needs the tab's current
 * settings, and it just came over the wire.
 */
export async function resolveTabEntry(tabId: string, agentHint?: string): Promise<DesktopTabEntry> {
	const list = await listDesktopTabs();

	if (tabId.trim().toLowerCase() === ACTIVE_TAB_KEYWORD) {
		const agentId = agentHint ? resolveAgentId(agentHint) : readActiveAgentId();
		if (!agentId) {
			throw new Error(
				'No active agent recorded. Pass --agent <id> to say whose active tab you mean.'
			);
		}
		const active = list.find((t) => t.agentId === agentId && t.active);
		if (active) return active;
		// An agent whose activeTabId points at a terminal / file tab has no active
		// AI tab; say so rather than silently acting on some other tab.
		throw new Error(`Agent ${agentId} has no active AI tab`);
	}

	const exact = list.find((s) => s.tabId === tabId);
	if (exact) return exact;
	const matches = list.filter((s) => s.tabId.startsWith(tabId));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(`Ambiguous tab ID '${tabId}' (${matches.length} matches)`);
	}
	throw new Error(`Tab not found: ${tabId}`);
}

/**
 * Resolve the agent (session) that owns a desktop tab. Thin wrapper over
 * {@link resolveTabEntry} for callers that only need the two ids.
 */
export async function resolveTabOwner(
	tabId: string,
	agentHint?: string
): Promise<{ agentId: string; tabId: string }> {
	const entry = await resolveTabEntry(tabId, agentHint);
	return { agentId: entry.agentId, tabId: entry.tabId };
}

/**
 * Common shape for an agent-scoped command: resolve the agent, send a single
 * message, report the result. `build` returns the message type, expected
 * response type, success line, and any extra payload fields.
 */
export async function runAgentCommand(
	agentId: string,
	options: { json?: boolean },
	build: (sessionId: string) => {
		type: string;
		responseType: string;
		successMessage: string;
		extraPayload?: Record<string, unknown>;
	}
): Promise<void> {
	const sessionId = resolveAgentOrFail(agentId, options.json);
	const { type, responseType, successMessage, extraPayload } = build(sessionId);
	try {
		const result = await sendSimpleCommand({ type, sessionId, ...extraPayload }, responseType);
		reportResult(result, { json: options.json, successMessage, jsonExtra: { sessionId } });
	} catch (error) {
		failFromError(error, options.json);
	}
}
