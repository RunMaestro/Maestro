// Session inspection commands - read-only access to desktop conversation state
// for external pollers (Maestro-Discord, Cue follow-ups, etc.).
//
// `session list` enumerates every open AI tab across every Maestro agent that
// the tab bar draws. Hidden tabs (consults) are left out unless
// `--include-hidden` is passed; every entry carries `hidden` either way.
// `session show <tabId>` returns that tab's conversation history, with optional
// `--since` (poll cursor) and `--tail` (cap) filters applied desktop-side so the
// wire payload stays small even on long conversations.
//
// Both verbs talk to the running desktop via the same WebSocket the `dispatch`
// command uses; there is no on-disk fallback. If the desktop is not running the
// CLI fails loudly with `MAESTRO_NOT_RUNNING` so callers can react rather than
// silently get back stale data.

import { withMaestroClient } from '../services/maestro-client';
import { exitIfMaestroNotRunning } from '../services/session-command';
import { parseCliTimestamp } from '../utils/parse';
import { formatRelativeTime } from '../../shared/formatters';
import type {
	DesktopTabEntry as DesktopSessionEntry,
	DesktopStripTabEntry,
	TabProviderInspection,
} from '../../shared/desktopTabs';
import type { TabStripVisibility } from '../../shared/tabStripMembership';
import { ExitCode, exitWith, exitCodeForError } from '../exit-codes';

export interface SessionListOptions {
	json?: boolean;
	/** Also list hidden tabs (consult transcripts the tab bar draws no chip for). */
	includeHidden?: boolean;
	/** Only the hidden tabs. */
	hidden?: boolean;
	/** Every tab: visible, hidden, and orphaned. */
	all?: boolean;
	/** Which kinds of tab: ai (default), file, browser, terminal, or all. */
	type?: string;
}

export interface SessionShowOptions {
	since?: string;
	tail?: string;
	json?: boolean;
}

interface SessionMessage {
	id: string;
	role: string;
	source: string;
	content: string;
	timestamp: string;
}

