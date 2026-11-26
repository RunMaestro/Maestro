/**
 * Stop a running turn: the one implementation behind every Stop.
 *
 * The desktop Stop pill (`useInterruptHandler`), the REST route
 * (`POST /api/session/:id/interrupt`) and `maestro-cli interrupt` all land in
 * {@link interruptTurn}, so a stop from outside the app ends the same work, in
 * the same order, as a click does.
 *
 * Two scopes:
 * - Agent (no `tabId`): what the Stop pill does. Every busy tab, every live
 *   `{id}-ai-*` process (forced-parallel siblings and a turn the store records
 *   idle included), the agent's consults, retries and compactions, its pending
 *   synopsis, and a terminal-mode command.
 * - Tab: one AI tab (or an orphan still draining). Only that tab's process,
 *   retry, compaction, hand-off and consults; the agent's other tabs run on.
 *
 * Stop acts on AI turns whatever the input mode is. Terminal tabs are shells
 * (`send-terminal --control C`), and a `!` command has its own card Stop.
 */

import { hostedTargetOf, interruptHostedTurn } from './hostedTurns';
import { cutHostedTurnTabs, endHostedTurnsHere, markHostedTurnsStopped } from './hostedLinkLoss';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { TURN_CANCELED_NOTE } from '../../shared/maestro-lib/store/transcript';
import type { AITab, LogEntry, QueuedItem, Session, SessionState } from '../types';
import { useSessionStore, selectSessionById, updateSessionWith } from '../stores/sessionStore';
import { useBatchStore } from '../stores/batchStore';
import { cancelContextCompaction, stopRetriesForAgent } from '../stores/retryStore';
import { dropMentionHandoffs } from './crossAgentHandoff';
import { dropStoppedHostStartMentions } from './hostedQueuedTurn';
import { cancelHostedConsults } from '../hooks/agent/useCrossAgentDispatch';
import { useCrossAgentInFlightStore } from '../stores/crossAgentInFlightStore';
import { generateId } from '../utils/ids';
import {
	getActiveTab,
	getBusyTabs,
	markTabRunningQueuedItem,
	resolveQueuedItemTarget,
	syncAgentStateToTabs,
} from '../utils/tabHelpers';
import { takeNextRunnableQueueItem } from '../utils/executionQueue';
import { parseSessionId } from '../utils/sessionIdParser';
import { logger } from '../utils/logger';
import {
	interruptTurnFailure,
	isTurnProcessInScope,
	type InterruptTurnResult,
} from '../../shared/turnInterrupt';

// ============================================================================
// Hook-owned dependencies
// ============================================================================

/**
 * What a stop needs that only a hook owns. Registered by `useInterruptHandler`,
 * which receives both from App.
 */
export interface TurnInterruptDeps {
	/** Kill the agent's pending `{id}-synopsis-*` processes (ids live in a hook ref). */
	cancelPendingSynopsis: (sessionId: string) => Promise<void>;
	/** Start a queued item now. */
	processQueuedItem: (sessionId: string, item: QueuedItem) => Promise<void>;
	/**
	 * Whether this client drains the agent's queue. A web-desktop client does not:
	 * the owning desktop renderer's exit listener starts the next item, so a Stop
	 * there must leave the queue alone rather than start it a second time.
	 */
	ownsQueue: (sessionId: string) => boolean;
}

let turnInterruptDeps: TurnInterruptDeps | null = null;

/**
 * Wire the hook-owned deps. Null until registered (app still mounting, or a
 * test): a stop then skips the synopsis cancel and the immediate queue drain,
 * and the exit listener drains the queue when the stopped process exits.
 */
export function registerTurnInterruptDeps(deps: TurnInterruptDeps | null): void {
	turnInterruptDeps = deps;
}

// ============================================================================
// Public API
// ============================================================================

export interface InterruptTurnOptions {
	/** One AI tab (or orphan) to stop. Omitted: the whole agent, as the Stop pill does. */
	tabId?: string;
	/**
	 * Desktop only: asked when the signal itself fails. True escalates to a
	 * force kill. Omitted (remote callers), a failed signal is reported back as
	 * `SIGNAL_FAILED` and nothing is settled.
	 */
	confirmForceKill?: () => boolean;
}

/** The question the desktop asks before it force-kills a turn that ignored Stop. */
export const FORCE_KILL_PROMPT =
	'Failed to interrupt the process gracefully. Would you like to force kill it?\n\n' +
	'Warning: This may cause data loss or leave the process in an inconsistent state.';

