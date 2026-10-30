/**
 * `runAgentTurn`: start an assembled turn, stream it, and say how it ended.
 *
 * `assembleTurn` decides what a turn IS (prompt, arguments, environment); this is everything
 * that has a side effect. It plans the launch (`buildAgentLaunchPlan`, with the SSH remote
 * looked up in the stored settings), refuses what the runtime cannot deliver, starts the
 * process through the library run layer (`runTurn` over `startTurn`), and hands back the turn
 * as an event stream plus a promise of how it ended.
 *
 * Refusals come BEFORE anything is started (a Windows system prompt file written by then is
 * removed with the refusal), and none of them falls back to something else:
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
 *
 * What the desktop's spawner and `ProcessManager` do around a running turn is done here too: a
 * resumed Claude session's cost is primed so the turn records its own share, the stdio close
 * watchdog makes sure the turn settles, Stop reaches an SSH agent on its remote host
 * (`guardTurn`), and an effort the provider refused is noted for the process.
 */

import * as os from 'os';
import { readClaudeTurnBaseline, type ClaudeCostState } from '../../claudeCostTracker';
import { getClaudeTokenMode, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import {
	describeEffortRejection,
	noteEffortRejection,
	parseEffortRejection,
	type EffortRejection,
} from '../../effortRejection';
import { logger } from '../host';
import { INTERACTIVE_STOP_GRACE_MS } from '../control/termination';
import { guardTurn, recordRemoteAgent, type RemoteAgentTarget } from '../control/turn-guard';
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
import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { createOutputParser } from '../parsers/parser-factory';
import { removeTempFiles } from '../run/pipe-spawn';
import {
	runTurn,
	UnknownProviderError,
	type CompletedTurn,
	type RunningTurn,
} from '../run/run-to-completion';
import { turnProcessSpecFromPlan, type TurnProcessSpec } from '../run/start-turn';
import type { ResolveTurnOutcomeOptions } from '../streaming/turn-outcome';
import { writeSystemPromptFile } from './args';
import type { AssembledTurn } from './assemble';

const LOG_CONTEXT = '[RunAgentTurn]';

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
	/** The process could not be created. */
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
	/**
	 * The turn runs in the agent's own working directory, so a TUI turn may accept claude's
	 * folder-trust prompt there (#1872). Leave unset for any other folder.
	 */
	acceptWorkspaceTrust?: boolean;
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

/** A resumed Claude Code session's cost tracker as a turn starts, for its parser. */
export interface ClaudeResumeBaseline {
	resumeSessionId: string;
	/** `null`: the session has no tracker yet. `undefined`: unknown (a remote transcript). */
	baseline: ClaudeCostState | null | undefined;
}

/**
 * Claude reports its cost and per-model usage as running SESSION totals. The session's total as a
 * resumed turn starts, read from the transcript it resumes, is what turns them into this turn's
 * (see src/shared/claudeCostTracker.ts). Undefined for any other turn. Read it before the process
 * starts, and hand it to the turn's parser with `primeClaudeResume`.
 */
export function readClaudeResumeBaseline(input: {
	providerId: string;
	resumeSessionId: string | undefined;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The agent runs on another host, whose transcript cannot be read here. */
	remote: boolean;
}): ClaudeResumeBaseline | undefined {
	const { resumeSessionId } = input;
	if (input.providerId !== CLAUDE_CODE_ID || !resumeSessionId) return undefined;
	return {
		resumeSessionId,
		baseline: readClaudeTurnBaseline({
			resumeSessionId,
			cwd: input.cwd,
			env: input.env,
			homeDir: os.homedir(),
			remote: input.remote,
		}),
	};
}

/** Prime a turn's parser with the baseline `readClaudeResumeBaseline` read. */
export function primeClaudeResume(
	parser: AgentOutputParser | null | undefined,
	resume: ClaudeResumeBaseline | undefined
): void {
	if (resume) parser?.primeResumedSession?.(resume.resumeSessionId, resume.baseline);
}

/**
 * The reasoning effort a failed turn was refused, if that is how it failed. The provider's own
 * words can be in the classified error, the answer, or only in the raw stream, so all of them are
 * read. Null for a turn that did not crash: one that finished, or one somebody stopped.
 */
export function effortRefusalOf(completed: CompletedTurn): EffortRejection | null {
	if (completed.outcome !== 'crashed') return null;
	return parseEffortRejection(
		[
			completed.error?.message,
			completed.answerText,
			completed.exit.stderrText,
			completed.exit.stdoutText,
		]
			.filter(Boolean)
			.join('\n')
	);
}

/**
 * Note an effort refusal for the process, as the desktop's error listener does for every agent
 * error, so `resolveEffortLevel` stops offering the value (see `shared/effortRejection.ts`).
 * Answers the refusal, for a caller that retries without the effort.
 */
export function noteEffortRefusal(
	providerId: string,
	completed: CompletedTurn
): EffortRejection | null {
	const rejection = effortRefusalOf(completed);
	if (rejection && noteEffortRejection(providerId, rejection)) {
		logger.warn(
			`${describeEffortRejection(providerId, rejection)} Turns that map to it now use the agent's own effort.`,
			LOG_CONTEXT,
			{ providerId, ...rejection }
		);
	}
	return rejection;
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

	// Windows hands a large system prompt to the agent in a file, through the realization every
	// spawn shares: owner-only, removed after its lifetime, and the inline flag when the write
	// fails. The flag goes into the arguments before the plan places the prompt after them.
	let args = launch.args;
	let systemPromptFile: string | undefined;
	if (turn.systemPromptDelivery.via === 'file' && turn.systemPrompt) {
		const delivered = await writeSystemPromptFile({
			args,
			prompt: launch.prompt,
			systemPrompt: turn.systemPrompt,
			sessionId: options.sessionId,
			agentId: providerId,
			logContext: LOG_CONTEXT,
			tempDir: deps.tempDir,
		});
		args = delivered.args;
		systemPromptFile = delivered.tempFile;
	}
	// A turn refused from here on leaves no file behind for its lifetime.
	const abandon = (reason: RunAgentTurnRefusal, message: string): RunAgentTurnStart => {
		if (systemPromptFile) removeTempFiles([systemPromptFile]);
		return refuse(reason, message);
	};

	const planned = buildAgentLaunchPlan({ ...launch, args, sshStore: options.sshStore });
	if (!planned.ok) return abandon('ssh-unresolved', planned.error);
	const plan = planned.plan;

	// The process to start.
	let spec: TurnProcessSpec;
	let remote: RemoteAgentTarget | undefined;
	if (plan.target.kind === 'remote' && sshConfig) {
		// A remote TUI turn runs maestro-p on the remote host instead of `claude`.
		const remoteInteractive = claudeDecision
			? buildRemoteInteractiveSpawn({
					decision: claudeDecision,
					interactiveModeArgs: provider.interactiveModeArgs,
					remoteClaudeBin: claudeDecision.claudeRealBinPath,
					acceptWorkspaceTrust: options.acceptWorkspaceTrust,
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
			return abandon('ssh-unresolved', sshUnresolvedRemoteMessage(sshConfig));
		// The script records the remote agent's pid, so Stop reaches it and not only the ssh client.
		const recorded = recordRemoteAgent({
			command: wrapped.command,
			args: wrapped.args,
			sshStdinScript: wrapped.sshStdinScript,
			sessionId: options.sessionId,
		});
		remote = recorded.remote;
		spec = {
			command: wrapped.command,
			args: wrapped.args,
			cwd: wrapped.cwd,
			env: { ...(deps.env ?? process.env) },
			stdin: recorded.sshStdinScript,
		};
	} else if (plan.env === undefined) {
		return abandon('launch', 'The launch plan has no local environment');
	} else {
		spec = turnProcessSpecFromPlan({ ...plan, env: plan.env });
		if (claudeDecision?.mode === 'interactive' && claudeDecision.maestroPBinPath) {
			const applied = applyClaudeSpawnDecision({
				decision: claudeDecision,
				interactiveModeArgs: provider.interactiveModeArgs,
				command: plan.command,
				args: plan.args,
				customEnvVars: {},
				acceptWorkspaceTrust: options.acceptWorkspaceTrust,
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

	const claudeResume = readClaudeResumeBaseline({
		providerId,
		resumeSessionId: turn.resumeSessionId,
		cwd: launch.cwd,
		env: spec.env,
		remote: plan.target.kind === 'remote',
	});

	const stopGraceMs = options.stopGraceMs ?? INTERACTIVE_STOP_GRACE_MS;
	const stream = new EventStream<ParsedEvent>();
	let running: RunningTurn;
	try {
		running = runTurn(
			spec,
			{
				agentId: providerId,
				sessionId: options.sessionId,
				stopGraceMs,
				signal: options.signal,
				outcome: options.outcome,
			},
			{ onEvent: (event) => stream.push(event) }
		);
	} catch (error) {
		if (error instanceof UnknownProviderError) return abandon('no-parser', error.message);
		return abandon(
			'launch',
			`Could not start ${provider.name ?? providerId}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	// Before the first line is read, which is on a later tick.
	primeClaudeResume(running.handle.parser, claudeResume);
	const stops = guardTurn(running.handle, {
		sessionId: options.sessionId,
		graceMs: stopGraceMs,
		remote,
		signal: options.signal,
	});

	const result = running.completed.then((completed) => {
		stream.close();
		// The file is only for the agent's first read. It goes when the turn does, or at the end of
		// its lifetime, whichever is first.
		if (systemPromptFile) removeTempFiles([systemPromptFile]);
		noteEffortRefusal(providerId, completed);
		return completed;
	});

	return {
		ok: true,
		run: {
			pid: running.handle.pid,
			events: stream,
			result,
			interrupt: stops.interrupt,
			terminate: stops.terminate,
			terminateNow: stops.terminateNow,
			stopRequested: () => running.handle.stopRequested(),
		},
	};
}
