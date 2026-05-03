// Session inspection commands — read-only access to desktop conversation state
// for external pollers (Maestro-Discord, Cue follow-ups, etc.).
//
// `session list` enumerates every open AI tab across every Maestro agent.
// `session show <tabId>` returns that tab's conversation history, with optional
// `--since` (poll cursor) and `--tail` (cap) filters applied desktop-side so the
// wire payload stays small even on long conversations.
//
// Both verbs talk to the running desktop via the same WebSocket the `dispatch`
// command uses; there is no on-disk fallback. If the desktop is not running the
// CLI fails loudly with `MAESTRO_NOT_RUNNING` so callers can react rather than
// silently get back stale data.

import { withMaestroClient } from '../services/maestro-client';
import { formatRelativeTime } from '../../shared/formatters';

export interface SessionListOptions {
	json?: boolean;
}

export interface SessionShowOptions {
	since?: string;
	tail?: string;
	json?: boolean;
}

interface DesktopSessionEntry {
	tabId: string;
	sessionId: string;
	agentId: string;
	agentName: string;
	toolType: string;
	name: string | null;
	agentSessionId: string | null;
	state: 'idle' | 'busy';
	createdAt: number;
	starred: boolean;
}

interface SessionMessage {
	id: string;
	role: string;
	source: string;
	content: string;
	timestamp: string;
}

interface SessionShowResult {
	success: true;
	tabId: string;
	sessionId: string;
	agentId: string;
	agentSessionId: string | null;
	messages: SessionMessage[];
}

