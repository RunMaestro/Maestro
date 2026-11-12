/**
 * Wire shape for the AI tab overlay menu's context items, reached remotely:
 * Context: Compact (`summarize_context`), Context: Merge Into (`merge_context`)
 * and Context: Send to Agent (`transfer_context`), plus the read-only
 * continuity preview (`continuity_preview`).
 *
 * The first three messages predate tab targeting and keep their names and fields
 * (`sessionId` for compact, `sourceSessionId` + `targetSessionId` for the
 * other two), so an old-shape sender still works. Every new field is optional:
 * `tabId` names the source tab (default: the agent's active AI tab, which is
 * what the menu acts on), `targetTabId` the merge target's tab (default: the
 * target agent's active AI tab), and `background` asks for no view change.
 *
 * The preview is its OWN message, not a flag on `summarize_context`: a desktop
 * that predates it ignores a field it does not know, so a preview asked for with
 * a flag would start a real compaction (a provider turn) there. An unknown
 * message type is refused instead.
 *
 * Lives in `shared/` because all three processes need it: the CLI builds the
 * message, main validates it on the way through, and the renderer answers it.
 */

import { stripControlCharacters } from './stringUtils';

/** The context operations of the tab overlay menu, and the continuity preview. */
export type TabContextOp = 'compact' | 'merge' | 'transfer' | 'continuity';

/** Protocol message and reply type for each operation. */
export const TAB_CONTEXT_OP_MESSAGES = {
	compact: { type: 'summarize_context', resultType: 'summarize_context_result' },
	merge: { type: 'merge_context', resultType: 'merge_context_result' },
	transfer: { type: 'transfer_context', resultType: 'transfer_context_result' },
	continuity: { type: 'continuity_preview', resultType: 'continuity_preview_result' },
} as const satisfies Record<TabContextOp, { type: string; resultType: string }>;

/**
 * How long main waits for the renderer to finish each operation before it
 * answers `timedOut`. Compact runs a summarization turn (chunked for a long
 * transcript), so it gets minutes; merge and transfer only move text; the
 * continuity preview reads History once and starts no turn.
 */
export const TAB_CONTEXT_OP_REPLY_MS: Record<TabContextOp, number> = {
	compact: 10 * 60_000,
	merge: 60_000,
	transfer: 30_000,
	continuity: 30_000,
};

/** The operations that name their source agent in `sessionId` (the others use `sourceSessionId`). */
function namesSessionId(op: TabContextOp): boolean {
	return op === 'compact' || op === 'continuity';
}

/**
 * Extra time the CLI waits past main's budget, so main's `timedOut` answer
 * arrives before the CLI gives up on the socket.
 */
export const TAB_CONTEXT_OP_CLI_MARGIN_MS = 15_000;

/** One context operation, already validated. */
export interface TabContextOpRequest {
	op: TabContextOp;
	/** The agent whose tab is the source. */
	sessionId: string;
	/** The source tab. Absent means the agent's active AI tab. */
	tabId?: string;
	/** merge / transfer: the agent the context goes to. */
	targetSessionId?: string;
	/** merge only: the tab the context goes into. Absent means the target's active AI tab. */
	targetTabId?: string;
	/**
	 * Leave the selected agent and every agent's active tab alone
	 * (`--background`). Opt-in only: a literal `true`.
	 */
	background?: boolean;
}

/**
 * The continuity preview of one tab, as it crosses the wire. `text` is the whole
 * preview and the only part meant to be read; the rest lets a script check it
 * without parsing prose. Built by `continuityWire()` in `continuityPreview.ts`.
 */
export interface TabContinuityPreview {
	/** Plain text. Never Markdown: its excerpts are model text. */
	text: string;
	/** Transcript entries the preview was read from. */
	entries: number;
	synopses: {
		/** Earlier synopses the preview shows. */
		shown: number;
		/** History entries kept out, by reason. */
		refused: Record<string, number>;
	};
	/** What the gates found about the evidence, one sentence each. */
	notices: string[];
	/** What could not be established, as `field: reason`. */
	unknowns: string[];
	/**
	 * The preview's repetition and readiness signals, as data. Absent from a desktop
	 * that predates them. Observations only: nothing in it is a score or a saving.
	 */
	signals?: TabContinuitySignals;
}

/** The signals of a continuity preview, as strings and counts a script can read without `contextSignals`. */
export interface TabContinuitySignals {
	/** Calls repeated with nothing between that could change the outcome. */
	repetition: {
		kind: string;
		call: string;
		count: number;
		ongoing: boolean;
		outputs: string;
		/** The entries of the run, as `tool #5`. */
		refs: string[];
		/** `reason at entry`, when something ended the run. */
		endedBy?: string;
		uncertainty: string[];
	}[];
	/** One reading each: `clear`, `open`, `info` or `unknown`. */
	readiness: { id: string; status: string; statement: string; uncertainty: string[] }[];
	/** The routing a continuation is configured with (settings, not a launch). Empty: not read. */
	routing: string[];
	/** Sentences in a report. Nothing acts on them. */
	advice: string[];
	/** What the signals could not establish, as `field: reason`. */
	unknowns: string[];
}

