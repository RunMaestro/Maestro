// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { captureCliRun, settlementFromAgentResult } from '../services/agent-run-capture';
import { resolveAgentId, getSessionById, addHistoryEntry } from '../services/storage';
import { prepareMaestroSystemPromptCli } from '../services/system-prompt';
import { getCliPrompt } from '../services/prompt-loader';
import { estimateContextUsage } from '../../shared/maestro-lib/parsers/usage-aggregator';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import type { TurnOutcome } from '../../shared/maestro-lib/streaming/turn-outcome';
import { withMaestroClient } from '../services/maestro-client';
import { installInterruptHandler } from '../utils/interrupt';
import { isFailedSynopsisResponse, parseSynopsis } from '../../shared/synopsis';
import { cheapTurnSettings } from '../../shared/modelTiers';
import {
	FALLBACK_CONTEXT_WINDOW,
	getModelContextWindowOverride,
} from '../../shared/agentConstants';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { generateUUID } from '../../shared/uuid';
import type { HistoryEntry, SessionInfo, ToolType } from '../../shared/types';

interface SendOptions {
	session?: string;
	readOnly?: boolean;
	tab?: boolean;
	// Commander auto-negates `--no-system-prompt` into `systemPrompt: false`,
	// defaulting to true when the flag is omitted. Bots calling
	// `maestro-cli send` get the Maestro system context by default - parity
	// with desktop spawn sites that all pass `appendSystemPrompt`.
	systemPrompt?: boolean;
	// `--no-history` -> `history: false`. A send is a real turn on the agent, so
	// by default it lands in the agent's History panel like a desktop tab turn
	// does, whether or not the desktop app is running. Same flag and same
	// `addHistoryEntry` path as `playbook`, `run-doc` and `goal-run`.
	history?: boolean;
	// `--no-synopsis` -> `synopsis: false`. Skips the extra summarization turn;
	// the History entry then carries the response itself.
	synopsis?: boolean;
}

/** Longest summary line kept when the response stands in for a synopsis. */
const FALLBACK_SUMMARY_MAX = 200;

function fallbackSummary(text: string): string {
	const firstLine =
		text
			.split('\n')
			.map((l) => l.trim())
			.find(Boolean) ?? '';
	return firstLine.length > FALLBACK_SUMMARY_MAX
		? `${firstLine.slice(0, FALLBACK_SUMMARY_MAX - 1)}…`
		: firstLine;
}

/**
 * Run the cheap synopsis turn for a finished send, resumed on the same
 * provider session. Returns the parsed synopsis, or null when there is
 * nothing usable (the turn failed, printed a provider error, or reported
 * NOTHING_TO_REPORT), in which case the caller keeps the response.
 */
async function runSendSynopsis(
	agent: SessionInfo,
	agentSessionId: string,
	signal: AbortSignal
): Promise<{ shortSummary: string; fullSynopsis: string } | null> {
	const cheap = cheapTurnSettings(agent.toolType);
	// Same guard as the desktop synopsis (useAgentExecution): resuming replays
	// the transcript, so never downgrade onto a smaller context window than the
	// agent's own model, or a long session fails with "Prompt is too long".
	// Effort still drops to the bottom rung.
	const shrinksWindow =
		(getModelContextWindowOverride(agent.customModel) ?? FALLBACK_CONTEXT_WINDOW) >
		(getModelContextWindowOverride(cheap.model) ?? FALLBACK_CONTEXT_WINDOW);
	const synopsisModel = shrinksWindow ? agent.customModel : (cheap.model ?? agent.customModel);

	const synopsisResult = await captureCliRun(
		{
			sessionId: agentSessionId,
			toolType: agent.toolType,
			cwd: agent.cwd,
			source: 'cli:send-synopsis',
		},
		async () =>
			spawnAgent(
				agent.toolType,
				agent.cwd,
				await getCliPrompt(PROMPT_IDS.AUTORUN_SYNOPSIS),
				agentSessionId,
				{
					signal,
					customModel: synopsisModel,
					customEffort: cheap.effort ?? agent.customEffort,
					customArgs: agent.customArgs,
					additionalDirectories: agent.additionalDirectories,
					customEnvVars: agent.customEnvVars,
					sshRemoteConfig: agent.sessionSshRemoteConfig,
					querySource: 'auto',
					enableMaestroP: agent.enableMaestroP,
					maestroPMode: agent.maestroPMode,
					maestroPPath: agent.maestroPPath,
				}
			),
		settlementFromAgentResult
	);

	const text = synopsisResult.response;
	if (!synopsisResult.success || !text || isFailedSynopsisResponse(text, agent.toolType)) {
		return null;
	}
	const parsed = parseSynopsis(text);
	return parsed.nothingToReport ? null : parsed;
}

