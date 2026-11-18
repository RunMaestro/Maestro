/**
 * Message pins in the renderer: the one place a tab's pins are changed.
 *
 * The pin button on a message, the pin panel's unpin and rename, and
 * `maestro-cli tab pins` all come through here, so every path writes the tab
 * the same way and mirrors the result onto the provider session's origin
 * record (which is what brings pins back when the conversation is reopened
 * from History). The pin model itself is in `src/shared/messagePins.ts`.
 */

import type { AITab, LogEntry, Session } from '../types';
import {
	addMessagePin,
	createMessagePin,
	findPinForRow,
	isPinnableRow,
	messagePinLabel,
	removeMessagePin,
	renameMessagePin,
	resolvePinnedRows,
	sortMessagePins,
	type MessagePin,
	type PinnableRow,
} from '../../shared/messagePins';
import type {
	MessagePinCommandRequest,
	MessagePinCommandResult,
	MessagePinSummary,
} from '../../shared/messagePinCommands';
import { updateAiTab, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { resolveSessionProjectPath } from '../components/AgentSessionsBrowser/utils/sessionProjectPath';
import { collapseAiResponseLogs } from '../components/TerminalOutput/utils/collapseAiResponseLogs';
import { buildRenderedIdMap } from '../components/TerminalOutput/utils/renderedLogIds';
import { aiTabFocusFields } from '../utils/tabHelpers/focusFields';
import { noteDesktopAiTabSelection } from '../utils/desktopTabSelectionSync';
import { generateId } from '../utils/ids';
import { captureException } from '../utils/sentry';

/**
 * The rows of a tab a pin can point at, as the transcript draws them: a turn's
 * streamed reply folded into one entry (keeping its first entry's id), and the
 * person's messages. Pins are made on these rows and resolved against them.
 */
export function pinnableRows(logs: LogEntry[]): LogEntry[] {
	return collapseAiResponseLogs(logs).filter(isPinnableRow);
}

/**
 * Mirror a tab's pins onto its provider session's origin record. A tab with no
 * provider session yet has nowhere to mirror to; it is mirrored again when it
 * closes (see `snapshotClosedTabTranscript` callers), by which time it has one.
 */
export function persistTabPins(session: Session, tab: AITab): void {
	if (!tab.agentSessionId) return;
	const { projectPathForSessions } = resolveSessionProjectPath(session);
	if (!projectPathForSessions) return;
	const agentId = tab.turnProvider ?? session.toolType ?? 'claude-code';
	window.maestro.agentSessions
		.setSessionPins(agentId, projectPathForSessions, tab.agentSessionId, tab.pinnedMessages ?? [])
		.catch((error: unknown) => {
			captureException(error, {
				extra: {
					sessionId: session.id,
					agentSessionId: tab.agentSessionId,
					agentType: agentId,
					operation: 'persist-tab-pins',
				},
			});
		});
}

function findTab(sessionId: string, tabId: string): { session: Session; tab: AITab } | null {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const tab = session?.aiTabs.find((t) => t.id === tabId);
	return session && tab ? { session, tab } : null;
}

/**
 * Apply `change` to a tab's pins, write the tab, and mirror it. Returns the
 * new pins, or null when the tab is gone or nothing changed.
 */
function commitPins(
	sessionId: string,
	tabId: string,
	change: (pins: MessagePin[], tab: AITab) => MessagePin[]
): MessagePin[] | null {
	const found = findTab(sessionId, tabId);
	if (!found) return null;
	const current = found.tab.pinnedMessages ?? [];
	const next = change(current, found.tab);
	if (next === current) return null;
	updateAiTab(sessionId, tabId, (tab) => {
		if (next.length > 0) return { ...tab, pinnedMessages: next };
		const { pinnedMessages: _cleared, ...rest } = tab;
		return rest;
	});
	const after = findTab(sessionId, tabId);
	if (after) persistTabPins(after.session, after.tab);
	// The panel has nothing to show once the last pin goes.
	if (next.length === 0 && useUIStore.getState().messagePinsTabId === tabId) {
		useUIStore.getState().setMessagePinsTabId(null);
	}
	return next;
}

/**
 * Pin `row` in a tab, or unpin it when it is already pinned. `row` is a row as
 * the transcript draws it (see `pinnableRows`).
 *
 * @returns What happened, or null when the row cannot be pinned or the tab is gone.
 */
export function toggleMessagePin(
	sessionId: string,
	tabId: string,
	row: PinnableRow
): 'pinned' | 'unpinned' | null {
	let outcome: 'pinned' | 'unpinned' | null = null;
	commitPins(sessionId, tabId, (pins, tab) => {
		const existing = findPinForRow(pins, row, pinnableRows(tab.logs));
		if (existing) {
			outcome = 'unpinned';
			return removeMessagePin(pins, existing.id);
		}
		if (!isPinnableRow(row)) return pins;
		outcome = 'pinned';
		return addMessagePin(pins, createMessagePin(row, generateId(), Date.now()));
	});
	return outcome;
}

/** Remove one pin from a tab. */
export function unpinMessage(sessionId: string, tabId: string, pinId: string): boolean {
	return commitPins(sessionId, tabId, (pins) => removeMessagePin(pins, pinId)) !== null;
}

/** Rename one pin. A blank label goes back to the automatic title. */
export function renamePinnedMessage(
	sessionId: string,
	tabId: string,
	pinId: string,
	label: string
): boolean {
	return commitPins(sessionId, tabId, (pins) => renameMessagePin(pins, pinId, label)) !== null;
}

/** A tab's pins, flattened for the CLI, in transcript order. */
export function summarizeTabPins(tab: AITab): MessagePinSummary[] {
	const pins = sortMessagePins(tab.pinnedMessages ?? []);
	const resolved = resolvePinnedRows(pins, pinnableRows(tab.logs));
	return pins.map((pin) => {
		const row = resolved.get(pin.id);
		return {
			id: pin.id,
			label: messagePinLabel(pin),
			title: pin.title,
			renamed: !!pin.label,
			source: pin.source,
			timestamp: pin.timestamp,
			pinnedAt: pin.pinnedAt,
			messageId: row?.id ?? null,
			loaded: !!row,
			excerpt: pin.excerpt,
		};
	});
}

/** The one item whose id is `id`, or the only one whose id starts with it. */
function matchId<T>(
	items: T[],
	id: string,
	getId: (item: T) => string,
	noun: string
): { ok: true; item: T } | { ok: false; error: string } {
	const exact = items.find((item) => getId(item) === id);
	if (exact) return { ok: true, item: exact };
	const prefixed = items.filter((item) => getId(item).startsWith(id));
	if (prefixed.length === 1) return { ok: true, item: prefixed[0] };
	if (prefixed.length > 1) {
		return { ok: false, error: `"${id}" matches ${prefixed.length} ${noun}s; use more characters` };
	}
	return { ok: false, error: `No ${noun} matches "${id}"` };
}

/** The pinnable row an `add` request names. */
function pickRowToPin(
	tab: AITab,
	request: MessagePinCommandRequest
): { ok: true; row: LogEntry } | { ok: false; error: string } {
	const rows = pinnableRows(tab.logs);
	if (request.last) {
		const source = request.last === 'user' ? 'user' : 'stdout';
		const row = [...rows].reverse().find((r) => r.source === source);
		return row
			? { ok: true, row }
			: {
					ok: false,
					error: `This tab has no ${request.last === 'user' ? 'user message' : 'agent reply'} to pin`,
				};
	}
	// Any raw transcript entry id is accepted: a later chunk of a streamed reply
	// resolves to the reply it was folded into.
	const matched = matchId(tab.logs, request.messageId ?? '', (log) => log.id, 'message');
	if (!matched.ok) return matched;
	const notPinnable = {
		ok: false as const,
		error: `Message ${matched.item.id} is not a user message or agent reply`,
	};
	if (matched.item.source !== 'user' && matched.item.source !== 'stdout') return notPinnable;
	const rowId = buildRenderedIdMap(rows, tab.logs).get(matched.item.id);
	const row = rows.find((r) => r.id === rowId);
	return row ? { ok: true, row } : notPinnable;
}

export interface MessagePinCommandDeps {
	/** Make the agent the selected one (`show`). */
	selectAgent?: (sessionId: string) => void;
}

/**
 * Run one `message_pin_command`. Answers rather than throws for every expected
 * outcome (unknown tab, bad id): the caller is a CLI process reporting to a human.
 */
export function runRemoteMessagePinCommand(
	request: MessagePinCommandRequest,
	deps: MessagePinCommandDeps = {}
): MessagePinCommandResult {
	const { sessionId, tabId } = request;
	const found = findTab(sessionId, tabId);
	if (!found) return { success: false, error: `AI tab not found: ${tabId}` };
	const { tab } = found;
	const summaries = () => {
		const latest = findTab(sessionId, tabId)?.tab;
		return latest ? summarizeTabPins(latest) : [];
	};
	const summaryFor = (pinId: string) => summaries().find((pin) => pin.id === pinId);

	switch (request.action) {
		case 'list':
			return { success: true, pins: summarizeTabPins(tab) };

		case 'show': {
			if (!tab.pinnedMessages?.length) {
				return { success: false, error: 'This tab has no pinned messages' };
			}
			updateSessionWith(sessionId, (s) => ({ ...s, ...aiTabFocusFields(tabId) }));
			deps.selectAgent?.(sessionId);
			noteDesktopAiTabSelection(sessionId, tabId);
			useUIStore.getState().setMessagePinsTabId(tabId);
			return { success: true, pins: summarizeTabPins(tab) };
		}

		case 'add': {
			const picked = pickRowToPin(tab, request);
			if (!picked.ok) return { success: false, error: picked.error };
			const rows = pinnableRows(tab.logs);
			const existing = findPinForRow(tab.pinnedMessages ?? [], picked.row, rows);
			if (existing) {
				return {
					success: true,
					alreadyPinned: true,
					pin: summaryFor(existing.id),
					pins: summaries(),
				};
			}
			toggleMessagePin(sessionId, tabId, picked.row);
			const added = findPinForRow(
				findTab(sessionId, tabId)?.tab.pinnedMessages ?? [],
				picked.row,
				rows
			);
			if (!added) return { success: false, error: 'The message could not be pinned' };
			return { success: true, pin: summaryFor(added.id), pins: summaries() };
		}

		case 'remove':
		case 'rename': {
			const matched = matchId(tab.pinnedMessages ?? [], request.pinId ?? '', (p) => p.id, 'pin');
			if (!matched.ok) return { success: false, error: matched.error };
			const pinId = matched.item.id;
			if (request.action === 'remove') {
				const before = summaryFor(pinId);
				unpinMessage(sessionId, tabId, pinId);
				return { success: true, pin: before, pins: summaries() };
			}
			renamePinnedMessage(sessionId, tabId, pinId, request.label ?? '');
			return { success: true, pin: summaryFor(pinId), pins: summaries() };
		}
	}
}
