/**
 * Re-deriving "this agent is busy" from the processes MAIN still owns.
 *
 * `restoreSession` resets every agent and AI tab to idle on load, because in the
 * Electron app the main process dies with the window and no spawned agent
 * survives a restart. That assumption does not hold for the web-desktop bundle:
 * the browser page is a client of a main process that keeps running, so a page
 * reload (or a reconnect after the browser suspended the tab) throws away the
 * renderer's in-memory busy state while the agent keeps working. The result is
 * an agent drawn with the idle dot, no thinking pill, and no elapsed timer,
 * while its output streams into the transcript - the listeners route by
 * `{agentId}-ai-{tabId}` and never needed the renderer's bookkeeping.
 *
 * Busy state is therefore not something to remember across a reload, it is
 * something to ASK for: the process table in main is the only authority on what
 * is running right now. These helpers turn that table back into session state.
 *
 * The pass is a no-op on a cold Electron start (the process manager is empty),
 * so it costs one IPC round trip and changes nothing there.
 */

import type { Session, SessionState, AITab } from '../types';
import { parseSessionId } from './sessionIdParser';

/**
 * One live AI turn main still owns, resolved back to the agent and tab it
 * belongs to. Forced-parallel turns (`-fp-<n>`) resolve to their originating
 * tab, which is the tab whose indicator should read busy.
 */
export interface LiveAiTurn {
	/** The agent (`Session.id`) the turn belongs to. */
	sessionId: string;
	/** The AI tab the turn was spawned on. */
	tabId: string;
	/** OS pid of the agent process. */
	pid: number;
	/** When main started the process, for the elapsed-time pill. */
	startTime?: number;
}

/**
 * Resolve raw active-process entries into the AI turns they represent.
 *
 * Terminal PTYs and Cue runs are excluded: neither occupies an agent's
 * sequential AI turn, so neither should make its dot go yellow. Anything whose
 * id is not an `{agentId}-ai-{tabId}` shape (batch runs, synopsis runs, bare
 * agent ids) is skipped for the same reason.
 */
export function resolveLiveAiTurns(
	processes: Array<{
		sessionId: string;
		pid: number;
		isTerminal: boolean;
		isCueRun?: boolean;
		startTime?: number;
	}>
): LiveAiTurn[] {
	const turns: LiveAiTurn[] = [];
	for (const process of processes) {
		if (process.isTerminal || process.isCueRun) continue;
		const parsed = parseSessionId(process.sessionId);
		if (parsed.type !== 'ai-tab' || !parsed.tabId) continue;
		turns.push({
			sessionId: parsed.actualSessionId,
			tabId: parsed.tabId,
			pid: process.pid,
			startTime: process.startTime,
		});
	}
	return turns;
}

/** The earliest start time among a set of turns, falling back to `now`. */
function earliestStart(turns: LiveAiTurn[], now: number): number {
	let earliest: number | undefined;
	for (const turn of turns) {
		if (turn.startTime === undefined) continue;
		earliest = earliest === undefined ? turn.startTime : Math.min(earliest, turn.startTime);
	}
	return earliest ?? now;
}

/**
 * Mark the agents and tabs named by `turns` busy again.
 *
 * Only ever moves state in one direction - a session with no live turn is
 * returned untouched rather than forced idle. Reconciling the other way is the
 * exit listener's job, and it already verifies against this same process table
 * before clearing anything; doing it here as well would race a turn spawned
 * between the probe and the store write and cancel its indicator.
 *
 * A turn whose tab is gone (closed before the reload, or pruned by restoration)
 * still marks the AGENT busy. The Left Bar dot is the symptom the user reads
 * first, and an agent that is demonstrably working must not be drawn idle just
 * because the pane it was working in is no longer open.
 *
 * `state === 'error'` is left alone: a limit pause is deliberately restored as
 * a live error so auto-resume re-finds it, and overwriting that with 'busy'
 * would hide the pause the coordinator is waiting on.
 */
export function applyLiveAiTurns(
	sessions: Session[],
	turns: LiveAiTurn[],
	now: number = Date.now()
): Session[] {
	if (turns.length === 0) return sessions;

	const bySession = new Map<string, LiveAiTurn[]>();
	for (const turn of turns) {
		const existing = bySession.get(turn.sessionId);
		if (existing) existing.push(turn);
		else bySession.set(turn.sessionId, [turn]);
	}
	if (bySession.size === 0) return sessions;

	let changed = false;
	const next = sessions.map((session) => {
		const sessionTurns = bySession.get(session.id);
		if (!sessionTurns || session.state === 'error') return session;

		const startTimeByTab = new Map<string, number>();
		for (const turn of sessionTurns) {
			const start = turn.startTime ?? now;
			const known = startTimeByTab.get(turn.tabId);
			startTimeByTab.set(turn.tabId, known === undefined ? start : Math.min(known, start));
		}

		const markTab = (tab: AITab): AITab => {
			const start = startTimeByTab.get(tab.id);
			if (start === undefined || tab.state === 'busy') return tab;
			return { ...tab, state: 'busy', thinkingStartTime: start };
		};

		changed = true;
		return {
			...session,
			state: 'busy' as SessionState,
			busySource: 'ai' as const,
			thinkingStartTime: earliestStart(sessionTurns, now),
			aiPid: sessionTurns[0].pid,
			aiTabs: session.aiTabs.map(markTab),
			...(session.orphanedThinkingTabs && {
				orphanedThinkingTabs: session.orphanedThinkingTabs.map(markTab),
			}),
		};
	});

	return changed ? next : sessions;
}
