/**
 * Wire shape for the AI tab overlay menu's context items, reached remotely:
 * Context: Compact (`summarize_context`), Context: Merge Into (`merge_context`)
 * and Context: Send to Agent (`transfer_context`).
 *
 * The three messages predate tab targeting and keep their names and fields
 * (`sessionId` for compact, `sourceSessionId` + `targetSessionId` for the
 * other two), so an old-shape sender still works. Every new field is optional:
 * `tabId` names the source tab (default: the agent's active AI tab, which is
 * what the menu acts on), `targetTabId` the merge target's tab (default: the
 * target agent's active AI tab), and `background` asks for no view change.
 *
 * Lives in `shared/` because all three processes need it: the CLI builds the
 * message, main validates it on the way through, and the renderer answers it.
 */

/** The three context operations of the tab overlay menu. */
export type TabContextOp = 'compact' | 'merge' | 'transfer';

/** Protocol message and reply type for each operation. */
export const TAB_CONTEXT_OP_MESSAGES = {
	compact: { type: 'summarize_context', resultType: 'summarize_context_result' },
	merge: { type: 'merge_context', resultType: 'merge_context_result' },
	transfer: { type: 'transfer_context', resultType: 'transfer_context_result' },
} as const satisfies Record<TabContextOp, { type: string; resultType: string }>;

/**
 * How long main waits for the renderer to finish each operation before it
 * answers `timedOut`. Compact runs a summarization turn (chunked for a long
 * transcript), so it gets minutes; merge and transfer only move text.
 */
export const TAB_CONTEXT_OP_REPLY_MS: Record<TabContextOp, number> = {
	compact: 10 * 60_000,
	merge: 60_000,
	transfer: 30_000,
};

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
}

const STRING_FIELDS = [
	'error',
	'sessionId',
	'tabId',
	'newTabId',
	'targetSessionId',
	'targetTabId',
] as const;

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
	if (!result.success && !result.error) result.error = 'Context operation failed';
	return result;
}

/** Build the protocol message for a request, in the fields each message has always used. */
export function buildTabContextOpMessage(request: TabContextOpRequest): Record<string, unknown> {
	const { op, sessionId, tabId, targetSessionId, targetTabId, background } = request;
	const message: Record<string, unknown> = { type: TAB_CONTEXT_OP_MESSAGES[op].type };
	if (op === 'compact') {
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
	const sourceField = op === 'compact' ? 'sessionId' : 'sourceSessionId';
	const rawSource = message[sourceField];
	const sessionId = typeof rawSource === 'string' ? rawSource.trim() : '';
	const rawTarget = message.targetSessionId;
	const targetSessionId = typeof rawTarget === 'string' ? rawTarget.trim() : '';

	if (op === 'compact') {
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
			...(op !== 'compact' ? { targetSessionId } : {}),
			...(tabId.value ? { tabId: tabId.value } : {}),
			...(targetTabId.value ? { targetTabId: targetTabId.value } : {}),
			...(message.background === true ? { background: true } : {}),
		},
	};
}
