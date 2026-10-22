// src/main/codex-app-server/event-translator.ts

/**
 * `codex app-server` -> `codex exec --json` translator.
 *
 * The app-server transport exists so a Codex turn can be steered while it runs,
 * but everything downstream of the process (CodexOutputParser, StdoutHandler,
 * usage, tool cards, the session id listener, the renderer) was built against
 * the JSONL `codex exec --json` writes. Rather than re-plumb that stack, this
 * converts app-server notifications back into the exact legacy exec shapes the
 * parser already handles: `thread.started`, `turn.started`, `item.started`,
 * `item.completed`, `turn.completed`, `turn.failed` and `error`, plus one line
 * of Maestro's own, `maestro.call_usage` (see `CODEX_CALL_USAGE_LINE_TYPE`).
 * Same design as
 * `src/main/opencode-server/event-translator.ts` for OpenCode.
 *
 * The full mapping table, with the fixture line behind every row, is in
 * `docs/agent-guides/CODEX-APP-SERVER.md` ("Notification -> codex exec line").
 *
 * Separately from the exec lines, the translator tracks what steering needs:
 * the active turn id (the `expectedTurnId` for `turn/steer`, the `turnId` for
 * `turn/interrupt`) and every `userMessage` item that completes inside the
 * active turn. A steer is `absorbed` when its text comes back as one of those.
 *
 * Every notification is scoped to THIS turn's thread. One app-server
 * connection can carry more than one thread (a sub-agent spawned by the turn
 * runs as its own thread, `parentThreadId` pointing back at ours), and every
 * thread-scoped notification names its thread (`params.threadId`, or
 * `params.thread.id` on `thread/started`). A notification naming another
 * thread is dropped, or a sub-agent's `turn/started` / `turn/completed` would
 * end or hang this turn and steer or interrupt the wrong one.
 *
 * Pure and free of any process concerns, so it can be replayed against the
 * recorded fixtures. One instance per spawned turn.
 */

import { CODEX_CALL_USAGE_LINE_TYPE } from '../../shared/maestro-lib/parsers/codex-output-parser';
import type {
	CodexAppServerItem,
	CodexAppServerNotification,
	CodexAppServerThread,
	CodexAppServerTokenBreakdown,
	CodexAppServerTurn,
	CodexAppServerTurnError,
} from './protocol';

/** One `codex exec --json` line, as an object (JSON.stringify it to feed StdoutHandler). */
export interface CodexExecLine {
	type: string;
	[key: string]: unknown;
}

/** A `userMessage` item that completed while the turn was active. */
export interface CodexAppServerUserMessage {
	turnId: string;
	itemId: string;
	text: string;
}

/** How the turn ended, once `turn/completed` has arrived. */
export type CodexAppServerTurnOutcome = 'completed' | 'interrupted' | 'failed';

/** The client requests whose RESPONSE carries data the translator needs. */
export type CodexTranslatedRequestMethod = 'thread/start' | 'thread/resume' | 'turn/start';

/** Exec `usage` fields, in the order exec reports them. */
const USAGE_FIELDS = [
	['inputTokens', 'input_tokens'],
	['cachedInputTokens', 'cached_input_tokens'],
	['outputTokens', 'output_tokens'],
	['reasoningOutputTokens', 'reasoning_output_tokens'],
] as const;

type UsageTotals = Record<(typeof USAGE_FIELDS)[number][0], number>;

/** What the usage updates for one turn said: its first and its latest. */
interface TurnUsage {
	/**
	 * Thread total BEFORE the turn, derived from its first update as
	 * `total - last` (`last` is the model call that update covers). Null when
	 * that update carried no `last`.
	 */
	baseline: UsageTotals | null;
	/** Thread total at the turn's latest update. */
	current: UsageTotals;
	/**
	 * Thread total of the most recent update for an EARLIER turn, as it stood
	 * when this turn's first update arrived (a resumed thread replays the
	 * previous turn's total before this one starts). The fallback baseline.
	 */
	replayBaseline: UsageTotals | null;
}