function emitErrorJson(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

/**
 * Translate transport-layer errors into CLI error codes consistent with
 * `dispatch`. MaestroClient throws three distinct strings before any WebSocket
 * activity ("Maestro desktop app is not running", "Maestro discovery file is
 * stale (app may have crashed)", "Not connected to Maestro"); without these
 * mappings, those errors fall through to a generic CLI error and break the
 * error-code contract downstream consumers (Maestro-Discord) rely on to
 * distinguish "app down" from "command rejected".
 */
function mapTransportError(error: unknown): { error: string; code: string } | null {
	const msg = error instanceof Error ? error.message : String(error);
	const lowerMsg = msg.toLowerCase();
	if (
		lowerMsg.includes('econnrefused') ||
		lowerMsg.includes('connection refused') ||
		lowerMsg.includes('websocket') ||
		lowerMsg.includes('enotfound') ||
		lowerMsg.includes('etimedout') ||
		lowerMsg.includes('maestro desktop app is not running') ||
		lowerMsg.includes('discovery file is stale') ||
		lowerMsg.includes('not connected to maestro')
	) {
		return {
			error: 'Maestro desktop is not running or not reachable',
			code: 'MAESTRO_NOT_RUNNING',
		};
	}
	return null;
}

/**
 * Parse `--since` accepting:
 *   - ISO-8601 timestamps ("2026-04-28T10:00:00Z") — output of a previous
 *     `session show`'s `messages[].timestamp`, the natural cursor source.
 *   - Numeric epoch values (ms or seconds — auto-detected by magnitude).
 * Returns ms epoch for the wire, or null if the input is unparseable so the
 * caller can fail loudly with INVALID_OPTION rather than silently filtering.
 */
function parseSinceToMs(since: string): number | null {
	const trimmed = since.trim();
	if (!trimmed) return null;

	if (/^-?\d+$/.test(trimmed)) {
		const num = Number(trimmed);
		if (!Number.isFinite(num)) return null;
		// Heuristic: timestamps after ~2001 in seconds (1e9) vs ms (1e12). A bare
		// integer below 1e12 is interpreted as seconds; above as ms. Picks the
		// right interpretation for both `Date.now()` and `Date.now() / 1000`.
		return num >= 1e12 ? num : num * 1000;
	}

	const parsed = Date.parse(trimmed);
	if (Number.isNaN(parsed)) return null;
	return parsed;
}

export async function sessionList(options: SessionListOptions): Promise<void> {
	try {
		const sessions = await withMaestroClient(async (client) => {
			const result = await client.sendCommand<{ sessions?: DesktopSessionEntry[] }>(
				{ type: 'list_desktop_sessions' },
				'desktop_sessions_list'
			);
			return result.sessions ?? [];
		});

		if (options.json) {
			console.log(JSON.stringify({ success: true, sessions }, null, 2));
			return;
		}

		if (sessions.length === 0) {
			console.log('No open AI tabs.');
			return;
		}

		// Compact human-readable view: one tab per line so the output is grep-able
		// and pipes cleanly into other tools while still being readable for a
		// quick glance. Columns: state | star | tabId | agent | name | createdAt.
		// `state` is spelled out (busy/idle) rather than relying on the `*` marker
		// alone so `grep busy` works without column-counting.
		for (const s of sessions) {
			const state = s.state === 'busy' ? 'busy' : 'idle';
			const star = s.starred ? '★' : ' ';
			const name = s.name ?? '(unnamed)';
			const created = Number.isFinite(s.createdAt) ? formatRelativeTime(s.createdAt) : '—';
			console.log(
				`${state} ${star} ${s.tabId}  ${s.agentName} (${s.agentId})  ${name}  ${created}`
			);
		}
	} catch (error) {
		const mapped = mapTransportError(error);
		if (mapped) {
			emitErrorJson(mapped.error, mapped.code);
		} else {
			const msg = error instanceof Error ? error.message : String(error);
			emitErrorJson(`Failed to list sessions: ${msg}`, 'COMMAND_FAILED');
		}
		process.exit(1);
	}
}

export async function sessionShow(tabId: string, options: SessionShowOptions): Promise<void> {
	let sinceMs: number | undefined;
	if (options.since !== undefined) {
		const parsed = parseSinceToMs(options.since);
		if (parsed === null) {
			emitErrorJson(
				`Invalid --since value: ${options.since} (expected ISO-8601 or epoch number)`,
				'INVALID_OPTION'
			);
			process.exit(1);
			return;
		}
		sinceMs = parsed;
	}

	let tail: number | undefined;
	if (options.tail !== undefined) {
		// Strict regex up front: `Number.parseInt('5abc', 10)` is `5` and
		// `parseInt('1.9', 10)` is `1`, so a permissive parse silently accepts
		// malformed flags and quietly truncates. Reject anything that isn't a
		// run of digits so the caller learns about the typo immediately.
		const trimmedTail = options.tail.trim();
		if (!/^\d+$/.test(trimmedTail)) {
			emitErrorJson(
				`Invalid --tail value: ${options.tail} (expected non-negative integer)`,
				'INVALID_OPTION'
			);
			process.exit(1);
			return;
		}
		tail = Number(trimmedTail);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				success?: boolean;
				error?: string;
				code?: string;
				tabId?: string;
				sessionId?: string;
				agentId?: string;
				agentSessionId?: string | null;
				messages?: SessionMessage[];
			}>(
				{
					type: 'get_session_history',
					tabId,
					...(sinceMs !== undefined ? { sinceMs } : {}),
					...(tail !== undefined ? { tail } : {}),
				},
				'session_history_result'
			);
		});

		if (!result.success) {
			emitErrorJson(result.error ?? 'Unknown error', result.code ?? 'UNKNOWN');
			process.exit(1);
			return;
		}

		const payload: SessionShowResult = {
			success: true,
			tabId: result.tabId ?? tabId,
			sessionId: result.sessionId ?? tabId,
			agentId: result.agentId ?? '',
			agentSessionId: result.agentSessionId ?? null,
			messages: result.messages ?? [],
		};

		if (options.json) {
			console.log(JSON.stringify(payload, null, 2));
			return;
		}

		// Default text mode: header + per-message transcript. ISO timestamps are
		// preserved verbatim so consumers can round-trip them straight into a
		// follow-up `session show --since "<timestamp>"` call without having to
		// re-parse a localized datetime.
		const headerParts = [`Tab: ${payload.tabId}`, `Agent: ${payload.agentId || '(unknown)'}`];
		if (payload.agentSessionId) headerParts.push(`Session: ${payload.agentSessionId}`);
		headerParts.push(`Messages: ${payload.messages.length}`);
		console.log(headerParts.join('  '));

		if (payload.messages.length === 0) {
			console.log('(no messages)');
			return;
		}

		console.log('');
		for (const msg of payload.messages) {
			console.log(`[${msg.timestamp}] ${msg.role}`);
			console.log(msg.content);
			console.log('');
		}
	} catch (error) {
		const mapped = mapTransportError(error);
		if (mapped) {
			emitErrorJson(mapped.error, mapped.code);
		} else {
			const msg = error instanceof Error ? error.message : String(error);
			emitErrorJson(`Failed to show session: ${msg}`, 'COMMAND_FAILED');
		}
		process.exit(1);
	}
}
