// Send command - send a message to an agent and get a JSON response
// Requires a Maestro agent ID. Optionally resumes an existing agent session.

import { spawnAgent, detectAgent, type AgentResult } from '../services/agent-spawner';
import { captureCliRun, settlementFromAgentResult } from '../services/agent-run-capture';
import { resolveAgentId, getSessionById, addHistoryEntry } from '../services/storage';
import { prepareMaestroSystemPromptCli } from '../services/system-prompt';
import { requestCliSynopsis } from '../services/synopsis';
import { estimateContextUsage } from '../../shared/maestro-lib/parsers/usage-aggregator';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import type { TurnOutcome } from '../../shared/maestro-lib/streaming/turn-outcome';
import {
	MaestroClient,
	UnsupportedCommandError,
	withMaestroClient,
} from '../services/maestro-client';
import { installInterruptHandler } from '../utils/interrupt';
import { interruptedResult } from '../services/turn-result';
import { HEADLESS_RUN_COMPLETION_TIMEOUT_MS } from '../../shared/plugins/headless-agent-timeouts';
import type { PluginToolReceipt } from '../../main/plugins/plugin-tool-run-identity';
import { MCP_CONFIG_BY_AGENT } from '../../shared/plugins/mcp-agent-config';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { readCallerIdentity } from '../../shared/agentDelegation';
import { QUERY_SOURCE_ENV_VAR } from '../../shared/querySource';
import { generateUUID } from '../../shared/uuid';
import { prependNewSessionMessageOnFirstTurn } from '../../shared/newSessionMessage';
import { AGENT_LIFTED_CODE, liftedSendRefusal } from '../../shared/maestro-lib/agents/lift-pointer';
import type {
	AgentError,
	HistoryEntry,
	SessionInfo,
	ToolType,
	UsageStats,
} from '../../shared/types';
import type { TurnEvent } from '../../shared/maestro-lib/client/types';
import {
	PeerResolveError,
	hostCallError,
	peerAgentRef,
	peerErrorCode,
	routeAgentTarget,
	watchPeerConnection,
	withPeerAgent,
	type PeerTarget,
	type ResolvedPeerAgent,
} from '../services/peer-resolver';
import {
	runPeerAgentAction,
	type PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
import { ExitCode } from '../exit-codes';

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

/** Who started a send: a Cue run, another agent, or the user at a shell. */
type SendOrigin = { kind: 'cue' } | { kind: 'agent'; agentName: string } | { kind: 'user' };

/**
 * Read who started this send from the environment its shell inherited.
 *
 * Cue wins: a run Cue started (a shell action, or an agent Cue woke) stamps
 * `MAESTRO_QUERY_SOURCE=cue`, and that describes where the whole chain began.
 * Otherwise the caller identity every desktop agent spawn stamps names the
 * agent whose shell ran the command. With neither it is the user, or a script
 * of theirs, at a shell.
 */
function resolveSendOrigin(env: NodeJS.ProcessEnv): SendOrigin {
	if (env[QUERY_SOURCE_ENV_VAR]?.trim() === 'cue') return { kind: 'cue' };
	const caller = readCallerIdentity(env);
	if (!caller) return { kind: 'user' };
	// A caller whose agent is gone by now still asked; its id is the only name
	// left for it.
	return { kind: 'agent', agentName: getSessionById(caller.agentId)?.name ?? caller.agentId };
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
 *
 * WHO asked decides the kind (`resolveSendOrigin`). A send Cue started is a
 * CUE entry. A send run from another agent's shell is an AGENT entry naming
 * that agent, the same kind a consult writes: an ordinary turn whose only
 * difference from a user's is who asked. Both kinds carry the panel's
 * pass/fail mark. Anything else is a USER entry.
 *
 * A CUE entry deliberately sets no `cueTriggerName` / `cueEventType`: the
 * History read pairs a CUE entry in this file with the `cue_events` row
 * sharing those two fields and hides the row (`dropCueRowsAlreadyInJsonl`),
 * so a send to the subscription's own agent would hide the run that sent it.
 */
async function recordSendHistory(
	agent: SessionInfo,
	message: string,
	result: AgentResult,
	elapsedTimeMs: number,
	options: SendOptions,
	origin: SendOrigin,
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
				// Its own try: the response already stands in as the summary, so a
				// synopsis turn that throws (missing prompt file, spawn rejection)
				// costs the synopsis, not the entry.
				try {
					const synopsis = await requestCliSynopsis(agent, result.agentSessionId, {
						source: 'cli:send-synopsis',
						readOnlyMode: options.readOnly,
						signal,
					});
					if (synopsis) {
						summary = synopsis.shortSummary;
						fullResponse = synopsis.fullSynopsis;
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					console.error(`Warning: Could not generate history synopsis: ${msg}`);
				}
			}
		}

		const sourceAgentName = origin.kind === 'agent' ? origin.agentName : undefined;

		const entry: HistoryEntry = {
			id: generateUUID(),
			type: origin.kind === 'cue' ? 'CUE' : sourceAgentName ? 'AGENT' : 'USER',
			timestamp: Date.now(),
			// Nothing in the panel draws `sourceAgentName`, so the summary names
			// the sender, as a consult's "Consulted by" does.
			summary: sourceAgentName ? `Sent by ${sourceAgentName}: ${summary}` : summary,
			fullResponse,
			...(sourceAgentName ? { sourceAgentName } : {}),
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
	toolReceipts?: PluginToolReceipt[];
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
		...(result.outcome ? { outcome: result.outcome } : {}),
		usage,
	};
}

/** Run one prompt for the resolved stored agent and emit its provider result as JSON.
 * Prefer the authenticated desktop runner; required plugin tools/receipts prohibit
 * standalone fallback so success cannot silently omit the requested MCP boundary.
 */
export async function send(
	agentIdArg: string,
	message: string,
	options: SendOptions
): Promise<void> {
	const route = routeAgentTarget(agentIdArg);
	if (route.kind === 'peer') return sendToPeer(route.target, message, options);

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

	// A lifted agent runs on its host now: a local turn would resume the session the host owns.
	const liftedRefusal = liftedSendRefusal(agent);
	if (liftedRefusal) {
		emitErrorJson(liftedRefusal, AGENT_LIFTED_CODE);
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
	if (
		requirePluginHost &&
		(agent.sessionSshRemoteConfig?.enabled ||
			!MCP_CONFIG_BY_AGENT[agent.toolType]?.verified ||
			(agent.toolType === 'claude-code' && getClaudeTokenMode(agent) !== 'api'))
	) {
		emitErrorJson(
			'Verified local plugin tools are unavailable for this agent',
			'PLUGIN_TOOLS_UNAVAILABLE'
		);
		process.exit(1);
		return;
	}

	// A send without `--session` opens a new provider session, so it carries the
	// agent's New Session Message like the first message of a desktop tab does.
	// Agent-only: the run ledger below records the message as it was sent.
	const agentPrompt = prependNewSessionMessageOnFirstTurn(
		message,
		agent.newSessionMessage,
		agentSessionId
	);

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
			agentPrompt.length > 64 * 1024 ||
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
	// Ctrl+C stops the agent and reports `outcome: 'interrupted'`
	// instead of orphaning it; a second Ctrl+C exits immediately. The handler
	// stays installed through the History write, so a Ctrl+C during the
	// synopsis turn stops that turn too and the entry falls back to the response.
	const origin = resolveSendOrigin(process.env);
	const interrupt = installInterruptHandler({ onFirst: () => desktop?.disconnect() });
	let result: SendAgentResult;
	try {
		const startedAt = Date.now();
		result = await captureCliRun(
			{
				agentId,
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
					agentPrompt.length <= 64 * 1024 &&
					(!agentSessionId || /^[^\x00-\x1f\x7f]{1,256}$/.test(agentSessionId))
				) {
					let reply: DesktopSendAgentReply | null = null;
					try {
						reply = await desktop.sendCommand<DesktopSendAgentReply>(
							{
								type: 'plugins_send_agent',
								...(requirePluginHost ? { requirePluginTools: true } : {}),
								agentId,
								prompt: agentPrompt,
								providerSessionId: agentSessionId || undefined,
								...(requiredToolId ? { requiredToolId } : {}),
							},
							'plugins_send_agent_result',
							HEADLESS_RUN_COMPLETION_TIMEOUT_MS
						);
					} catch (error) {
						if (interrupt.signal.aborted) return interruptedResult();
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
				const nativeControl = agent.harnessControlMode === 'native';
				const appendSystemPrompt =
					options.systemPrompt !== false ? await prepareMaestroSystemPromptCli(agent) : undefined;
				return spawnAgent(agent.toolType, agent.cwd, agentPrompt, agentSessionId, {
					signal: interrupt.signal,
					readOnlyMode: options.readOnly,
					appendSystemPrompt,
					// A send Cue started is still Cue's turn on this agent. Left
					// unset otherwise, so the turn keeps the default origin.
					...(origin.kind === 'cue' ? { querySource: 'cue' as const } : {}),
					customModel: agent.customModel,
					customEffort: agent.customEffort,
					customArgs: agent.customArgs,
					additionalDirectories: agent.additionalDirectories,
					customEnvVars: agent.customEnvVars,
					requiredSecrets: agent.requiredSecrets,
					sshRemoteConfig: agent.sessionSshRemoteConfig,
					// Honor the agent's Claude token source for every CLI transport.
					enableMaestroP: agent.enableMaestroP,
					maestroPMode: agent.maestroPMode,
					maestroPPath: agent.maestroPPath,
					...(nativeControl
						? { harnessControlMode: 'native' as const, nativeSessionId: agent.id }
						: {}),
					// The turn runs in the agent's own cwd (#1872).
					acceptWorkspaceTrust: true,
				});
			},
			settlementFromAgentResult
		);
		const elapsedTimeMs = Date.now() - startedAt;

		const response = buildResponse(agentId, agent.name, result, agent.toolType);
		console.log(JSON.stringify(response, null, 2));

		if (options.history !== false) {
			await recordSendHistory(
				agent,
				message,
				result,
				elapsedTimeMs,
				options,
				origin,
				interrupt.signal
			);
		}
	} finally {
		desktop?.disconnect();
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

// ---------------------------------------------------------------------------
// Federation: `send peer:agent`
// ---------------------------------------------------------------------------

/**
 * The flag a peer send cannot honor, if one was passed. Each changes how the turn runs or is
 * recorded on THIS machine (a read-only spawn, the local system prompt, the local History, a
 * desktop plugin run, the desktop's tab focus). The host runs and records the turn its own way,
 * so the flag is refused rather than silently dropped.
 */
function peerUnsupportedSendFlag(options: SendOptions): string | undefined {
	if (options.readOnly) return '--read-only';
	if (options.tab) return '--tab';
	if (options.requirePluginTools) return '--require-plugin-tools';
	if (options.requireToolReceipt !== undefined) return '--require-tool-receipt';
	if (options.systemPrompt === false) return '--no-system-prompt';
	if (options.history === false) return '--no-history';
	if (options.synopsis === false) return '--no-synopsis';
	return undefined;
}

/** A peer send that stopped short of an outcome. `extra` goes into the JSON as is. */
class PeerSendFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: ExitCode,
		readonly extra: Record<string, unknown> = {}
	) {
		super(message);
		this.name = 'PeerSendFailure';
	}
}

/** How waiting on a host turn ended. */
type PeerTurnEnd =
	| { kind: 'outcome'; outcome: TurnOutcome; error?: AgentError }
	| { kind: 'lost'; reason: string }
	| { kind: 'timeout' };

/** What the host's turn events said, folded. */
interface PeerTurnFacts {
	text: string;
	sessionId?: string;
	usage?: UsageStats;
	error?: AgentError;
}

function foldTurnEvent(facts: PeerTurnFacts, event: TurnEvent): void {
	switch (event.kind) {
		case 'session':
			facts.sessionId = event.providerSessionId;
			break;
		case 'text':
			facts.text += event.text;
			break;
		case 'usage':
			// One report each, the latest standing: never summed (see `TurnEvent`).
			facts.usage = event.usage;
			break;
		case 'error':
			facts.error = event.error;
			break;
	}
}

/**
 * The host tab the turn runs in. Without `--session` a fresh tab, so the turn opens a new provider
 * session, as a local send without `--session` does. With it, the host tab holding that provider
 * session, which must be idle: a message queued behind another turn would be read as this one.
 */
async function pickPeerTab(resolved: ResolvedPeerAgent, session?: string): Promise<string> {
	const { agent, client, peer } = resolved;
	const ref = peerAgentRef(peer, agent.id);
	if (session === undefined) {
		const created = await runPeerAgentAction(client, agent, { kind: 'new-tab' });
		if (!created.ok) throw hostCallError(peer, created.error);
		return (created.value as Extract<PeerAgentActionResult, { kind: 'new-tab' }>).tabId;
	}
	const tab = (agent.aiTabs ?? []).find((t) => t.agentSessionId === session);
	if (!tab) {
		throw new PeerSendFailure(
			'SESSION_NOT_FOUND',
			`No tab of ${ref} holds session ${session}. List its tabs with: maestro-cli show agent ${ref}`,
			ExitCode.GeneralError
		);
	}
	if (tab.state === 'busy') {
		throw new PeerSendFailure(
			'TAB_BUSY',
			`Tab ${tab.id} of ${ref} is mid-turn. Wait for it, or send without --session to start a new session.`,
			ExitCode.GeneralError,
			{ tabId: tab.id }
		);
	}
	return tab.id;
}

/**
 * Send to an agent on a peer's host and wait for the turn to end, as a local send waits for its
 * spawn. The host runs the turn and records its History; this machine records nothing. A forward
 * that drops mid-turn ends the wait, not the turn: the report says the turn is still running on
 * the host and how to find it. Nothing is retried or queued.
 */
async function sendToPeer(
	target: PeerTarget,
	message: string,
	options: SendOptions
): Promise<void> {
	const unsupported = peerUnsupportedSendFlag(options);
	if (unsupported) {
		emitErrorJson(
			`${unsupported} is not available for a peer's agent: the host on peer "${target.peer}" runs and records the turn itself. Send without it.`,
			'PEER_UNSUPPORTED_OPTION'
		);
		process.exit(ExitCode.InvalidUsage);
		return;
	}

	let printed: { response: SendResponse & { peer: string; tabId: string }; ok: boolean } | null =
		null;
	try {
		printed = await withPeerAgent(target, async (resolved) => {
			const { agent, client, peer } = resolved;
			const tabId = await pickPeerTab(resolved, options.session);
			const ref = peerAgentRef(peer, agent.id);
			const where = { agentId: agent.id, agentName: agent.name, peer, tabId };
			const stillRunning = `The turn is still running on peer "${peer}" (tab ${tabId}). Check it with: maestro-cli show agent ${ref}`;

			const facts: PeerTurnFacts = { text: '' };
			let settle: (end: PeerTurnEnd) => void = () => undefined;
			const ended = new Promise<PeerTurnEnd>((resolve) => (settle = resolve));
			// Subscribed before the send, so no event of this turn is missed.
			const offTurn = client.turns.subscribe(agent.id, tabId, (event) => {
				foldTurnEvent(facts, event);
				if (event.kind === 'outcome') {
					settle({ kind: 'outcome', outcome: event.outcome, error: event.error ?? facts.error });
				}
			});
			const offLost = watchPeerConnection(resolved, (reason) => settle({ kind: 'lost', reason }));
			const timer = setTimeout(
				() => settle({ kind: 'timeout' }),
				HEADLESS_RUN_COMPLETION_TIMEOUT_MS
			);
			// Ctrl+C stops the host's turn; its `interrupted` outcome then ends the wait. A second
			// Ctrl+C exits at once.
			const interrupt = installInterruptHandler({
				onFirst: () => void client.turns.interrupt(agent.id, tabId),
			});
			try {
				const sent = await runPeerAgentAction(client, agent, {
					kind: 'send',
					tabId,
					text: message,
				});
				if (!sent.ok) {
					if (sent.error.unknown || sent.error.code === 'host-lost') {
						throw new PeerSendFailure(
							peerErrorCode('connection-lost'),
							`The connection to peer "${peer}" dropped before the host confirmed the message. ${stillRunning}`,
							ExitCode.NotRunning,
							where
						);
					}
					throw hostCallError(peer, sent.error);
				}
				const receipt = (sent.value as Extract<PeerAgentActionResult, { kind: 'send' }>).receipt;
				if (receipt.status === 'queued') {
					throw new PeerSendFailure(
						'QUEUED_ON_PEER',
						`Tab ${tabId} became busy, so the message waits in the host's queue (item ${receipt.itemId}) and runs there. Check it with: maestro-cli show agent ${ref}`,
						ExitCode.GeneralError,
						{ ...where, itemId: receipt.itemId }
					);
				}

				const end = await ended;
				if (end.kind === 'lost') {
					throw new PeerSendFailure(
						peerErrorCode('connection-lost'),
						`The connection to peer "${peer}" dropped mid-turn (${end.reason}). ${stillRunning}`,
						ExitCode.NotRunning,
						{ ...where, sessionId: facts.sessionId ?? null }
					);
				}
				if (end.kind === 'timeout') {
					throw new PeerSendFailure(
						'PEER_TURN_TIMEOUT',
						`Stopped waiting for peer "${peer}" after ${Math.round(HEADLESS_RUN_COMPLETION_TIMEOUT_MS / 60000)} minutes. ${stillRunning}`,
						ExitCode.Timeout,
						{ ...where, sessionId: facts.sessionId ?? null }
					);
				}

				const success = end.outcome === 'completed' || end.outcome === 'completed-with-warning';
				const result: SendAgentResult = {
					success,
					response: facts.text || undefined,
					agentSessionId: facts.sessionId,
					usageStats: facts.usage,
					outcome: end.outcome,
					...(success
						? {}
						: {
								error:
									end.error?.message ??
									(end.outcome === 'interrupted' ? 'Interrupted' : 'The turn crashed on the host'),
							}),
				};
				return {
					response: {
						...buildResponse(agent.id, agent.name, result, agent.toolType as ToolType),
						peer,
						tabId,
					},
					ok: success,
				};
			} finally {
				clearTimeout(timer);
				offTurn();
				offLost();
				interrupt.dispose();
			}
		});
	} catch (error) {
		if (error instanceof PeerSendFailure) {
			console.log(
				JSON.stringify(
					{ success: false, error: error.message, code: error.code, ...error.extra },
					null,
					2
				)
			);
			console.error(`maestro-cli send failed: ${error.message}`);
			process.exit(error.exitCode);
			return;
		}
		if (error instanceof PeerResolveError) {
			console.log(
				JSON.stringify(
					{
						success: false,
						error: error.message,
						code: peerErrorCode(error.code),
						...(error.peer ? { peer: error.peer } : {}),
					},
					null,
					2
				)
			);
			console.error(`maestro-cli send failed: ${error.message}`);
			process.exit(error.exitCode);
			return;
		}
		throw error;
	}

	console.log(JSON.stringify(printed.response, null, 2));
	if (!printed.ok) {
		console.error(`maestro-cli send failed: ${printed.response.error ?? 'unknown error'}`);
		process.exit(printed.response.outcome === 'interrupted' ? 130 : 1);
	}
}
