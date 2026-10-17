/** One host-owned, headless provider turn, shared by plugin send and CLI send. */
import type { SessionInfo } from '../../shared/types';
import type { AgentResult, SpawnAgentOptions } from '../../cli/services/agent-spawner';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { createPluginRunProofFile, removePluginRunProofFile } from './plugin-tool-run-identity';
import type { PluginToolReceipt } from './plugin-tool-run-identity';
import { MCP_CONFIG_BY_AGENT } from '../../shared/plugins/mcp-agent-config';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { getClaudeTokenMode } from '../../shared/claudeTokenMode';
import { trackHeadlessAgentActivity } from '../utils/headless-agent-activity';
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
	detectAgent: (type: SessionInfo['toolType']) => Promise<{ available: boolean; path?: string }>;
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
	prepareSystemPrompt: (agent: SessionInfo) => Promise<string | undefined>;
	issueRunToken: (agentId: string, ttlMs: number, receiptToolId?: string) => string;
	getRunReceipts?: (token: string) => PluginToolReceipt[];
	hasRunReceiptOverflow?: (token: string) => boolean;
	revokeRunToken: (token: string) => void;
	cliScriptPath: () => string;
	audit: (agentId: string, resumed: boolean) => void;
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
		requirePluginTools = false
	) => {
		// Detection and prompt preparation consume the same host ceiling as spawn;
		// a slow preflight must not outlive the CLI's absolute reply wait.
		const deadlineAt = Date.now() + HEADLESS_RUN_TIMEOUT_MS;
		const agent = deps.getAgent(agentId);
		if (!agent) throw new Error(`agents.send: no agent "${agentId}"`);
		const local = !agent.sessionSshRemoteConfig?.enabled;
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
		const customBinary =
			local && agent.customPath ? await checkCustomPath(agent.customPath) : undefined;
		const detection = local
			? customBinary
				? { available: customBinary.exists, path: customBinary.path }
				: await deps.detectAgent(agent.toolType)
			: undefined;
		if (local && !detection?.available) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: `Agent CLI unavailable: ${agent.toolType}`,
			};
		}
		// Complete asynchronous preparation before issuing time-bounded run authority.
		const systemPrompt = signal?.aborted ? undefined : await deps.prepareSystemPrompt(agent);
		const remainingMs = Math.max(0, deadlineAt - Date.now());
		const completionTtlMs = Math.min(
			HEADLESS_RUN_COMPLETION_TIMEOUT_MS,
			remainingMs + HEADLESS_RUN_CLEANUP_MARGIN_MS
		);
		const runToken =
			local && deps.hasPluginTools() && !signal?.aborted && remainingMs > 0
				? deps.issueRunToken(agent.id, completionTtlMs, receiptToolId)
				: undefined;
		let pluginRunProofFile: string | undefined;
		let releaseActivity: (() => void) | undefined;
		let settled = false;
		let conversationId = providerSessionId;
		try {
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
						? 'Agent run timed out or was cancelled'
						: 'Agent run stopped: absolute runtime ceiling exceeded',
				};
			}
			const result = await deps.spawn(agent.toolType, agent.cwd, prompt, providerSessionId, {
				customModel: agent.customModel,
				customEffort: agent.customEffort,
				customArgs: agent.customArgs,
				customEnvVars: agent.customEnvVars,
				globalEnvVars: deps.getGlobalEnvVars?.(),
				agentConfigValues: deps.getAgentConfig?.(agent.toolType),
				agentCommand: detection?.path,
				additionalDirectories: agent.additionalDirectories,
				sshRemoteConfig: agent.sessionSshRemoteConfig,
				appendSystemPrompt: systemPrompt,
				enableMaestroP: agent.enableMaestroP,
				maestroPMode: agent.maestroPMode,
				maestroPPath: agent.maestroPPath,
				querySource: origin === 'relay' ? 'auto' : origin,
				pluginRunProofFile,
				mcpCliScriptPath: deps.cliScriptPath(),
				timeoutMs: remainingMs,
				idle: deps.idleProfile ?? HEADLESS_IDLE_PROFILE,
				signal,
				onProcessStarted: (pid) => {
					if (pid && !signal?.aborted && !settled && !releaseActivity) {
						releaseActivity = trackHeadlessAgentActivity(agent.id);
					}
				},
				onProgress,
			});
			conversationId = result.agentSessionId || providerSessionId;

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
				...(receiptToolId && runToken ? { toolReceipts: deps.getRunReceipts!(runToken) } : {}),
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
			if (origin === 'relay' && conversationId) {
				try {
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
