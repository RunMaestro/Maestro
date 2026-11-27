/**
 * Keep every hosted agent's Left Bar record in step with its Federation host, so it renders through
 * the same Main Window and Right Bar as any agent (`projectHostedSession()`).
 *
 * It follows the window's peer mirror (`peerMirrorStore`, memory only, fed by `usePeerMirrorBridge`)
 * and the agent list. On a change it folds each hosted agent's host tabs, transcripts, live turns,
 * and queue into the record through `updateSessionWith()`; the projection is idempotent, so its own
 * write settles in one pass. It also reads the transcript of the tab on screen when the mirror has
 * none yet or the host marked it stale (`readMirrorTranscript()`), the same lazy rule the mirror
 * always used: a tab nobody looks at costs no read, and a host that is down is not polled.
 *
 * A run the host drives for the agent (Auto Run) lands in the same `batchRunStates` entry a local
 * run would use, as a mirror (`applyAutoRunMirrorFrame()`), so the Auto Run panel, the progress
 * pill, and the Left Bar draw it as they draw a local run; its controls go to the host. When the
 * host's run ends, the window that owns app-wide effects raises the same "Auto-Run Complete" toast
 * a local run raises (`notifyAutoRunComplete()`). The run's reasoning and tool calls feed the same
 * Thought Stream a local run's do (`feedHostedAutoRunActivity()`), and its steering notes are
 * read back from the host as the run moves on (`refreshHostedSteering()`).
 *
 * With hosted agents switched off (`hostingEnabled()`) it folds nothing in, and releases each
 * hosted record once (`releaseHostedSession()`), so it works as its SSH agent.
 */

import type { AutoRunBroadcastState } from '../../shared/autoRunBroadcast';
import type { QueueExit } from '../../shared/maestro-lib/client/types';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import type { MirrorPush } from '../../shared/maestro-lib/client/peer-mirror';
import type { Session } from '../types';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import {
	captureToolActivity,
	createThoughtCoalescer,
	type ThoughtCoalescer,
} from '../stores/thoughtStreamStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useSshOutageStore } from '../stores/sshOutageStore';
import {
	projectHostedSession,
	releaseHostedSession,
	type HostedProjectionInput,
} from '../utils/hostedSession';
import { applyAutoRunMirrorFrame } from '../hooks/batch/useAutoRunStateMirror';
import { useBatchStore } from '../stores/batchStore';
import { mirroredRunCompleteInfo, notifyAutoRunComplete } from './autoRunCompletion';
import {
	followHostedHandoffs,
	nextHostedHandoffDeadline,
	type HostedTranscriptAccess,
} from './crossAgentHandoff';
import {
	fireHostStartedMentions,
	nextHostStartDeadline,
	pruneHostStartedMentions,
} from './hostedQueuedTurn';
import {
	closingHostTabIds,
	createPendingHostTabs,
	hostingEnabled,
	nextPendingHostTabRetryAt,
	pruneHostedTabBooks,
} from './hostedTurns';
import {
	clearPendingSteeringNotes,
	forgetHostedSteering,
	refreshHostedSteering,
} from './autoRunSteering';
import { useAutoRunSteeringStore } from '../stores/autoRunSteeringStore';
import { readMirrorTranscript } from './peerMirror';
import {
	hostLinkLostError,
	hostedTurnsEndedHere,
	hostedCutsKept,
	noteHostedTurnsCut,
	pruneHostedLinkLoss,
	settleCutHostedTurns,
	cutTurnUndecided,
	type HostLink,
} from './hostedLinkLoss';
import { retryConnectionOutagesNow } from '../stores/retryStore';
import {
	hostedTabsHandingOver,
	hostHandOverClock,
	nextHostHandOverDeadline,
	onHostedTabLineChanged,
	pruneHostHandOvers,
} from '../utils/hostedTabLine';