function readTotals(
	breakdown: CodexAppServerTokenBreakdown | null | undefined
): UsageTotals | null {
	if (!breakdown || typeof breakdown !== 'object') return null;
	const totals = {} as UsageTotals;
	for (const [field] of USAGE_FIELDS) {
		const value = breakdown[field];
		totals[field] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
	}
	return totals;
}

function hasTokens(totals: UsageTotals): boolean {
	return USAGE_FIELDS.some(([field]) => totals[field] > 0);
}

/** Totals in `codex exec` usage field names. */
function execUsage(totals: UsageTotals): Record<string, number> {
	const usage: Record<string, number> = {};
	for (const [field, execField] of USAGE_FIELDS) usage[execField] = totals[field];
	return usage;
}

function subtractTotals(total: UsageTotals, part: UsageTotals): UsageTotals {
	const out = {} as UsageTotals;
	for (const [field] of USAGE_FIELDS) out[field] = Math.max(0, total[field] - part[field]);
	return out;
}

/** The thread a notification names, if any. */
function notificationThreadId(method: string, params: Record<string, unknown>): string | undefined {
	if (method === 'thread/started') {
		const id = (params.thread as CodexAppServerThread | undefined)?.id;
		return typeof id === 'string' ? id : undefined;
	}
	return typeof params.threadId === 'string' ? params.threadId : undefined;
}

/** App-server item status -> exec item status. `declined` is a failure to exec. */
function execItemStatus(status: string | undefined): 'in_progress' | 'completed' | 'failed' {
	if (status === 'inProgress') return 'in_progress';
	if (status === 'completed') return 'completed';
	return 'failed';
}

/** Text of a `userMessage` item: every text part, joined. */
function userMessageText(item: CodexAppServerItem): string {
	const content = item.content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			return part && part.type === 'text' && typeof part.text === 'string' ? part.text : '';
		})
		.filter((text) => text.length > 0)
		.join('\n');
}

/** Reasoning text: the summary, falling back to the raw content; blank when both are. */
function reasoningText(item: CodexAppServerItem): string {
	const join = (parts: unknown) =>
		Array.isArray(parts)
			? parts
					.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
					.join('\n\n')
			: '';
	return join(item.summary) || join(item.content);
}

export class CodexAppServerEventTranslator {
	private _threadId: string | null = null;
	private threadStartedEmitted = false;
	private _activeTurnId: string | null = null;
	private turnStartedEmitted = false;
	private _outcome: CodexAppServerTurnOutcome | null = null;
	/** Usage updates per turn id, so the active turn's can be read once it is known. */
	private usageByTurn = new Map<string, TurnUsage>();
	/** Thread total at the most recent usage update, whichever turn it named. */
	private latestUsageTotal: UsageTotals | null = null;
	private userMessageListeners = new Set<(message: CodexAppServerUserMessage) => void>();

	/** The thread id (the provider session id), once known. */
	get threadId(): string | null {
		return this._threadId;
	}

	/** The running turn's id; null before it starts and after it completes. */
	get activeTurnId(): string | null {
		return this._activeTurnId;
	}

	/** How the turn ended; null until `turn/completed` arrives. */
	get outcome(): CodexAppServerTurnOutcome | null {
		return this._outcome;
	}

	/**
	 * Subscribe to `userMessage` items completing inside the active turn: the
	 * prompt itself, and every steer the server absorbed. Returns an unsubscribe.
	 */
	onUserMessage(listener: (message: CodexAppServerUserMessage) => void): () => void {
		this.userMessageListeners.add(listener);
		return () => {
			this.userMessageListeners.delete(listener);
		};
	}

	/**
	 * Feed the successful RESPONSE to one of our requests. The `thread/start` and
	 * `thread/resume` responses carry the thread id; the response is preferred
	 * over the `thread/started` notification because resume never sends one, and
	 * the tab would otherwise never learn the session id on a resumed turn. The
	 * `turn/start` response carries the turn id before `turn/started` does.
	 */
	translateResponse(method: CodexTranslatedRequestMethod, result: unknown): CodexExecLine[] {
		if (!result || typeof result !== 'object') return [];
		if (method === 'turn/start') {
			const turn = (result as { turn?: CodexAppServerTurn }).turn;
			if (turn?.id && !this._outcome) this._activeTurnId = turn.id;
			return [];
		}
		const thread = (result as { thread?: CodexAppServerThread }).thread;
		if (!thread?.id) return [];
		// The response is authoritative for which thread this turn runs on.
		this._threadId = thread.id;
		return this.threadStarted(thread.id);
	}

