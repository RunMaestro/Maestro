// Agent spawner service for CLI
// Spawns agent CLIs and parses their output

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
	AdditionalDirectory,
	AgentSshRemoteConfig,
	ToolType,
	UsageStats,
} from '../../shared/types';
import { createOutputParser } from '../../shared/maestro-lib/parsers/parser-factory';
import { aggregateModelUsage } from '../../shared/maestro-lib/parsers/usage-aggregator';
import { ClaudeOutputParser } from '../../shared/maestro-lib/parsers/claude-output-parser';
import { getAgentDefinition, type AgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import {
	getAgentCapabilities,
	hasCapability,
} from '../../shared/maestro-lib/providers/capabilities';
import {
	buildAgentLaunchPlan,
	type AgentLaunchPlanResult,
} from '../../shared/maestro-lib/launch/launch-plan';
import {
	resolveSystemPromptDelivery,
	type SystemPromptDelivery,
} from '../../shared/maestro-lib/launch/prompt-delivery';
import { checkBinaryExists, checkCustomPath } from '../../shared/maestro-lib/launch/path-prober';
import { BACKGROUND_STOP_GRACE_MS } from '../../shared/maestro-lib/control/termination';
import { startTurn, type StartTurnOptions } from '../../shared/maestro-lib/run/start-turn';
import { TurnCapture } from '../../shared/maestro-lib/run/turn-capture';
import { replaceUsageStats } from '../../shared/maestro-lib/streaming/usage-totals';
import type { TurnOutcome } from '../../shared/maestro-lib/streaming/turn-outcome';
import { resolveCliTurnResult, interruptedResult, spawnFailureResult } from './turn-result';
import { getAgentCustomPath, readAgentConfig, readSshRemotes } from './storage';
import { generateUUID } from '../../shared/uuid';
import type { QuerySource } from '../../shared/querySource';
import { sanitizeSessionId } from '../../shared/history';
import { isWindows } from '../../shared/platformDetection';
import { embedSystemPromptInPrompt } from '../../shared/embeddedSystemPrompt';
import {
	applyAgentConfigOverrides,
	buildAdditionalDirArgs,
} from '../../shared/maestro-lib/launch/agent-args';
import { buildCliWakaTimeHeartbeat } from './wakatime';
import {
	getClaudeTokenMode,
	getClaudeTokenSourceFields,
	type ClaudeTokenSourceFields,
} from '../../shared/claudeTokenMode';
import {
	resolveClaudeSpawnModeCore,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	findPackagedAppHost,
	isMaestroPBinaryPath,
	resolveConfigDirKeyFromEnv,
	defaultSelectMode,
	type ClaudeSpawnCoreDeps,
	type PackagedAppHost,
} from '../../shared/maestro-lib/launch/interactive-mode';

// Types from the SSH wrapper are imported type-only so no runtime module load
// happens for non-SSH sessions - the SSH chain pulls in execFile/which helpers
// that aren't needed when a session runs locally. The wrapSpawnWithSsh
// implementation is dynamically imported inside maybeWrapSpawnWithSsh().
type SshSpawnWrapConfig = import('../../main/utils/ssh-spawn-wrapper').SshSpawnWrapConfig;
type SshSpawnWrapResult = import('../../main/utils/ssh-spawn-wrapper').SshSpawnWrapResult;

/**
 * Locate the maestro-p script shipped beside the bundled CLI. esbuild emits the
 * CLI as `dist/cli/maestro-cli.js` (CJS), so `__dirname` at runtime is
 * `dist/cli/`, where `maestro-p.js` is a sibling. Returns null when it isn't
 * readable there - the resolver then falls the spawn back to API rather than
 * failing, so a CLI without maestro-p degrades safely.
 */
function getCliMaestroPBinPath(): string | null {
	const candidate = path.join(__dirname, 'maestro-p.js');
	try {
		fs.accessSync(candidate, fs.constants.R_OK);
		return candidate;
	} catch {
		return null;
	}
}

/**
 * The packaged app to run maestro-p under when this CLI was started by a plain
 * `node` rather than the app binary (#1770). Under the app binary (the shim
 * MaestroCliManager installs) `process.resourcesPath` is already set and the
 * spawn core handles it, so this only fills the gap for a system `node`.
 */
function getCliPackagedAppHost(): PackagedAppHost | null {
	if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) return null;
	return findPackagedAppHost(__dirname);
}

/**
 * CLI-side collaborators for the shared Claude spawn-mode decision core. Mirrors
 * the desktop `defaultDeps` in `resolveClaudeSpawnMode.ts`, but with lightweight,
 * native-free implementations so the `maestro-cli` bundle (no electron-store, no
 * SQLite) can run the SAME decision every desktop surface runs. This is what
 * makes the per-agent Claude token source honored for CLI Auto Run / playbooks /
 * `send` exactly as it is for the desktop chat.
 */
const cliSpawnCoreDeps: ClaudeSpawnCoreDeps = {
	getMaestroPBinPath: getCliMaestroPBinPath,
	isMaestroPBinaryPath,
	resolveConfigDirKey: resolveConfigDirKeyFromEnv,
	// The standalone CLI has no SQLite usage store, so no dynamic usage snapshot
	// exists. selectMode(null) resolves to interactive - i.e. Dynamic prefers the
	// TUI (it can't observe quota exhaustion to fall back), which honors the
	// user's "start on TUI" intent rather than silently downgrading to API.
	getUsageSnapshot: () => null,
	fileExists: (p) => {
		try {
			return fs.existsSync(p);
		} catch {
			return false;
		}
	},
	// The CLI can't probe SSH remotes for maestro-p, so stay optimistic (undefined),
	// matching the desktop cold-cache behavior. An absent remote maestro-p exits
	// 127 on that turn; the user fixes it by installing maestro-p on the remote.
	getRemoteMaestroPAvailable: () => undefined,
	selectMode: defaultSelectMode,
	logger: {
		warn: (message, context, meta) =>
			console.error(`[${context ?? 'ClaudeSpawn'}] ${message}`, meta ?? ''),
		debug: () => {},
	},
};

async function maybeWrapSpawnWithSsh(
	config: SshSpawnWrapConfig,
	sshConfig: AgentSshRemoteConfig
): Promise<SshSpawnWrapResult> {
	const { wrapSpawnWithSsh } = await import('../../main/utils/ssh-spawn-wrapper');
	return wrapSpawnWithSsh(config, sshConfig, { getSshRemotes: () => readSshRemotes() });
}

type SpawnOverrides = Pick<
	SpawnAgentOptions,
	| 'customModel'
	| 'customEffort'
	| 'customArgs'
	| 'customEnvVars'
	| 'appendSystemPrompt'
	| 'additionalDirectories'
	| 'querySource'
	| 'signal'
>;