/** The mirror's view of the agent a record points at, or undefined when it holds none. */
function hostedInput(session: { id: string; liftedTo?: unknown; aiTabs: Session['aiTabs'] }):
	| {
			peerId: string;
			agentId: string;
			input: HostedProjectionInput;
			connected: boolean;
			link: HostLink;
			autoRun: AutoRunBroadcastState | null;
			/** How the host queue items that last left it left, when the host names that. */
			queueExits: readonly QueueExit[] | undefined;
			/** How many whole reads of the host queue the mirror took since its host named exits. */
			queueReads: number;
	  }
	| undefined {
	const pointer = readLiftedTo(session.liftedTo);
	if (!pointer) return undefined;
	const mirror = usePeerMirrorStore.getState();
	const peer = mirror.peers[pointer.peer];
	const agent = peer?.agents.find((candidate) => candidate.id === pointer.agentId);
	if (!peer || !agent) return undefined;
	const now = Date.now();
	return {
		peerId: pointer.peer,
		agentId: agent.id,
		connected: peer.connection === 'connected',
		link: {
			peerId: pointer.peer,
			agentId: agent.id,
			remoteId: peer.remoteId,
			remoteName: peer.name,
			connection: peer.connection,
			agent,
		},
		autoRun: peer.autoRuns?.[agent.id] ?? null,
		queueExits: peer.queueExits?.[agent.id],
		queueReads: peer.queueReads?.[agent.id] ?? 0,
		input: {
			agent,
			transcripts: mirror.transcripts[pointer.peer],
			liveTurns: peer.liveTurns,
			queue: peer.queues[agent.id],
			closing: closingHostTabIds({ peerId: pointer.peer, agentId: agent.id, agent }, session),
			handingOver: hostedTabsHandingOver(session.id),
			now,
			handOverClock: hostHandOverClock(session.id, now),
		},
	};
}

/** The host frame each record's Auto Run mirror was last built from, by record id. */
const appliedAutoRuns = new Map<string, AutoRunBroadcastState | null>();

/**
 * Draw the host's run as this record's run. A frame is applied once (the projection runs on every
 * store change); a record whose host has no run, or that is no longer hosted, drops its mirror.
 * A run this window owns for the record is never touched (`applyAutoRunMirrorFrame()`).
 */
function syncHostedAutoRun(
	sessionId: string,
	sessionName: string,
	frame: AutoRunBroadcastState | null,
	connected: boolean
): void {
	if (appliedAutoRuns.has(sessionId) && appliedAutoRuns.get(sessionId) === frame) return;
	appliedAutoRuns.set(sessionId, frame);
	const before = useBatchStore.getState().batchRunStates[sessionId];
	applyAutoRunMirrorFrame(sessionId, frame);
	// The host ended the run it drove (its last frame is no run). A host that went out of reach
	// says nothing about the run, so it raises nothing.
	const ended =
		before?.mirrored === true &&
		before.isRunning &&
		!frame?.isRunning &&
		useBatchStore.getState().batchRunStates[sessionId] === undefined;
	if (ended && connected && announcesRunEnds) {
		// The peer mirror hands the sync only running frames and `null` (`setAgentAutoRun()`), and a
		// host sends its final counts before that `null`, so the last mirror holds how it ended.
		notifyAutoRunComplete(mirroredRunCompleteInfo(sessionId, sessionName, before));
	}
	if (ended) {
		// The run's end drops the notes no task took, as a local run's end does. The host records a
		// task's reply before its last frame, so a reply still to come is read now.
		clearPendingSteeringNotes(sessionId);
		if (connected && awaitsHostSteering(sessionId)) void refreshHostedSteering(sessionId);
		forgetHostedRun(sessionId);
	} else if (connected && frame?.isRunning) {
		// First seen (a new window, a reload, another client's note), or the run moved to another
		// task: what the host holds may have changed. Read it again.
		const position = runPosition(frame);
		const moved = steeringPositions.get(sessionId) !== position;
		steeringPositions.set(sessionId, position);
		if (moved || awaitsHostSteering(sessionId)) void refreshHostedSteering(sessionId);
	}
}

/** Where each hosted run was when its steering was last read, by record id. */
const steeringPositions = new Map<string, string>();

/** A run's place: a task taking notes or replying moves it. */
function runPosition(frame: AutoRunBroadcastState): string {
	return [
		frame.currentDocumentIndex,
		frame.completedTasksAcrossAllDocs,
		frame.currentTaskIndex,
		frame.goalIteration,
		frame.loopIteration,
	].join(':');
}

