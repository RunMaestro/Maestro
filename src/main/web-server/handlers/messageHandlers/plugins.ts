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
import { evaluatePluginDispatch } from '../../../../shared/plugins/plugin-dispatch-gate';
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
	// This CLI-only surface carries prompts and responses. The ordinary web
	// remote has its own command path; a LAN browser cannot use this shortcut.
	const remoteAddress = (client.socket as unknown as { _socket?: { remoteAddress?: string } })
		._socket?.remoteAddress;
	if (
		remoteAddress !== '127.0.0.1' &&
		remoteAddress !== '::1' &&
		remoteAddress !== '::ffff:127.0.0.1'
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
	if (
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
	try {
		respond({
			available: true,
			...(await run(agentId, prompt, sessionId as string | undefined, undefined, 'user')),
		});
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
 * contribution (never an arbitrary command handler), and risk is rated on the
 * model's ARGUMENTS via the shared Pianola gate - a HIGH verdict is surfaced
 * and NEVER executed. Tool failures: `{ ok:false, error }`; blocks: `{ blocked:true }`.
 */
export async function handlePluginsCallTool(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const respond = (extra: Record<string, unknown>): void =>
		ctx.send(client, {
			type: 'plugins_call_tool_result',
			requestId: message.requestId,
			...extra,
		});
	const toolId = typeof message.toolId === 'string' ? message.toolId : '';
	if (!toolId) {
		respond({ ok: false, error: 'Missing toolId' });
		return;
	}
	const manager = getActivePluginManager();
	if (!manager || !isPluginsFeatureEnabled()) {
		respond({ ok: false, error: 'PluginsDisabled' });
		return;
	}
	const declaredTool = manager.getContributions().tools.find((t) => t.id === toolId);
	if (!declaredTool) {
		// Only DECLARED `tools` are model-callable; never let a tools/call name
		// resolve to an arbitrary command handler in the sandbox's shared map.
		respond({ ok: false, error: `Unknown tool: ${toolId}` });
		return;
	}
	const args = 'args' in message ? message.args : undefined;
	let argText = '';
	try {
		argText = JSON.stringify(args ?? {});
	} catch {
		argText = '';
	}
	// Rate risk on the declared tool's human name + description + the model's
	// args: catches a destructive tool by identity AND destructive args, without
	// the slug noise of the raw toolId. Follow-up: per-tool risk metadata + a
	// user-approval path for HIGH instead of a hard block.
	const riskText = `${declaredTool.name} ${declaredTool.description} ${argText}`;
	const verdict = evaluatePluginDispatch(riskText);
	if (!verdict.eligible) {
		respond({ ok: false, blocked: true, risk: verdict.risk, reason: verdict.reason });
		return;
	}
	try {
		const context = pluginToolRunIdentity.resolve(message.runToken);
		logger.info(
			`[PluginAudit] tool ${toolId} callerAgentId=${context.callerAgentId ?? 'unverified'}`,
			LOG_CONTEXT
		);
		const result = await manager.invokeTool(toolId, args, context);
		respond({ ok: true, result });
	} catch (error) {
		respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
}