/**
 * Maximum command-line length we'll accept before falling back to
 * `--append-system-prompt-file <tmp>` on Windows. Matches the threshold logic
 * in `src/main/ipc/handlers/process.ts` - Windows CreateProcess caps the
 * cmdline at ~32K, so a large inline system prompt would silently truncate.
 * SSH sessions are exempt: the command runs inside a shell script, not the OS
 * cmdline. The 30s cleanup mirrors the desktop handler's safety window.
 */
const SYSTEM_PROMPT_TMPFILE_CLEANUP_MS = 30_000;

/**
 * Prompts longer than this go through a file on Windows for agents that
 * declare `promptFileArgs` (omp's `@path`). Same threshold as the desktop's
 * `ChildProcessSpawner`: agents without a native system-prompt flag get the
 * instructions embedded in the user message, which alone can exceed
 * CreateProcess's ~32K argv cap and fail the spawn with ENAMETOOLONG.
 */
const PROMPT_FILE_THRESHOLD_CHARS = 24_000;

/**
 * Write a long prompt to a unique, exclusive temp file and return its file-delivery
 * args, or null when the agent cannot take a file, the platform does not
 * need it, or the write fails (the caller then delivers inline as before).
 * Cleanup mirrors the system-prompt tempfile above.
 */
function buildPromptFileArgs(
	def: AgentDefinition | undefined,
	prompt: string,
	isSshSession: boolean
): string[] | null {
	if (!isWindows() || isSshSession || !def?.promptFileArgs) return null;
	if (prompt.length <= PROMPT_FILE_THRESHOLD_CHARS) return null;
	let tempFile: string;
	for (;;) {
		tempFile = path.join(
			os.tmpdir(),
			`maestro-prompt-${Date.now()}-${process.pid}-${randomUUID()}.md`
		);
		try {
			fs.writeFileSync(tempFile, prompt, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
			break;
		} catch (writeErr) {
			if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
			const reason = writeErr instanceof Error ? writeErr.message : String(writeErr);
			console.error(
				`[maestro-cli] prompt tempfile write failed (${reason}); delivering the prompt inline`
			);
			return null;
		}
	}
	const cleanupTimer = setTimeout(() => {
		fs.promises.unlink(tempFile).catch((unlinkErr: NodeJS.ErrnoException) => {
			if (unlinkErr.code !== 'ENOENT') {
				console.error(
					`[maestro-cli] prompt tempfile cleanup failed (${unlinkErr.message}) at ${tempFile}`
				);
			}
		});
	}, SYSTEM_PROMPT_TMPFILE_CLEANUP_MS);
	cleanupTimer.unref?.();
	return def.promptFileArgs(tempFile);
}

/**
 * Resolve agent-level + session-level overrides and produce final args plus
 * the user-configured customEnvVars. Mirrors what the desktop process handler
 * does in `applyAgentConfigOverrides()` so CLI-spawned agents honor the same
 * custom model / effort / args / env vars as the desktop app.
 *
 * Note: `applyAgentConfigOverrides().effectiveCustomEnvVars` folds agent
 * `defaultEnvVars` into its return value. We deliberately strip that here -
 * defaults are layered separately by `applyEnvLayers()` and
 * `buildSshEnvForRemote()` with "shell wins" semantics, and treating them as
 * user overrides would clobber explicit shell env.
 */
function resolveAgentOverrides(
	toolType: ToolType,
	def: ReturnType<typeof getAgentDefinition>,
	baseArgs: string[],
	overrides: SpawnOverrides,
	readOnlyMode?: boolean
): {
	args: string[];
	userCustomEnvVars?: Record<string, string>;
	agentCustomEnvVars?: Record<string, string>;
} {
	const agentConfigValues = readAgentConfig(toolType);
	const result = applyAgentConfigOverrides(def ?? null, baseArgs, {
		agentConfigValues,
		sessionCustomModel: overrides.customModel,
		sessionCustomEffort: overrides.customEffort,
		sessionCustomArgs: overrides.customArgs,
		sessionCustomEnvVars: overrides.customEnvVars,
		readOnlyMode,
	});
	const agentCustomEnvVars = agentConfigValues.customEnvVars as Record<string, string> | undefined;
	const userCustomEnvVars = overrides.customEnvVars ?? agentCustomEnvVars;
	return { args: result.args, userCustomEnvVars, agentCustomEnvVars };
}

/**
 * Plan a CLI agent launch with the shared `buildAgentLaunchPlan`, as the `cli`
 * surface: provider defaults fill only what the shell has not set, so a value
 * exported in the shell that runs the command survives; the user's own vars
 * override it; and the prompt goes on the command line on every host. The
 * CLI's own inputs: SSH remotes read from disk, and batch-mode vars always on
 * (every CLI spawn is a batch spawn).
 */
function planCliLaunch(
	toolType: ToolType,
	def: ReturnType<typeof getAgentDefinition>,
	input: {
		command: string;
		args: string[];
		cwd: string;
		prompt: string;
		readOnlyMode?: boolean;
		agentCustomEnvVars?: Record<string, string>;
		sessionCustomEnvVars?: Record<string, string>;
		isResuming: boolean;
		querySource?: SpawnOverrides['querySource'];
		sshRemoteConfig?: AgentSshRemoteConfig;
	}
): AgentLaunchPlanResult {
	return buildAgentLaunchPlan({
		surface: 'cli',
		agent: def ? { ...def, capabilities: getAgentCapabilities(toolType) } : null,
		command: input.command,
		args: input.args,
		cwd: input.cwd,
		prompt: input.prompt,
		agentCustomEnvVars: input.agentCustomEnvVars,
		sessionCustomEnvVars: input.sessionCustomEnvVars,
		readOnlyMode: input.readOnlyMode,
		batchMode: true,
		isResuming: input.isResuming,
		querySource: input.querySource,
		sshRemoteConfig: input.sshRemoteConfig,
		sshStore: { getSshRemotes: () => readSshRemotes() },
	});
}

/**
 * Decide how this turn's system prompt travels, with the rule desktop chat
 * uses (`resolveSystemPromptDelivery`): the flag every turn for a provider that
 * has it (a temp file on a Windows host), otherwise embedded in the first turn
 * and skipped on resume.
 */
function cliSystemPromptDelivery(
	toolType: ToolType,
	systemPrompt: string | undefined,
	prompt: string,
	isResume: boolean,
	sshRemoteConfig: AgentSshRemoteConfig | undefined
): SystemPromptDelivery {
	return resolveSystemPromptDelivery({
		systemPrompt,
		supportsAppendSystemPrompt: hasCapability(toolType, 'supportsAppendSystemPrompt'),
		isWindowsHost: isWindows(),
		sshRemote: !!sshRemoteConfig?.enabled,
		isResume,
		hasUserPrompt: !!prompt,
	});
}

/** The user prompt after the system prompt, when it rides in the prompt, is folded in. */
function promptWithSystemPrompt(
	delivery: SystemPromptDelivery,
	systemPrompt: string | undefined,
	prompt: string
): string {
	if (!systemPrompt) return prompt;
	if (delivery.via === 'embed') return embedSystemPromptInPrompt(systemPrompt, prompt);
	if (delivery.via === 'as-prompt') return systemPrompt;
	return prompt;
}

/**
 * The args that carry the system prompt for a `flag` or `file` delivery; none
 * for any other. For `file` the prompt is written to a temp file and passed via
 * `--append-system-prompt-file` to dodge CreateProcess's ~32K cmdline limit.
 * The temp-file cleanup is fire-and-forget: scheduled 30s out so the agent has
 * plenty of time to read it before deletion, regardless of whether the spawn
 * succeeded.
 */
function buildAppendSystemPromptArgs(
	delivery: SystemPromptDelivery,
	content: string | undefined,
	sessionTag: string
): string[] {
	if (!content || (delivery.via !== 'flag' && delivery.via !== 'file')) return [];
	if (delivery.via === 'file') {
		// Sanitize the session tag before interpolating into a tmp path.
		// `path.join('/tmp', '../etc/passwd')` normalizes upward, escaping
		// `os.tmpdir()`, so a hostile session id could redirect the write.
		// `sanitizeSessionId` (shared with history file naming) collapses
		// anything outside [A-Za-z0-9_-] to `_`.
		const safeTag = sanitizeSessionId(sessionTag) || 'session';
		const tempFile = path.join(os.tmpdir(), `maestro-sysprompt-${safeTag}-${Date.now()}.txt`);
		try {
			fs.writeFileSync(tempFile, content, 'utf-8');
		} catch (writeErr) {
			// If we can't write the temp file, fall back to inline. The agent
			// may truncate on Windows cmdline limits, but that's better than
			// silently dropping the prompt. Log so the user can spot the
			// downgrade - CLI has no Sentry pipeline, so stderr is the visibility
			// surface available here.
			const reason = writeErr instanceof Error ? writeErr.message : String(writeErr);
			console.error(
				`[maestro-cli] system prompt tempfile write failed (${reason}); falling back to inline --append-system-prompt`
			);
			return ['--append-system-prompt', content];
		}
		// `.unref()` so the 30s cleanup timer doesn't keep the CLI alive after
		// the agent already exited - without it, `maestro-cli send` would
		// appear to hang on Windows until the timer fires.
		const cleanupTimer = setTimeout(() => {
			fs.promises.unlink(tempFile).catch((unlinkErr: NodeJS.ErrnoException) => {
				// ENOENT means the file is already gone - expected if the OS
				// cleaned tmpdir or a parallel run won the race. Other errors
				// indicate a real problem (permissions, FS issue): surface them
				// on stderr so the user has a breadcrumb.
				if (unlinkErr.code !== 'ENOENT') {
					console.error(
						`[maestro-cli] system prompt tempfile cleanup failed (${unlinkErr.message}) at ${tempFile}`
					);
				}
			});
		}, SYSTEM_PROMPT_TMPFILE_CLEANUP_MS);
		cleanupTimer.unref?.();
		return ['--append-system-prompt-file', tempFile];
	}
	return ['--append-system-prompt', content];
}

// Claude Code arguments for batch mode (stream-json format)
const CLAUDE_ARGS = ['--print', '--verbose', '--output-format', 'stream-json'];

// Permission bypass arg for Claude - skipped in read-only mode
const CLAUDE_YOLO_ARGS = ['--dangerously-skip-permissions'];

// Cached paths per agent type (resolved once at startup)
const cachedPaths: Map<string, string> = new Map();

// Result from spawning an agent
export interface AgentResult {
	success: boolean;
	response?: string;
	agentSessionId?: string;
	usageStats?: UsageStats;
	error?: string;
	/**
	 * How the turn ended, from the shared `resolveTurnOutcome`. `success` is
	 * derived from it (`completed` and `completed-with-warning` succeed), so
	 * existing callers keep working; a caller that needs to tell a user stop
	 * from a crash reads this instead of parsing `error`.
	 */
	outcome?: TurnOutcome;
}

// Detection result
export interface DetectResult {
	available: boolean;
	path?: string;
	source?: 'settings' | 'path';
}

/**
 * Resolve a configured executable path, including known rotating install locations.
 */
async function resolveExecutablePath(filePath: string): Promise<string | undefined> {
	const detection = await checkCustomPath(filePath);
	return detection.exists ? detection.path : undefined;
}

/**
 * Detect if an agent CLI is available.
 * Checks custom path in settings first, then falls back to PATH detection.
 */
export async function detectAgent(toolType: ToolType): Promise<DetectResult> {
	const cached = cachedPaths.get(toolType);
	if (cached) {
		return { available: true, path: cached, source: 'settings' };
	}

	const def = getAgentDefinition(toolType);
	const defaultCommand = def?.binaryName || toolType;

	// 1. Check for custom path in settings
	const customPath = getAgentCustomPath(toolType);
	if (customPath) {
		const resolvedCustomPath = await resolveExecutablePath(customPath);
		if (resolvedCustomPath) {
			cachedPaths.set(toolType, resolvedCustomPath);
			return { available: true, path: resolvedCustomPath, source: 'settings' };
		}
		console.error(
			`Warning: Custom ${def?.name || toolType} path "${customPath}" is not executable, falling back to PATH detection`
		);
	}

	// 2. Fall back to the same lookup the desktop uses. It probes the known
	// install locations first, and on Windows picks the runnable .exe or .cmd
	// over the extensionless sh shim an npm install puts first on PATH, which
	// CreateProcess cannot run (#1718).
	const detection = await checkBinaryExists(defaultCommand);
	if (detection.exists && detection.path) {
		cachedPaths.set(toolType, detection.path);
		return { available: true, path: detection.path, source: 'path' };
	}

	return { available: false };
}

// Backward-compatible wrappers
export const detectClaude = () => detectAgent('claude-code');
export const detectCodex = () => detectAgent('codex');
export const detectOpenCode = () => detectAgent('opencode');
export const detectDroid = () => detectAgent('factory-droid');

/**
 * Get the resolved command/path for spawning an agent.
 * Uses cached path from detectAgent() or falls back to the agent's binaryName.
 */
export function getAgentCommand(toolType: ToolType): string {
	const cached = cachedPaths.get(toolType);
	if (cached) return cached;
	const def = getAgentDefinition(toolType);
	return def?.binaryName || toolType;
}

/**
 * Resolve the command a LOCAL spawn should exec, warming the detection cache
 * when it is cold.
 *
 * `getAgentCommand()` answers from that cache and falls back to the bare
 * `binaryName` when nothing has populated it - which is every spawn that did
 * not run `detectAgent()` first, i.e. every playbook (`batch-processor.ts`),
 * every goal run (`goal-runner.ts`), and every `maestro-cli send`. A bare name
 * costs two things. The user's configured custom path is silently ignored,
 * because `detectAgent()` is the ONLY reader of `getAgentCustomPath()` - so a
 * CLI run executed whatever `claude` PATH happened to offer while the desktop
 * ran the binary the user pointed at. And on Windows `spawn('claude')` finds
 * nothing at all: CreateProcess does not apply PATHEXT the way a shell does, so
 * an agent installed as an npm `.cmd` shim never resolves (#1608).
 *
 * Resolve here rather than at each call site: a resolution the spawner performs
 * itself cannot be forgotten by the next caller that lands.
 *
 * Detection that comes up empty falls back to the bare name, which is exactly
 * today's behavior - a machine where `which`/`where` fails must still get its
 * spawn attempted (and its real error) rather than being refused here.
 *
 * SSH spawns deliberately do NOT come through here: the remote host resolves
 * the command through its own login-shell PATH, and a path resolved on THIS
 * machine names nothing over there.
 */
export async function resolveLocalAgentCommand(toolType: ToolType): Promise<string> {
	const detection = await detectAgent(toolType);
	return detection.available && detection.path ? detection.path : getAgentCommand(toolType);
}

// Backward-compatible wrappers
export const getClaudeCommand = () => getAgentCommand('claude-code');
export const getCodexCommand = () => getAgentCommand('codex');
export const getOpenCodeCommand = () => getAgentCommand('opencode');
export const getDroidCommand = () => getAgentCommand('factory-droid');

/**
 * Providers only pattern-match stdout inside `detectErrorFromExit`, so a
 * bounded tail is enough and keeps a chatty multi-hour agent from growing an
 * unbounded string in the CLI process.
 */
const STDOUT_TAIL_LIMIT = 256 * 1024;

/**
 * Cap on the line reader's unparsed remainder. A provider that emits a very
 * long unterminated line would otherwise grow the buffer for the life of the
 * process; past this the stuck remainder is dropped and framing resumes at the
 * next complete line.
 *
 * 1 MB matches `MAX_COPILOT_JSON_BUFFER_LENGTH`, the desktop handler's cap for
 * the same job. Deliberately NOT `STDOUT_TAIL_LIMIT` (256 KB): that bounds an
 * error excerpt, and a single legitimate stream-json line carrying a large tool
 * result can exceed it, which would drop real output rather than a stuck buffer.
 */
const MAX_LINE_BUFFER_LENGTH = 1024 * 1024;

/**
 * Say so when the cap above discards a stuck remainder. The drop is deliberate,
 * but it is still output the user will not see, and silent truncation is worse
 * than a visible one: the desktop handler logs the same event.
 */
function warnOversizedLineBuffer(droppedLength: number): void {
	console.error(
		`[maestro-cli] Dropped ${droppedLength} bytes of unparsed agent output: no complete line arrived within ${MAX_LINE_BUFFER_LENGTH} bytes.`
	);
}

/** Stand-in when a provider has no registered parser to classify a bad exit. */
const NO_EXIT_CLASSIFICATION = { detectErrorFromExit: () => null };

/**
 * How every CLI turn is started and stopped. Aborting the caller's signal runs
 * the shared stop ladder from SIGTERM: if the agent is still alive after the
 * grace period its whole tree is killed (some agents trap SIGTERM to finish a
 * tool call, and a stop that never lands is worse than an abrupt one), and
 * whatever it started is stopped with it. On Windows the tree goes through
 * `taskkill /t /f`. The turn then settles as `interrupted`, never as a crash.
 *
 * Over SSH this stops the LOCAL ssh client; without a forced TTY the remote
 * process is not guaranteed to receive the hangup, so a remote agent may
 * outlive an interrupted CLI run. Documented in Plans/maestro-lib-cli-migration.md.
 */
function cliTurnOptions(signal: AbortSignal | undefined): StartTurnOptions {
	return {
		stopGraceMs: BACKGROUND_STOP_GRACE_MS,
		signal,
		maxLineLength: MAX_LINE_BUFFER_LENGTH,
		stdoutTailLimit: STDOUT_TAIL_LIMIT,
		label: 'cli',
	};
}

/**
 * Spawn Claude Code with a prompt and return the result.
 *
 * Honors the same agent-level and session-level overrides as the desktop app:
 * custom model, effort, CLI args, env vars, and SSH remote execution. Custom
 * binary path is applied via getAgentCommand()/detectAgent().
 *
 * Claude uses a unique JSON format (stream-json) that differs from the
 * AgentOutputParser interface used by other agents, so it has its own spawner.
 */
async function spawnClaudeAgent(
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	readOnlyMode?: boolean,
	sshRemoteConfig?: AgentSshRemoteConfig,
	overrides: SpawnOverrides = {},
	tokenSource: ClaudeTokenSourceFields = {}
): Promise<AgentResult> {
	const def = getAgentDefinition('claude-code');

	// Build args WITHOUT the prompt - the prompt is appended below for local
	// execution or embedded into the SSH wrapper for remote execution.
	const preOverrideArgs = [...CLAUDE_ARGS];

	if (readOnlyMode) {
		if (def?.readOnlyArgs) preOverrideArgs.push(...def.readOnlyArgs);
	} else {
		preOverrideArgs.push(...CLAUDE_YOLO_ARGS);
	}

	if (agentSessionId) {
		preOverrideArgs.push('--resume', agentSessionId);
	} else {
		// Force a fresh, isolated session for each task execution
		// This prevents context bleeding between tasks in Auto Run
		preOverrideArgs.push('--session-id', generateUUID());
	}

	// Layer agent-level + session-level overrides (model, effort, customArgs)
	// and extract the user-configured env vars (agent + session customEnvVars).
	const {
		args: resolvedArgs,
		userCustomEnvVars,
		agentCustomEnvVars,
	} = resolveAgentOverrides('claude-code', def, preOverrideArgs, overrides, readOnlyMode);

	// Inject the Maestro system prompt via `--append-system-prompt(-file)`. The
	// flag rides through both the local args and the SSH-wrapped args because
	// `wrapSpawnWithSsh` rebuilds the remote command from `baseArgs` below.
	// Claude Code re-reads this flag every turn (not persisted in the session
	// transcript), so include it on resume too - matches desktop behavior at
	// `src/main/ipc/handlers/process.ts:254`.
	const systemPromptDelivery = cliSystemPromptDelivery(
		'claude-code',
		overrides.appendSystemPrompt,
		prompt,
		!!agentSessionId,
		sshRemoteConfig
	);
	const baseArgs = [
		...resolvedArgs,
		...buildAppendSystemPromptArgs(
			systemPromptDelivery,
			overrides.appendSystemPrompt,
			agentSessionId || 'fresh'
		),
	];

	// A local spawn needs a REAL path (see resolveLocalAgentCommand). An SSH run
	// keeps the bare name so the remote's own PATH resolves it.
	const claudeCommand = sshRemoteConfig?.enabled
		? getAgentCommand('claude-code')
		: await resolveLocalAgentCommand('claude-code');
	const sshEnabled = !!sshRemoteConfig?.enabled;

	// Target, environment and prompt delivery come from the shared launch plan,
	// by the CLI's own rules (see planCliLaunch). An SSH remote that cannot be
	// resolved fails here, before anything is spawned.
	const planResult = planCliLaunch('claude-code', def, {
		command: claudeCommand,
		args: baseArgs,
		cwd,
		prompt,
		readOnlyMode,
		agentCustomEnvVars,
		sessionCustomEnvVars: overrides.customEnvVars,
		isResuming: !!agentSessionId,
		querySource: overrides.querySource,
		sshRemoteConfig,
	});
	if (!planResult.ok) {
		return spawnFailureResult(planResult.error);
	}
	const plan = planResult.plan;
	const agentCustomPath = getAgentCustomPath('claude-code');

	// Resolve the per-agent Claude token source through the SAME shared decision
	// core the desktop uses, so CLI Auto Run / batch / `send` honor API vs TUI vs
	// Dynamic identically.
	//
	// Default is API (`claude --print`): an UNCONFIGURED agent must NOT be flipped
	// to maestro-p. That's doubly important for SSH here - the CLI can't probe the
	// remote, and maestro-p may not be installed there, so an optimistic TUI
	// default would try to exec a missing binary and fail the turn. We therefore
	// do NOT pass the `{ sshEnabled }` default-flip option (which the desktop uses
	// only because it has a live remote maestro-p probe as a safety net). Only an
	// EXPLICIT TUI/Dynamic selection routes through maestro-p.
	const tokenMode = getClaudeTokenMode({
		enableMaestroP: tokenSource.enableMaestroP,
		maestroPMode: tokenSource.maestroPMode,
	});
	const spawnDecision = resolveClaudeSpawnModeCore(
		{
			agent: def
				? {
						id: def.id,
						interactiveCommand: def.interactiveCommand,
						interactiveModeArgs: def.interactiveModeArgs,
						defaultEnvVars: def.defaultEnvVars,
					}
				: null,
			tokenMode,
			sshEnabled,
			command: claudeCommand,
			sessionCustomPath: agentCustomPath,
			sessionCustomEnvVars: userCustomEnvVars,
			maestroPPath: tokenSource.maestroPPath,
			now: new Date(),
		},
		cliSpawnCoreDeps
	);

	// Beat WakaTime for the life of the run. CLI-spawned agents never reach the
	// desktop's ProcessManager listener, so without this their time goes
	// unrecorded under Maestro entirely.
	const wakaHeartbeat = buildCliWakaTimeHeartbeat(
		`cli:${cwd}`,
		cwd,
		Boolean(sshRemoteConfig?.enabled)
	);

	// SSH-wrap a remote plan; a local plan already carries the prompt (in argv,
	// or for stdin delivery in `plan.stdin`). Claude uses '-- <prompt>'
	// positional form - the default in wrapSpawnWithSsh.
	let spawnCommand = plan.command;
	let spawnArgs: string[] = plan.args;
	let spawnCwd = plan.cwd;
	let spawnEnv: NodeJS.ProcessEnv = plan.env ?? { ...process.env };
	let sshStdinScript: string | undefined;

	if (plan.target.kind === 'remote' && sshRemoteConfig) {
		// Remote interactive (TUI): run maestro-p on the remote host instead of
		// `claude`, prepend its interactive flags, and point MAESTRO_CLAUDE_BIN at
		// the remote claude when a custom path is set. Mirrors the desktop SSH
		// remote-interactive path. API / Dynamic-over-SSH leave the command on
		// `claude` (the resolver already collapses Dynamic→API for SSH).
		const remoteInteractive = buildRemoteInteractiveSpawn({
			decision: spawnDecision,
			interactiveModeArgs: def?.interactiveModeArgs,
			remoteClaudeBin: spawnDecision.claudeRealBinPath,
		});
		const remoteEnv = plan.envVars;
		const wrapped = await maybeWrapSpawnWithSsh(
			{
				command: remoteInteractive ? remoteInteractive.command : claudeCommand,
				args: remoteInteractive ? [...remoteInteractive.prependArgs, ...plan.args] : plan.args,
				cwd,
				prompt,
				customEnvVars: remoteInteractive ? { ...remoteEnv, ...remoteInteractive.env } : remoteEnv,
				agentBinaryName: remoteInteractive ? remoteInteractive.command : def?.binaryName,
				querySource: overrides.querySource,
			},
			sshRemoteConfig
		);
		if (!wrapped.sshRemoteUsed) {
			return sshUnresolvedFailure(sshRemoteConfig);
		}
		({ spawnCommand, spawnArgs, spawnCwd, spawnEnv, sshStdinScript } = applySshWrapResult(wrapped));
	} else if (spawnDecision.mode === 'interactive' && spawnDecision.maestroPBinPath) {
		// Local TUI: wrap the spawn with maestro-p via process.execPath (node),
		// injecting MAESTRO_CLAUDE_BIN. maestro-p strips the headless-only flags,
		// drives the real claude TUI on the Max plan, and reads the prompt after
		// `--`. API / direct-binary decisions leave the local spawn untouched.
		const packagedHost = getCliPackagedAppHost();
		const applied = applyClaudeSpawnDecision({
			decision: spawnDecision,
			interactiveModeArgs: def?.interactiveModeArgs,
			command: claudeCommand,
			args: plan.args,
			customEnvVars: {},
			execPath: packagedHost?.execPath,
			resourcesPath: packagedHost?.resourcesPath,
		});
		spawnCommand = applied.command;
		spawnArgs = applied.args;
		// Merge what maestro-p adds (MAESTRO_CLAUDE_BIN, ELECTRON_RUN_AS_NODE,
		// NODE_PATH) over the planned env, which already holds the user's vars.
		spawnEnv = { ...spawnEnv, ...(applied.customEnvVars ?? {}) };
	}

	// Used for `detectErrorFromExit` and for in-band failures; Claude's stream
	// is still read by `processMessage` below because its stream-json shape is
	// richer than the AgentOutputParser event vocabulary.
	const claudeParser = createOutputParser('claude-code');
	const exitClassifier = claudeParser ?? NO_EXIT_CLASSIFICATION;

	let result: string | undefined;
	let assistantText = ''; // Accumulate text from assistant messages as fallback
	let sessionId: string | undefined;
	let usageStats: UsageStats | undefined;
	let resultEmitted = false;
	let resultMessageSeen = false;
	let sessionIdEmitted = false;
	let errorText: string | undefined;

	// Sees every message only to track the last main-transcript API call's
	// usage, which is the turn's real context occupancy (`absoluteUsage`).
	// The totals themselves still come from `aggregateModelUsage` below.
	const occupancyTracker = new ClaudeOutputParser();

	// Process a single parsed JSON message from Claude Code's stream-json output

	const processMessage = (msg: any) => {
		// An explicit result event is the provider's "done" signal, independent
		// of whether it carried any text.
		if (msg.type === 'result') resultMessageSeen = true;

		// A failure Claude reports in its own stream (a `result` flagged
		// `is_error: true`, a plan-limit notice, a structured `error` event), which
		// it follows with exit 0, so the exit code alone reads it as success. The
		// same classifier desktop chat runs on every line. An in-turn API error
		// notice is skipped: Claude may retry past it, and if it does not, the
		// failed `result` that ends the turn is caught here instead.
		if (!errorText && claudeParser && !claudeParser.isProvisionalErrorNotice?.(msg)) {
			const inBand = claudeParser.detectErrorFromParsed(msg);
			if (inBand) errorText = inBand.message;
		}

		// Capture result text (only once)
		if (msg.type === 'result' && msg.result && !resultEmitted) {
			resultEmitted = true;
			result = msg.result;
		}

		// Accumulate text from assistant messages - Claude Code may emit
		// an empty result field with the actual text in assistant messages
		if (msg.type === 'assistant' && msg.message?.content) {
			const content = msg.message.content;
			if (typeof content === 'string') {
				if (assistantText) assistantText += '\n';
				assistantText += content;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === 'text' && block.text) {
						if (assistantText) assistantText += '\n';
						assistantText += block.text;
					}
				}
			}
		}

		// Capture session_id (only once)
		if (msg.session_id && !sessionIdEmitted) {
			sessionIdEmitted = true;
			sessionId = msg.session_id;
		}

		// Extract usage statistics using shared aggregator. Deliberately last-
		// write-wins and NOT routed through UsageAccumulator: Claude's terminal
		// `result` message carries the whole turn's totals, so the last message
		// is already the right answer, whereas delta-normalizing it against the
		// preceding per-call `assistant` usage would report only the difference.
		// `replaceUsageStats` keeps an occupancy snapshot or resolved window an
		// earlier message reported when a later one (a trailing usage-only
		// message, say) carries none.
		const absoluteUsage = occupancyTracker.parseJsonObject(msg)?.usage?.absoluteUsage;
		if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
			const step = aggregateModelUsage(msg.modelUsage, msg.usage || {}, msg.total_cost_usd || 0);
			usageStats = replaceUsageStats(usageStats, absoluteUsage ? { ...step, absoluteUsage } : step);
		}
	};

	const processLine = (line: string) => {
		try {
			processMessage(JSON.parse(line));
		} catch {
			// Ignore non-JSON lines
		}
	};

	const turn = startTurn(
		{
			command: spawnCommand,
			args: spawnArgs,
			cwd: spawnCwd,
			env: spawnEnv,
			stdin: sshStdinScript || plan.stdin,
		},
		{
			onStdout: () => wakaHeartbeat?.(),
			onLine: processLine,
			onOversizedLine: warnOversizedLineBuffer,
		},
		cliTurnOptions(overrides.signal)
	);
	const exit = await turn.done;
	if (exit.spawnError) {
		return spawnFailureResult(`Failed to spawn Claude: ${exit.spawnError.message}`);
	}

	return resolveCliTurnResult({
		toolType: 'claude-code',
		provider: exitClassifier,
		exitCode: exit.exitCode,
		signal: exit.signal,
		interrupted: exit.interrupted,
		stderrText: exit.stderrText,
		stdoutText: exit.stdoutText,
		stdinError: exit.stdinError,
		// Use accumulated assistant text as fallback when result field is empty
		answerText: result || assistantText || undefined,
		resultMessageSeen,
		errorText,
		agentSessionId: sessionId,
		usageStats,
		// Claude's CLI path has always failed a clean exit that captured nothing,
		// and a non-zero exit even when text was streamed (`code === 0 && finalResult`).
		strictEmptyAnswer: true,
		answerOutranksBareExit: false,
		droppedOutputBytes: exit.droppedOutputBytes,
	});
}

