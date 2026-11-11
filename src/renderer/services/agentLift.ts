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
import type {
	DesktopSetupHostAnswer,
	DesktopSetupHostOptions,
} from '../../main/federation/setup-host';
import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../shared/federationCommands';
import { useModalStore } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { liftedMirrorTarget, type LiftableAgent } from '../utils/peerMirrorView';
import { flushSessionPersistenceNow } from './sessionPersistenceFlush';

/**
 * Open the Move to Host modal for one agent (Left Bar right-click, command palette). The same
 * modal is Make Federated: when the agent's remote runs no host yet, it offers to set one up first.
 */
export function requestMoveToHost(sessionId: string): void {
	useModalStore.getState().openModal('moveToHost', { sessionId });
}

async function callLift(
	sessionId: string,
	options: { dryRun: boolean; withEnv: boolean }
): Promise<DesktopLiftAnswer> {
	const api = window.maestro?.federation;
	if (!api)
		return { ok: false, code: 'FEDERATION_NOT_RUNNING', error: FEDERATION_NOT_RUNNING_MESSAGE };
	try {
		await flushSessionPersistenceNow();
		return await api.lift(sessionId, options);
	} catch (error) {
		return { ok: false, code: 'LIFT_FAILED', error: ipcErrorMessage(error) };
	}
}

/**
 * Install this app's maestro-cli on an SSH remote (or upgrade it), start the host there, and
 * reload the peer: Make Federated's first step, and the peer menu's Start Host. Main runs the
 * same `setupRemoteHost()` as `maestro-cli remote-host install --start`. A failure is a red toast
 * as well as the answer, so a caller that only fires it still tells the person.
 */
export async function setupRemoteHostFromWindow(
	remoteId: string,
	options: DesktopSetupHostOptions = {},
	{ toastOnError = true }: { toastOnError?: boolean } = {}
): Promise<DesktopSetupHostAnswer> {
	const api = window.maestro?.federation;
	let answer: DesktopSetupHostAnswer;
	if (!api) {
		answer = { ok: false, code: 'FEDERATION_NOT_RUNNING', error: FEDERATION_NOT_RUNNING_MESSAGE };
	} else {
		try {
			answer = await api.setupHost(remoteId, options);
		} catch (error) {
			answer = { ok: false, code: 'SETUP_FAILED', error: ipcErrorMessage(error) };
		}
	}
	if (!answer.ok && toastOnError) {
		notifyToast({ color: 'red', title: 'Could not set up the host', message: answer.error });
	}
	return answer;
}

/** The peer menu's Start Host: set up the host on a peer that is down, with a toast either way. */
export async function startPeerHost(remoteId: string, peerName: string): Promise<boolean> {
	notifyToast({
		color: 'yellow',
		title: `Starting the host on ${peerName}`,
		message: 'Maestro installs or upgrades maestro-cli there first when it needs to.',
	});
	const answer = await setupRemoteHostFromWindow(remoteId);
	if (answer.ok) {
		notifyToast({
			color: answer.reconnectError ? 'yellow' : 'green',
			title: `Host running on ${peerName}`,
			message: answer.reconnectError ?? 'Its agents show in the Left Bar.',
		});
	}
	return answer.ok;
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
