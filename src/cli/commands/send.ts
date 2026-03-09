// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { resolveAgentId, getSessionById } from '../services/storage';
import { estimateContextUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import type { ToolType } from '../../shared/types';

interface SendOptions {
	session?: string;
	readOnly?: boolean;
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

	// Spawn agent — spawnAgent handles --resume vs --session-id internally
	const result = await spawnAgent(agent.toolType, agent.cwd, message, options.session, {
		readOnlyMode: options.readOnly,
	});
	const response = buildResponse(agentId, agent.name, result, agent.toolType);

	console.log(JSON.stringify(response, null, 2));

	if (!result.success) {
		process.exit(1);
	}
}