/**
 * Stop a running turn on an agent, or on one of its tabs.
 *
 * Safe to repeat: a scope with nothing running answers `wasBusy: false` and
 * changes nothing (no log line, no signal).
 *
 * @param sessionId - The agent (`Session.id`)
 * @param options - `tabId` narrows the stop to one tab; see {@link InterruptTurnOptions}
 */
export async function interruptTurn(
	sessionId: string,
	options: InterruptTurnOptions = {}
): Promise<InterruptTurnResult> {
	const tabId = options.tabId ?? null;
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) {
		return interruptTurnFailure(
			sessionId,
			tabId,
			'AGENT_NOT_FOUND',
			`Agent not found: ${sessionId}`
		);
	}

	let scopedTab: AITab | undefined;
	if (tabId !== null) {
		scopedTab =
			session.aiTabs.find((t) => t.id === tabId) ??
			session.orphanedThinkingTabs?.find((t) => t.id === tabId);
		if (!scopedTab) {
			return interruptTurnFailure(sessionId, tabId, 'TAB_NOT_FOUND', `Tab not found: ${tabId}`);
		}
	}
	const scopeTabId = tabId ?? undefined;

	// Ended first and synchronously, before any await, so no retry timer can
	// resend the stopped prompt while the stop is still running: for a hosted
	// agent too, whose message kept while its host was down waits on the same
	// retry. A compaction is part of the turn being stopped: ending it first makes
	// the kill below read as a cancel, not a failed compaction, and releases the
	// prompt it held.
	const recoveriesEnded =
		cancelContextCompaction(sessionId, scopeTabId) + stopRetriesForAgent(sessionId, scopeTabId);

	// A hosted agent's turns run on its Federation host: Stop goes there. A terminal command is
	// this machine's own (it runs over SSH from here), so it keeps the local path below.
	const terminalCommand =
		tabId === null && session.state === 'busy' && session.busySource === 'terminal';
	if (hostedTargetOf(session) && !terminalCommand) {
		const hostBusy = scopedTab
			? scopedTab.state === 'busy'
				? [scopedTab.id]
				: []
			: getBusyTabs(session).map((t) => t.id);
		// An Auto Run task's turn runs on no tab, on the host as it would here: its run is the
		// sign that the agent has a turn to stop.
		const hostRunsAutoRun =
			!scopedTab && useBatchStore.getState().batchRunStates[sessionId]?.isRunning === true;
		const forward = hostBusy.length > 0 || hostRunsAutoRun;
		// The agent's `@mentions` run here, as a local agent's do: Stop ends them and the hand-off
		// armed for the turn, the same as below. The hand-off goes first, before any await, so a
		// host update that lands meanwhile cannot release it.
		dropMentionHandoffs(sessionId, scopeTabId);
		// A consult of the stopped turn whose start the host has not confirmed yet goes with it.
		dropStoppedHostStartMentions(sessionId, scopeTabId);
		const peer = usePeerMirrorStore.getState().peers[hostedTargetOf(session)?.peerId ?? ''];
		// A turn the lost link cut is drawn idle here while the host may still run it, or may not
		// have: Stop ends it too, so it is never sent again when the host is back.
		const cutTabs = cutHostedTurnTabs(sessionId, scopeTabId);
		const stopHere = [...new Set([...hostBusy, ...cutTabs])];
		const hostNotTold = !!peer && peer.connection !== 'connected' && stopHere.length > 0;
		if (hostNotTold) {
			// The host cannot be told: the turn ends here, as a local Stop ends it, and says so.
			endHostedTurnsHere(sessionId, stopHere, peer.name);
		} else {
			markHostedTurnsStopped(sessionId, cutTabs, peer?.name ?? '');
			if (forward) await interruptHostedTurn(session, scopeTabId);
		}
		const consults = await cancelConsults(sessionId, scopeTabId);
		const consultsCanceled = consults.canceled;
		// The host writes no note where it did not stop a turn, so those tabs get the one a local
		// Stop writes, through the same settle: every tab Stop ended here because the host could not
		// be told (CodeRabbit on #2154), and each tab whose consult ended here when the host did not
		// stop its turn (a mention with no turn yet, or one held for its reply). A tab the host
		// stopped ends on the host's own.
		const noteTabIds = new Set(hostNotTold ? stopHere : []);
		if (consultsCanceled > 0) {
			const consultTabs = canceledNoteTabIds(session, scopedTab?.id, consults.tabIds, false);
			for (const noteTabId of consultTabs) {
				if (hostNotTold || !stopHere.includes(noteTabId)) noteTabIds.add(noteTabId);
			}
		}
		if (noteTabIds.size > 0) {
			settleStoppedTabs(sessionId, noteTabIds, systemLog(TURN_CANCELED_NOTE));
		}
		const wasBusy = forward || stopHere.length > 0 || recoveriesEnded > 0 || consultsCanceled > 0;
		return {
			success: true,
			sessionId,
			tabId,
			wasBusy,
			interrupted: wasBusy,
			stoppedTabIds: stopHere,
			exited: false,
		};
	}

	// A hand-off armed for the turn must not fire when it stops: Stop means stop.
	dropMentionHandoffs(sessionId, scopeTabId);

	// A `@mention` fans the turn out to one `cross-agent-*` process per target,
	// none carrying this agent's id, so only main's consult registry reaches
	// them. Left running they stream answers into a conversation already stopped.
	const consults = await cancelConsults(sessionId, scopeTabId);
	const consultsCanceled = consults.canceled;

	const busyTabIds = scopedTab
		? scopedTab.state === 'busy'
			? [scopedTab.id]
			: []
		: getBusyTabs(session, { includeOrphans: true }).map((t) => t.id);
	const primaryTabId = scopedTab?.id ?? getActiveTab(session)?.id ?? 'default';
	const { targets, liveTabIds, liveTurns } = await collectInterruptTargets(
		sessionId,
		tabId,
		primaryTabId,
		busyTabIds
	);
	const runningTerminalCommand =
		tabId === null && session.state === 'busy' && session.busySource === 'terminal';

	const wasBusy =
		busyTabIds.length > 0 ||
		liveTabIds.length > 0 ||
		// A live turn on no tab: an Auto Run task's `-batch-` process.
		liveTurns > 0 ||
		recoveriesEnded > 0 ||
		consultsCanceled > 0 ||
		runningTerminalCommand;
	if (!wasBusy) {
		return {
			success: true,
			sessionId,
			tabId,
			wasBusy: false,
			interrupted: false,
			stoppedTabIds: [],
			exited: false,
		};
	}
	const stoppedTabIds = [...new Set([...busyTabIds, ...liveTabIds])];
	const done = (interrupted: boolean): InterruptTurnResult => ({
		success: true,
		sessionId,
		tabId,
		wasBusy: true,
		interrupted,
		stoppedTabIds,
		exited: false,
	});

	let interrupted = false;
	if (tabId === null) {
		// A synopsis is the stopped turn's History write; its ids carry no tab, so
		// only an agent-level stop ends it. Non-critical.
		try {
			await turnInterruptDeps?.cancelPendingSynopsis(sessionId);
		} catch (synopsisErr) {
			logger.warn('[turnInterrupt] Failed to cancel pending synopsis:', undefined, synopsisErr);
		}
		// A terminal-mode command runs under the bare agent id, outside the turn
		// process table. Its own exit listener settles the agent.
		if (runningTerminalCommand) {
			try {
				interrupted = (await window.maestro.process.cancelCommand(sessionId)) || interrupted;
			} catch (commandErr) {
				logger.warn('[turnInterrupt] Failed to cancel terminal command:', undefined, commandErr);
			}
		}
	}

	const endedTurn = stoppedTabIds.length > 0 || recoveriesEnded > 0;
	const aiInScope = endedTurn || consultsCanceled > 0;
	const settle = (note: LogEntry, startQueued: boolean) => {
		if (!aiInScope) return;
		if (scopedTab) settleStoppedTabs(sessionId, [scopedTab.id], note);
		else settleStoppedAgent(sessionId, note, startQueued, consults.tabIds, endedTurn);
	};

	const results = await Promise.allSettled(
		targets.map((id) => window.maestro.process.interrupt(id))
	);
	if (results[0].status === 'fulfilled') {
		interrupted = interrupted || results.some((r) => r.status === 'fulfilled' && r.value === true);
		settle(systemLog(TURN_CANCELED_NOTE), true);
		return done(interrupted);
	}

	// Only the primary (the active or named tab) failing is a failure. Secondary
	// targets (other busy tabs, forced-parallel siblings) are best effort.
	const signalError = results[0].reason;
	logger.error('Failed to interrupt process:', undefined, signalError);
	if (!options.confirmForceKill?.()) {
		return {
			...interruptTurnFailure(sessionId, tabId, 'SIGNAL_FAILED', errorMessage(signalError)),
			wasBusy: true,
			interrupted,
		};
	}

	try {
		const killResults = await Promise.allSettled(
			targets.map((id) => window.maestro.process.kill(id))
		);
		if (killResults[0].status === 'rejected') throw killResults[0].reason;
		settle(systemLog('Process forcefully terminated'), true);
		return done(true);
	} catch (killError: unknown) {
		logger.error('Failed to kill process:', undefined, killError);
		const message = errorMessage(killError);
		settle(systemLog(`Error: Failed to terminate process - ${message}`), false);
		return {
			...interruptTurnFailure(sessionId, tabId, 'SIGNAL_FAILED', message),
			wasBusy: true,
			interrupted,
			stoppedTabIds,
		};
	}
}