/**
 * Record a `send` turn in the agent's History, the same file the desktop's
 * History panel reads (and watches, so an open app shows it live).
 *
 * A successful turn is summarized like a desktop tab turn: a cheap synopsis
 * turn resumed on the same provider session. Unlike the desktop, a
 * NOTHING_TO_REPORT synopsis does not drop the entry: a send is a deliberate
 * hand-off, and the cheap tier judges read-only research as nothing, so the
 * response stands in instead. Failed and interrupted turns are recorded
 * without a synopsis turn. Failures here never fail the send: the caller
 * already has its response on stdout, so they only warn on stderr.
 */
async function recordSendHistory(
	agent: SessionInfo,
	message: string,
	result: AgentResult,
	elapsedTimeMs: number,
	options: SendOptions,
	signal: AbortSignal
): Promise<void> {
	try {
		let summary: string;
		let fullResponse: string;

		if (result.outcome === 'interrupted') {
			summary = 'Send interrupted';
			fullResponse = 'Interrupted by the operator before the turn finished.';
		} else if (!result.success) {
			summary = `Send failed: ${fallbackSummary(result.error ?? 'unknown error')}`;
			fullResponse = result.error ?? summary;
		} else {
			const response = result.response ?? '';
			summary = fallbackSummary(response) || fallbackSummary(message);
			fullResponse = response;

			if (options.synopsis !== false && result.agentSessionId && !signal.aborted) {
				const synopsis = await runSendSynopsis(agent, result.agentSessionId, signal);
				if (synopsis) {
					summary = synopsis.shortSummary;
					fullResponse = synopsis.fullSynopsis;
				}
			}
		}

		const entry: HistoryEntry = {
			id: generateUUID(),
			type: 'USER',
			timestamp: Date.now(),
			summary,
			fullResponse,
			agentSessionId: result.agentSessionId,
			projectPath: agent.cwd,
			sessionId: agent.id,
			success: result.success,
			usageStats: result.usageStats,
			elapsedTimeMs,
		};
		addHistoryEntry(entry);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`Warning: Could not write history entry: ${msg}`);
	}
}

interface SendResponse {
	agentId: string;
	agentName: string;
	sessionId: string | null;
	response: string | null;
	success: boolean;
	error?: string;
	/** How the turn ended: `completed`, `completed-with-warning`, `interrupted` or `crashed`. */
	outcome?: TurnOutcome;
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
		...(result.outcome ? { outcome: result.outcome } : {}),
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

	// Build the Maestro system prompt unless the caller opted out with
	// `--no-system-prompt`. Failure to build (template missing, fs error) is
	// non-fatal: spawn proceeds without the prompt rather than failing the
	// whole send, matching the renderer's `prepareMaestroSystemPrompt` which
	// returns undefined on failure (`src/renderer/utils/spawnHelpers.ts:35`).
	const includeSystemPrompt = options.systemPrompt !== false;
	const appendSystemPrompt = includeSystemPrompt
		? await prepareMaestroSystemPromptCli(agent)
		: undefined;

	// Spawn agent - spawnAgent handles --resume vs fresh session internally.
	// Wrapped in captureCliRun so the send lands in the agent-run ledger.
	// Ctrl+C stops the agent gracefully and reports `outcome: 'interrupted'`
	// instead of orphaning it; a second Ctrl+C exits immediately. The handler
	// stays installed through the History write, so a Ctrl+C during the
	// synopsis turn stops that turn too and the entry falls back to the response.
	const interrupt = installInterruptHandler();
	let result: AgentResult;
	try {
		const startedAt = Date.now();
		result = await captureCliRun(
			{
				sessionId: agentSessionId ?? agentId,
				toolType: agent.toolType,
				cwd: agent.cwd,
				prompt: message,
				source: 'cli:send',
			},
			() =>
				spawnAgent(agent.toolType, agent.cwd, message, agentSessionId, {
					signal: interrupt.signal,
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
				}),
			settlementFromAgentResult
		);
		const elapsedTimeMs = Date.now() - startedAt;

		const response = buildResponse(agentId, agent.name, result, agent.toolType);
		console.log(JSON.stringify(response, null, 2));

		if (options.history !== false) {
			await recordSendHistory(agent, message, result, elapsedTimeMs, options, interrupt.signal);
		}
	} finally {
		interrupt.dispose();
	}

	if (!result.success) {
		// The JSON on stdout is the contract, but a caller that only reads stderr
		// would otherwise see a silent non-zero exit.
		console.error(`maestro-cli send failed: ${result.error ?? 'unknown error'}`);
		// 130 is the shell convention for an interrupt; 1 stays for real failures.
		process.exit(result.outcome === 'interrupted' ? 130 : 1);
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