/**
 * Return an AgentResult that tells the caller the configured SSH remote
 * couldn't be resolved. Fails loudly instead of silently running locally -
 * when the user explicitly enabled SSH, they don't want their prompt leaking
 * onto the local machine if the remote is misconfigured.
 */
function sshUnresolvedFailure(sshRemoteConfig: AgentSshRemoteConfig): AgentResult {
	const remoteLabel = sshRemoteConfig.remoteId ? ` "${sshRemoteConfig.remoteId}"` : '';
	return spawnFailureResult(
		`SSH remote execution is enabled for this session but the configured ` +
			`remote${remoteLabel} could not be resolved. Check that the remote exists, ` +
			`is enabled, and that the session's remoteId points at a valid SSH remote.`
	);
}

/**
 * Apply a successful SSH wrap result to our local spawn state. The local ssh
 * client inherits process.env (for SSH_AUTH_SOCK, etc.); the remote's own
 * env vars travel inside the wrapped command or stdin script.
 */
function applySshWrapResult(wrapped: SshSpawnWrapResult): {
	spawnCommand: string;
	spawnArgs: string[];
	spawnCwd: string;
	spawnEnv: NodeJS.ProcessEnv;
	sshStdinScript: string | undefined;
} {
	return {
		spawnCommand: wrapped.command,
		spawnArgs: wrapped.args,
		spawnCwd: wrapped.cwd,
		spawnEnv: { ...process.env },
		sshStdinScript: wrapped.sshStdinScript,
	};
}

