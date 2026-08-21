// Shared helpers for CLI commands that drive the running desktop app over the
// WebSocket bridge. Most of these commands follow the same shape: resolve an
// agent, send a single `{ type, sessionId, ... }` message, expect a
// `{ success, error? }` reply, then report it (JSON or human-readable) and exit
// non-zero on failure. Centralizing that here keeps the per-command files thin
// and the behavior consistent across the whole CLI surface.

import { withMaestroClient } from './maestro-client';
import { resolveAgentId, readActiveAgentId } from './storage';
import type { DesktopTabEntry } from '../../shared/desktopTabs';

export type { DesktopTabEntry };
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
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
