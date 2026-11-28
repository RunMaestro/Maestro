/**
 * Federation WebSocket handler: `federation_command`, the CLI half of the desktop's peer mirror
 * (`maestro-cli federation peers|reconnect|agents|add|...`, FED-SSH-05).
 *
 * Routed to the ONE `PeerMirrorService` the `federation:*` IPC handlers and the Left Bar read, so
 * `peers` prints what the desktop shows and `reconnect` runs the same reload as the Left Bar's
 * Reconnect. Before boot starts the service there is none, and every action is refused with
 * `FEDERATION_NOT_RUNNING_MESSAGE`.
 *
 * CLI ONLY: the socket must have presented this boot's CLI secret (`client.cli`). `reconnect` dials
 * SSH, and every `federation:` IPC channel is already kept off the web-desktop bridge.
 */

import { logger } from '../../../utils/logger';
import {
	autoFederationSnapshot,
	getPeerMirrorService,
	runAutoFederationNow,
} from '../../../federation';
import { requestFederationWindow } from '../../../federation/federation-window';
import { findMirrorPeer } from '../../../../shared/maestro-lib/client/peer-mirror';
import {
	FEDERATION_COMMAND_ACTIONS,
	FEDERATION_COMMAND_RESULT,
	FEDERATION_NOT_RUNNING_MESSAGE,
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

	logger.info(`[Web] federation_command: ${action}`, LOG_CONTEXT);

	try {
		// Automatic Federation answers whether or not it runs: while hosted agents are off, the
		// idle snapshot, exactly as the desktop's Settings shows it. Nothing dials.
		if (action === 'auto-status' || action === 'auto-run') {
			reply({
				success: true,
				auto: action === 'auto-run' ? await runAutoFederationNow() : autoFederationSnapshot(),
			});
			return;
		}

		const service = getPeerMirrorService();
		if (!service) {
			reply({ success: false, error: FEDERATION_NOT_RUNNING_MESSAGE });
			return;
		}

		if (action === 'peers') {
			reply({ success: true, peers: service.peers() });
			return;
		}
		if (action === 'conflicts') {
			reply(await requestFederationWindow({ action: 'list' }));
			return;
		}
		if (action === 'resolve-conflict') {
			const { agent, field, take, value } = message as Record<string, unknown>;
			if (typeof agent !== 'string' || !agent.trim()) {
				reply({ success: false, error: 'Name the hosted agent (peer:agent)' });
				return;
			}
			if (typeof field !== 'string' || !field.trim()) {
				reply({ success: false, error: 'Name the field to settle' });
				return;
			}
			if (take !== 'host' && take !== 'local' && take !== 'value') {
				reply({ success: false, error: 'Say which value to take: host, local, or value' });
				return;
			}
			if (take === 'value' && typeof value !== 'string') {
				reply({ success: false, error: 'A merged value needs the text to use' });
				return;
			}
			reply(
				await requestFederationWindow({
					action: 'resolve',
					agent,
					field,
					resolution:
						take === 'value'
							? { take: 'value', value: (value as string).trim() || undefined }
							: { take },
				})
			);
			return;
		}
		if (action === 'hosted-agents') {
			reply(await requestFederationWindow({ action: 'hosted-agents' }));
			return;
		}
		if (action === 'add-agent') {
			const { agent, group, background } = message as Record<string, unknown>;
			if (typeof agent !== 'string' || !agent.trim()) {
				reply({ success: false, error: 'Name the host agent to add (peer:agent)' });
				return;
			}
			reply(
				await requestFederationWindow({
					action: 'add-agent',
					agent: agent.trim(),
					...(typeof group === 'string' && group.trim() ? { group: group.trim() } : {}),
					...(background === true ? { background: true } : {}),
				})
			);
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
