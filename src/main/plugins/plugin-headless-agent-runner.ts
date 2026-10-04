/** One host-owned, headless provider turn, shared by plugin send and CLI send. */
import type { SessionInfo } from '../../shared/types';
import type { AgentResult, SpawnAgentOptions } from '../../cli/services/agent-spawner';
import type { HeadlessAgentRunner } from './plugin-manager-singleton';
import { createPluginRunProofFile, removePluginRunProofFile } from './plugin-tool-run-identity';
import { logger } from '../utils/logger';

const HEADLESS_RUN_TIMEOUT_MS = 20 * 60_000;

export interface PluginHeadlessRunnerDeps {
	getAgent: (agentId: string) => SessionInfo | undefined;
	detectAgent: (type: SessionInfo['toolType']) => Promise<{ available: boolean }>;
	hasPluginTools: () => boolean;
	spawn: (
		type: SessionInfo['toolType'],
		cwd: string,
		prompt: string,
		sessionId?: string,
		options?: SpawnAgentOptions
	) => Promise<AgentResult>;
	prepareSystemPrompt: (agent: SessionInfo) => Promise<string | undefined>;
	issueRunToken: (agentId: string, ttlMs: number) => string;
	revokeRunToken: (token: string) => void;
	cliScriptPath: () => string;
	audit: (agentId: string, resumed: boolean) => void;
}

export function createPluginHeadlessAgentRunner(
	deps: PluginHeadlessRunnerDeps
): HeadlessAgentRunner {
	return async (agentId, prompt, providerSessionId, signal, origin = 'auto', onProgress) => {
		const agent = deps.getAgent(agentId);
		if (!agent) throw new Error(`agents.send: no agent "${agentId}"`);
		const local = !agent.sessionSshRemoteConfig?.enabled;
		if (local && !(await deps.detectAgent(agent.toolType)).available) {
			return {
				success: false,
				response: null,
				sessionId: null,
				error: `Agent CLI unavailable: ${agent.toolType}`,
			};
		}
		const runToken =
			local && deps.hasPluginTools()
				? deps.issueRunToken(agent.id, HEADLESS_RUN_TIMEOUT_MS + 60_000)
				: undefined;
		let pluginRunProofFile: string | undefined;
		try {
			pluginRunProofFile = runToken
				? createPluginRunProofFile(runToken, HEADLESS_RUN_TIMEOUT_MS + 60_000)
				: undefined;
			deps.audit(agent.id, !!providerSessionId);
			if (signal?.aborted) {
				return {
					success: false,
					response: null,
					sessionId: null,
					error: 'Agent run timed out or was cancelled',
				};
			}
			const result = await deps.spawn(agent.toolType, agent.cwd, prompt, providerSessionId, {
				customModel: agent.customModel,
				customEffort: agent.customEffort,
				customArgs: agent.customArgs,
				customEnvVars: agent.customEnvVars,
				additionalDirectories: agent.additionalDirectories,
				sshRemoteConfig: agent.sessionSshRemoteConfig,
				appendSystemPrompt: await deps.prepareSystemPrompt(agent),
				enableMaestroP: agent.enableMaestroP,
				maestroPMode: agent.maestroPMode,
				maestroPPath: agent.maestroPPath,
				querySource: origin,
				pluginRunProofFile,
				mcpCliScriptPath: deps.cliScriptPath(),
				timeoutMs: HEADLESS_RUN_TIMEOUT_MS,
				signal,
				onProgress,
			});
			const success =
				result.success &&
				typeof result.response === 'string' &&
				result.response.trim().length > 0 &&
				!signal?.aborted;
			return {
				success,
				response: success ? result.response! : null,
				sessionId: result.agentSessionId ?? null,
				usageStats: result.usageStats,
				...(success ? {} : { error: result.error ?? 'Agent run failed or returned no final text' }),
			};
		} finally {
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
