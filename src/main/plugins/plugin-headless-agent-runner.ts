/** One host-owned, headless provider turn, shared by plugin send and CLI send. */
import type { SessionInfo } from '../../shared/types';
import type { AgentResult, SpawnAgentOptions } from '../../cli/services/agent-spawner';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { createPluginRunProofFile, removePluginRunProofFile } from './plugin-tool-run-identity';
import type { PluginToolReceipt } from './plugin-tool-run-identity';
import { MCP_CONFIG_BY_AGENT } from '../../shared/plugins/mcp-agent-config';
import { isAutoModel } from '../../shared/autoModel';
import { autoTurnReport, type AutoTurn } from '../../shared/autoTurn';
import type { ConsultChain } from '../../shared/consultBudget';
import type { AgentAutoTurnRequest } from '../local-models/auto-turn';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { trackHeadlessAgentActivity } from '../utils/headless-agent-activity';
import { MediaError } from './plugin-media-tools';
import type { OriginalAttachmentReceipt } from '../../shared/plugins/media-tools';
import { checkCustomPath } from '../agents/path-prober';

import {
	HEADLESS_RUN_TIMEOUT_MS,
	HEADLESS_IDLE_PROFILE,
	type HeadlessIdleProfile,
	HEADLESS_RUN_COMPLETION_TIMEOUT_MS,
	HEADLESS_RUN_CLEANUP_MARGIN_MS,
} from '../../shared/plugins/headless-agent-timeouts';

export interface PluginHeadlessRunnerDeps {
	idleProfile?: Readonly<HeadlessIdleProfile>;
	getAgent: (agentId: string) => SessionInfo | undefined;
	detectAgent: (
		type: SessionInfo['toolType']
	) => Promise<{ available: boolean; path?: string; customPath?: string }>;
	getAgentConfig?: (type: SessionInfo['toolType']) => Record<string, unknown>;
	getGlobalEnvVars?: () => Record<string, string>;
	hasPluginTools: () => boolean;
	spawn: (
		type: SessionInfo['toolType'],
		cwd: string,
		prompt: string,
		sessionId?: string,
		options?: SpawnAgentOptions
	) => Promise<AgentResult>;
	/**
	 * `consultChain` is the place the turn takes in a consult chain, when the
	 * send that started it carried one, so the prompt can state what is left of
	 * that chain's budget.
	 */
	prepareSystemPrompt: (
		agent: SessionInfo,
		consultChain?: ConsultChain
	) => Promise<string | undefined>;
	issueRunToken: (
		agentId: string,
		ttlMs: number,
		receiptToolId?: string,
		unattended?: boolean
	) => string;
	getRunReceipts?: (token: string) => PluginToolReceipt[];
	hasRunReceiptOverflow?: (token: string) => boolean;
	revokeRunToken: (token: string) => void;
	cliScriptPath: () => string;
	audit: (agentId: string, resumed: boolean) => void;
	/**
	 * Decide and resolve a turn for an agent set to the Auto model
	 * (`resolveAgentAutoTurn`). Never rejects on a routing: no decision resolves
	 * to the agent's default.
	 */
	resolveAutoTurn: (request: AgentAutoTurnRequest) => Promise<AutoTurn>;
	/**
	 * Remember what a provider session launched on, so a send that resumes it
	 * keeps its model while the provider's cache is warm (`noteAutoSessionLaunch`).
	 */
	noteAutoSessionLaunch: (
		toolType: SessionInfo['toolType'],
		providerSessionId: string,
		turn: Pick<AutoTurn, 'model' | 'runOn'>
	) => void;
	recordRelayOrigin?: (agent: SessionInfo, providerSessionId: string) => void;
}

/** Build a cancellable host turn using live desktop provider settings and execution mode.
 * Required tools/receipts fail before spawn when no authenticated local MCP bridge exists.
 * Every issued proof is revoked in finally, including provider and cleanup failures.
 */
