import type { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import type { AgentOutputParser } from '../parsers';
import type { AgentError } from '../../shared/types';

/**
 * Configuration for spawning a new process
 */
export interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	requiresPty?: boolean;
	prompt?: string;
	shell?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	images?: string[];
	imageArgs?: (imagePath: string) => string[];
	promptArgs?: (prompt: string) => string[];
	contextWindow?: number;
	customEnvVars?: Record<string, string>;
	noPromptSeparator?: boolean;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	/** If true, always spawn in a shell (for PATH resolution on Windows) */
	runInShell?: boolean;
	/** If true, send the prompt via stdin as JSON instead of command line */
	sendPromptViaStdin?: boolean;
}

/**
 * Internal representation of a managed process
 */
export interface ManagedProcess {
	sessionId: string;
	toolType: string;
	ptyProcess?: IPty;
	childProcess?: ChildProcess;
	cwd: string;
	pid: number;
	isTerminal: boolean;
	isBatchMode?: boolean;
	isStreamJsonMode?: boolean;
	jsonBuffer?: string;
	lastCommand?: string;
	sessionIdEmitted?: boolean;
	resultEmitted?: boolean;
	errorEmitted?: boolean;
	startTime: number;
	outputParser?: AgentOutputParser;
	stderrBuffer?: string;
	stdoutBuffer?: string;
	streamedText?: string;
	contextWindow?: number;
	tempImageFiles?: string[];
	command?: string;
	args?: string[];
	lastUsageTotals?: UsageTotals;
	usageIsCumulative?: boolean;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	dataBuffer?: string;
	dataBufferTimeout?: NodeJS.Timeout;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	reasoningTokens?: number;
}

export interface SpawnResult {
	pid: number;
	success: boolean;
}

export interface CommandResult {
	exitCode: number;
}

/**
 * Events emitted by ProcessManager
 */
export interface ProcessManagerEvents {
	data: (sessionId: string, data: string) => void;
	stderr: (sessionId: string, data: string) => void;
	exit: (sessionId: string, code: number) => void;
	'command-exit': (sessionId: string, code: number) => void;
	usage: (sessionId: string, stats: UsageStats) => void;
	'session-id': (sessionId: string, agentSessionId: string) => void;
	'agent-error': (sessionId: string, error: AgentError) => void;
	'thinking-chunk': (sessionId: string, text: string) => void;
	'tool-execution': (sessionId: string, tool: ToolExecution) => void;
	'slash-commands': (sessionId: string, commands: unknown[]) => void;
	'query-complete': (sessionId: string, data: QueryCompleteData) => void;
}

export interface ToolExecution {
	toolName: string;
	state: unknown;
	timestamp: number;
}

export interface QueryCompleteData {
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto';
	startTime: number;
	duration: number;
	projectPath?: string;
	tabId?: string;
}

// Re-export for backwards compatibility
export type { ParsedEvent, AgentOutputParser } from '../parsers';
export type { AgentError, AgentErrorType, SshRemoteConfig } from '../../shared/types';
