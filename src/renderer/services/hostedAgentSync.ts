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
 * pill, and the Left Bar draw it as they draw a local run; its controls go to the host.
 *
 * With hosted agents switched off (`hostingEnabled()`) it folds nothing in, and releases each
 * hosted record once (`releaseHostedSession()`), so it works as its SSH agent.
 */

import type { AutoRunBroadcastState } from '../../shared/autoRunBroadcast';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import { liveTurnKey } from '../../shared/maestro-lib/client/live-turn';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import {
	projectHostedSession,
	releaseHostedSession,
	type HostedProjectionInput,
} from '../utils/hostedSession';
import { applyAutoRunMirrorFrame } from '../hooks/batch/useAutoRunStateMirror';
import { followHostedHandoffs } from './crossAgentHandoff';
import { hostingEnabled } from './hostedTurns';
import { readMirrorTranscript } from './peerMirror';

/** The mirror's view of the agent a record points at, or undefined when it holds none. */
function hostedInput(session: { liftedTo?: unknown }):
	| {
			peerId: string;
			agentId: string;
			input: HostedProjectionInput;
			connected: boolean;
			autoRun: AutoRunBroadcastState | null;
	  }
	| undefined {
	const pointer = readLiftedTo(session.liftedTo);
	if (!pointer) return undefined;
	const mirror = usePeerMirrorStore.getState();
	const peer = mirror.peers[pointer.peer];
	const agent = peer?.agents.find((candidate) => candidate.id === pointer.agentId);
	if (!peer || !agent) return undefined;
	return {
		peerId: pointer.peer,
		agentId: agent.id,
		connected: peer.connection === 'connected',
		autoRun: peer.autoRuns?.[agent.id] ?? null,
		input: {
			agent,
			transcripts: mirror.transcripts[pointer.peer],
			liveTurns: peer.liveTurns,
			queue: peer.queues[agent.id],
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
function syncHostedAutoRun(sessionId: string, frame: AutoRunBroadcastState | null): void {
	if (appliedAutoRuns.has(sessionId) && appliedAutoRuns.get(sessionId) === frame) return;
	appliedAutoRuns.set(sessionId, frame);
	applyAutoRunMirrorFrame(sessionId, frame);
}

/** Drop the Auto Run mirror of every record that is no longer hosted. */
function dropStaleAutoRuns(hostedIds: ReadonlySet<string>): void {
	for (const sessionId of [...appliedAutoRuns.keys()]) {
		if (hostedIds.has(sessionId)) continue;
		if (appliedAutoRuns.get(sessionId) !== null) applyAutoRunMirrorFrame(sessionId, null);
		appliedAutoRuns.delete(sessionId);
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
		releaseHostedAgents();
		return;
	}
	released.clear();
	if (!usePeerMirrorStore.getState().enabled) return;
	const { sessions, activeSessionId } = useSessionStore.getState();
	const hostedIds = new Set<string>();
	for (const session of sessions) {
		const hosted = hostedInput(session);
		if (!hosted) continue;
		hostedIds.add(session.id);
		syncHostedAutoRun(session.id, hosted.autoRun);
		// The unread rule reads whether this agent is the one on screen, as a local tab's does.
		const input = { ...hosted.input, viewing: session.id === activeSessionId };
		const next = projectHostedSession(session, input);
		if (next !== session) {
			updateSessionWith(session.id, (current) =>
				current === session ? next : projectHostedSession(current, input)
			);
		}
		// A hand-off armed on a turn the host runs releases when the host's turn ends.
		followHostedHandoffs(next);
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
}

/** Start following. Returns the stop. */
export function startHostedAgentSync(): () => void {
	let scheduled = false;
	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			syncHostedAgents();
		});
	};
	const offMirror = usePeerMirrorStore.subscribe(schedule);
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
		offMirror();
		offSettings();
		offSessions();
	};
}