/** Whether a hosted record shows a note the host may since have taken, or a reply still to come. */
function awaitsHostSteering(sessionId: string): boolean {
	const { notes, delivered } = useAutoRunSteeringStore.getState();
	return (
		(notes[sessionId]?.length ?? 0) > 0 ||
		(delivered[sessionId] ?? []).some((note) => note.response === undefined)
	);
}

/** Whether this window raises the toast a hosted run's end raises (`startHostedAgentSync()`). */
let announcesRunEnds = false;

/** Drop the Auto Run mirror of every record that is no longer hosted. */
function dropStaleAutoRuns(hostedIds: ReadonlySet<string>): void {
	for (const sessionId of [...appliedAutoRuns.keys()]) {
		if (hostedIds.has(sessionId)) continue;
		if (appliedAutoRuns.get(sessionId) !== null) applyAutoRunMirrorFrame(sessionId, null);
		appliedAutoRuns.delete(sessionId);
		forgetHostedRun(sessionId);
	}
}

/** Drop what the sync and the steering service keep for a hosted run that ended or left. */
function forgetHostedRun(sessionId: string): void {
	steeringPositions.delete(sessionId);
	forgetHostedSteering(sessionId);
}

/** Whether each hosted record's host was connected at the last sync, by record id. */
const hostConnected = new Map<string, boolean>();

/**
 * A hosted record's host connected again: a message kept for it while the link was down goes now,
 * not at the end of its backoff, as an SSH agent's goes when its remote is reachable again
 * (`retryConnectionOutagesNow()`). Called once per sync per record.
 */
function noteHostConnected(sessionId: string, connected: boolean): void {
	const was = hostConnected.get(sessionId);
	hostConnected.set(sessionId, connected);
	// Not known to be up before (disconnected, or not seen since it left the hosted set): the link
	// is back as far as a kept message can tell (CodeRabbit on #2161).
	if (connected && was !== true) {
		retryConnectionOutagesNow(new Set([sessionId]), cutTurnUndecided);
	}
}

/** Records already released since hosted agents were switched off (see `releaseHostedSession()`). */
const released = new Set<string>();

/**
 * Hosted agents are switched off: take what only the host can settle out of each hosted record,
 * once, so it works as its SSH agent. Releasing again later would idle a local SSH turn.
 */
function releaseHostedAgents(): void {
	for (const session of useSessionStore.getState().sessions) {
		if (released.has(session.id) || !readLiftedTo(session.liftedTo)) continue;
		released.add(session.id);
		const next = releaseHostedSession(session);
		if (next !== session) updateSessionWith(session.id, (current) => releaseHostedSession(current));
	}
}