interface SessionShowResult extends TabProviderInspection {
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

const SESSION_LIST_TYPES = ['ai', 'file', 'browser', 'terminal', 'all'] as const;
type SessionListType = (typeof SESSION_LIST_TYPES)[number];
type SessionListScope = 'visible' | 'hidden' | 'visible+hidden' | 'all';
const VISIBILITIES = ['visible', 'hidden', 'orphaned'] as const;

/**
 * An entry's visibility. A desktop older than the `visibility` field still
 * sends `hidden`, which tells visible from hidden; it cannot report orphans.
 */
function visibilityOf(entry: {
	visibility?: TabStripVisibility;
	hidden?: boolean;
}): TabStripVisibility {
	return entry.visibility ?? (entry.hidden === true ? 'hidden' : 'visible');
}

function inScope(visibility: TabStripVisibility, scope: SessionListScope): boolean {
	if (scope === 'all') return true;
	if (scope === 'visible+hidden') return visibility !== 'orphaned';
	return visibility === scope;
}

/** The trailing marker a non-visible row carries in text mode. */
function visibilityMarker(visibility: TabStripVisibility): string {
	if (visibility === 'hidden') return '  [hidden]';
	if (visibility === 'orphaned') return '  [orphaned: no tab-strip slot]';
	return '';
}

export async function sessionList(options: SessionListOptions): Promise<void> {
	const scopeFlags = [options.hidden, options.includeHidden, options.all].filter(Boolean).length;
	if (scopeFlags > 1) {
		emitErrorJson('Pass only one of --hidden, --include-hidden, --all', 'INVALID_OPTION');
		process.exit(1);
		return;
	}
	const type = (options.type ?? 'ai').toLowerCase() as SessionListType;
	if (!SESSION_LIST_TYPES.includes(type)) {
		emitErrorJson(
			`Invalid --type "${options.type}". Use one of: ${SESSION_LIST_TYPES.join(', ')}`,
			'INVALID_OPTION'
		);
		process.exit(1);
		return;
	}
	try {
		const listing = await withMaestroClient((client) =>
			client.sendCommand<{ sessions?: DesktopSessionEntry[]; tabs?: DesktopStripTabEntry[] }>(
				{ type: 'list_desktop_sessions' },
				'desktop_sessions_list'
			)
		);
		if (type !== 'ai' && !Array.isArray(listing.tabs)) {
			emitErrorJson(
				'This Maestro build does not report file, browser or terminal tabs. Update Maestro, or use --type ai.',
				'UNSUPPORTED'
			);
			process.exit(1);
			return;
		}

		// The desktop reports every stored tab so tab verbs can still resolve a
		// hidden one by ID. The listing defaults to what the tab strips draw, the
		// same rule the Usage Dashboard "Open Tabs" card counts by (#2008).
		const scope: SessionListScope = options.all
			? 'all'
			: options.includeHidden
				? 'visible+hidden'
				: options.hidden
					? 'hidden'
					: 'visible';
		const aiEntries = type === 'ai' || type === 'all' ? (listing.sessions ?? []) : [];
		const stripEntries =
			type === 'ai' ? [] : (listing.tabs ?? []).filter((t) => type === 'all' || t.tabType === type);
		const counts: Record<TabStripVisibility, number> = { visible: 0, hidden: 0, orphaned: 0 };
		for (const entry of [...aiEntries, ...stripEntries]) counts[visibilityOf(entry)]++;
		const sessions = aiEntries.filter((s) => inScope(visibilityOf(s), scope));
		const tabs = stripEntries.filter((t) => inScope(t.visibility, scope));
		// A desktop older than the `hidden` field cannot tell hidden tabs apart,
		// so every tab reads as visible. Say so rather than report a wrong count.
		const visibilityReported =
			aiEntries.length === 0 ||
			aiEntries.some((s) => s.visibility !== undefined || s.hidden !== undefined);

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						scope,
						type,
						counts,
						visibilityReported,
						sessions,
						...(type === 'ai' ? {} : { tabs }),
					},
					null,
					2
				)
			);
			return;
		}

		if (!visibilityReported) {
			console.error(
				'Note: this Maestro build does not report tab visibility, so hidden tabs are listed as visible. Update Maestro for an exact list.'
			);
		}
		const kind = type === 'ai' ? 'AI tabs' : type === 'all' ? 'tabs' : `${type} tabs`;
		if (sessions.length + tabs.length === 0) {
			console.log(scope === 'hidden' ? `No hidden ${kind}.` : `No open ${kind}.`);
		}

		// Compact human-readable view: one tab per line so the output is grep-able
		// and pipes cleanly into other tools while still being readable for a
		// quick glance. Columns: state | star | tabId | agent | name | createdAt.
		// `state` is spelled out (busy/idle/unknown) rather than relying on the `*` marker
		// alone so `grep busy` works without column-counting.
		for (const s of sessions) {
			// Padded so the columns still line up now that 'unknown' is three
			// characters wider than 'busy'/'idle'. Falls back rather than printing
			// `undefined` when an older desktop omits the field entirely.
			const state = (s.state ?? 'unknown').padEnd(7);
			const star = s.starred ? '★' : ' ';
			const name = s.name ?? '(unnamed)';
			const created = Number.isFinite(s.createdAt) ? formatRelativeTime(s.createdAt) : '-';
			const prefix = type === 'all' ? 'ai       ' : '';
			console.log(
				`${prefix}${state} ${star} ${s.tabId}  ${s.agentName} (${s.agentId})  ${name}  ${created}${visibilityMarker(visibilityOf(s))}`
			);
		}
		// Non-AI rows: kind | active | tabId | agent | name | path, URL or cwd.
		for (const t of tabs) {
			const active = t.active ? '*' : ' ';
			const detail = t.target ? `  ${t.target}` : '';
			console.log(
				`${t.tabType.padEnd(8)} ${active} ${t.tabId}  ${t.agentName} (${t.agentId})  ${t.name ?? '(unnamed)'}${detail}${visibilityMarker(t.visibility)}`
			);
		}
		const left = VISIBILITIES.filter((v) => !inScope(v, scope) && counts[v] > 0).map(
			(v) => `${counts[v]} ${v}`
		);
		if (left.length > 0) {
			console.log(
				`(${left.join(', ')} not shown; --include-hidden adds hidden tabs, --all lists every tab)`
			);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
		const msg = error instanceof Error ? error.message : String(error);
		emitErrorJson(`Failed to list sessions: ${msg}`, 'COMMAND_FAILED');
		exitWith(exitCodeForError(error));
	}
}

export async function sessionShow(tabId: string, options: SessionShowOptions): Promise<void> {
	let sinceMs: number | undefined;
	if (options.since !== undefined) {
		const parsed = parseCliTimestamp(options.since);
		if (parsed === null) {
			emitErrorJson(
				`Invalid --since value: ${options.since} (expected ISO-8601 or epoch number)`,
				'INVALID_OPTION'
			);
			exitWith(ExitCode.GeneralError);
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
			exitWith(ExitCode.GeneralError);
			return;
		}
		tail = Number(trimmedTail);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<
				{
					success?: boolean;
					error?: string;
					code?: string;
					tabId?: string;
					sessionId?: string;
					agentId?: string;
					agentSessionId?: string | null;
					messages?: SessionMessage[];
				} & TabProviderInspection
			>(
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
			exitWith(ExitCode.GeneralError);
			return;
		}

		const payload: SessionShowResult = {
			success: true,
			tabId: result.tabId ?? tabId,
			sessionId: result.sessionId ?? tabId,
			agentId: result.agentId ?? '',
			agentSessionId: result.agentSessionId ?? null,
			messages: result.messages ?? [],
			provider: result.provider,
			agentProvider: result.agentProvider,
			tabProvider: result.tabProvider,
			turnProvider: result.turnProvider,
			pendingTranslation: result.pendingTranslation,
			effectiveModel: result.effectiveModel,
			effectiveEffort: result.effectiveEffort,
			runOn: result.runOn,
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
		if (payload.provider) headerParts.push(`Provider: ${payload.provider}`);
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
		exitIfMaestroNotRunning(error, { json: true, indent: 2 });
		const msg = error instanceof Error ? error.message : String(error);
		emitErrorJson(`Failed to show session: ${msg}`, 'COMMAND_FAILED');
		exitWith(exitCodeForError(error));
	}
}