// ============================================================================
// Target resolution
// ============================================================================

/**
 * Every process id this stop must signal, primary first, plus the tabs that
 * own a live one.
 *
 * Agent scope reads main's process table for every `{id}-ai-*` turn, not only
 * the tabs the store records busy: forced-parallel spawns append `-fp-<n>` to
 * their tab's id and cannot be derived, and a turn whose tab the store already
 * settled (issue #1448) has no other handle. Tab scope reads it for that tab's
 * `-fp-` siblings. A failed read still signals what can be named.
 */
/**
 * End the `@mention` consults this machine runs for the agent's tab (or every tab): the
 * `cross-agent-*` processes main holds, and the waits on consults of hosted agents. Answers how
 * many it ended, and the asking tabs of those it saw running (read before the cancel clears them;
 * a consult whose send has not resolved yet is counted but has no tab here).
 */
async function cancelConsults(
	sessionId: string,
	scopeTabId: string | undefined
): Promise<{ canceled: number; tabIds: ReadonlySet<string> }> {
	const tabIds = new Set(
		Object.values(useCrossAgentInFlightStore.getState().requests)
			.filter(
				(request) =>
					request.sourceSessionId === sessionId &&
					(!scopeTabId || request.sourceTabId === scopeTabId)
			)
			.map((request) => request.sourceTabId)
	);
	let canceled = 0;
	try {
		({ canceled } = await window.maestro.crossAgent.cancel(sessionId, scopeTabId));
	} catch (crossAgentErr) {
		logger.warn('[turnInterrupt] Failed to cancel cross-agent consults:', undefined, crossAgentErr);
	}
	// A consult of a hosted agent runs on its host, so no process here holds it: end the wait.
	return { canceled: canceled + cancelHostedConsults(sessionId, scopeTabId), tabIds };
}