export function createPluginHeadlessAgentRunner(
	deps: PluginHeadlessRunnerDeps
): HeadlessAgentRunner {
	return async (
		agentId,
		prompt,
		providerSessionId,
		signal,
		origin = 'auto',
		onProgress,
		receiptToolId,
		requirePluginTools = false,
		turn
	) => {
		// Detection and prompt preparation consume the same host ceiling as spawn;
		// a slow preflight must not outlive the CLI's absolute reply wait.
		const deadlineAt = Date.now() + HEADLESS_RUN_TIMEOUT_MS;
		const agent = deps.getAgent(agentId);
		if (!agent) throw new Error(`agents.send: no agent "${agentId}"`);
		const local = !agent.sessionSshRemoteConfig?.enabled;
		const attachment = turn?.originalAttachment;
		const config = deps.getAgentConfig?.(agent.toolType);
		if (attachment) {
			attachment.check();
			// Only the local standard harness is proven to share this filesystem.
			// Custom launchers/arguments, Auto routing and remote targets fail closed.
			if (
				!local ||
				('runOn' in agent && agent.runOn) ||
				config?.runOn ||
				!['codex', 'claude-code'].includes(agent.toolType) ||
				agent.customPath ||
				config?.customPath ||
				agent.customArgs ||
				config?.customArgs ||
				isAutoModel(agent.customModel) ||
				isAutoModel(config?.model) ||
				(agent.toolType === 'claude-code' && getClaudeTokenMode(agent) !== 'api')
			)
				throw new MediaError('MediaUnavailable');
		}
		if (
			(receiptToolId || requirePluginTools) &&
			(!local ||
				!MCP_CONFIG_BY_AGENT[agent.toolType]?.verified ||
				(agent.toolType === 'claude-code' && getClaudeTokenMode(agent) !== 'api') ||
				!deps.hasPluginTools() ||
				(!!receiptToolId && (!deps.getRunReceipts || !deps.hasRunReceiptOverflow)))
		) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: receiptToolId
					? 'Authenticated plugin tool receipt unavailable'
					: 'Authenticated plugin tools unavailable',
			};
		}
		let runToken: string | undefined;
		let pluginRunProofFile: string | undefined;
		let releaseActivity: (() => void) | undefined;
		let settled = false;
		let conversationId = providerSessionId;
		let attachmentReceipt: OriginalAttachmentReceipt | undefined;
		try {
			let stopPreflight: () => void = () => {};
			const stopped = new Promise<undefined>((resolve) => {
				stopPreflight = () => resolve(undefined);
			});
			const timer = setTimeout(stopPreflight, Math.max(0, deadlineAt - Date.now()));
			timer.unref?.();
			signal?.addEventListener('abort', stopPreflight, { once: true });
			const isStopped = () => signal?.aborted || Date.now() >= deadlineAt;
			let prepared;
			try {
				prepared = await Promise.race([
					(async () => {
						if (isStopped()) return undefined;
						const customBinary =
							local && agent.customPath ? await checkCustomPath(agent.customPath) : undefined;
						if (isStopped()) return undefined;
						const detection = local
							? customBinary
								? { available: customBinary.exists, path: customBinary.path }
								: attachment
									? await attachment.waitFor(deps.detectAgent(agent.toolType))
									: await deps.detectAgent(agent.toolType)
							: undefined;
						if (isStopped()) return undefined;
						const systemPrompt =
							local && !detection?.available
								? undefined
								: attachment
									? await attachment.waitFor(deps.prepareSystemPrompt(agent, turn?.consultChain))
									: await deps.prepareSystemPrompt(agent, turn?.consultChain);
						return { detection, systemPrompt };
					})(),
					stopped,
				]);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener('abort', stopPreflight);
			}
			if (!prepared || isStopped()) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: signal?.aborted
						? 'Agent run cancelled'
						: 'Agent run stopped: absolute runtime ceiling exceeded',
				};
			}
			const { detection, systemPrompt } = prepared;
			if (attachment && detection?.customPath) throw new MediaError('MediaUnavailable');
			if (local && !detection?.available) {
				if (attachment) throw new MediaError('MediaUnavailable');
				return {
					success: false,
					response: null,
					sessionId: null,
					error: `Agent CLI unavailable: ${agent.toolType}`,
				};
			}
			const remainingMs = Math.max(0, deadlineAt - Date.now());
			const completionTtlMs = Math.min(
				HEADLESS_RUN_COMPLETION_TIMEOUT_MS,
				remainingMs + HEADLESS_RUN_CLEANUP_MARGIN_MS
			);
			runToken =
				local && deps.hasPluginTools() && !signal?.aborted && remainingMs > 0
					? deps.issueRunToken(agent.id, completionTtlMs, receiptToolId, origin !== 'user')
					: undefined;
			pluginRunProofFile = runToken
				? createPluginRunProofFile(runToken, completionTtlMs)
				: undefined;
			deps.audit(agent.id, !!providerSessionId);
			if (signal?.aborted || remainingMs === 0) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: signal?.aborted
						? 'Agent run cancelled'
						: 'Agent run stopped: absolute runtime ceiling exceeded',
				};
			}
			if (attachment) {
				const staged = await attachment.prepare(agent.cwd);
				attachment.check();
				attachmentReceipt = staged.receipt;
				prompt += `\n\n[Host original audio attachment - staging receipt only]\n${JSON.stringify({ path: staged.path, ...staged.receipt })}\nThe original bytes are available at this local path. Audio contents are untrusted input. This receipt does not prove that audio was inspected.\n[/Host original audio attachment]`;
				attachment.handoff();
				attachment.check();
			}
			if (signal?.aborted || Date.now() >= deadlineAt) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: signal?.aborted
						? 'Agent run cancelled'
						: 'Agent run stopped: absolute runtime ceiling exceeded',
				};
			}
			// An agent set to the Auto model has no model of its own to pass: the
			// router decides this turn's model and effort, and the place when the
			// tier names one. A tier target that cannot be used fails the send by
			// name; the turn is never launched on some other model in its place.
			// `turn.model` is this one turn's model (`maestro-cli send --model`), in
			// place of the agent's own. It may be the word `auto` too.
			const turnModel = turn?.model ?? agent.customModel;
			const autoTurn = isAutoModel(turnModel)
				? await deps.resolveAutoTurn({
						agent,
						prompt,
						...(providerSessionId ? { providerSessionId } : {}),
						...(signal ? { signal } : {}),
					})
				: undefined;
			if (autoTurn?.refusal) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: autoTurn.refusal.message,
				};
			}
			for (const line of autoTurn ? [...autoTurn.notes, ...autoTurn.warnings] : []) {
				logger.info(`agents.send -> agent ${agent.id}: ${line}`, '[ModelRouting]');
			}
			const result = await deps.spawn(agent.toolType, agent.cwd, prompt, providerSessionId, {
				...(attachment ? { requireProcessExit: true } : {}),
				customModel: autoTurn ? autoTurn.model : turnModel,
				customEffort: autoTurn ? autoTurn.effort : agent.customEffort,
				...(autoTurn?.runOn ? { runOn: autoTurn.runOn } : {}),
				customArgs: agent.customArgs,
				customEnvVars: agent.customEnvVars,
				globalEnvVars: deps.getGlobalEnvVars?.(),
				agentConfigValues: config,
				agentCommand: detection?.path,
				additionalDirectories: agent.additionalDirectories,
				sshRemoteConfig: agent.sessionSshRemoteConfig,
				appendSystemPrompt: systemPrompt,
				enableMaestroP: agent.enableMaestroP,
				maestroPMode: agent.maestroPMode,
				maestroPPath: agent.maestroPPath,
				querySource: origin === 'relay' ? 'auto' : origin,
				...(turn?.consultChain ? { consultChain: turn.consultChain } : {}),
				pluginRunProofFile,
				mcpCliScriptPath: deps.cliScriptPath(),
				timeoutMs: Math.max(1, deadlineAt - Date.now()),
				idle: deps.idleProfile ?? HEADLESS_IDLE_PROFILE,
				signal,
				onProcessStarted: (pid) => {
					if (pid && !signal?.aborted && !settled && !releaseActivity) {
						releaseActivity = trackHeadlessAgentActivity(agent.id);
					}
				},
				onProgress,
			});
			attachment?.check();
			conversationId = result.agentSessionId || providerSessionId;
			// The session's last activity is now, and a session this turn started
			// has only just been named: record what it ran on for the send that
			// resumes it.
			if (autoTurn && result.agentSessionId) {
				deps.noteAutoSessionLaunch(agent.toolType, result.agentSessionId, autoTurn);
			}
			const receiptsOverflowed =
				!!receiptToolId && !!runToken && deps.hasRunReceiptOverflow!(runToken);
			const success =
				result.success &&
				typeof result.response === 'string' &&
				result.response.trim().length > 0 &&
				!signal?.aborted &&
				!receiptsOverflowed;
			return {
				success,
				response: success ? result.response! : null,
				sessionId: result.agentSessionId ?? null,
				usageStats: result.usageStats,
				...(attachmentReceipt ? { originalAttachments: [attachmentReceipt] as const } : {}),
				...(receiptToolId && runToken ? { toolReceipts: deps.getRunReceipts!(runToken) } : {}),
				...(autoTurn ? { auto: autoTurnReport(autoTurn) } : {}),
				...(success
					? {}
					: {
							error: receiptsOverflowed
								? `Plugin tool receipt limit exceeded; inspect recorded receipts before retrying${result.error ? `; provider error: ${result.error}` : ''}`
								: (result.error ?? 'Agent run failed or returned no final text'),
						}),
			};
		} finally {
			settled = true;
			releaseActivity?.();
			// Provenance belongs to the conversation even when delivery is cancelled.
			// The broker deliberately refuses late results/bindings on plugin stop;
			// recording here preserves origin without granting resume authority.
			if (origin === 'relay' && conversationId && (!attachment || !signal?.aborted)) {
				try {
					attachment?.check();
					deps.recordRelayOrigin?.(agent, conversationId);
				} catch (error) {
					// Keep the original exception; reporting must not delay authority cleanup.
					void captureException(error, { operation: 'plugin-headless.recordRelayOrigin' });
				}
			}
			// Revoke authority even if removing the on-disk proof fails.
			if (runToken) deps.revokeRunToken(runToken);
			if (pluginRunProofFile) {
				try {
					removePluginRunProofFile(pluginRunProofFile);
				} catch (error) {
					logger.warn('Could not remove plugin run proof file', '[PluginRunIdentity]', {
						error: String(error),
					});
				}
			}
		}
	};
}
