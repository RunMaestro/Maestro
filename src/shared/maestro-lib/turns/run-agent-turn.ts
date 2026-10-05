/**
 * `runAgentTurn`: start an assembled turn, stream it, and say how it ended.
 *
 * `assembleTurn` decides what a turn IS (prompt, arguments, environment); this is everything
 * that has a side effect. It plans the launch (`buildAgentLaunchPlan`, with the SSH remote
 * looked up in the stored settings), refuses what the runtime cannot deliver, starts the
 * process through the library run layer (`runTurn` over `startTurn`), and hands back the turn
 * as an event stream plus a promise of how it ended.
 *
 * Refusals come BEFORE anything is started or written, and none of them falls back to
 * something else:
 *
 * - An SSH remote that cannot be resolved (decision D1c). The turn never runs on this machine
 *   in its place.
 * - Images (PA12). Placing them writes temp files per provider, which waits for CH-8; a silent
 *   drop would send a prompt about a picture the agent never sees.
 * - Standard permission mode on a Claude Code API turn (PA11). The permission relay lives in
 *   the desktop; without it Claude aborts on the first tool call.
 *
 * Completion is the caller's policy (decision D2): the exit facts go through
 * `resolveTurnOutcome`, and the session id is the first one the provider announced (D4).
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getClaudeTokenMode, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import { logger } from '../host';
import { INTERACTIVE_STOP_GRACE_MS } from '../control/termination';
import {
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	createStandaloneClaudeSpawnCoreDeps,
	resolveClaudeSpawnModeCore,
	type ClaudeSpawnCoreDeps,
} from '../launch/interactive-mode';
import { buildAgentLaunchPlan } from '../launch/launch-plan';
import type { SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import {
	sshUnresolvedRemoteMessage,
	wrapSpawnWithSsh,
	type SshSpawnWrapConfig,
	type SshSpawnWrapResult,
} from '../launch/ssh-spawn-wrapper';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { createOutputParser } from '../parsers/parser-factory';
import {
	runTurn,
	UnknownProviderError,
	type CompletedTurn,
	type RunningTurn,
} from '../run/run-to-completion';
import { turnProcessSpecFromPlan, type TurnProcessSpec } from '../run/start-turn';
import type { ResolveTurnOutcomeOptions } from '../streaming/turn-outcome';
import type { AssembledTurn } from './assemble';

/** How long a Windows system prompt file is left for the agent to read. */
const SYSTEM_PROMPT_FILE_LIFETIME_MS = 30_000;

const CLAUDE_CODE_ID = 'claude-code';

export type RunAgentTurnRefusal =
	/** The agent is on an SSH remote that is not usable. The turn did not run. */
	| 'ssh-unresolved'
	/** The turn carries images (CH-8). */
	| 'images-unsupported'
	/** Claude Code in Standard permission mode, with no relay to answer its prompts (PA11). */
	| 'standard-mode-unsupported'
	/** The provider has no output parser, so its answer could not be read. */
	| 'no-parser'
	/** The system prompt file or the process could not be created. */
	| 'launch';

export type RunAgentTurnStart =
	| { ok: true; run: AgentTurnRun }
	| { ok: false; reason: RunAgentTurnRefusal; message: string };

/** What `runAgentTurn` reaches outside its inputs for. Every field has a working default. */
export interface RunAgentTurnDeps {
	/** The environment an SSH wrapper process runs in. Default: this process's. */
	env?: NodeJS.ProcessEnv;
	/** Test seam for the SSH command builder. */
	wrapSpawnWithSsh?: (
		config: SshSpawnWrapConfig,
		sshConfig: NonNullable<AssembledTurn['launch']['sshRemoteConfig']>,
		store: SshRemoteSettingsStore
	) => Promise<SshSpawnWrapResult>;
	/** Where the Windows system prompt file goes. Default: the OS temp directory. */
	tempDir?: string;
}

export interface RunAgentTurnOptions {
	/**
	 * Names the turn to the outcome resolver (`<agent id>-ai-<tab id>`), which exempts a few
	 * session shapes from its empty-answer rule by name.
	 */
	sessionId: string;
	/** The stored SSH remotes (`sshRemotes` in the settings file). Absent: no remote resolves. */
	sshStore?: SshRemoteSettingsStore;
	/** The agent's Claude token source (API, TUI, Dynamic). Unconfigured is API, as on the CLI. */
	claudeTokenSource?: ClaudeTokenSourceFields;
	/**
	 * The collaborators for the Claude token source decision. Default: the standalone set, with
	 * `maestroPBinPath` as the maestro-p script (none: Claude runs `--print`).
	 */
	claudeSpawnDeps?: ClaudeSpawnCoreDeps;
	maestroPBinPath?: string | null;
	/** Aborting stops the turn, from the terminate stage. */
	signal?: AbortSignal;
	/** How long each stop stage gets. Default: `INTERACTIVE_STOP_GRACE_MS`. */
	stopGraceMs?: number;
	/** The caller's completion policy, passed to `resolveTurnOutcome` as given. */
	outcome?: ResolveTurnOutcomeOptions;
	deps?: RunAgentTurnDeps;
}

