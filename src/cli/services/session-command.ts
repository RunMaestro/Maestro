// Shared helpers for CLI commands that drive the running desktop app over the
// WebSocket bridge. Most of these commands follow the same shape: resolve an
// agent, send a single `{ type, sessionId, ... }` message, expect a
// `{ success, error? }` reply, then report it (JSON or human-readable) and exit
// non-zero on failure. Centralizing that here keeps the per-command files thin
// and the behavior consistent across the whole CLI surface.

import { withMaestroClient } from './maestro-client';
import { resolveAgentId } from './storage';
import { formatError, formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';

export interface SimpleResult {
	success: boolean;
	error?: string;
	[key: string]: unknown;
}

/** Send one command to the desktop and return the typed result. */
export async function sendSimpleCommand(
	payload: Record<string, unknown>,
	responseType: string
): Promise<SimpleResult> {
	return withMaestroClient((client) => client.sendCommand<SimpleResult>(payload, responseType));
}

/** Print an error (JSON-aware) and exit non-zero. Never returns. */
export function failCommand(message: string, json?: boolean): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

/** Report a `{ success }` result: success line, or error + exit(1) on failure. */
export function reportResult(
	result: SimpleResult,
	options: { json?: boolean; successMessage: string; jsonExtra?: Record<string, unknown> }
): void {
	if (result.success) {
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...options.jsonExtra }));
		} else if (!isQuiet()) {
			// --quiet suppresses incidental success lines (JSON is never gated).
			console.log(formatSuccess(options.successMessage));
		}
		return;
	}
	failCommand(result.error || 'Command failed', options.json);
}

/** Resolve an agent ID (partial match) or fail loudly. Never returns on error. */
export function resolveAgentOrFail(agentId: string, json?: boolean): string {
	try {
		return resolveAgentId(agentId);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
}

/**
 * Resolve the agent (session) that owns a desktop tab by querying the running
 * app's open-tab list. Accepts an exact tab ID or a unique prefix. Throws on
 * not-found or ambiguous prefix so callers fail loudly.
 */
export async function resolveTabOwner(tabId: string): Promise<{ agentId: string; tabId: string }> {
	const res = await withMaestroClient((client) =>
		client.sendCommand<{ sessions?: Array<{ tabId: string; agentId: string }> }>(
			{ type: 'list_desktop_sessions' },
			'desktop_sessions_list'
		)
	);
	const list = res.sessions ?? [];
	const exact = list.find((s) => s.tabId === tabId);
	if (exact) return { agentId: exact.agentId, tabId: exact.tabId };
	const matches = list.filter((s) => s.tabId.startsWith(tabId));
	if (matches.length === 1) return { agentId: matches[0].agentId, tabId: matches[0].tabId };
	if (matches.length > 1) {
		throw new Error(`Ambiguous tab ID '${tabId}' (${matches.length} matches)`);
	}
	throw new Error(`Tab not found: ${tabId}`);
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
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
