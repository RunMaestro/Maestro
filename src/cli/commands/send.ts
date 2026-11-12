// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { captureCliRun } from '../services/agent-run-capture';
import { resolveAgentId, getSessionById, readStoredAiTabs } from '../services/storage';
import { listDesktopTabs } from '../services/session-command';
import { prepareMaestroSystemPromptCli } from '../services/system-prompt';
import { estimateContextUsage } from '../../main/parsers/usage-aggregator';
import { getAgentDefinition } from '../../main/agents/definitions';
import { withMaestroClient } from '../services/maestro-client';
import type { ToolType } from '../../shared/types';
import { prependNewSessionMessageOnFirstTurn } from '../../shared/newSessionMessage';

interface SendOptions {
	session?: string;
	readOnly?: boolean;
	tab?: boolean;
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

/**
 * Why a `--session` value must not be resumed, or `null` when it may.
 *
 * `send` runs a headless provider process beside the desktop; it never writes
 * into a desktop tab. Two values used to slip through and come back as an
 * opaque `crashed` turn:
 *   - a Maestro TAB id, which the provider cannot resume (it is not one of its
 *     session ids), and
 *   - the provider session of a tab that is mid-turn, which puts a second
 *     writer on one conversation.
 * Both are refused with a reason that names the verb that does what the caller
 * meant (`dispatch --tab --queue`). The desktop's live tab list is asked first
 * because only it knows which tab is busy; with the app down, the persisted
 * tabs still catch the tab-id mistake.
 */
async function sessionResumeRefusal(
	agentId: string,
	sessionArg: string
): Promise<{ error: string; code: string } | null> {
	let tabs: { tabId: string; agentSessionId: string | null; state: string }[];
	try {
		tabs = (await listDesktopTabs()).filter((tab) => tab.agentId === agentId);
	} catch {
		tabs = readStoredAiTabs(agentId).map((tab) => ({
			tabId: tab.id,
			agentSessionId: tab.agentSessionId ?? null,
			state: 'unknown',
		}));
	}
	const queueHint = (tabId: string) =>
		`To deliver into that tab instead, run: maestro-cli dispatch ${agentId} "<message>" --tab ${tabId} --queue`;

	const byTabId = tabs.find((tab) => tab.tabId === sessionArg);
	if (byTabId) {
		const providerNote = byTabId.agentSessionId
			? ` (that tab's provider session is ${byTabId.agentSessionId})`
			: '';
		return {
			code: 'SESSION_IS_TAB_ID',
			error: `"${sessionArg}" is a Maestro tab id; --session takes a provider session id${providerNote}. ${queueHint(sessionArg)}`,
		};
	}
	const busyTab = tabs.find((tab) => tab.agentSessionId === sessionArg && tab.state === 'busy');
	if (busyTab) {
		return {
			code: 'TAB_BUSY',
			error: `Provider session ${sessionArg} is mid-turn in desktop tab ${busyTab.tabId}; resuming it now would put a second writer on one conversation. Wait for the turn to finish. ${queueHint(busyTab.tabId)}`,
		};
	}
	return null;
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
	if (agentSessionId) {
		const refusal = await sessionResumeRefusal(agentId, agentSessionId);
		if (refusal) {
			emitErrorJson(refusal.error, refusal.code);
			console.error(`maestro-cli send refused: ${refusal.error}`);
			process.exit(1);
		}
	}

	// Build the Maestro system prompt unless the caller opted out with
	// `--no-system-prompt`. Failure to build (template missing, fs error) is
	// non-fatal: spawn proceeds without the prompt rather than failing the
	// whole send, matching the renderer's `prepareMaestroSystemPrompt` which
	// returns undefined on failure (`src/renderer/utils/spawnHelpers.ts:35`).
	const includeSystemPrompt = options.systemPrompt !== false;
	const appendSystemPrompt = includeSystemPrompt
		? await prepareMaestroSystemPromptCli(agent)
		: undefined;

	// A send without `--session` opens a new provider session, so it carries the
	// agent's New Session Message like the first message of a desktop tab does.
	// Agent-only: the run ledger below records the message as it was sent.
	const agentPrompt = prependNewSessionMessageOnFirstTurn(
		message,
		agent.newSessionMessage,
		agentSessionId
	);

	// Spawn agent - spawnAgent handles --resume vs fresh session internally.
	// Wrapped in captureCliRun so the send lands in the agent-run ledger.
	const result = await captureCliRun(
		{
			sessionId: agentSessionId ?? agentId,
			toolType: agent.toolType,
			cwd: agent.cwd,
			prompt: message,
			source: 'cli:send',
		},
		() =>
			spawnAgent(agent.toolType, agent.cwd, agentPrompt, agentSessionId, {
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
				// The turn runs in the agent's own cwd (#1872).
				acceptWorkspaceTrust: true,
			}),
		(r) => (r.success ? 0 : 1)
	);
	const response = buildResponse(agentId, agent.name, result, agent.toolType);

	console.log(JSON.stringify(response, null, 2));

	if (!result.success) {
		// The JSON on stdout is the contract, but a caller that only reads stderr
		// would otherwise see a silent exit 1.
		console.error(`maestro-cli send failed: ${result.error ?? 'unknown error'}`);
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