/** The turn as it runs: events as they are parsed, then how it ended. */
export interface AgentTurnRun {
	pid: number | undefined;
	/**
	 * Every event the provider's parser understood, in order. One consumer: events that arrive
	 * before iteration starts are held, and the stream ends when the turn does.
	 */
	events: AsyncIterable<ParsedEvent>;
	/** How the turn ended. Never rejects: a failure is an outcome. */
	result: Promise<CompletedTurn>;
	/** Stop the way the Stop button does: interrupt, then terminate, then kill the tree. */
	interrupt(): void;
	/** Stop without the interrupt stage. */
	terminate(): void;
	/** Last resort for process exit: no grace, nothing awaited. */
	terminateNow(): void;
	stopRequested(): boolean;
}

/**
 * A single-consumer async queue. `push` never blocks; `close` ends the stream once what was
 * pushed has been read.
 */
class EventStream<T> implements AsyncIterable<T> {
	private readonly buffer: T[] = [];
	private waiting: ((result: IteratorResult<T>) => void) | undefined;
	private closed = false;

	push(value: T): void {
		if (this.closed) return;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = undefined;
			resolve({ value, done: false });
		} else {
			this.buffer.push(value);
		}
	}

	close(): void {
		this.closed = true;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = undefined;
			resolve({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				if (this.buffer.length > 0) {
					return Promise.resolve({ value: this.buffer.shift() as T, done: false });
				}
				if (this.closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => {
					this.waiting = resolve;
				});
			},
		};
	}
}

function refuse(reason: RunAgentTurnRefusal, message: string): RunAgentTurnStart {
	return { ok: false, reason, message };
}

/** Remove a system prompt file, ignoring one that is already gone. */
function removeQuietly(file: string): void {
	fsp.unlink(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') {
			logger.warn('Could not remove the system prompt file', 'RunAgentTurn', {
				file,
				error: error.message,
			});
		}
	});
}

/**
 * Start one assembled turn. Resolves to a refusal (nothing was started) or to the running
 * turn. Never throws for a turn that merely cannot run.
 */
