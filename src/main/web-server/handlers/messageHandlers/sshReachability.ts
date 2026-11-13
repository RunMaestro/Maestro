/**
 * SSH reachability WebSocket message handlers.
 *
 * The CLI side of the SSH outage dialog: `ssh_reachability_status` is its read
 * (which remotes the app currently holds as unreachable) and
 * `ssh_reachability_check` is its "Check Now". Both call the same tracker the
 * dialog does (`src/main/ssh-reachability.ts`), so a check from the CLI also
 * closes an open dialog when the host answers.
 */

import { checkSshRemote, getUnreachableSshRemotes } from '../../../ssh-reachability';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** Handle ssh_reachability_status - list the remotes currently unreachable. */
export function handleSshReachabilityStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	ctx.send(client, {
		type: 'ssh_reachability_status_result',
		success: true,
		unreachable: getUnreachableSshRemotes(),
		requestId: message.requestId,
	});
}

/** Handle ssh_reachability_check - probe one remote now and settle its state. */
export async function handleSshReachabilityCheck(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const remoteId = typeof message.remoteId === 'string' ? message.remoteId : '';
	if (!remoteId) {
		ctx.send(client, {
			type: 'ssh_reachability_check_result',
			success: false,
			error: 'remoteId is required',
			requestId: message.requestId,
		});
		return;
	}
	const reachable = await checkSshRemote(remoteId);
	ctx.send(client, {
		type: 'ssh_reachability_check_result',
		success: true,
		reachable,
		event: getUnreachableSshRemotes().find((e) => e.remoteId === remoteId),
		requestId: message.requestId,
	});
}