/** Fold the host into every hosted record, and read the shown tab when it needs it. */
export function syncHostedAgents(): void {
	if (!hostingEnabled()) {
		dropStaleAutoRuns(new Set());
		pruneHostStartedMentions(new Set());
		pruneHostedLinkLoss(new Set());
		pruneHostHandOvers(new Set());
		pruneHostedTabBooks(useSessionStore.getState().sessions);
		hostConnected.clear();
		releaseHostedAgents();
		return;
	}
	released.clear();
	const { sessions, activeSessionId } = useSessionStore.getState();
	// A record still points at a host while the mirror reconnects: only a deleted or moved-back
	// agent lets go of the consults it waits to fire.
	pruneHostStartedMentions(
		new Set(sessions.filter((s) => readLiftedTo(s.liftedTo)).map((s) => s.id))
	);
	if (!usePeerMirrorStore.getState().enabled) {
		pruneHostedLinkLoss(new Set());
		pruneHostHandOvers(new Set());
		pruneHostedTabBooks(useSessionStore.getState().sessions);
		hostConnected.clear();
		return;
	}
	const hostedIds = new Set<string>();
	for (const session of sessions) {
		const hosted = hostedInput(session);
		if (!hosted) continue;
		hostedIds.add(session.id);
		syncHostedAutoRun(
			session.id,
			session.name || session.cwd.split('/').pop() || 'Unknown',
			hosted.autoRun,
			hosted.connected
		);
		// A lost link ends the turns the host last reported running, as a cut SSH link does; once
		// the host is back, how each one ended is read from the host.
		const linkLost = hostLinkLostError(session, hosted.link);
		if (linkLost) noteHostedTurnsCut(session, hosted.link, linkLost);
		else if (hosted.connected) settleCutHostedTurns(session.id, hosted.link);
		// A tab opened here while the host was down is made there once the link is back (R15).
		if (hosted.connected) createPendingHostTabs(session);
		// The host is back: a kept message's retry fires now (R18).
		noteHostConnected(session.id, hosted.connected);
		const endedHere = hostedTurnsEndedHere(session.id, hosted.connected);
		const keptCuts = linkLost ? hostedCutsKept(session.id) : undefined;
		// The unread rule reads whether this agent is the one on screen, as a local tab's does.
		const input: HostedProjectionInput = {
			...hosted.input,
			viewing: session.id === activeSessionId,
			...(linkLost ? { linkLost } : {}),
			...(endedHere ? { endedHere } : {}),
			...(keptCuts ? { keptCuts } : {}),
		};
		const next = projectHostedSession(session, input);
		if (next !== session) {
			updateSessionWith(session.id, (current) =>
				current === session ? next : projectHostedSession(current, input)
			);
		}
		// A background tab's saved transcript, read when a turn's own entries are not here yet.
		const slotOf = (tabId: string) =>
			usePeerMirrorStore.getState().transcripts[hosted.peerId]?.[
				liveTurnKey(hosted.agentId, tabId)
			];
		const transcript: HostedTranscriptAccess = {
			// The rule the shown tab's read follows: never while one is out, never again after one
			// failed (the next stale mark or reconnect asks again), so a failing host is not polled.
			read: (tabId) => {
				const slot = slotOf(tabId);
				if (!hosted.connected || slot?.loading || slot?.error) return;
				if (!slot || slot.stale || !slot.loaded) {
					void readMirrorTranscript(hosted.peerId, hosted.agentId, tabId);
				}
			},
			isCurrent: (tabId) => {
				const slot = slotOf(tabId);
				return !!slot?.loaded && !slot.stale && !slot.loading && !slot.error;
			},
		};
		// A consult of a turn the host queued fires as that turn starts.
		fireHostStartedMentions(next, hosted.queueExits, Date.now(), hosted.queueReads, transcript);
		// A hand-off armed on a turn the host runs releases when the host's turn ends, with the
		// answer the host saved.
		followHostedHandoffs(next, transcript, hosted.queueExits, Date.now(), hosted.queueReads);
		if (session.id !== activeSessionId || !hosted.connected) continue;
		const tabId = next.activeTabId;
		if (!hosted.input.agent.aiTabs?.some((tab) => tab.id === tabId)) continue;
		const slot =
			usePeerMirrorStore.getState().transcripts[hosted.peerId]?.[
				liveTurnKey(hosted.agentId, tabId)
			];
		const needsRead = !slot?.loading && (!slot || slot.stale || (!slot.loaded && !slot.error));
		if (needsRead) void readMirrorTranscript(hosted.peerId, hosted.agentId, tabId);
	}
	dropStaleAutoRuns(hostedIds);
	// A deleted agent, one moved back, or one whose peer was removed lets go of its cut turns.
	pruneHostedLinkLoss(hostedIds);
	// ...and of the host-queue hand-overs, whose limits arm the recheck (U6).
	pruneHostHandOvers(hostedIds);
	// ...and of what the pending-tab path keeps for its tabs (R28).
	pruneHostedTabBooks(sessions);
	for (const id of hostConnected.keys()) if (!hostedIds.has(id)) hostConnected.delete(id);
}

/**
 * Start following. Returns the stop. `announcesRunEnds`: this window owns app-wide effects
 * (`useIsLifecycleOwner()`), so it raises a hosted run's end toast, once for the app.
 */