export async function runAgentTurn(
	turn: AssembledTurn,
	options: RunAgentTurnOptions
): Promise<RunAgentTurnStart> {
	const launch = turn.launch;
	const provider = turn.provider;
	const providerId = provider.id;
	const sshConfig = launch.sshRemoteConfig;
	const sshEnabled = sshConfig?.enabled === true;
	const deps = options.deps ?? {};

	if (launch.hasImages) {
		return refuse(
			'images-unsupported',
			'Images cannot be sent from here yet. Send the message without them, or use the desktop.'
		);
	}
	if (!createOutputParser(providerId)) {
		return refuse(
			'no-parser',
			`${provider.name ?? providerId} has no output parser, so its answer could not be read`
		);
	}

	// Windows hands a large system prompt to the agent in a file. Its path is chosen now so the
	// plan carries the argument; the file itself is written only once nothing can refuse the turn.
	const systemPromptFile =
		turn.systemPromptDelivery.via === 'file' && turn.systemPrompt
			? path.join(
					deps.tempDir ?? os.tmpdir(),
					`maestro-sysprompt-${options.sessionId}-${Date.now()}.txt`
				)
			: undefined;
	const args = systemPromptFile
		? [...launch.args, '--append-system-prompt-file', systemPromptFile]
		: launch.args;

	const planned = buildAgentLaunchPlan({ ...launch, args, sshStore: options.sshStore });
	if (!planned.ok) return refuse('ssh-unresolved', planned.error);
	const plan = planned.plan;

	// The Claude token source: `claude --print` (API) or the maestro-p TUI. Unconfigured is API;
	// an SSH agent has no remote probe here, so it is API too (PA15).
	const claudeDecision =
		providerId === CLAUDE_CODE_ID
			? resolveClaudeSpawnModeCore(
					{
						agent: {
							id: providerId,
							interactiveCommand: provider.interactiveCommand,
							interactiveModeArgs: provider.interactiveModeArgs,
							defaultEnvVars: provider.defaultEnvVars,
						},
						tokenMode: getClaudeTokenMode(options.claudeTokenSource),
						sshEnabled,
						sshRemoteId: sshConfig?.remoteId ?? undefined,
						command: launch.command,
						sessionCustomPath: undefined,
						sessionCustomEnvVars: launch.sessionCustomEnvVars,
						maestroPPath: options.claudeTokenSource?.maestroPPath,
						now: new Date(),
					},
					options.claudeSpawnDeps ??
						createStandaloneClaudeSpawnCoreDeps({
							getMaestroPBinPath: () => options.maestroPBinPath ?? null,
						})
				)
			: undefined;

	if (
		claudeDecision?.mode === 'api' &&
		turn.permissionMode === 'standard' &&
		providerId === CLAUDE_CODE_ID
	) {
		return refuse(
			'standard-mode-unsupported',
			'Standard permission mode is not available for Claude Code from here. ' +
				'Switch this tab to Full Access or Read-Only.'
		);
	}

	// The process to start.
	let spec: TurnProcessSpec;
	if (plan.target.kind === 'remote' && sshConfig) {
		// A remote TUI turn runs maestro-p on the remote host instead of `claude`.
		const remoteInteractive = claudeDecision
			? buildRemoteInteractiveSpawn({
					decision: claudeDecision,
					interactiveModeArgs: provider.interactiveModeArgs,
					remoteClaudeBin: claudeDecision.claudeRealBinPath,
				})
			: null;
		const wrap = deps.wrapSpawnWithSsh ?? wrapSpawnWithSsh;
		const wrapped = await wrap(
			{
				command: remoteInteractive ? remoteInteractive.command : plan.command,
				args: remoteInteractive ? [...remoteInteractive.prependArgs, ...plan.args] : plan.args,
				cwd: launch.cwd,
				prompt: launch.prompt,
				customEnvVars: remoteInteractive
					? { ...plan.envVars, ...remoteInteractive.env }
					: plan.envVars,
				agentBinaryName: remoteInteractive ? remoteInteractive.command : provider.binaryName,
				promptArgs: provider.promptArgs,
				noPromptSeparator: provider.noPromptSeparator,
				querySource: launch.querySource,
			},
			sshConfig,
			options.sshStore ?? { getSshRemotes: () => [] }
		);
		// The wrapper degrades to a local spawn when it cannot resolve the remote. Taking that
		// would run the agent here against the remote's path.
		if (!wrapped.sshRemoteUsed)
			return refuse('ssh-unresolved', sshUnresolvedRemoteMessage(sshConfig));
		spec = {
			command: wrapped.command,
			args: wrapped.args,
			cwd: wrapped.cwd,
			env: { ...(deps.env ?? process.env) },
			stdin: wrapped.sshStdinScript,
		};
	} else if (plan.env === undefined) {
		return refuse('launch', 'The launch plan has no local environment');
	} else {
		spec = turnProcessSpecFromPlan({ ...plan, env: plan.env });
		if (claudeDecision?.mode === 'interactive' && claudeDecision.maestroPBinPath) {
			const applied = applyClaudeSpawnDecision({
				decision: claudeDecision,
				interactiveModeArgs: provider.interactiveModeArgs,
				command: plan.command,
				args: plan.args,
				customEnvVars: {},
			});
			// What maestro-p adds (MAESTRO_CLAUDE_BIN and friends) goes over the planned
			// environment, which already holds the user's variables.
			spec = {
				...spec,
				command: applied.command,
				args: applied.args,
				env: { ...spec.env, ...(applied.customEnvVars ?? {}) },
			};
		}
	}

	if (systemPromptFile) {
		try {
			await fsp.writeFile(systemPromptFile, turn.systemPrompt as string, 'utf-8');
		} catch (error) {
			return refuse(
				'launch',
				`Could not write the system prompt file: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	const stream = new EventStream<ParsedEvent>();
	let running: RunningTurn;
	try {
		running = runTurn(
			spec,
			{
				agentId: providerId,
				sessionId: options.sessionId,
				stopGraceMs: options.stopGraceMs ?? INTERACTIVE_STOP_GRACE_MS,
				signal: options.signal,
				outcome: options.outcome,
			},
			{ onEvent: (event) => stream.push(event) }
		);
	} catch (error) {
		if (systemPromptFile) removeQuietly(systemPromptFile);
		if (error instanceof UnknownProviderError) return refuse('no-parser', error.message);
		return refuse(
			'launch',
			`Could not start ${provider.name ?? providerId}: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	// The file is only for the agent's first read. It goes when the turn does, or at the desktop's
	// 30 seconds, whichever is first.
	let fileTimer: NodeJS.Timeout | undefined;
	if (systemPromptFile) {
		fileTimer = setTimeout(() => removeQuietly(systemPromptFile), SYSTEM_PROMPT_FILE_LIFETIME_MS);
		fileTimer.unref();
	}
	const result = running.completed.then((completed) => {
		stream.close();
		if (systemPromptFile) {
			if (fileTimer) clearTimeout(fileTimer);
			removeQuietly(systemPromptFile);
		}
		return completed;
	});

	return {
		ok: true,
		run: {
			pid: running.handle.pid,
			events: stream,
			result,
			interrupt: () => running.handle.interrupt(),
			terminate: () => running.handle.terminate(),
			terminateNow: () => running.handle.terminateNow(),
			stopRequested: () => running.handle.stopRequested(),
		},
	};
}
