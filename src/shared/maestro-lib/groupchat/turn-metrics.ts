/**
 * @file groupchat/turn-metrics.ts
 * @description Measures one group chat turn: how long it ran, how many tokens
 * it burned, what it cost.
 *
 * Group chat turns never touch the renderer's agent pipeline - they are batch
 * processes spawned and reaped by the host - so none of them reach the
 * per-turn stats row that ordinary AI tabs record. Without this, the only
 * timing a chat can report is the wall clock between its first and last
 * message, which counts every night the room sat idle as work.
 *
 * The lifecycle is one turn wide:
 *
 *   the spawn choke point  -> begin(sessionId)
 *   process 'usage' event  -> recordUsage(sessionId, usage)
 *   history entry written  -> finish(groupChatId, participantName)
 *
 * Tokens accumulate in the shared `turnUsageLedger` keyed by the raw session
 * id, exactly as the renderer does for ordinary turns - `process.onUsage`
 * events are per-turn deltas, so they are summed, never max'd or overwritten.
 *
 * The finish side keys by participant instead, because the history entry knows
 * who answered and not which batch session did it. Participants run in
 * parallel, so a single "current turn" would hand one agent's tokens to
 * whichever finished first.
 *
 * It is a factory because the clock is an input: the desktop feeds it the
 * sleep tracker that `powerMonitor` drives, and a headless host passes an
 * unfed tracker (wall clock).
 */

import type { SleepAwareSpan } from '../../sleepTracking';
import { recordTurnUsage, drainTurnUsage, type TurnUsage } from '../../turnUsageLedger';
import type { UsageStats } from '../../types';
import { parseModeratorSessionId, parseParticipantSessionId } from './session-ids';
import type { GroupChatTurnOwner } from './session-ids';

/**
 * Name the router stamps on moderator history entries. The metrics key has to
 * match it byte for byte or a moderator turn is measured and then never claimed.
 */
export const GROUP_CHAT_MODERATOR_NAME = 'Moderator';

/** What one finished turn contributes to its history entry. */
export interface GroupChatTurnMeasurement {
	elapsedTimeMs?: number;
	tokenCount?: number;
	cost?: number;
}

/**
 * The clock a metrics instance reads. Sleep-aware, not a bare `Date.now()`: a
 * turn running when the machine suspends would otherwise bill the whole night
 * to the agent, and the chat's working time is exactly the number that must
 * not include it.
 */
export interface GroupChatTurnSpans {
	begin(): SleepAwareSpan;
	elapsedMs(span: SleepAwareSpan): number;
}

interface InFlightTurn {
	sessionId: string;
	span: SleepAwareSpan;
}

/**
 * Hard cap on tracked turns. Every entry is normally claimed by the history
 * entry that follows the turn, but a process that dies without producing one
 * (a crash, a timeout, a killed chat) would otherwise leak for the life of the
 * host. Map preserves insertion order, so the oldest entry is the one least
 * likely to still be running.
 */
const MAX_TRACKED_TURNS = 200;

function turnKey(groupChatId: string, participantName: string): string {
	return `${groupChatId}::${participantName}`;
}

function tokensOf(usage: TurnUsage): number {
	// Cache reads count: they are real tokens the provider processed and priced,
	// just cheaply. Matches `totalTokens` in statsGroupRollup.
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

/**
 * Resolve a group chat session id to the participant it belongs to.
 *
 * Returns null for anything that is not a group chat turn, so callers can pass
 * raw session ids without pre-filtering.
 */
export function resolveGroupChatTurnKey(sessionId: string): GroupChatTurnOwner | null {
	const participant = parseParticipantSessionId(sessionId);
	if (participant) return participant;

	const moderatorChatId = parseModeratorSessionId(sessionId);
	if (moderatorChatId) {
		return { groupChatId: moderatorChatId, participantName: GROUP_CHAT_MODERATOR_NAME };
	}

	return null;
}

export function createGroupChatTurnMetrics(options: { spans: GroupChatTurnSpans }) {
	const { spans } = options;
	/** turnKey -> the turn currently running for that participant. */
	const inFlight = new Map<string, InFlightTurn>();

	return {
		/**
		 * Start measuring a turn. Called from the single spawn choke point, so every
		 * turn shape (moderator, participant, synthesis, recovery) is covered without
		 * each site remembering to opt in.
		 */
		begin(sessionId: string): void {
			const key = resolveGroupChatTurnKey(sessionId);
			if (!key) return;

			// A respawn (recovery) replaces the turn in flight for that participant -
			// the abandoned one can no longer produce a history entry to claim it.
			const mapKey = turnKey(key.groupChatId, key.participantName);
			const previous = inFlight.get(mapKey);
			if (previous) drainTurnUsage(previous.sessionId);

			if (inFlight.size >= MAX_TRACKED_TURNS) {
				const oldest = inFlight.keys().next();
				if (!oldest.done) {
					const stale = inFlight.get(oldest.value);
					if (stale) drainTurnUsage(stale.sessionId);
					inFlight.delete(oldest.value);
				}
			}

			inFlight.set(mapKey, { sessionId, span: spans.begin() });
		},

		/**
		 * Fold one usage event into the turn's running total.
		 *
		 * Safe to call for every group chat usage event - a session with no turn in
		 * flight is ignored rather than opening one, so a late event from an abandoned
		 * process cannot resurrect it.
		 */
		recordUsage(sessionId: string, usage: UsageStats): void {
			const key = resolveGroupChatTurnKey(sessionId);
			if (!key) return;

			const turn = inFlight.get(turnKey(key.groupChatId, key.participantName));
			if (!turn || turn.sessionId !== sessionId) return;

			recordTurnUsage(sessionId, usage);
		},

		/**
		 * Close out a participant's turn and report what it cost.
		 *
		 * Fields are omitted rather than zeroed when nothing was measured: a turn that
		 * reported no usage is UNKNOWN, and a zero would make it look free forever.
		 * Returns an empty object when there is no turn in flight, so a caller can
		 * spread it unconditionally.
		 */
		finish(groupChatId: string, participantName: string): GroupChatTurnMeasurement {
			const mapKey = turnKey(groupChatId, participantName);
			const turn = inFlight.get(mapKey);
			if (!turn) return {};
			inFlight.delete(mapKey);

			const measurement: GroupChatTurnMeasurement = { elapsedTimeMs: spans.elapsedMs(turn.span) };

			const usage = drainTurnUsage(turn.sessionId);
			if (usage) {
				const tokens = tokensOf(usage);
				if (tokens > 0) measurement.tokenCount = tokens;
				if (usage.costUsd > 0) measurement.cost = usage.costUsd;
			}

			return measurement;
		},

		/** Number of turns being measured. Test/diagnostic helper. */
		count(): number {
			return inFlight.size;
		},

		/** Reset in-flight turns. Tests only. */
		reset(): void {
			for (const turn of inFlight.values()) drainTurnUsage(turn.sessionId);
			inFlight.clear();
		},
	};
}

export type GroupChatTurnMetrics = ReturnType<typeof createGroupChatTurnMetrics>;
