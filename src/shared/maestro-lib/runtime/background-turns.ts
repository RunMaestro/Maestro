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
 * | Decide the launch | `prepareGroupChatSpawn`: SSH wrap, Claude token source, Windows shell, turn clock |
 * | Decide the process | `planPipeSpawn`: where the prompt travels, the environment, stdin |
 * | Start, stream, stop | `runTurn`: the library run layer's buffered turn |
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
import type { ConsultObserver, ConsultRunner } from '../agents/consult';
import { logger } from '../host';
import {
	resolveClaudeSpawnModeCore,
	createStandaloneClaudeSpawnCoreDeps,
} from '../launch/interactive-mode';
import type { SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import { planPipeSpawn } from '../run/pipe-spawn';
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
import { readSettingsStore } from '../store/read-stores';
import type { AgentConfig } from '../providers/definitions';
import type { BinaryProbe } from '../turns/provider-binary';
import { resolveProviderAgent } from '../turns/provider-agent';
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
	/** Turns running now (group chat and consult). */
	activeCount(): number;
}

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export function createBackgroundTurns(options: BackgroundTurnsOptions): BackgroundTurns {
	const { paths, registry } = options;
	const deps: BackgroundTurnDeps = { runTurn, ...options.deps };
	const sshStore = createSshRemoteStore(paths);

	/** Turns running, by their full process id: what Stop reaches. */
	const running = new Map<string, RunningTurn>();

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
	): Promise<{ success: boolean; pid?: number; error?: string }> {
		const prepared = await prepareGroupChatSpawn(spawn, spawnDeps());
		const plan = planPipeSpawn({
			sessionId: prepared.processId,
			toolType: prepared.providerId,
			cwd: prepared.cwd,
			command: prepared.command,
			args: prepared.args,
			prompt: prepared.prompt,
			promptArgs: prepared.promptArgs,
			noPromptSeparator: prepared.noPromptSeparator,
			// Group chat turns get no global Settings -> Environment variables: their environment is
			// the agent's own overrides, as on the desktop (GD6).
			customEnvVars: prepared.customEnvVars,
			runInShell: prepared.runInShell,
			shell: prepared.shell,
			sendPromptViaStdin: prepared.sendPromptViaStdin,
			sendPromptViaStdinRaw: prepared.sendPromptViaStdinRaw,
			sshStdinScript: prepared.sshStdinScript,
			hasOutputParser: createOutputParser(prepared.providerId) !== null,
		});

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
			return { success: false, error: errorText(error) };
		}

		// A process that never existed has no pid; its error settles the turn a moment later.
		if (turn.handle.pid === undefined) {
			const failed = await turn.completed;
			return {
				success: false,
				error: failed.exit.spawnError?.message ?? 'The process could not be started.',
			};
		}

		const processId = prepared.processId;
		running.set(processId, turn);
		const done = turn.completed.then(async (completed) => {
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
			}
		});
		registry.register(owner, processId, {
			interrupt: () => turn.handle.interrupt(),
			terminate: () => turn.handle.terminate(),
			terminateNow: () => turn.handle.terminateNow(),
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
				running.get(processId)?.handle.terminate();
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
					});
				},
				stop: (processId) => {
					detached.add(processId);
					const turn = running.get(processId);
					const partial = turn?.answerSoFar() ?? '';
					turn?.handle.terminate();
					return partial;
				},
			};
		},

		activeCount: () => running.size,
	};
}
