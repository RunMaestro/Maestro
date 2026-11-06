/**
 * The runtime's background turns: the processes a group chat round and a cross-agent consult are
 * made of, run on this host with no desktop.
 *
 * These are not chat turns. A chat turn is a person's message on an agent's tab (`./turns`); a
 * group chat turn is the moderator or a participant answering inside a room, and a consult is one
 * read-only question put to another agent. Neither is written to an agent's transcript by this
 * module, neither makes its agent look busy (GD20), and each is decided by its own rule: a group
 * chat turn by "did any text come back", a consult by the stricter exit-code rule. What they share
 * is how a process starts and how it is stopped, which is this module:
 *
 * | Step | Piece |
 * | --- | --- |
 * | Deliver the system prompt | `deliverSystemPrompt`: the native flag, a Windows temp file, or embedded |
 * | Decide the launch | `prepareGroupChatSpawn`: SSH wrap, Claude token source, Windows shell, turn clock |
 * | Decide the process | `planPipeSpawn`: where the prompt travels, the environment, stdin |
 * | Start, stream, stop | `runTurn`: the library run layer's buffered turn |
 * | Settle, and stop remotely | `guardTurn`: the stdio close watchdog, Stop on an SSH agent's host |
 * | Own its lifetime | `ProcessRegistry`, under an owner that is not an agent id |
 *
 * Both hosts' runners are built here and differ only in what they report to: a group chat runner
 * hands each observation to the engine (`sessionAnnounced`, `usageReported`, then `turnEnded`, in
 * that order, so the next spawn reads the stored session id), a consult runner to its observer.
 *
 * Design: `Plans/maestro-tui-group-chat.md` section 6.1.
 */