/** What the renderer answers a context operation with. */
export interface TabContextOpResult {
	success: boolean;
	error?: string;
	/** Main gave up waiting. The operation may still finish in the desktop. */
	timedOut?: boolean;
	/** The source agent. */
	sessionId?: string;
	/** The source tab the operation read. */
	tabId?: string;
	/** compact / transfer: the tab the operation created. */
	newTabId?: string;
	/** merge / transfer: the agent the context went to. */
	targetSessionId?: string;
	/** merge: the tab the context went into. */
	targetTabId?: string;
	/** transfer: the target was busy, so the context waits in its execution queue. */
	queued?: boolean;
	/** merge: the context waits on the target tab and sends when that tab is next opened. */
	staged?: boolean;
	/** compact: how much smaller the new tab's context is, in percent. */
	reductionPercent?: number;
	/** continuity: the preview. */
	continuity?: TabContinuityPreview;
}

const STRING_FIELDS = [
	'error',
	'sessionId',
	'tabId',
	'newTabId',
	'targetSessionId',
	'targetTabId',
] as const;

/** Longest preview text the receiver keeps. The digest is far smaller; this bounds a hostile sender. */
export const MAX_CONTINUITY_TEXT_CHARS = 64_000;
const MAX_CONTINUITY_LINES = 50;
const MAX_CONTINUITY_LINE_CHARS = 1_000;
const MAX_CONTINUITY_REASONS = 20;
const MAX_SIGNAL_ITEMS = 40;

function wholeCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A list of short sentences from outside: strings only, controls removed, bounded. */
function sentenceList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === 'string')
		.slice(0, MAX_CONTINUITY_LINES)
		.map((item) => stripControlCharacters(item).slice(0, MAX_CONTINUITY_LINE_CHARS));
}

/** One short string from outside: controls removed, bounded. Anything else is dropped. */
function cleanLine(value: unknown): string | undefined {
	return typeof value === 'string'
		? stripControlCharacters(value).slice(0, MAX_CONTINUITY_LINE_CHARS)
		: undefined;
}

function recordList(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
		.slice(0, MAX_SIGNAL_ITEMS);
}

/**
 * Narrow the signals of a preview from the wire, item by item: an item that is
 * not shaped as one is dropped, never repaired. Absent or not an object: no signals.
 */
export function normalizeContinuitySignals(raw: unknown): TabContinuitySignals | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const candidate = raw as Record<string, unknown>;
	const repetition: TabContinuitySignals['repetition'] = [];
	for (const item of recordList(candidate.repetition)) {
		const kind = cleanLine(item.kind);
		const call = cleanLine(item.call);
		const outputs = cleanLine(item.outputs);
		const count = wholeCount(item.count);
		if (kind === undefined || call === undefined || outputs === undefined || count === undefined) {
			continue;
		}
		const endedBy = cleanLine(item.endedBy);
		repetition.push({
			kind,
			call,
			count,
			ongoing: item.ongoing === true,
			outputs,
			refs: sentenceList(item.refs),
			...(endedBy !== undefined ? { endedBy } : {}),
			uncertainty: sentenceList(item.uncertainty),
		});
	}
	const readiness: TabContinuitySignals['readiness'] = [];
	for (const item of recordList(candidate.readiness)) {
		const id = cleanLine(item.id);
		const status = cleanLine(item.status);
		const statement = cleanLine(item.statement);
		if (id === undefined || status === undefined || statement === undefined) continue;
		readiness.push({ id, status, statement, uncertainty: sentenceList(item.uncertainty) });
	}
	return {
		repetition,
		readiness,
		routing: sentenceList(candidate.routing),
		advice: sentenceList(candidate.advice),
		unknowns: sentenceList(candidate.unknowns),
	};
}

/**
 * Narrow a preview from the wire. It is printed and shown as it arrives, so the
 * receiver does not trust the sender to have cleaned it: control characters are
 * removed, every size is bounded, and a shape that is not a preview is dropped
 * (the caller then reports a desktop that answered without one).
 *
 * Exported so every surface that shows a preview reads it through this one
 * function: `maestro-cli tab continuity` (through `normalizeTabContextOpResult`)
 * and the Preview Continuity modal show the same text because they clean it the
 * same way.
 */