/** Widen a parser's per-event usage into the `UsageStats` shape the accumulator speaks. */
/**
 * Generic spawner for agents that use JSON line output parsed via AgentOutputParser.
 * Handles Codex, OpenCode, Factory Droid, and any future agents with the same pattern.
 *
 * Honors the same agent-level and session-level overrides as the desktop app:
 * custom model, effort, CLI args, env vars, and SSH remote execution. Custom
 * binary path is applied via getAgentCommand()/detectAgent().
 */
async function spawnJsonLineAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	readOnlyMode?: boolean,
	sshRemoteConfig?: AgentSshRemoteConfig,
	overrides: SpawnOverrides = {}
): Promise<AgentResult> {
	const def = getAgentDefinition(toolType);

	// Build args from agent definition (without the prompt or model/customArgs -
	// those come from applyAgentConfigOverrides via configOptions).
	const preOverrideArgs: string[] = [];

	// Codex requires `-C <dir>` as a ROOT-level global flag that MUST precede the
	// `exec` subcommand (and therefore everything after it, including
	// `resume <id>`). Placed later, Codex silently ignores it on fresh runs (#959)
	// and HARD-FAILS on resume with "unexpected argument '-C' found", which broke
	// Maestro Relay follow-up messages to Codex agents. Mirror the desktop path
	// (`src/main/utils/agent-args.ts`), which prepends workingDirArgs before the
	// batchModePrefix. See #960.
	if (toolType === 'codex' && def?.workingDirArgs) {
		preOverrideArgs.push(...def.workingDirArgs(cwd));
	}

	if (def?.batchModePrefix) preOverrideArgs.push(...def.batchModePrefix);

	// In read-only mode, filter out YOLO/bypass args from batchModeArgs
	// (they override read-only flags). In normal mode, apply all batchModeArgs.
	// Skip filtering for agents without CLI-level read-only enforcement
	// (e.g., Gemini CLI needs -y to avoid interactive prompts that hang with closed stdin).
	if (def?.batchModeArgs) {
		if (readOnlyMode && def.readOnlyCliEnforced !== false && def.yoloModeArgs?.length) {
			const yoloSet = new Set(def.yoloModeArgs);
			preOverrideArgs.push(...def.batchModeArgs.filter((a) => !yoloSet.has(a)));
		} else {
			preOverrideArgs.push(...def.batchModeArgs);
		}
	}

	if (def?.jsonOutputArgs) preOverrideArgs.push(...def.jsonOutputArgs);
	if (readOnlyMode && def?.readOnlyArgs) preOverrideArgs.push(...def.readOnlyArgs);

	if (agentSessionId && def?.resumeArgs) {
		preOverrideArgs.push(...def.resumeArgs(agentSessionId));
	}

	// Native Additional Directories grants (e.g. `--add-dir`). Shares the exact
	// mapping the desktop uses via `buildAgentArgs`, so a CLI/playbook spawn and
	// an interactive turn hand the provider identical flags. Providers with no
	// native mechanism emit nothing here and rely on the prompt block instead.
	preOverrideArgs.push(...buildAdditionalDirArgs(def, overrides.additionalDirectories));

	// Layer agent-level + session-level overrides (model, effort, customArgs)
	// and extract the user-configured env vars (agent + session customEnvVars).
	const { args: resolvedArgs, agentCustomEnvVars } = resolveAgentOverrides(
		toolType,
		def,
		preOverrideArgs,
		overrides,
		readOnlyMode
	);

	// System prompt delivery for JSON-line agents:
	//  - Agents declaring `supportsAppendSystemPrompt: true` get the dedicated
	//    flag (no agent in this branch does today, but the gate future-proofs).
	//  - Everyone else gets the prompt embedded in the user message on first
	//    turn; on resume we skip - desktop relies on the prompt being already
	//    captured in the agent's session transcript (see
	//    `src/main/ipc/handlers/process.ts:300-312`).
	const isResume = !!agentSessionId;
	const systemPromptDelivery = cliSystemPromptDelivery(
		toolType,
		overrides.appendSystemPrompt,
		prompt,
		isResume,
		sshRemoteConfig
	);
	const baseArgs = [
		...resolvedArgs,
		...buildAppendSystemPromptArgs(
			systemPromptDelivery,
			overrides.appendSystemPrompt,
			agentSessionId || 'fresh'
		),
	];
	const effectivePrompt = promptWithSystemPrompt(
		systemPromptDelivery,
		overrides.appendSystemPrompt,
		prompt
	);

	const noPromptSeparator = !!def?.noPromptSeparator;

	// A local spawn needs a REAL path (see resolveLocalAgentCommand). An SSH run
	// keeps the bare name so the remote's own PATH resolves it.
	const agentCommand = sshRemoteConfig?.enabled
		? getAgentCommand(toolType)
		: await resolveLocalAgentCommand(toolType);

	// Target, environment and prompt delivery come from the shared launch plan,
	// by the CLI's own rules (see planCliLaunch): the provider's own prompt flag
	// (Copilot's `-p`), a bare positional or `-- <prompt>`. Local Windows
	// providers that accept a prompt file use that transport below. An SSH
	// remote that cannot be resolved fails here, before anything is spawned.
	const planResult = planCliLaunch(toolType, def, {
		command: agentCommand,
		args: baseArgs,
		cwd,
		prompt: effectivePrompt,
		readOnlyMode,
		agentCustomEnvVars,
		sessionCustomEnvVars: overrides.customEnvVars,
		isResuming: isResume,
		querySource: overrides.querySource,
		sshRemoteConfig,
	});
	if (!planResult.ok) {
		return spawnFailureResult(planResult.error);
	}
	const plan = planResult.plan;

	// See the note in spawnClaudeAgent: CLI runs are invisible to the desktop
	// WakaTime listener, so they beat from their own output stream.
	const wakaHeartbeat = buildCliWakaTimeHeartbeat(
		`cli:${cwd}`,
		cwd,
		Boolean(sshRemoteConfig?.enabled)
	);

	const promptFileArgs = buildPromptFileArgs(def, effectivePrompt, plan.target.kind === 'remote');
	let spawnCommand = plan.command;
	let spawnArgs = promptFileArgs ? [...baseArgs, ...promptFileArgs] : plan.args;
	let spawnCwd = plan.cwd;
	let spawnEnv: NodeJS.ProcessEnv = plan.env ?? { ...process.env };
	let sshStdinScript: string | undefined;

	if (plan.target.kind === 'remote' && sshRemoteConfig) {
		// Pass `effectivePrompt` (not the raw `prompt`) so the embed-in-turn-1
		// fallback for agents without native --append-system-prompt support
		// also reaches the SSH remote. baseArgs already carries the native
		// flag for agents that support it.
		const wrapped = await maybeWrapSpawnWithSsh(
			{
				command: agentCommand,
				args: plan.args,
				cwd,
				prompt: effectivePrompt,
				customEnvVars: plan.envVars,
				agentBinaryName: def?.binaryName,
				noPromptSeparator,
				promptArgs: def?.promptArgs,
				querySource: overrides.querySource,
			},
			sshRemoteConfig
		);
		if (!wrapped.sshRemoteUsed) {
			return sshUnresolvedFailure(sshRemoteConfig);
		}
		({ spawnCommand, spawnArgs, spawnCwd, spawnEnv, sshStdinScript } = applySshWrapResult(wrapped));
	}

	// Resolve the output parser before spawning so a misconfigured agent type
	// fails fast instead of leaving an orphaned child process. Reviewer flagged
	// the previous post-spawn null-check as a process leak (greptile P1).
	const parser = createOutputParser(toolType);
	if (!parser) {
		return spawnFailureResult(`No parser available for agent type: ${toolType}`);
	}

	// The shared capture applies the provider's usage rule (Codex reports a
	// running session total that is turned into deltas before summing; everyone
	// else reports per-step values that sum as they are), keeps the first
	// session id announced, and falls back to the streamed text when no result
	// event carries any. This path settles on the text of `error` events, so the
	// in-band classifier stays off and its outcomes are what they always were.
	const capture = new TurnCapture(toolType, parser, { classifyInBandErrors: false });

	const turn = startTurn(
		{
			command: spawnCommand,
			args: spawnArgs,
			cwd: spawnCwd,
			env: spawnEnv,
			stdin: sshStdinScript || plan.stdin,
		},
		{
			onStdout: () => wakaHeartbeat?.(),
			onEvent: (event) => capture.handleEvent(event),
			onOversizedLine: warnOversizedLineBuffer,
		},
		{ ...cliTurnOptions(overrides.signal), parser }
	);
	const exit = await turn.done;
	if (exit.spawnError) {
		const agentName = def?.name || toolType;
		return spawnFailureResult(`Failed to spawn ${agentName}: ${exit.spawnError.message}`);
	}

	// Soft success: agents like Grok may exit non-zero after a full
	// answer (e.g. --max-turns) with no structured error event. The shared
	// resolver reports that as `completed-with-warning`, still a success;
	// the answer is preferred over raw stderr when there is no errorText.
	return resolveCliTurnResult({
		toolType,
		provider: parser,
		exitCode: exit.exitCode,
		signal: exit.signal,
		interrupted: exit.interrupted,
		stderrText: exit.stderrText,
		stdoutText: exit.stdoutText,
		stdinError: exit.stdinError,
		errorText: capture.errorText,
		answerText: capture.answerText,
		resultMessageSeen: capture.resultMessageSeen,
		agentSessionId: capture.sessionId,
		usageStats: capture.usage,
		// This path has always accepted a clean exit with no answer, and a
		// non-zero exit after a full answer (Grok with `--max-turns`).
		strictEmptyAnswer: false,
		answerOutranksBareExit: true,
		droppedOutputBytes: exit.droppedOutputBytes,
	});
}