import type { UsageStats } from '../../types';
import { BACKGROUND_STOP_GRACE_MS } from '../control/termination';
import { guardTurn, type GuardedTurnStops } from '../control/turn-guard';
import type { ConsultObserver, ConsultRunner } from '../agents/consult';
import { logger } from '../host';
import {
	resolveClaudeSpawnModeCore,
	createStandaloneClaudeSpawnCoreDeps,
} from '../launch/interactive-mode';
import { resolveSshLaunchTarget, type SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import {
	argsResumeSession,
	planPipeSpawn,
	removeTempFiles,
	resumeIdFromArgs,
} from '../run/pipe-spawn';
import {
	runTurn,
	type CompletedTurn,
	type RunTurnOptions,
	type RunningTurn,
} from '../run/run-to-completion';
import {
	DEFAULT_STDOUT_TAIL_LIMIT,
	type TurnHandlers,
	type TurnProcessSpec,
} from '../run/start-turn';
import { prepareGroupChatSpawn, type GroupChatSpawnDeps } from '../groupchat/spawn';
import { getWindowsSpawnConfig } from '../groupchat/windows-spawn';
import type { GroupChatSpawn, GroupChatTurnRunner } from '../groupchat/types';

/** How a turn started: running with a pid, or refused with nothing running. */
type GroupChatTurnStart = Awaited<ReturnType<GroupChatTurnRunner['start']>>;
import { readSettingsStore } from '../store/read-stores';
import type { AgentConfig } from '../providers/definitions';
import { deliverSystemPrompt } from '../turns/args';
import type { BinaryProbe } from '../turns/provider-binary';
import { resolveProviderAgent } from '../turns/provider-agent';
import {
	noteEffortRefusal,
	primeClaudeResume,
	readClaudeResumeBaseline,
} from '../turns/run-agent-turn';
import type { ProcessRegistry } from './processes';
import type { RuntimeTurnOptions } from './turns';
import { createSshRemoteStore } from './ssh-store';

const LOG_CONTEXT = '[BackgroundTurns]';

/** The owner a group chat's turns register under: not an agent id, so no agent reads busy for them. */
export const groupChatOwner = (chatId: string): string => `group-chat:${chatId}`;

/** The owner a consult's turn registers under. */
export const consultOwner = (requestId: string): string => `consult:${requestId}`;

/** Seams for tests: the provider launch and the binary probe. */
export interface BackgroundTurnDeps {
	/** Start one buffered turn. A test replaces it with a recorded provider. */
	runTurn(spec: TurnProcessSpec, options: RunTurnOptions, handlers: TurnHandlers): RunningTurn;
	probeBinary?: BinaryProbe;
}

export interface BackgroundTurnsOptions {
	paths: MaestroPaths;
	registry: ProcessRegistry;
	/** The `maestro-p` script a Claude agent on the TUI token source runs through. */
	host: Pick<RuntimeTurnOptions, 'maestroPBinPath'>;
	/** Starts the turn clock for a process id (`GroupChatTurnMetrics.begin`). */
	beginTurn(processId: string): void;
	deps?: Partial<BackgroundTurnDeps>;
}

/** What a runner reports about one turn, in the order it happens. */
interface TurnHooks {
	/** Proof of life: output arrived. Restarts the silence budget. */
	onActivity?(): void;
	/** A chunk of the provider's raw output, as it streams. */
	onOutput?(chunk: string): void;
	/** The provider announced its own session id. Awaited before usage and the end. */
	onSessionId?(sessionId: string): Promise<void> | void;
	/** What the turn cost. Reported once, before the end. */
	onUsage?(usage: UsageStats): void;
	/** The turn is over and everything above has been reported. The registry waits for this. */
	onEnd(completed: CompletedTurn): Promise<void> | void;
}

/** What a group chat round hears about its turns. `onEnd` is the engine's `turnEnded`. */
export interface GroupChatRunnerHandlers {
	chatIdOf(processId: string): string | undefined;
	onActivity(processId: string): void;
	onOutput(processId: string, chunk: string): void;
	onSessionId(processId: string, sessionId: string): Promise<void>;
	onUsage(processId: string, usage: UsageStats): void;
	onEnd(processId: string, completed: CompletedTurn): Promise<void>;
}

export interface BackgroundTurns {
	/** The launch description of a provider on this machine, or null for one this build does not know. */
	resolveAgent(providerId: string): Promise<AgentConfig | null>;
	/** The SSH remotes, read per use so a desktop edit applies to the next turn. */
	readonly sshStore: SshRemoteSettingsStore;
	/** The runner a group chat round starts its turns through. */
	groupChatRunner(handlers: GroupChatRunnerHandlers): GroupChatTurnRunner;
	/** The runner a consult starts its one turn through. */
	consultRunner(): ConsultRunner;
	/** Turns whose process is running now (group chat and consult). */
	activeCount(): number;
	/**
	 * Turns the process registry still holds for this module: running, or ended and still
	 * reporting their end. The count to subtract from the registry's size.
	 */
	registeredCount(): number;
	/**
	 * Resolves once every registered turn `match` selects has ended and reported its end. A turn
	 * that is stopped still reports (a log line, a participant card), so a caller about to delete
	 * what those reports write to waits here first.
	 */
	whenSettled(match: (processId: string) => boolean): Promise<void>;
}

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export function createBackgroundTurns(options: BackgroundTurnsOptions): BackgroundTurns {
	const { paths, registry } = options;
	const deps: BackgroundTurnDeps = { runTurn, ...options.deps };
	const sshStore = createSshRemoteStore(paths);

	/** Turns running, by their full process id: what Stop reaches, through the guarded stops. */
	const running = new Map<string, { turn: RunningTurn; stops: GuardedTurnStops }>();
	// Stop must also reach a turn waiting for system delivery or SSH preparation.
	const preparing = new Map<string, AbortController>();
	// A turn stays in the process registry until `done` settles, which is after its end has been
	// reported (and the moderator's report starts the participants). `running` drops it earlier.
	const registered = new Map<string, Promise<void>>();

	function readCustomShellPath(): string | undefined {
		const settings = readSettingsStore(paths.settingsFile);
		const value = settings.status === 'ok' ? settings.data.customShellPath : undefined;
		return typeof value === 'string' && value !== '' ? value : undefined;
	}

	const spawnDeps = (): GroupChatSpawnDeps => ({
		sshStore,
		resolveClaudeSpawnMode: (input) =>
			resolveClaudeSpawnModeCore(
				input,
				createStandaloneClaudeSpawnCoreDeps({
					getMaestroPBinPath: () => options.host.maestroPBinPath ?? null,
					logger,
				})
			),
		windowsSpawnConfig: (agentId, ssh) =>
			getWindowsSpawnConfig(agentId, ssh ?? undefined, { customShellPath: readCustomShellPath() }),
		beginTurn: options.beginTurn,
	});

	/**
	 * Start one turn and keep reporting it to `hooks` until it ends.
	 *
	 * `success: false` is a refusal: nothing runs and no end will be reported. A launch that cannot
	 * be prepared (an SSH remote that does not resolve) THROWS, as the desktop's spawn does, and the
	 * engine words it for the room.
	 */
	async function launch(
		spawn: GroupChatSpawn,
		owner: string,
		hooks: TurnHooks
	): Promise<GroupChatTurnStart> {
		if (preparing.has(spawn.processId) || running.has(spawn.processId)) {
			return { success: false, error: 'A background turn with this process id already exists.' };
		}
		const abort = new AbortController();
		const processId = spawn.processId;
		const privatePrompt = !!spawn.agent.promptFile;
		const preparationFiles: string[] = [];
		let started = false;
		preparing.set(processId, abort);
		try {
			const result = await launchPrepared(spawn, owner, hooks, abort.signal, preparationFiles);
			started = result.success;
			return result;
		} catch (error) {
			if (privatePrompt) throw new Error('Prompt-file background preparation unavailable.');
			throw error;
		} finally {
			if (!started) removeTempFiles(preparationFiles);
			preparing.delete(processId);
		}
	}

	async function launchPrepared(
		spawn: GroupChatSpawn,
		owner: string,
		hooks: TurnHooks,
		signal: AbortSignal,
		preparationFiles: string[]
	): Promise<GroupChatTurnStart> {
		// Keep selected account, model, host and arguments stable across preparation's awaits.
		spawn = {
			...spawn,
			agent: {
				...spawn.agent,
				capabilities: { ...spawn.agent.capabilities },
				promptFile: spawn.agent.promptFile
					? {
							...spawn.agent.promptFile,
							exclusivePromptFlags: [...spawn.agent.promptFile.exclusivePromptFlags],
						}
					: undefined,
			},
			args: [...spawn.args],
			customEnvVars: spawn.customEnvVars ? { ...spawn.customEnvVars } : undefined,
			agentConfigValues: spawn.agentConfigValues ? { ...spawn.agentConfigValues } : undefined,
			sshRemoteConfig: spawn.sshRemoteConfig ? { ...spawn.sshRemoteConfig } : spawn.sshRemoteConfig,
		};
		const privatePrompt = !!spawn.agent.promptFile;
		// Pin the selected endpoint before system delivery yields. The shared preparer
		// and SSH wrapper must read the same host even if settings change meanwhile.
		const preparation = spawnDeps();
		const target = resolveSshLaunchTarget(sshStore, spawn.sshRemoteConfig);
		if (target.kind === 'unresolved') throw new Error(target.message);
		if (target.kind === 'remote') {
			const remote = structuredClone(target.remote);
			preparation.sshStore = { getSshRemotes: () => [structuredClone(remote)] };
		}
		const isResume = !!spawn.isResume || (privatePrompt && argsResumeSession(spawn.args));
		if (privatePrompt && isResume && !resumeIdFromArgs(spawn.args)) {
			throw new Error('Prompt-file resume requires an explicit provider session identity.');
		}
		spawn.isResume = isResume;
		const cancelled: GroupChatTurnStart = {
			success: false,
			error: 'Background turn cancelled before spawn.',
		};
		// System prompt first, so every later step (maestro-p rewrite, SSH wrap, Windows stdin)
		// sees the final args and prompt, as on the desktop (`spawnGroupChatAgent`).
		const delivered = await deliverSystemPrompt({
			args: spawn.args,
			prompt: spawn.prompt,
			systemPrompt: spawn.appendSystemPrompt,
			supportsAppendSystemPrompt: !!spawn.agent.capabilities?.supportsAppendSystemPrompt,
			isResume,
			isSshSession: !!spawn.sshRemoteConfig?.enabled,
			sessionId: spawn.processId,
			agentId: spawn.providerId,
			logContext: LOG_CONTEXT,
		}).catch((error: unknown) => {
			if (privatePrompt) throw new Error('Prompt-file system preparation unavailable.');
			throw error;
		});
		if (delivered.tempFile) preparationFiles.push(delivered.tempFile);
		if (signal.aborted) return cancelled;
		const prepared = await prepareGroupChatSpawn(
			{ ...spawn, args: delivered.args, prompt: delivered.prompt },
			preparation
		).catch((error: unknown) => {
			if (privatePrompt) throw new Error('Prompt-file background preparation unavailable.');
			throw error;
		});
		if (signal.aborted) return cancelled;
		const artifact = prepared.promptDelivery?.artifact;
		if (
			artifact?.owner === 'remote' &&
			(!spawn.sshRemoteConfig?.enabled ||
				artifact.sshRemoteId !== spawn.sshRemoteConfig.remoteId ||
				prepared.promptArtifactPath !== artifact.path)
		) {
			throw new Error('Prompt-file delivery does not match its host plan.');
		}
		const plan = planPipeSpawn({
			sessionId: prepared.processId,
			toolType: prepared.providerId,
			cwd: prepared.cwd,
			command: prepared.command,
			args: prepared.args,
			prompt: artifact ? undefined : prepared.prompt,
			// startTurn owns local files; the SSH script and guarded remote stop own remote files.
			promptDelivery: artifact?.owner === 'local' ? prepared.promptDelivery : undefined,
			promptArtifactPath: prepared.promptArtifactPath,
			promptArgs: prepared.promptArgs,
			noPromptSeparator: prepared.noPromptSeparator,
			// Group chat turns get no global Settings -> Environment variables: their environment is
			// the agent's own overrides, as on the desktop (GD6).
			customEnvVars: prepared.customEnvVars,
			runInShell: prepared.runInShell,
			shell: prepared.shell,
			sendPromptViaStdin: artifact ? false : prepared.sendPromptViaStdin,
			sendPromptViaStdinRaw: artifact ? false : prepared.sendPromptViaStdinRaw,
			sshStdinScript: prepared.sshStdinScript,
			hasOutputParser: createOutputParser(prepared.providerId) !== null,
		});
		preparationFiles.push(...plan.tempFiles);
		if (delivered.tempFile) plan.tempFiles.push(delivered.tempFile);
		const claudeResume = readClaudeResumeBaseline({
			providerId: prepared.providerId,
			// An SSH spawn's arguments hold no resume flag of their own (the remote command does), so
			// it is not primed here: its parser falls back on the total it saw the session report.
			resumeSessionId: resumeIdFromArgs(prepared.args),
			cwd: prepared.cwd,
			env: plan.spec.env,
			remote: !!spawn.sshRemoteConfig?.enabled,
		});

		if (signal.aborted) return cancelled;
		let turn: RunningTurn;
		try {
			turn = deps.runTurn(
				plan.spec,
				{
					agentId: prepared.providerId,
					sessionId: prepared.processId,
					stopGraceMs: BACKGROUND_STOP_GRACE_MS,
					stdoutTailLimit: DEFAULT_STDOUT_TAIL_LIMIT,
					keepStdinOpen: plan.keepStdinOpen,
					label: spawn.debugLabel,
					signal,
				},
				{
					onStdout: (chunk) => {
						hooks.onOutput?.(chunk);
						// Any output is proof of life: a stream the parser cannot read still means it is working.
						hooks.onActivity?.();
					},
					onEvent: () => hooks.onActivity?.(),
				}
			);
		} catch (error) {
			// An unknown provider, or an option the process could not be created with.
			return {
				success: false,
				error: privatePrompt ? 'Prompt-file process could not be started.' : errorText(error),
			};
		}
		// The running turn now owns legacy preparation cleanup through its completion.
		preparationFiles.length = 0;
		// Before the first line is read, which is on a later tick.
		primeClaudeResume(turn.handle.parser, claudeResume);
		const stops = guardTurn(turn.handle, {
			sessionId: prepared.processId,
			graceMs: BACKGROUND_STOP_GRACE_MS,
			remote: plan.remoteAgent,
		});
		if (signal.aborted) stops.terminate();
		const ended = turn.completed.then((completed) => {
			removeTempFiles(plan.tempFiles);
			noteEffortRefusal(prepared.providerId, completed);
			return completed;
		});

		// A process that never existed has no pid; its error settles the turn a moment later.
		if (turn.handle.pid === undefined) {
			const failed = await ended;
			return {
				success: false,
				error: privatePrompt
					? 'Prompt-file process could not be started.'
					: (failed.exit.spawnError?.message ?? 'The process could not be started.'),
			};
		}

		const processId = prepared.processId;
		running.set(processId, { turn, stops });
		const done = ended.then(async (completed) => {
			running.delete(processId);
			try {
				if (completed.sessionId) await hooks.onSessionId?.(completed.sessionId);
				const usage = completed.usage;
				if (usage) {
					// A provider that reports no window leaves the share to the agent's configured one.
					hooks.onUsage?.(
						usage.contextWindow > 0 ? usage : { ...usage, contextWindow: prepared.contextWindow }
					);
				}
				await hooks.onEnd(completed);
			} catch (error) {
				logger.error(`Reporting the end of ${processId} failed: ${errorText(error)}`, LOG_CONTEXT);
			} finally {
				registered.delete(processId);
			}
		});
		registered.set(processId, done);
		registry.register(owner, processId, {
			interrupt: stops.interrupt,
			terminate: stops.terminate,
			terminateNow: stops.terminateNow,
			done,
		});
		return { success: true, pid: turn.handle.pid };
	}

	return {
		resolveAgent: (providerId) =>
			resolveProviderAgent(providerId, { paths, probe: deps.probeBinary }),
		sshStore,

		groupChatRunner: (handlers) => ({
			start: (spawn) => {
				const processId = spawn.processId;
				const owner = groupChatOwner(handlers.chatIdOf(processId) ?? 'unknown');
				return launch(spawn, owner, {
					onActivity: () => handlers.onActivity(processId),
					onOutput: (chunk) => handlers.onOutput(processId, chunk),
					onSessionId: (sessionId) => handlers.onSessionId(processId, sessionId),
					onUsage: (usage) => handlers.onUsage(processId, usage),
					onEnd: (completed) => handlers.onEnd(processId, completed),
				});
			},
			stop: (processId) => {
				preparing.get(processId)?.abort();
				running.get(processId)?.stops.terminate();
			},
		}),

		consultRunner: () => {
			/** Consults the service stopped: nothing is reported about them after that. */
			const detached = new Set<string>();
			return {
				start: (spawn: GroupChatSpawn, observer: ConsultObserver) => {
					const processId = spawn.processId;
					const live = (): boolean => !detached.has(processId);
					return launch(spawn, consultOwner(processId), {
						onActivity: () => {
							if (live()) observer.onActivity();
						},
						onSessionId: (sessionId) => {
							if (live()) observer.onSessionId(sessionId);
						},
						onEnd: (completed) => {
							if (!live()) {
								detached.delete(processId);
								return;
							}
							observer.onEnd({
								exitCode: completed.exit.exitCode,
								readText: () => completed.answerText ?? '',
							});
						},
					}).finally(() => {
						if (!running.has(processId)) detached.delete(processId);
					});
				},
				stop: (processId) => {
					detached.add(processId);
					preparing.get(processId)?.abort();
					const entry = running.get(processId);
					const partial = entry?.turn.answerSoFar() ?? '';
					entry?.stops.terminate();
					return partial;
				},
			};
		},

		activeCount: () => running.size,
		registeredCount: () => registered.size,
		whenSettled: async (match) => {
			await Promise.all([...registered].filter(([id]) => match(id)).map(([, done]) => done));
		},
	};
}