/**
 * Where Stop's "Canceled by user" line goes, in every mode: the stopped tab; for the whole agent,
 * each tab whose consult Stop ended, and the active tab when Stop ended a turn there (`endedTurn`)
 * or a consult whose tab is not known. Only tabs the agent has.
 */
function canceledNoteTabIds(
	session: Session,
	scopedTabId: string | undefined,
	consultTabIds: ReadonlySet<string>,
	endedTurn: boolean
): Set<string> {
	if (scopedTabId) return new Set([scopedTabId]);
	const tabs = new Set([...consultTabIds].filter((id) => session.aiTabs.some((t) => t.id === id)));
	const activeTabId = getActiveTab(session)?.id;
	if (activeTabId && (endedTurn || tabs.size === 0)) tabs.add(activeTabId);
	return tabs;
}

async function collectInterruptTargets(
	sessionId: string,
	tabId: string | null,
	primaryTabId: string,
	busyTabIds: string[]
): Promise<{ targets: string[]; liveTabIds: string[]; liveTurns: number }> {
	const targets = [`${sessionId}-ai-${primaryTabId}`];
	for (const busyTabId of busyTabIds) {
		const id = `${sessionId}-ai-${busyTabId}`;
		if (!targets.includes(id)) targets.push(id);
	}

	const liveTabIds = new Set<string>();
	let liveTurns = 0;
	try {
		const active = await window.maestro.process.getActiveProcesses({
			includeChildProcesses: false,
		});
		for (const proc of active) {
			if (proc.isTerminal || !isTurnProcessInScope(proc.sessionId, sessionId, tabId)) continue;
			liveTurns++;
			if (!targets.includes(proc.sessionId)) targets.push(proc.sessionId);
			const parsed = parseSessionId(proc.sessionId);
			if (parsed.tabId) liveTabIds.add(parsed.tabId);
		}
	} catch (lookupErr) {
		logger.warn('[turnInterrupt] Could not list live turn processes:', undefined, lookupErr);
	}

	return { targets, liveTabIds: [...liveTabIds], liveTurns };
}

// ============================================================================
// Settling the store
// ============================================================================

