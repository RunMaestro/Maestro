/**
 * Move to Host (Federation lift, FED-SSH-06): what a window does to lift a local SSH agent onto the
 * `maestro-cli host` on its remote, and to follow a lifted agent's pointer.
 *
 * The lift itself runs in main (`window.maestro.federation.lift` -> `src/main/federation/lift.ts`),
 * through `runLift()`, the function `maestro-cli lift` runs. Main reads the agent from the stored
 * list, so this window flushes its pending writes first: the plan then lists the tabs and queue the
 * person sees. The pointer comes back through this window's own `remote:updateSessionConfig`
 * handler, the one the CLI's lift reaches too.
 *
 * Move Back from Host is the reverse (`window.maestro.federation.unlift`, `runReturnFromHost()`,
 * the function `maestro-cli unlift` runs): the agent becomes an SSH agent again, with the host's
 * tabs merged in, and automatic moves leave it here.
 */

import type { DesktopLiftAnswer, DesktopReturnAnswer } from '../../main/federation/lift';
import type {
	DesktopSetupHostAnswer,
	DesktopSetupHostOptions,
} from '../../main/federation/setup-host';
import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../shared/federationCommands';
import { getModalActions, useModalStore } from '../stores/modalStore';
import { notifyToast } from '../stores/notificationStore';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { flushSessionPersistenceNow } from './sessionPersistenceFlush';

/**
 * Open the Move to Host modal for one agent (Left Bar right-click, command palette). The same
 * modal sets a host up first when the agent's remote runs none yet.
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
 * reload the peer: Move to Host's setup step, and the peer menu's Start Host. Main runs the
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

async function callUnlift(
	sessionId: string,
	options: { offline: boolean }
): Promise<DesktopReturnAnswer> {
	const api = window.maestro?.federation;
	if (!api?.unlift)
		return { ok: false, code: 'FEDERATION_NOT_RUNNING', error: FEDERATION_NOT_RUNNING_MESSAGE };
	try {
		await flushSessionPersistenceNow();
		return await api.unlift(sessionId, options);
	} catch (error) {
		return { ok: false, code: 'RETURN_FAILED', error: ipcErrorMessage(error) };
	}
}

/** Toast the outcome of a Move Back. */
function reportUnlift(answer: DesktopReturnAnswer): void {
	if (!answer.ok) {
		notifyToast({ color: 'red', title: 'Not moved back', message: answer.error });
		return;
	}
	for (const notice of answer.result.notices ?? []) {
		notifyToast({ color: 'yellow', title: 'Moved back from host', message: notice });
	}
	const { result } = answer;
	notifyToast({
		color: 'green',
		title: `"${result.agent.name}" is an SSH agent again`,
		message:
			result.tabs > 0
				? `${result.tabs} tab(s) came back from ${result.from}${result.newTabs > 0 ? `, ${result.newTabs} of them new` : ''}. Automatic moves leave it here.`
				: 'Automatic moves leave it here.',
	});
}

/**
 * Move Back from Host (Left Bar right-click, command palette): confirm, then make the hosted
 * agent an SSH agent again. When its host cannot be reached, a second confirm offers to move it
 * back with only this machine's copy.
 */
export function requestMoveBackFromHost(
	sessionId: string,
	agentName: string,
	peerName: string
): void {
	const { showConfirmation } = getModalActions();
	showConfirmation(
		`Move "${agentName}" back from ${peerName}? It becomes an SSH agent again: its conversations on ${peerName} come back as tabs here, its copy on ${peerName} is removed, and automatic moves leave it here.`,
		() => {
			void (async () => {
				const answer = await callUnlift(sessionId, { offline: false });
				if (!answer.ok && answer.code === 'PEER_NOT_CONNECTED') {
					showConfirmation(
						`${peerName} cannot be reached. Move "${agentName}" back anyway, with only this machine's copy? Conversations started on ${peerName} after the move stay there, and its copy there is not removed.`,
						() => {
							void callUnlift(sessionId, { offline: true }).then(reportUnlift);
						}
					);
					return;
				}
				reportUnlift(answer);
			})();
		}
	);
}
