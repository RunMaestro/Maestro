import {
	getClaudeTokenSourceFields,
	type ClaudeTokenSourceFields,
} from '../../../../shared/claudeTokenMode';
import type { AgentConfig } from '../../../../shared/types';
import type { ProcessConfig, Session } from '../../../types';

export type SynopsisSessionConfig = ClaudeTokenSourceFields & {
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	customContextWindow?: number;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
};

type AgentExecutionSpawnConfig = ProcessConfig & ClaudeTokenSourceFields;
type SpawnAgent = Pick<AgentConfig, 'args'>;

export interface BatchAgentSpawnInput {
	targetSessionId: string;
	session: Session;
	command: string;
	agent: SpawnAgent;
	cwd: string;
	prompt: string;
	appendSystemPrompt?: string;
	sendPromptViaStdin: boolean;
	sendPromptViaStdinRaw: boolean;
}

/** Builds the complete, side-effect-free batch spawn payload. */
export function createBatchAgentSpawnConfig(input: BatchAgentSpawnInput): ProcessConfig {
	const {
		targetSessionId,
		session,
		command,
		agent,
		cwd,
		prompt,
		appendSystemPrompt,
		sendPromptViaStdin,
		sendPromptViaStdinRaw,
	} = input;
	return {
		sessionId: targetSessionId,
		toolType: session.toolType,
		cwd,
		command,
		args: agent.args || [],
		prompt,
		appendSystemPrompt,
		readOnlyMode: false,
		permissionMode: 'full',
		sessionCustomPath: session.customPath,
		sessionCustomArgs: session.customArgs,
		sessionAdditionalDirectories: session.additionalDirectories,
		sessionCustomEnvVars: session.customEnvVars,
		sessionCustomModel: session.customModel,
		sessionCustomEffort: session.customEffort,
		sessionCustomContextWindow: session.customContextWindow,
		sessionSshRemoteConfig: session.sessionSshRemoteConfig,
		sendPromptViaStdin,
		sendPromptViaStdinRaw,
	};
}

export interface SynopsisAgentSpawnInput {
	targetSessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt: string;
	agentSessionId: string;
	sessionConfig?: SynopsisSessionConfig;
	sessionSshRemoteConfig?: ProcessConfig['sessionSshRemoteConfig'];
	sendPromptViaStdin: boolean;
	sendPromptViaStdinRaw: boolean;
}

/** Builds the complete, side-effect-free resumed synopsis spawn payload. */
export function createSynopsisAgentSpawnConfig(
	input: SynopsisAgentSpawnInput
): AgentExecutionSpawnConfig {
	return {
		sessionId: input.targetSessionId,
		toolType: input.toolType,
		cwd: input.cwd,
		command: input.command,
		args: input.args,
		prompt: input.prompt,
		agentSessionId: input.agentSessionId,
		sessionCustomPath: input.sessionConfig?.customPath,
		sessionCustomArgs: input.sessionConfig?.customArgs,
		sessionCustomEnvVars: input.sessionConfig?.customEnvVars,
		sessionCustomModel: input.sessionConfig?.customModel,
		sessionCustomContextWindow: input.sessionConfig?.customContextWindow,
		...getClaudeTokenSourceFields(input.sessionConfig),
		sessionSshRemoteConfig: input.sessionSshRemoteConfig,
		sendPromptViaStdin: input.sendPromptViaStdin,
		sendPromptViaStdinRaw: input.sendPromptViaStdinRaw,
	};
}