function systemLog(text: string): LogEntry {
	return { id: generateId(), timestamp: Date.now(), source: 'system', text };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A stopped tab: idle, with its thinking and tool rows stripped. */
function idleStoppedTab(tab: AITab, note?: LogEntry): AITab {
	const logs = tab.logs.filter((log) => log.source !== 'thinking' && log.source !== 'tool');
	return {
		...tab,
		state: 'idle',
		thinkingStartTime: undefined,
		logs: note ? [...logs, note] : logs,
	};
}

/**
 * Tabs Stop ended (one for a tab stop; a hosted agent's tabs whose turn or consult ended here):
 * idle each, with `note`, and recompute the agent from what is still running. The queue is left
 * to the exit listener and the idle drain, exactly as when a turn ends on its own. An orphan is
 * only signalled: the exit listener retires it.
 */
function settleStoppedTabs(sessionId: string, tabIds: Iterable<string>, note: LogEntry): void {
	const ids = new Set(tabIds);
	updateSessionWith(sessionId, (s) => {
		if (!s.aiTabs.some((t) => ids.has(t.id))) return s;
		return syncAgentStateToTabs({
			...s,
			aiTabs: s.aiTabs.map((t) => (ids.has(t.id) ? idleStoppedTab(t, note) : t)),
		});
	});
}

/**
 * The whole agent stopped. When a runnable queued item waits, its tab is
 * marked running and the item is dispatched; every other busy tab, and each
 * tab whose consult Stop ended, goes idle with `note`. Otherwise the active
 * tab, every busy tab and the consults' tabs go idle, with `note` where
 * `canceledNoteTabIds()` puts it.
 *
 * The dispatch RACES the stopped process: the signal has only been sent, so
 * the child usually still owns its process key and the spawn is refused.
 * agentStore puts the item back runnable, and the exit listener drains it once
 * the child is gone, so the prompt is never lost. With no dispatcher
 * registered the queue is not touched at all, so nothing is taken out of it
 * that nobody would send; the exit listener drains it instead.
 */
function settleStoppedAgent(
	sessionId: string,
	note: LogEntry,
	startQueued: boolean,
	/** The tabs whose consults Stop ended: each gets `note`. */
	consultTabIds: ReadonlySet<string>,
	/** Stop ended a turn (not only consults): the active tab gets `note` too. */
	endedTurn: boolean
): void {
	const dispatch =
		startQueued && turnInterruptDeps?.ownsQueue(sessionId)
			? turnInterruptDeps.processQueuedItem
			: undefined;
	let startedItem: QueuedItem | undefined;
	updateSessionWith(sessionId, (s): Session => {
		const { item: nextItem, remaining: remainingQueue } = dispatch
			? takeNextRunnableQueueItem(s.executionQueue)
			: { item: undefined, remaining: s.executionQueue };
		if (nextItem) {
			startedItem = nextItem;
			const busyFields = {
				state: 'busy' as SessionState,
				busySource: 'ai' as const,
				executionQueue: remainingQueue,
				thinkingStartTime: Date.now(),
				currentCycleTokens: 0,
				currentCycleBytes: 0,
			};
			const target = resolveQueuedItemTarget(s, nextItem);
			if (!target) return { ...s, ...busyFields };

			// When the target is an orphan (closed while the message was queued),
			// busy state and the user log go THERE, never onto the active tab.
			const updatedOrphans =
				target.location === 'orphan' && s.orphanedThinkingTabs
					? s.orphanedThinkingTabs.map((tab) =>
							tab.id === target.tabId ? markTabRunningQueuedItem(tab, nextItem, s) : tab
						)
					: s.orphanedThinkingTabs;
			return {
				...s,
				...busyFields,
				aiTabs: s.aiTabs.map((tab) => {
					if (tab.id === target.tabId) return markTabRunningQueuedItem(tab, nextItem, s);
					return tab.state === 'busy' || consultTabIds.has(tab.id)
						? idleStoppedTab(tab, note)
						: tab;
				}),
				...(updatedOrphans !== s.orphanedThinkingTabs && {
					orphanedThinkingTabs: updatedOrphans,
				}),
			};
		}

		const activeTabId = getActiveTab(s)?.id;
		const noteTabIds = canceledNoteTabIds(s, undefined, consultTabIds, endedTurn);
		return {
			...s,
			state: 'idle',
			busySource: undefined,
			thinkingStartTime: undefined,
			aiTabs: s.aiTabs.map((tab) =>
				tab.id === activeTabId || tab.state === 'busy' || noteTabIds.has(tab.id)
					? idleStoppedTab(tab, noteTabIds.has(tab.id) ? note : undefined)
					: tab
			),
		};
	});

	if (startedItem && dispatch) {
		const item = startedItem;
		setTimeout(() => {
			dispatch(sessionId, item).catch((err) =>
				logger.error(
					'[turnInterrupt] Queued dispatch after Stop failed, item returned to queue',
					undefined,
					err
				)
			);
		}, 0);
	}
}
