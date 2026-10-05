// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { captureCliRun } from '../services/agent-run-capture';
import { resolveAgentId, getSessionById } from '../services/storage';
import { prepareMaestroSystemPromptCli } from '../services/system-prompt';
import { estimateContextUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import {
	MaestroClient,
	UnsupportedCommandError,
	withMaestroClient,
} from '../services/maestro-client';
import type { ToolType } from '../../shared/types';
import { HEADLESS_RUN_COMPLETION_TIMEOUT_MS } from '../../shared/plugins/headless-agent-timeouts';
import type { PluginToolReceipt } from '../../main/plugins/plugin-tool-run-identity';

interface SendOptions {
	session?: string;
	readOnly?: boolean;
	tab?: boolean;
	/** Fail closed when the desktop cannot start a run with plugin tools. */
	requirePluginTools?: boolean;
	/** Require an actual successful call to this namespaced plugin tool ID. */
	requireToolReceipt?: string;
	// Commander auto-negates `--no-system-prompt` into `systemPrompt: false`,
	// defaulting to true when the flag is omitted. Bots calling
	// `maestro-cli send` get the Maestro system context by default - parity
	// with desktop spawn sites that all pass `appendSystemPrompt`.
	systemPrompt?: boolean;
}

interface SendResponse {
	agentId: string;
	agentName: string;
	sessionId: string | null;
	response: string | null;
	success: boolean;
	error?: string;
	toolReceipts?: PluginToolReceipt[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		totalCostUsd: number;
		contextWindow: number;
		contextUsagePercent: number | null;
	} | null;
}

interface DesktopSendAgentReply {
	available?: boolean;
	success?: boolean;
	response?: string | null;
	sessionId?: string | null;
	error?: string;
	usageStats?: AgentResult['usageStats'];
	toolReceipts?: PluginToolReceipt[];
}

type SendAgentResult = AgentResult & { toolReceipts?: PluginToolReceipt[] };

function emitErrorJson(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

function buildResponse(
	agentId: string,
	agentName: string,
	result: SendAgentResult,
	agentType: ToolType
): SendResponse {
	let usage: SendResponse['usage'] = null;

	if (result.usageStats) {
		const stats = result.usageStats;
		const contextUsagePercent = estimateContextUsage(stats, agentType);

		usage = {
			inputTokens: stats.inputTokens,
			outputTokens: stats.outputTokens,
			cacheReadInputTokens: stats.cacheReadInputTokens,
			cacheCreationInputTokens: stats.cacheCreationInputTokens,
			totalCostUsd: stats.totalCostUsd,
			contextWindow: stats.contextWindow,
			contextUsagePercent,
		};
	}

	return {
		agentId,
		agentName,
		sessionId: result.agentSessionId ?? null,
		response: result.success ? (result.response ?? null) : null,
		success: result.success,
		...(result.success ? {} : { error: result.error }),
		...(result.toolReceipts !== undefined ? { toolReceipts: result.toolReceipts } : {}),
		usage,
	};
}

export async function send(
	agentIdArg: string,
	message: string,
	options: SendOptions
): Promise<void> {
	// Resolve agent ID (supports partial IDs)
	let agentId: string;
	try {
		agentId = resolveAgentId(agentIdArg);
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		emitErrorJson(msg, 'AGENT_NOT_FOUND');
		process.exit(1);
	}

	const agent = getSessionById(agentId);
	if (!agent) {
		emitErrorJson(`Agent not found: ${agentIdArg}`, 'AGENT_NOT_FOUND');
		process.exit(1);
	}

	// Validate agent type is supported for CLI spawning
	const def = getAgentDefinition(agent.toolType);
	if (!def) {
		emitErrorJson(
			`Agent type "${agent.toolType}" is not supported for send mode.`,
			'AGENT_UNSUPPORTED'
		);
		process.exit(1);
	}

	// Verify agent CLI is available
	const detection = await detectAgent(agent.toolType);
	if (!detection.available) {
		const errorCode = `${agent.toolType.toUpperCase().replace(/-/g, '_')}_NOT_FOUND`;
		emitErrorJson(`${def.name} CLI not found. Please install ${def.name}.`, errorCode);
		process.exit(1);
	}

	// Only resume a session when explicitly requested via --session flag.
	// Without -s, always create a fresh session to prevent session leakage
	// when multiple callers (e.g. Discord threads) send concurrently.
	const agentSessionId = options.session;
	const requiredToolId = options.requireToolReceipt?.trim();
	if (options.requireToolReceipt !== undefined && !requiredToolId) {
		emitErrorJson('A required plugin tool ID must be provided', 'INVALID_PLUGIN_TOOL_ID');
		process.exit(1);
		return;
	}
	const requirePluginHost = options.requirePluginTools || !!requiredToolId;

	// The host builds its own Maestro system prompt. The standalone fallback
	// builds one only if it actually needs to spawn locally.
	// When a desktop is running it owns the headless spawn and mints the MCP
	// proof from the actual stored agent it starts. A free-form CLI id or --tab
	// can never mint a proof by itself.
	let desktop: MaestroClient | null = new MaestroClient();
	try {
		await desktop.connect();
	} catch {
		desktop.disconnect();
		desktop = null;
	}
	if (
		requirePluginHost &&
		(!desktop ||
			options.readOnly ||
			options.systemPrompt === false ||
			message.length > 64 * 1024 ||
			(agentSessionId !== undefined && !/^[^\x00-\x1f\x7f]{1,256}$/.test(agentSessionId)))
	) {
		desktop?.disconnect();
		emitErrorJson(
			'A desktop-backed plugin-tool run is unavailable for this request',
			'PLUGIN_TOOLS_UNAVAILABLE'
		);
		process.exit(1);
		return;
	}

	// Spawn agent - spawnAgent handles --resume vs fresh session internally.
	// Wrapped in captureCliRun so the send lands in the agent-run ledger.
	let result: SendAgentResult;
	try {
		result = await captureCliRun(
			{
				sessionId: agentSessionId ?? agentId,
				toolType: agent.toolType,
				cwd: agent.cwd,
				prompt: message,
				source: 'cli:send',
			},
			async () => {
				if (
					desktop &&
					!options.readOnly &&
					options.systemPrompt !== false &&
					message.length <= 64 * 1024 &&
					(!agentSessionId || /^[^\x00-\x1f\x7f]{1,256}$/.test(agentSessionId))
				) {
					let reply: DesktopSendAgentReply | null = null;
					try {
						reply = await desktop.sendCommand<DesktopSendAgentReply>(
							{
								type: 'plugins_send_agent',
								agentId,
								prompt: message,
								providerSessionId: agentSessionId || undefined,
								...(requiredToolId ? { requiredToolId } : {}),
							},
							'plugins_send_agent_result',
							HEADLESS_RUN_COMPLETION_TIMEOUT_MS
						);
					} catch (error) {
						// An older desktop echoes an unsupported verb before starting any
						// provider run. Ordinary sends may fall back; required plugin
						// runs must fail without starting a standalone provider.
						if (!(error instanceof UnsupportedCommandError) || requirePluginHost) {
							// A dropped connection or timeout may have happened AFTER the
							// desktop started work. Never spawn a duplicate local run.
							return {
								success: false,
								error: error instanceof Error ? error.message : String(error),
							};
						}
					}
					if (reply && reply.available !== false) {
						const hasRequiredReceipt =
							!requiredToolId ||
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
						return {
							success: reply.success === true && !!hasRequiredReceipt,
							response: reply.response ?? undefined,
							agentSessionId: reply.sessionId ?? undefined,
							error:
								reply.error ||
								(hasRequiredReceipt
									? undefined
									: 'Required plugin tool returned no delivery receipt'),
							usageStats: reply.usageStats,
							...(requiredToolId ? { toolReceipts: reply.toolReceipts ?? [] } : {}),
						};
					}
					if (requirePluginHost) {
						return {
							success: false,
							error: reply?.error ?? 'Desktop plugin tools unavailable',
						};
					}
				}
				const appendSystemPrompt =
					options.systemPrompt !== false ? await prepareMaestroSystemPromptCli(agent) : undefined;
				return spawnAgent(agent.toolType, agent.cwd, message, agentSessionId, {
					readOnlyMode: options.readOnly,
					customModel: agent.customModel,
					customEffort: agent.customEffort,
					customArgs: agent.customArgs,
					additionalDirectories: agent.additionalDirectories,
					customEnvVars: agent.customEnvVars,
					sshRemoteConfig: agent.sessionSshRemoteConfig,
					appendSystemPrompt,
					// Honor the agent's Claude token source for `maestro-cli send` turns.
					enableMaestroP: agent.enableMaestroP,
					maestroPMode: agent.maestroPMode,
					maestroPPath: agent.maestroPPath,
				});
			},
			(r) => (r.success ? 0 : 1)
		);
	} finally {
		desktop?.disconnect();
	}
	const response = buildResponse(agentId, agent.name, result, agent.toolType);

	console.log(JSON.stringify(response, null, 2));

	if (!result.success) {
		process.exit(1);
	}

	// If --tab flag is set, focus the session tab in Maestro desktop
	if (options.tab) {
		try {
			await withMaestroClient(async (client) => {
				await client.sendCommand(
					{ type: 'select_session', sessionId: agentId, focus: true },
					'select_session_result'
				);
			});
		} catch {
			console.error(
				'Warning: Could not focus session tab in Maestro desktop (app may not be running)'
			);
		}
	}
}