/**
 * Options for spawning an agent via CLI.
 *
 * Session-level overrides take precedence over the agent-level config read
 * from `maestro-agent-configs.json`. Pass the session values directly here -
 * the spawner merges agent + session overrides via applyAgentConfigOverrides().
 */
export interface SpawnAgentOptions {
	/** Resume an existing agent session */
	agentSessionId?: string;
	/** Run in read-only/plan mode (uses centralized agent definitions for provider-specific flags) */
	readOnlyMode?: boolean;
	/** Per-session model override (wins over agent-level model). */
	customModel?: string;
	/** Per-session effort/reasoning override (wins over agent-level). */
	customEffort?: string;
	/** Per-session extra CLI args (shell-quote aware, appended after built-in args). */
	customArgs?: string;
	/** Per-session env vars merged over agent-level customEnvVars and agent defaults. */
	customEnvVars?: Record<string, string>;
	/**
	 * Per-session Additional Directories. Providers that declare
	 * `supportsAdditionalDirectories` translate these into native grant flags via
	 * the definition's `additionalDirArgs` (e.g. `--add-dir`); every agent also
	 * receives them in the `{{ADDITIONAL_DIRECTORIES}}` system-prompt block built
	 * by `prepareMaestroSystemPromptCli()`. Mirrors the desktop `process:spawn`
	 * handler's `sessionAdditionalDirectories`.
	 */
	additionalDirectories?: AdditionalDirectory[];
	/**
	 * Per-session SSH remote config. When `enabled`, the spawn is wrapped with
	 * ssh so the agent runs on the remote host. Required for parity with the
	 * desktop app when sessions are configured for SSH remote execution.
	 */
	sshRemoteConfig?: AgentSshRemoteConfig;
	/**
	 * Maestro system prompt to deliver alongside the user message. Mirrors the
	 * desktop `process:spawn` handler's `appendSystemPrompt` field. For agents
	 * with `supportsAppendSystemPrompt: true` (Claude Code today) this is
	 * passed via `--append-system-prompt`; otherwise it's embedded into the
	 * first user turn (skipped on resume so it's not repeated). Callers should
	 * build this via `prepareMaestroSystemPromptCli()` in `./system-prompt.ts`.
	 */
	appendSystemPrompt?: string;
	/**
	 * Claude token source (Claude Code only), forwarded so CLI Auto Run / batch /
	 * `send` honor the SAME per-agent selection the desktop chat does: API
	 * (`claude --print`), TUI (maestro-p), or Dynamic. Absent collapses to API
	 * via getClaudeTokenMode. See {@link ClaudeTokenSourceFields}.
	 */
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	/**
	 * Who asked for this turn. Stamped into the agent's env as
	 * MAESTRO_QUERY_SOURCE so tooling downstream of the spawn can tell a
	 * playbook or Auto Run task apart from a `maestro send` the user typed -
	 * the processes are otherwise identical. Defaults to 'user'.
	 */
	querySource?: QuerySource;
	/**
	 * Abort the turn. The agent is sent SIGTERM (then SIGKILL after a grace
	 * period) and the result comes back with `outcome: 'interrupted'` - a user
	 * stop, never reported as a crash. An already-aborted signal returns
	 * immediately without spawning anything.
	 */
	signal?: AbortSignal;
}

