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
 * With hosted agents switched off (`hostingEnabled()`) it folds nothing in, and releases each
 * hosted record once (`releaseHostedSession()`), so it works as its SSH agent.
 */

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
import { hostingEnabled } from './hostedTurns';
import { readMirrorTranscript } from './peerMirror';

/** The mirror's view of the agent a record points at, or undefined when it holds none. */
function hostedInput(session: {
	liftedTo?: unknown;
}):
	| { peerId: string; agentId: string; input: HostedProjectionInput; connected: boolean }
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
		input: {
			agent,
			transcripts: mirror.transcripts[pointer.peer],
			liveTurns: peer.liveTurns,
			queue: peer.queues[agent.id],
		},
	};
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
		releaseHostedAgents();
		return;
	}
	released.clear();
	if (!usePeerMirrorStore.getState().enabled) return;
	const { sessions, activeSessionId } = useSessionStore.getState();
	for (const session of sessions) {
		const hosted = hostedInput(session);
		if (!hosted) continue;
		const next = projectHostedSession(session, hosted.input);
		if (next !== session) {
			updateSessionWith(session.id, (current) =>
				current === session ? next : projectHostedSession(current, hosted.input)
			);
		}
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
