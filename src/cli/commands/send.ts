// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { resolveAgentId, getSessionById, readSettingValue } from '../services/storage';
import { estimateContextUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import { withMaestroClient } from '../services/maestro-client';
import { getSettingDefault } from '../../shared/settingsMetadata';
import type { ToolType } from '../../shared/types';

interface SendOptions {
	session?: string;
	readOnly?: boolean;
	tab?: boolean;
	live?: boolean;
	newTab?: boolean;
	force?: boolean;
}

interface SendResponse {
	agentId: string;
	agentName: string;
	sessionId: string | null;
	response: string | null;
	success: boolean;
	error?: string;
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

function emitErrorJson(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

function buildResponse(
	agentId: string,
	agentName: string,
	result: AgentResult,
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
		usage,
	};
}

export async function send(
	agentIdArg: string,
	message: string,
	options: SendOptions
): Promise<void> {
	// --new-tab requires --live (both are "route through desktop" modes)
	if (options.newTab && !options.live) {
		emitErrorJson('--new-tab requires --live', 'INVALID_OPTIONS');
		process.exit(1);
	}

	// --force only applies to --live (non-live spawns fresh processes; --new-tab
	// creates a fresh tab — neither path has a busy guard to override).
	if (options.force && !options.live) {
		emitErrorJson('--force requires --live', 'INVALID_OPTIONS');
		process.exit(1);
	}

	// --force is gated by the `allowConcurrentSend` setting. It's off by default
	// because concurrent writes can interleave responses in the target tab.
	if (options.force) {
		const stored = readSettingValue('allowConcurrentSend');
		const allowConcurrentSend =
			stored === undefined ? (getSettingDefault('allowConcurrentSend') as boolean) : stored;
		if (allowConcurrentSend !== true) {
			emitErrorJson(
				'--force is disabled. Enable it with: maestro-cli settings set allowConcurrentSend true',
				'FORCE_NOT_ALLOWED'
			);
			process.exit(1);
		}
	}

	// --live mode: route message through Maestro desktop tab
	if (options.live) {
		if (options.session || options.readOnly) {
			emitErrorJson('--live cannot be combined with --session or --read-only', 'INVALID_OPTIONS');
			process.exit(1);
		}
		// Resolve agent ID early so partial IDs produce the CLI's normal
		// "ambiguous / not found" error rather than a confusing server-side one.
		let liveAgentId: string;
		try {
			liveAgentId = resolveAgentId(agentIdArg);
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			emitErrorJson(msg, 'AGENT_NOT_FOUND');
			process.exit(1);
		}
		try {
			await withMaestroClient(async (client) => {
				if (options.newTab) {
					// Atomic: create a new AI tab, focus it, and dispatch the prompt
					await client.sendCommand(
						{ type: 'new_ai_tab_with_prompt', sessionId: liveAgentId, prompt: message },
						'new_ai_tab_with_prompt_result'
					);
				} else {
					// Write into the agent's currently-active AI tab
					await client.sendCommand(
						{
							type: 'send_command',
							sessionId: liveAgentId,
							command: message,
							inputMode: 'ai',
							...(options.force ? { force: true } : {}),
						},
						'command_result'
					);
				}
			});
			const response: SendResponse = {
				agentId: liveAgentId,
				agentName: 'live',
				sessionId: null,
				response: null,
				success: true,
				usage: null,
			};
			console.log(JSON.stringify(response, null, 2));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const lowerMsg = msg.toLowerCase();
			if (
				lowerMsg.includes('econnrefused') ||
				lowerMsg.includes('connection refused') ||
				lowerMsg.includes('websocket') ||
				lowerMsg.includes('enotfound') ||
				lowerMsg.includes('etimedout')
			) {
				emitErrorJson('Maestro desktop is not running or not reachable', 'MAESTRO_NOT_RUNNING');
			} else if (
				lowerMsg.includes('session not found') ||
				lowerMsg.includes('no such session') ||
				lowerMsg.includes('unknown session')
			) {
				emitErrorJson(`Session not found: ${liveAgentId}`, 'SESSION_NOT_FOUND');
			} else {
				emitErrorJson(`Command failed: ${msg}`, 'COMMAND_FAILED');
			}
			process.exit(1);
		}
		return;
	}

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

	// Spawn agent — spawnAgent handles --resume vs fresh session internally
	const result = await spawnAgent(agent.toolType, agent.cwd, message, agentSessionId, {
		readOnlyMode: options.readOnly,
		customModel: agent.customModel,
	});
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