/**
 * Spawn an agent with a prompt and return the result
 */
export async function spawnAgent(
	toolType: ToolType,
	cwd: string,
	prompt: string,
	agentSessionId?: string,
	options?: SpawnAgentOptions
): Promise<AgentResult> {
	if (options?.signal?.aborted) return interruptedResult();

	const readOnly = options?.readOnlyMode;
	const sshRemoteConfig = options?.sshRemoteConfig;
	const overrides: SpawnOverrides = {
		signal: options?.signal,
		customModel: options?.customModel,
		customEffort: options?.customEffort,
		customArgs: options?.customArgs,
		customEnvVars: options?.customEnvVars,
		appendSystemPrompt: options?.appendSystemPrompt,
		additionalDirectories: options?.additionalDirectories,
		querySource: options?.querySource,
	};
	// Single source of truth for the token-source triple (never a partial forward).
	const tokenSource = getClaudeTokenSourceFields(options);

	if (toolType === 'claude-code') {
		return spawnClaudeAgent(
			cwd,
			prompt,
			agentSessionId,
			readOnly,
			sshRemoteConfig,
			overrides,
			tokenSource
		);
	}

	if (hasCapability(toolType, 'usesJsonLineOutput')) {
		return spawnJsonLineAgent(
			toolType,
			cwd,
			prompt,
			agentSessionId,
			readOnly,
			sshRemoteConfig,
			overrides
		);
	}

	return spawnFailureResult(`Unsupported agent type for batch mode: ${toolType}`);
}

