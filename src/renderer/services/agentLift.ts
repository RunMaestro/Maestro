/**
 * Move to Host (Federation lift, FED-SSH-06): what a window does to lift a local SSH agent onto the
 * `maestro-cli host` on its remote, and to follow a lifted agent's pointer.
 *
 * The lift itself runs in main (`window.maestro.federation.lift` -> `src/main/federation/lift.ts`),
 * through `runLift()`, the function `maestro-cli lift` runs. Main reads the agent from the stored
 * list, so this window flushes its pending writes first: the plan then lists the tabs and queue the
 * person sees. The pointer comes back through this window's own `remote:updateSessionConfig`
 * handler, the one the CLI's lift reaches too.
 */

import type { DesktopLiftAnswer } from '../../main/federation/lift';
import { useModalStore } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { liftedMirrorTarget, type LiftableAgent } from '../utils/peerMirrorView';
import { flushSessionPersistenceNow } from './sessionPersistenceFlush';

/** Open the Move to Host modal for one agent (Left Bar right-click, command palette). */
export function requestMoveToHost(sessionId: string): void {
	useModalStore.getState().openModal('moveToHost', { sessionId });
}

async function callLift(
	sessionId: string,
	options: { dryRun: boolean; withEnv: boolean }
): Promise<DesktopLiftAnswer> {
	const api = window.maestro?.federation;
	if (!api) return { ok: false, code: 'PEER_ENCORE_OFF', error: 'Federation is not available.' };
	try {
		await flushSessionPersistenceNow();
		return await api.lift(sessionId, options);
	} catch (error) {
		return { ok: false, code: 'LIFT_FAILED', error: ipcErrorMessage(error) };
	}
}

/** The plan `maestro-cli lift --dry-run` prints. Nothing moves. */
export function planMoveToHost(sessionId: string, withEnv: boolean): Promise<DesktopLiftAnswer> {
	return callLift(sessionId, { dryRun: true, withEnv });
}

/** Lift the agent. A success is a green toast naming where to send from now on. */
export async function moveAgentToHost(
	sessionId: string,
	withEnv: boolean
): Promise<DesktopLiftAnswer> {
	const answer = await callLift(sessionId, { dryRun: false, withEnv });
	if (answer.ok) {
		for (const notice of answer.result.notices ?? []) {
			notifyToast({ color: 'yellow', title: 'Moved to host', message: notice });
		}
		notifyToast({
			color: 'green',
			title: `Moved "${answer.result.plan.agent.name}" to its host`,
			message: `It runs on peer "${answer.result.plan.peer}" now. Send to ${answer.result.target} from here on.`,
		});
	}
	return answer;
}

/**
 * Show the mirrored agent a lifted agent points at. False (with a toast) when the mirror does not
 * hold it right now: the peer is not connected, or the host removed the agent.
 */
export function openLiftedAgent(agent: Pick<LiftableAgent, 'liftedTo'>): boolean {
	const state = usePeerMirrorStore.getState();
	const target = liftedMirrorTarget(agent, state.peers);
	if (!target) return false;
	if (!target.mirrored) {
		const peer = state.peers[target.peerId];
		notifyToast({
			color: 'red',
			title: `${target.ref} is not available`,
			message: peer
				? `Peer "${target.peerId}" does not show that agent right now (${peer.connection}).`
				: `Peer "${target.peerId}" is not mirrored. Turn Federation on for its SSH remote.`,
		});
		return false;
	}
	state.selectMirroredAgent(target.peerId, target.agentId);
	return true;
}