export function normalizeContinuity(raw: unknown): TabContinuityPreview | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const candidate = raw as Record<string, unknown>;
	const synopses = candidate.synopses as Record<string, unknown> | null | undefined;
	const entries = wholeCount(candidate.entries);
	const shown = wholeCount(synopses?.shown);
	if (typeof candidate.text !== 'string' || !candidate.text) return undefined;
	if (entries === undefined || shown === undefined) return undefined;
	const refused: Record<string, number> = {};
	const rawRefused = synopses?.refused;
	if (rawRefused && typeof rawRefused === 'object') {
		for (const [reason, count] of Object.entries(rawRefused).slice(0, MAX_CONTINUITY_REASONS)) {
			const n = wholeCount(count);
			if (n !== undefined) refused[stripControlCharacters(reason).slice(0, 40)] = n;
		}
	}
	const text = stripControlCharacters(candidate.text);
	const signals = normalizeContinuitySignals(candidate.signals);
	return {
		text:
			text.length > MAX_CONTINUITY_TEXT_CHARS
				? `${text.slice(0, MAX_CONTINUITY_TEXT_CHARS)}\n[cut: the preview is longer than ${MAX_CONTINUITY_TEXT_CHARS} characters]`
				: text,
		entries,
		synopses: { shown, refused },
		notices: sentenceList(candidate.notices),
		unknowns: sentenceList(candidate.unknowns),
		...(signals ? { signals } : {}),
	};
}

/**
 * Narrow whatever the renderer sent back to a result.
 *
 * The reply crosses an IPC boundary, so a malformed answer becomes a failure
 * rather than a `success: undefined` the CLI would report as done.
 */
export function normalizeTabContextOpResult(raw: unknown): TabContextOpResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid context operation response' };
	}
	const candidate = raw as Record<string, unknown>;
	const result: TabContextOpResult = { success: candidate.success === true };
	for (const field of STRING_FIELDS) {
		const value = candidate[field];
		if (typeof value === 'string' && value) result[field] = value;
	}
	if (candidate.timedOut === true) result.timedOut = true;
	if (candidate.queued === true) result.queued = true;
	if (candidate.staged === true) result.staged = true;
	if (
		typeof candidate.reductionPercent === 'number' &&
		Number.isFinite(candidate.reductionPercent)
	) {
		result.reductionPercent = candidate.reductionPercent;
	}
	const continuity = normalizeContinuity(candidate.continuity);
	if (continuity) result.continuity = continuity;
	if (!result.success && !result.error) result.error = 'Context operation failed';
	return result;
}

/** Build the protocol message for a request, in the fields each message has always used. */
export function buildTabContextOpMessage(request: TabContextOpRequest): Record<string, unknown> {
	const { op, sessionId, tabId, targetSessionId, targetTabId, background } = request;
	const message: Record<string, unknown> = { type: TAB_CONTEXT_OP_MESSAGES[op].type };
	if (namesSessionId(op)) {
		message.sessionId = sessionId;
	} else {
		message.sourceSessionId = sessionId;
		message.targetSessionId = targetSessionId;
	}
	if (tabId) message.tabId = tabId;
	if (op === 'merge' && targetTabId) message.targetTabId = targetTabId;
	if (background === true) message.background = true;
	return message;
}

function optionalId(
	message: Record<string, unknown>,
	field: string
): { ok: true; value?: string } | { ok: false; error: string } {
	const raw = message[field];
	if (raw === undefined || raw === null) return { ok: true };
	if (typeof raw !== 'string' || !raw.trim()) {
		return { ok: false, error: `${field} must be a non-empty string when provided` };
	}
	return { ok: true, value: raw.trim() };
}

/**
 * Validate a raw context-operation message.
 *
 * Runs in main, between a client of any version and the renderer. Which tab is
 * meant (and whether source and target are the same tab) is the renderer's
 * call, because only it knows each agent's active tab; main refuses only what
 * is wrong whatever the tabs are.
 *
 * @returns The validated request, or a message naming what is wrong.
 */
export function parseTabContextOpMessage(
	op: TabContextOp,
	message: Record<string, unknown>
): { ok: true; request: TabContextOpRequest } | { ok: false; error: string } {
	const sourceField = namesSessionId(op) ? 'sessionId' : 'sourceSessionId';
	const rawSource = message[sourceField];
	const sessionId = typeof rawSource === 'string' ? rawSource.trim() : '';
	const rawTarget = message.targetSessionId;
	const targetSessionId = typeof rawTarget === 'string' ? rawTarget.trim() : '';

	if (namesSessionId(op)) {
		if (!sessionId) return { ok: false, error: 'Missing sessionId' };
	} else if (!sessionId || !targetSessionId) {
		return { ok: false, error: 'Missing sourceSessionId or targetSessionId' };
	}
	// Send to Agent opens a new tab in ANOTHER agent (the modal never lists the
	// source agent). Merge may go to another tab of the same agent.
	if (op === 'transfer' && sessionId === targetSessionId) {
		return { ok: false, error: 'Source and target agents must be different' };
	}

	const tabId = optionalId(message, 'tabId');
	if (!tabId.ok) return tabId;
	const targetTabId = op === 'merge' ? optionalId(message, 'targetTabId') : { ok: true as const };
	if (!targetTabId.ok) return targetTabId;

	return {
		ok: true,
		request: {
			op,
			sessionId,
			...(!namesSessionId(op) ? { targetSessionId } : {}),
			...(tabId.value ? { tabId: tabId.value } : {}),
			...(targetTabId.value ? { targetTabId: targetTabId.value } : {}),
			...(message.background === true ? { background: true } : {}),
		},
	};
}