/**
 * Read a markdown document and count unchecked tasks
 */
export function readDocAndCountTasks(
	folderPath: string,
	filename: string
): { content: string; taskCount: number } {
	const filePath = `${folderPath}/${filename}.md`;

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const matches = content.match(/^[\s]*-\s*\[\s*\]\s*.+$/gm);
		return {
			content,
			taskCount: matches ? matches.length : 0,
		};
	} catch {
		return { content: '', taskCount: 0 };
	}
}

/**
 * Read a markdown document and extract unchecked task text
 */
export function readDocAndGetTasks(
	folderPath: string,
	filename: string
): { content: string; tasks: string[] } {
	const filePath = `${folderPath}/${filename}.md`;

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const matches = content.match(/^[\s]*-\s*\[\s*\]\s*(.+)$/gm);
		const tasks = matches ? matches.map((m) => m.replace(/^[\s]*-\s*\[\s*\]\s*/, '').trim()) : [];
		return { content, tasks };
	} catch {
		return { content: '', tasks: [] };
	}
}

/**
 * Uncheck all markdown checkboxes in content (for reset-on-completion)
 */
export function uncheckAllTasks(content: string): string {
	return content.replace(/^(\s*-\s*)\[x\]/gim, '$1[ ]');
}

/**
 * Write content to a document
 */
export function writeDoc(folderPath: string, filename: string, content: string): void {
	const filePath = `${folderPath}/${filename}`;
	fs.writeFileSync(filePath, content, 'utf-8');
}
