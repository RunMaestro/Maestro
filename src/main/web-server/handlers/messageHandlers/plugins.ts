import { WebSocket } from 'ws';
import { PluginAuthorityError } from '../../../plugins/plugin-authority';
/**
 * Plugins domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: plugins_list_tools, plugins_call_tool.
 */

import { logger } from '../../../utils/logger';
import {
	getActivePluginManager,
	isPluginsFeatureEnabled,
	getHeadlessAgentRunner,
} from '../../../plugins/plugin-manager-singleton';
import {
	RELAY_PLUGIN_ID,
	RELAY_REPLY_TOOL_ID,
	isRelayConversationIdentity,
} from '../../../../shared/plugins/relay-identity';
import { evaluatePluginDispatch } from '../../../../shared/plugins/plugin-dispatch-gate';
import { relayMailReadOperation } from '../../../plugins/relay-mail/contract';
import { pluginToolRunIdentity } from '../../../plugins/plugin-tool-run-identity';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle plugins_list_tools - project the registered plugin `tools`
 * contributions into MCP tool defs for the `maestro-cli mcp serve` bridge.
 * Returns an MCP-safe `name` (namespaced id, `/`->`__`) plus the real
 * `toolId` so the bridge can reverse-map on call. Empty when the plugins flag
 * is off or no manager is wired.
 */
