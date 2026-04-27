// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { resolveAgentId, getSessionById } from '../services/storage';
import { estimateContextUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import { withMaestroClient } from '../services/maestro-client';
import { runDispatch } from './dispatch';
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

	// --live mode: hidden alias for `dispatch` during the deprecation window.
	// Delegates to runDispatch so behavior stays in lockstep, but preserves the
	// legacy SendResponse shape so existing scripts keep parsing successfully.
	if (options.live) {
		if (options.session || options.readOnly) {
			emitErrorJson('--live cannot be combined with --session or --read-only', 'INVALID_OPTIONS');
			process.exit(1);
		}
		// Print the deprecation notice to stderr (not stdout) so JSON-parsing
		// callers don't break. Notice goes out before the dispatch runs so
		// users see it even if dispatch fails.
		process.stderr.write(
			'maestro-cli: `send --live` is deprecated and will be removed in a future release; use `maestro-cli dispatch` instead.\n'
		);
		const result = await runDispatch(agentIdArg, message, {
			newTab: options.newTab,
			force: options.force,
		});
		if (!result.success) {
			emitErrorJson(result.error ?? 'Unknown error', result.code ?? 'UNKNOWN');
			process.exit(1);
			return;
		}
		// Preserve the historical `send --live` response shape: agentName is
		// the literal "live", sessionId/response/usage are null. Existing
		// scripts that grep these fields keep working unchanged.
		const response: SendResponse = {
			agentId: result.agentId ?? '',
			agentName: 'live',
			sessionId: null,
			response: null,
			success: true,
			usage: null,
		};
		console.log(JSON.stringify(response, null, 2));
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
		customEffort: agent.customEffort,
		customArgs: agent.customArgs,
		customEnvVars: agent.customEnvVars,
		sshRemoteConfig: agent.sessionSshRemoteConfig,
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