	/**
	 * Feed one server notification. Returns the exec lines to forward, possibly
	 * none. Unknown notifications, and every notification the mapping table calls
	 * noise, return nothing.
	 */
	translate(notification: CodexAppServerNotification): CodexExecLine[] {
		const params = (notification.params ?? {}) as Record<string, unknown>;
		const threadId = notificationThreadId(notification.method, params);
		// Another thread's notification (a sub-agent's) says nothing about ours.
		if (this._threadId && threadId && threadId !== this._threadId) return [];
		switch (notification.method) {
			case 'thread/started':
				return this.threadStarted((params.thread as CodexAppServerThread | undefined)?.id);

			case 'turn/started':
				return this.turnStarted(params.turn as CodexAppServerTurn | undefined);

			case 'item/started':
				return this.itemStarted(params.item as CodexAppServerItem | undefined);

			case 'item/completed':
				return this.itemCompleted(
					params.item as CodexAppServerItem | undefined,
					typeof params.turnId === 'string' ? params.turnId : undefined
				);

			case 'thread/tokenUsage/updated': {
				const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
				const growth = this.recordUsage(
					turnId,
					params.tokenUsage as
						| { total?: CodexAppServerTokenBreakdown; last?: CodexAppServerTokenBreakdown }
						| undefined
				);
				// Live reading for the active turn only: a resumed thread replays the
				// previous turn's update, which is not new spend.
				if (!growth || !turnId || turnId !== this._activeTurnId) return [];
				return [{ type: CODEX_CALL_USAGE_LINE_TYPE, usage: execUsage(growth) }];
			}

			case 'turn/completed':
				return this.turnCompleted(params.turn as CodexAppServerTurn | undefined);

			case 'error':
				return this.errorNotification(
					params.error as CodexAppServerTurnError | undefined,
					params.willRetry === true
				);

			default:
				return [];
		}
	}

	private threadStarted(threadId: string | undefined): CodexExecLine[] {
		if (!threadId) return [];
		this._threadId ??= threadId;
		if (this.threadStartedEmitted) return [];
		this.threadStartedEmitted = true;
		return [{ type: 'thread.started', thread_id: threadId }];
	}

	private turnStarted(turn: CodexAppServerTurn | undefined): CodexExecLine[] {
		if (turn?.id && !this._outcome) this._activeTurnId = turn.id;
		if (this.turnStartedEmitted) return [];
		this.turnStartedEmitted = true;
		return [{ type: 'turn.started' }];
	}

	private itemStarted(item: CodexAppServerItem | undefined): CodexExecLine[] {
		// Exec only reports command starts.
		if (!item || item.type !== 'commandExecution') return [];
		return [
			{
				type: 'item.started',
				item: {
					id: item.id,
					type: 'command_execution',
					command: item.command ?? '',
					status: 'in_progress',
				},
			},
		];
	}

	private itemCompleted(
		item: CodexAppServerItem | undefined,
		turnId: string | undefined
	): CodexExecLine[] {
		if (!item) return [];
		switch (item.type) {
			case 'agentMessage':
				return [
					{
						type: 'item.completed',
						item: {
							id: item.id,
							type: 'agent_message',
							text: item.text ?? '',
							...(item.phase === undefined ? {} : { phase: item.phase }),
						},
					},
				];

			case 'reasoning': {
				const text = reasoningText(item);
				if (!text) return [];
				return [{ type: 'item.completed', item: { id: item.id, type: 'reasoning', text } }];
			}

			case 'commandExecution':
				return [
					{
						type: 'item.completed',
						item: {
							id: item.id,
							type: 'command_execution',
							command: item.command ?? '',
							...(typeof item.aggregatedOutput === 'string'
								? { aggregated_output: item.aggregatedOutput }
								: {}),
							exit_code: item.exitCode ?? null,
							status: execItemStatus(item.status),
						},
					},
				];

			case 'userMessage':
				// Never forwarded: the user already sees what they typed. Steering
				// reads it to tell an absorbed steer from a dropped one.
				if (this._activeTurnId && turnId === this._activeTurnId) {
					const message: CodexAppServerUserMessage = {
						turnId,
						itemId: item.id,
						text: userMessageText(item),
					};
					for (const listener of this.userMessageListeners) listener(message);
				}
				return [];

			default:
				return [];
		}
	}