export function handlePluginsListTools(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const manager = getActivePluginManager();
	let tools: Array<{
		name: string;
		toolId: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}> = [];
	if (manager && isPluginsFeatureEnabled()) {
		try {
			tools = manager.getContributions().tools.map((t) => ({
				name: t.id.replace(/\//g, '__').replace(/[^a-zA-Z0-9_-]/g, '_'),
				toolId: t.id,
				description: t.description,
				inputSchema:
					t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
						? t.inputSchema
						: { type: 'object' },
			}));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn(`[Web] plugins_list_tools failed: ${reason}`, LOG_CONTEXT);
		}
	}
	ctx.send(client, {
		type: 'plugins_list_tools_result',
		success: true,
		tools,
		requestId: message.requestId,
	});
}

/** Only a locally stored agent can receive a run proof. The local CLI is a
 * trusted same-user client; the proof is never inferred from --tab. */
export async function handlePluginsSendAgent(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const respond = (extra: Record<string, unknown>): void =>
		ctx.send(client, {
			type: 'plugins_send_agent_result',
			requestId: message.requestId,
			...extra,
		});
	// A tunnel/reverse proxy can make a remote browser appear to arrive over
	// loopback. Only the CLI secret verified on WebSocket upgrade identifies the
	// CLI; address is an additional restriction, never the credential.
	const remoteAddress = (client.socket as unknown as { _socket?: { remoteAddress?: string } })
		._socket?.remoteAddress;
	if (
		client.cliAuthenticated !== true ||
		(remoteAddress !== '127.0.0.1' &&
			remoteAddress !== '::1' &&
			remoteAddress !== '::ffff:127.0.0.1')
	) {
		respond({ available: false, error: 'Local CLI connection required' });
		return;
	}
	const run = getHeadlessAgentRunner();
	const manager = getActivePluginManager();
	if (
		!isPluginsFeatureEnabled() ||
		!manager ||
		manager.getContributions().tools.length === 0 ||
		!run
	) {
		respond({ available: false, error: 'Plugin headless runner unavailable' });
		return;
	}
	const agentId = message.agentId;
	const prompt = message.prompt;
	const sessionId = message.providerSessionId;
	const requiredToolId = message.requiredToolId;
	const requirePluginTools = message.requirePluginTools;
	if (
		(requirePluginTools !== undefined && typeof requirePluginTools !== 'boolean') ||
		typeof agentId !== 'string' ||
		!ctx.callbacks.getSessionDetail?.(agentId) ||
		typeof prompt !== 'string' ||
		!prompt.trim() ||
		prompt.length > 64 * 1024 ||
		(sessionId !== undefined &&
			(typeof sessionId !== 'string' || !/^[^\x00-\x1f\x7f]{1,256}$/.test(sessionId)))
	) {
		respond({ available: true, success: false, error: 'Invalid headless agent request' });
		return;
	}
	if (
		requiredToolId !== undefined &&
		(typeof requiredToolId !== 'string' ||
			!requiredToolId ||
			requiredToolId.length > 200 ||
			!manager.getContributions().tools.some((tool) => tool.id === requiredToolId))
	) {
		respond({ available: true, success: false, error: 'Required plugin tool unavailable' });
		return;
	}
	try {
		const controller = new AbortController();
		const onClose = (): void => controller.abort();
		client.socket.once('close', onClose);
		try {
			const reply = await run(
				agentId,
				prompt,
				sessionId as string | undefined,
				controller.signal,
				// The CLI boot secret authenticates the caller, not a human turn.
				'auto',
				undefined,
				requiredToolId as string | undefined,
				...(requirePluginTools === true ? ([true] as const) : [])
			);
			const toolStillActive =
				requiredToolId === undefined ||
				(isPluginsFeatureEnabled() &&
					getActivePluginManager() === manager &&
					manager.getContributions().tools.some((tool) => tool.id === requiredToolId));
			const hasReceipt =
				requiredToolId === undefined ||
				(Array.isArray(reply.toolReceipts) &&
					reply.toolReceipts.some(
						(receipt) =>
							receipt !== null &&
							typeof receipt === 'object' &&
							/^[0-9a-f]{32}$/.test(receipt.runId) &&
							receipt.agentId === agentId &&
							receipt.toolId === requiredToolId &&
							Array.isArray(receipt.messageIds) &&
							receipt.messageIds.length > 0 &&
							receipt.messageIds.every(
								(id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)
							)
					));
			respond({
				available: true,
				...reply,
				...(requiredToolId && (!toolStillActive || !hasReceipt)
					? {
							success: false,
							response: null,
							error:
								reply.success === false && reply.error
									? reply.error
									: !toolStillActive
										? 'Required plugin tool became unavailable'
										: 'Required plugin tool returned no delivery receipt',
						}
					: {}),
			});
		} finally {
			client.socket.off('close', onClose);
		}
	} catch (error) {
		respond({
			available: true,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Handle plugins_call_tool - risk-gate a model-initiated plugin tool call,
 * then invoke it via the broker. The toolId MUST be a declared `tools`
 * contribution (never an arbitrary command handler). Ordinary calls use the
 * shared Pianola gate; only the authenticated pinned Relay reply transport has
 * the conversational topic exception. Known Relay reads instead execute fixed
 * Host code under native identity and domain permissions. Tool failures return
 * `{ ok:false, error }`; topic blocks return `{ blocked:true }`.
 */
export async function handlePluginsCallTool(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	// Only the bridge's private envelope carries proof. Identity inside model
	// args/sessionId/callerAgentId is never considered, even on ordinary calls.
	const verified = Object.prototype.hasOwnProperty.call(message, 'runToken');
	const runProof = verified ? message.runToken : undefined;
	const requestId = message.requestId;
	const socket = client.socket;
	const respond = (extra: Record<string, unknown>): void =>
		ctx.send(client, {
			type: 'plugins_call_tool_result',
			requestId,
			...extra,
		});
	try {
		const toolId = typeof message.toolId === 'string' ? message.toolId : '';
		if (!toolId) {
			respond({ ok: false, error: verified ? 'PLUGIN_INVALID' : 'Missing toolId' });
			return;
		}
		const manager = getActivePluginManager();
		if (!manager || !isPluginsFeatureEnabled()) {
			respond({ ok: false, error: verified ? 'PLUGIN_DENIED' : 'PluginsDisabled' });
			return;
		}
		const declaredTool = manager.getContributions().tools.find((t) => t.id === toolId);
		if (!declaredTool) {
			// Only DECLARED `tools` are model-callable; never let a tools/call name
			// resolve to an arbitrary command handler in the sandbox's shared map.
			respond({ ok: false, error: verified ? 'PLUGIN_DENIED' : `Unknown tool: ${toolId}` });
			return;
		}
		const args = 'args' in message ? message.args : undefined;
		const hostMailRead = relayMailReadOperation(declaredTool) !== undefined;
		if (hostMailRead && !verified) {
			respond({ ok: false, error: 'PLUGIN_DENIED' });
			return;
		}
		let argText = '';
		try {
			if (!hostMailRead) argText = JSON.stringify(args ?? {});
		} catch {
			argText = '';
		}
		// Rate risk on the declared tool's human name + description + the model's
		// args: catches a destructive tool by identity AND destructive args, without
		// the slug noise of the raw toolId. Follow-up: per-tool risk metadata + a
		// user-approval path for HIGH instead of a hard block.
		const riskText = `${declaredTool.name} ${declaredTool.description} ${argText}`;
		const context = pluginToolRunIdentity.resolve(runProof);
		const relayReply =
			toolId === RELAY_REPLY_TOOL_ID &&
			declaredTool.pluginId === RELAY_PLUGIN_ID &&
			declaredTool.localId === 'send';
		if (relayReply) {
			if (!context.callerAgentId) {
				respond({ ok: false, error: 'Verified caller required' });
				return;
			}
			if (
				!manager
					.getActiveRecords()
					.some((record) => isRelayConversationIdentity(record.id, record.signature))
			) {
				respond({
					ok: false,
					error: 'Relay reply requires a trusted signed plugin from the pinned Relay publisher',
				});
				return;
			}
		}
		const verdict = evaluatePluginDispatch(riskText);
		// Known reads execute fixed Host code with live native/domain authority.
		// Their prose/search strings are data, not authority or effect declarations.
		if (!relayReply && !hostMailRead && !verdict.eligible) {
			respond({ ok: false, blocked: true, risk: verdict.risk, reason: verdict.reason });
			return;
		}
		if (verified) {
			const assertTransport = () => {
				if (
					getActivePluginManager() !== manager ||
					client.socket !== socket ||
					socket.readyState !== WebSocket.OPEN
				)
					throw new PluginAuthorityError('PLUGIN_DENIED');
			};
			const assertEnabled = () => {
				assertTransport();
				if (!isPluginsFeatureEnabled()) throw new PluginAuthorityError('PLUGIN_DENIED');
				assertTransport();
			};
			assertEnabled();
			await manager.invokeVerifiedTool(toolId, args, runProof, (result, assertActive) => {
				// Publish inside manager completion: an await here would reopen the
				// gap between its final run/record/child check and result delivery.
				assertEnabled();
				assertActive();
				assertTransport();
				pluginToolRunIdentity.recordReceipt(runProof, toolId, result);
				respond({ ok: true, result });
			});
			return;
		}
		const result = await manager.invokeTool(toolId, args, context);
		respond({ ok: true, result });
	} catch (error) {
		respond({
			ok: false,
			error: verified
				? error instanceof PluginAuthorityError
					? error.code
					: 'PLUGIN_DENIED'
				: error instanceof Error
					? error.message
					: String(error),
		});
	}
}
