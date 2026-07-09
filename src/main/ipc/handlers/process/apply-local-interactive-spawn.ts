import * as path from 'path';
import type { AgentConfig } from '../../../agents/definitions';
import { applyClaudeSpawnDecision } from '../../../agents/resolveClaudeSpawnMode';
import { isMaestroPBinaryPath } from '../../../agents/claude-usage-startup';
import { logger } from '../../../utils/logger';
import type { ClaudeSpawnContext } from './resolve-claude-spawn-context';
import type { SpawnProcessConfig } from './spawn-types';

const LOG_CONTEXT = '[ProcessManager]';

export interface LocalInteractiveSpawnInput {
	config: SpawnProcessConfig;
	agent: AgentConfig | null;
	claudeContext: ClaudeSpawnContext;
	commandToSpawn: string;
	argsToSpawn: string[];
	customEnvVarsToPass: Record<string, string> | undefined;
}

export interface LocalInteractiveSpawnResult {
	commandToSpawn: string;
	argsToSpawn: string[];
	customEnvVarsToPass: Record<string, string> | undefined;
}

/**
 * Local interactive (maestro-p): realize command/args/env via the shared
 * helper used by Cue, group chat, and tab naming.
 */
export function applyLocalInteractiveSpawnDecision(
	input: LocalInteractiveSpawnInput
): LocalInteractiveSpawnResult {
	const { config, agent, claudeContext, commandToSpawn, argsToSpawn, customEnvVarsToPass } = input;
	const {
		claudeResolvedMode,
		claudeResolvedReason,
		resolvedMaestroPBinPath,
		resolvedConfigDirKey,
		claudeDecisionRealBinPath,
		claudeResolvedRemote,
	} = claudeContext;

	if (
		config.sessionSshRemoteConfig?.enabled ||
		claudeResolvedMode !== 'interactive' ||
		!resolvedMaestroPBinPath
	) {
		return { commandToSpawn, argsToSpawn, customEnvVarsToPass };
	}

	const detectedClaudePath =
		agent?.path && !isMaestroPBinaryPath(agent.path) ? agent.path : undefined;
	const decisionClaudePath =
		claudeDecisionRealBinPath && !isMaestroPBinaryPath(claudeDecisionRealBinPath)
			? claudeDecisionRealBinPath
			: undefined;
	// Prefer the detector's absolute path when the spawn payload only has
	// the bare `claude` command, matching the user's shell `which claude`.
	const claudeCommandForInteractive =
		(path.isAbsolute(decisionClaudePath ?? '') ? decisionClaudePath : undefined) ??
		detectedClaudePath ??
		decisionClaudePath ??
		config.sessionCustomPath ??
		config.command;

	const applied = applyClaudeSpawnDecision({
		decision: {
			mode: claudeResolvedMode,
			reason: claudeResolvedReason,
			maestroPBinPath: resolvedMaestroPBinPath,
			claudeRealBinPath: claudeCommandForInteractive,
			configDirKey: resolvedConfigDirKey,
			remote: claudeResolvedRemote,
		},
		interactiveModeArgs: agent?.interactiveModeArgs,
		command: claudeCommandForInteractive,
		args: argsToSpawn,
		customEnvVars: customEnvVarsToPass,
	});

	logger.debug('Spawning Claude Code in interactive mode (maestro-p)', LOG_CONTEXT, {
		sessionId: config.sessionId,
		maestroPBin: resolvedMaestroPBinPath,
		claudeRealBin: claudeCommandForInteractive,
		configDirKey: resolvedConfigDirKey,
	});

	return {
		commandToSpawn: applied.command,
		argsToSpawn: applied.args,
		customEnvVarsToPass: applied.customEnvVars,
	};
}
