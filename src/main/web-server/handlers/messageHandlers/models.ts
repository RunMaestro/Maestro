/**
 * Model discovery over the WebSocket bridge: `list_agent_models`.
 *
 * The CLI half of the model pickers' list and their Refresh button
 * (`maestro-cli list models <provider> [--refresh]`). It runs the same
 * `discoverAgentModels()` the `agents:getModels` IPC handler does, so a
 * `--refresh` here also pushes the new list to every picker on screen.
 */

import { AGENT_DEFINITIONS } from '../../../agents/definitions';
import { discoverAgentModels } from '../../../agents/model-discovery';
import { getSshRemoteById } from '../../../stores/getters';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export async function handleListAgentModels(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = 'list_agent_models_result';
	try {
		const agentId = typeof message.agentId === 'string' ? message.agentId.trim() : '';
		if (!agentId) {
			throw new Error('A provider id is required (for example: opencode, claude-code, codex).');
		}
		if (!AGENT_DEFINITIONS.some((agent) => agent.id === agentId)) {
			throw new Error(`Unknown provider "${agentId}".`);
		}
		const sshRemoteId =
			typeof message.sshRemoteId === 'string' && message.sshRemoteId.trim()
				? message.sshRemoteId.trim()
				: undefined;

		const models = await discoverAgentModels(
			{
				getAgentDetector: () => ctx.callbacks.getDebugPackageDeps?.()?.getAgentDetector() ?? null,
				getSshRemote: getSshRemoteById,
			},
			{ agentId, forceRefresh: message.refresh === true, sshRemoteId }
		);
		ctx.send(client, {
			type,
			success: true,
			agentId,
			sshRemoteId: sshRemoteId ?? null,
			models,
			requestId: message.requestId,
		});
	} catch (error) {
		ctx.send(client, {
			type,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			requestId: message.requestId,
		});
	}
}