	/**
	 * Track the thread's running total per turn. The total is NEVER forwarded
	 * as-is: it covers the whole thread, and reporting it per turn is the
	 * quadratic over-count `CodexTokenCounts` exists to stop. This turn's usage
	 * is its latest total minus the total before it started, which its FIRST
	 * update states directly as `total - last`. That does not depend on the
	 * server replaying the previous turn's total on resume; the replayed total
	 * is only the fallback for an update that carries no `last`.
	 *
	 * Updates are keyed by turn id rather than matched against the active turn,
	 * so one that lands before the turn id is known still counts.
	 *
	 * Returns what this update added to the turn: the growth past its previous
	 * update, or for its first update the call it covers (`last`). Null when
	 * that is unknown or nothing grew.
	 */
	private recordUsage(
		turnId: string | undefined,
		tokenUsage:
			| { total?: CodexAppServerTokenBreakdown; last?: CodexAppServerTokenBreakdown }
			| undefined
	): UsageTotals | null {
		const total = readTotals(tokenUsage?.total);
		if (!total) return null;
		const previousTotal = this.latestUsageTotal;
		this.latestUsageTotal = total;
		if (!turnId) return null;
		const entry = this.usageByTurn.get(turnId);
		if (entry) {
			const growth = subtractTotals(total, entry.current);
			entry.current = total;
			return hasTokens(growth) ? growth : null;
		}
		const last = readTotals(tokenUsage?.last);
		this.usageByTurn.set(turnId, {
			baseline: last ? subtractTotals(total, last) : null,
			current: total,
			replayBaseline: previousTotal,
		});
		return last && hasTokens(last) ? last : null;
	}

	private turnUsage(turnId: string | null): Record<string, number> | null {
		const entry = turnId ? this.usageByTurn.get(turnId) : undefined;
		if (!entry) return null;
		const baseline = entry.baseline ?? entry.replayBaseline;
		const turn = {} as UsageTotals;
		for (const [field] of USAGE_FIELDS) {
			turn[field] = Math.max(0, entry.current[field] - (baseline?.[field] ?? 0));
		}
		return execUsage(turn);
	}

	private turnCompleted(turn: CodexAppServerTurn | undefined): CodexExecLine[] {
		if (this._outcome) return [];
		if (turn?.id && this._activeTurnId && turn.id !== this._activeTurnId) return [];
		const turnId = this._activeTurnId ?? turn?.id ?? null;
		this._activeTurnId = null;

		if (turn?.status === 'failed') {
			this._outcome = 'failed';
			return [
				{
					type: 'turn.failed',
					error: { message: turn.error?.message || 'Turn failed' },
				},
			];
		}

		// An interrupted turn still spent real tokens; report them.
		this._outcome = turn?.status === 'interrupted' ? 'interrupted' : 'completed';
		const usage = this.turnUsage(turnId);
		return [{ type: 'turn.completed', ...(usage ? { usage } : {}) }];
	}

	private errorNotification(
		error: CodexAppServerTurnError | undefined,
		willRetry: boolean
	): CodexExecLine[] {
		const message = error?.message || 'Unknown error';
		// The parser's isCodexRetryNotice keys on the `Reconnecting...` prefix and
		// treats it as progress, exactly as it does for exec's retry notices.
		return [{ type: 'error', message: willRetry ? `Reconnecting... ${message}` : message }];
	}
}
