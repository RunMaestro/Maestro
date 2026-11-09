/**
 * Federation WebSocket handler: `federation_command`, the CLI half of the desktop's peer mirror
 * (`maestro-cli federation peers|reconnect`, FED-SSH-05).
 *
 * Routed to the ONE `PeerMirrorService` the `federation:*` IPC handlers and the Left Bar read, so
 * `peers` prints what the desktop shows and `reconnect` runs the same reload as the Left Bar's
 * Reconnect. While the Federation Encore Feature is off there is no service and every action is
 * refused with the feature's own message.
 *
 * CLI ONLY: the socket must have presented this boot's CLI secret (`client.cli`). `reconnect` dials
 * SSH, and every `federation:` IPC channel is already kept off the web-desktop bridge.
 */

import { logger } from '../../../utils/logger';
import { getPeerMirrorService } from '../../../federation';
import { encoreDisabledMessage } from '../../../../shared/encoreFeatureDefaults';
import { findMirrorPeer } from '../../../../shared/maestro-lib/client/peer-mirror';
import {
	FEDERATION_COMMAND_ACTIONS,
	FEDERATION_COMMAND_RESULT,
	type FederationCommandAction,
	type FederationCommandResult,
} from '../../../../shared/federationCommands';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const ACTIONS: ReadonlySet<string> = new Set<FederationCommandAction>(FEDERATION_COMMAND_ACTIONS);

export async function handleFederationCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: FederationCommandResult) => {
		ctx.send(client, { type: FEDERATION_COMMAND_RESULT, ...payload, requestId: message.requestId });
	};

	if (!client.cli) {
		logger.warn(`[Web] Refused federation_command from non-CLI client ${client.id}`, LOG_CONTEXT);
		reply({ success: false, error: 'Federation is not available over the web interface' });
		return;
	}

	const action = message.action;
	if (typeof action !== 'string' || !ACTIONS.has(action)) {
		reply({ success: false, error: `Unknown federation action: ${String(action)}` });
		return;
	}

	const service = getPeerMirrorService();
	if (!service) {
		reply({ success: false, error: encoreDisabledMessage('federation') });
		return;
	}

	logger.info(`[Web] federation_command: ${action}`, LOG_CONTEXT);

	try {
		if (action === 'peers') {
			reply({ success: true, peers: service.peers() });
			return;
		}
		const ref = message.peer;
		if (typeof ref !== 'string' || !ref.trim()) {
			reply({ success: false, error: 'Name the peer to reconnect' });
			return;
		}
		const match = findMirrorPeer(service.peers(), ref);
		if (!match.ok) {
			reply({ success: false, error: match.error });
			return;
		}
		const result = await service.reconnect(match.peer.peerId);
		reply({
			success: result.ok,
			...(result.error ? { error: result.error } : {}),
			...(result.peer ? { peer: result.peer } : {}),
		});
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