export function startHostedAgentSync(options: { announcesRunEnds?: boolean } = {}): () => void {
	announcesRunEnds = options.announcesRunEnds === true;
	let scheduled = false;
	// A consult or hand-off waiting on a host start runs out of time with no change from the host
	// to run the sync (a quiet host, an idle user): one timer runs it again at the soonest limit.
	let recheck: ReturnType<typeof setTimeout> | undefined;
	const armRecheck = () => {
		if (recheck !== undefined) clearTimeout(recheck);
		recheck = undefined;
		const deadlines = [
			nextHostStartDeadline(),
			nextHostedHandoffDeadline(useSessionStore.getState().sessions),
			// A pending tab whose making failed is asked again when its wait ends (R15).
			nextPendingHostTabRetryAt(useSessionStore.getState().sessions),
			// A host-queue hand-over past its limit reads queued, with no change from the host (U6).
			nextHostHandOverDeadline(),
		].filter((at): at is number => at !== undefined);
		if (deadlines.length === 0) return;
		const delay = Math.max(0, Math.min(...deadlines) - Date.now()) + 1;
		recheck = setTimeout(() => {
			recheck = undefined;
			schedule();
		}, delay);
	};
	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			syncHostedAgents();
			armRecheck();
		});
	};
	const offMirror = usePeerMirrorStore.subscribe(schedule);
	// An outage confirmed or cleared changes how a hosted turn is drawn (`hostLinkLostError()`).
	const offOutages = useSshOutageStore.subscribe((state, prev) => {
		if (state.outages !== prev.outages) schedule();
	});
	// A turn on its way to the host is drawn busy until the host has it (`hostedTabsHandingOver()`).
	const offLines = onHostedTabLineChanged(schedule);
	const offSettings = useSettingsStore.subscribe((state, prev) => {
		if (state.federationHostedAgents !== prev.federationHostedAgents) schedule();
	});
	const offSessions = useSessionStore.subscribe((state, prev) => {
		if (state.sessions !== prev.sessions || state.activeSessionId !== prev.activeSessionId) {
			schedule();
		}
	});
	schedule();
	return () => {
		announcesRunEnds = false;
		if (recheck !== undefined) clearTimeout(recheck);
		recheck = undefined;
		offMirror();
		offLines();
		offOutages();
		offSettings();
		offSessions();
	};
}

/** The longest run process id kept as a Thought Stream key; a host's id past this is cut. */
const MAX_HOSTED_PROCESS_ID_CHARS = 200;

/** A hosted run's reasoning goes through the same coalescer a local run's does. */
let hostedThoughts: ThoughtCoalescer | null = null;

/** The record a host's agent is drawn as, while hosted agents are on. */
function hostedRecordIdOf(peerId: string, agentId: string): string | undefined {
	if (!hostingEnabled()) return undefined;
	return useSessionStore.getState().sessions.find((session) => {
		const pointer = readLiftedTo(session.liftedTo);
		return pointer?.peer === peerId && pointer.agentId === agentId;
	})?.id;
}

/**
 * Feed a hosted run's reasoning and tool calls to this window's Thought Stream, under the record
 * the agent is drawn as, keyed by the run's process the way a local run's are
 * (`useThoughtStreamCaptureListener`, `useThoughtStreamToolListener`). So the panel counts the same
 * thoughts and actions, and lists the same entries, whichever machine runs the task. Returns
 * whether the push was one of these (nothing else is fed here).
 */
export function feedHostedAutoRunActivity(push: MirrorPush): boolean {
	const { event } = push;
	if (event.type !== 'agent.autorunActivity') return false;
	const sessionId = hostedRecordIdOf(push.peerId, event.agentId);
	if (!sessionId) return true;
	const { activity } = event;
	if (typeof activity.processId !== 'string' || !activity.processId) return true;
	const processId = activity.processId.slice(0, MAX_HOSTED_PROCESS_ID_CHARS);
	hostedThoughts ??= createThoughtCoalescer();
	if (activity.kind === 'thinking') {
		if (typeof activity.text === 'string') hostedThoughts.add(sessionId, processId, activity.text);
		return true;
	}
	if (activity.kind !== 'tool' || typeof activity.toolName !== 'string') return true;
	// `captureToolActivity()` lands the reasoning before the call first.
	captureToolActivity(sessionId, processId, {
		toolName: activity.toolName,
		state: activity.state,
		...(typeof activity.toolCallId === 'string' ? { toolCallId: activity.toolCallId } : {}),
		...(typeof activity.at === 'number' ? { timestamp: activity.at } : {}),
	});
	return true;
}

/** Land a hosted run's buffered reasoning and stop its timer (the mirror bridge unmounting). */
export function flushHostedAutoRunActivity(): void {
	hostedThoughts?.dispose();
	hostedThoughts = null;
}
