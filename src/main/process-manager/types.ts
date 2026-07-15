import type { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentOutputParser } from '../parsers';
import type { AgentError } from '../../shared/types';

/**
 * Kill/interrupt handle for server-backed processes that have no OS child
 * (currently the OpenCode SDK path). ProcessManager routes kill()/interrupt()
 * here when `ManagedProcess.sdkController` is set.
 */
export interface SdkProcessController {
	/** Abort the in-flight turn; the session/stream stays alive. */
	interrupt: () => void;
	/** Hard stop: abort the turn and tear down the event subscription. */
	kill: () => void;
}

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
	imagePromptBuilder?: (imagePaths: string[]) => string;
	promptArgs?: (prompt: string) => string[];
	contextWindow?: number;
	customEnvVars?: Record<string, string>;
	noPromptSeparator?: boolean;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	/**
	 * Identity key for the omp model->context-window catalog (see
	 * `computeOmpCatalogKey`). Set only for local omp spawns; carried onto the
	 * managed process so StdoutHandler resolves against the catalog primed for
	 * this exact binary + env, never another configuration's.
	 */
	ompModelCatalogKey?: string;
	/** If true, always spawn in a shell (for PATH resolution on Windows) */
	runInShell?: boolean;
	/** If true, send the prompt via stdin as JSON instead of command line */
	sendPromptViaStdin?: boolean;
	/** If true, send the prompt via stdin as raw text instead of command line */
	sendPromptViaStdinRaw?: boolean;
	/** If true, the prompt is already embedded in `args` by the caller. The spawner
	 *  must not append it again. Used by SSH tab naming for non-stream-json agents:
	 *  the prompt has to live inside the `bash -c '<cmd>'` wrapper, otherwise it
	 *  ends up as a positional arg to the remote bash and never reaches the agent. */
	promptAlreadyInArgs?: boolean;
	/** Script to send via stdin for SSH execution (bypasses shell escaping) */
	sshStdinScript?: string;
	/** Human-readable remote command line (the actual agent invocation running on the
	 *  remote host). Surfaced in Process Details above the local SSH command. */
	sshRemoteCommand?: string;
	/** PTY terminal width in columns (default 80) */
	cols?: number;
	/** PTY terminal height in rows (default 24) */
	rows?: number;
	/** Extra directories to prepend to the spawn-time PATH. Typically the
	 *  parent directory of the detected agent binary, so co-located runtimes
	 *  (e.g. the `node` next to an npm-installed `codex`) resolve via the
	 *  script's `#!/usr/bin/env node` shebang. Local spawn only — SSH builds
	 *  its remote PATH separately. */
	extraPathDirs?: string[];
	/** Agent-reported session id when this spawn is resuming a prior session
	 *  (e.g. Copilot's `--resume=<id>`, Claude's `--resume <id>`). The spawner
	 *  uses it to seed `ManagedProcess.agentSessionId` so post-exit work that
	 *  needs to inspect on-disk session state (Copilot's events.jsonl) can run
	 *  even when the resumed stream never re-announces the sessionId — Copilot
	 *  in particular emits `session.resume` (no sessionId) on resume rather
	 *  than `session.start`, so without this seed the disk reconciliation
	 *  never runs and the renderer falls back to streamed commentary instead
	 *  of the authoritative final answer / context window snapshot. */
	agentSessionId?: string;
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
	/** When true, the JSON buffer was force-cleared after exceeding size limits.
	 *  Subsequent chunks are discarded until a clean top-level `{` resync point. */
	jsonBufferCorrupted?: boolean;
	lastCommand?: string;
	sessionIdEmitted?: boolean;
	/** Agent-reported session id once extracted from the output stream.
	 *  Currently only populated for agents whose post-exit lifecycle we
	 *  need to inspect on disk (Copilot CLI events.jsonl). */
	agentSessionId?: string;
	resultEmitted?: boolean;
	errorEmitted?: boolean;
	/** Set by `ProcessManager.interrupt()` before it sends SIGINT (or writes
	 *  Ctrl+C). Lets the exit path tell a user-initiated stop apart from a real
	 *  silent crash: an interrupted turn that exits with a null signal code
	 *  (coerced to 0 by the spawner's `close` handler) must NOT be surfaced as an
	 *  "exited without producing a response" error. */
	interrupted?: boolean;
	startTime: number;
	outputParser?: AgentOutputParser;
	stderrBuffer?: string;
	stdoutBuffer?: string;
	streamedText?: string;
	contextWindow?: number;
	ompModelCatalogKey?: string;
	tempImageFiles?: string[];
	command?: string;
	args?: string[];
	lastUsageTotals?: UsageTotals;
	usageIsCumulative?: boolean;
	emittedToolCallIds?: Set<string>;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	/** Human-readable remote command line for SSH spawns (the agent invocation that
	 *  runs on the remote host). Shown in Process Details above the local SSH command. */
	sshRemoteCommand?: string;
	dataBuffer?: string;
	dataBufferTimeout?: NodeJS.Timeout;
	/** Env vars Maestro explicitly set on this process (global + agent + session overrides),
	 *  with `~/` paths expanded and MAESTRO_SESSION_RESUMED included when applicable.
	 *  Inherited system env is NOT included — this is the actionable set shown in the
	 *  Process Details modal. */
	maestroEnvVars?: Record<string, string>;
	/** Kill/interrupt handle for server-backed processes (OpenCode SDK path). When
	 *  set, this process has no `ptyProcess`/`childProcess`; ProcessManager routes
	 *  lifecycle calls through here instead of OS signals. */
	sdkController?: SdkProcessController;
	/** OpenCode server session id for the SDK path (used to abort the turn). */
	opencodeSessionId?: string;
	/** OpenCode SDK client bound to the shared server, for abort calls. */
	opencodeClient?: OpencodeClient;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

// Import and re-export UsageStats from canonical location
import type { UsageStats } from '../../shared/types';
export type { UsageStats } from '../../shared/types';

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
	/** `signal` is set only when the process was terminated by a signal
	 *  (WIFSIGNALED). node-pty reports those with `code` 0, so the code alone
	 *  cannot distinguish a clean exit from a kill. */
	exit: (sessionId: string, code: number, signal?: number) => void;
	spawn: (config: ProcessConfig) => void;
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
	/** Stable correlation id from the agent. When present, renderers
	 *  merge `running` and `completed`/`failed` events into a single
	 *  log entry keyed by this id instead of appending two bubbles. */
	toolCallId?: string;
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
