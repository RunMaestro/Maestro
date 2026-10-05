/**
 * Auto Run in the runtime: `AutoRunApi` answered in process (AR-1 to AR-9, gap L6).
 *
 * The engine (`autorun/run-playbook.ts`, `run-goal.ts`) is the one the CLI runs. This is its
 * runtime adapter: it validates a launch, builds the engine's ports from the runtime's own pieces,
 * drives the generator in the background, folds its events into the progress frames a client
 * reads, and answers the controls. The TUI's Auto Run view (Phase 4) reads those frames and the
 * run's output stream, so it works headless with no change.
 *
 * | Port | Runtime piece |
 * | --- | --- |
 * | turns | `createAutoRunTurnRunner` (assemble, run, register, watchdog, `query_events`) |
 * | documents | `createLocalDocuments` (fence-aware counts) |
 * | history | the library history writer, `readHistory` for the totals reconciliation |
 * | stats | `auto_run_sessions` and `auto_run_tasks` through the stats recorder |
 * | prompts | the library prompt loader |
 * | environment | local git, the repository's groups |
 * | activity | `cli-activity.json` under THIS data directory (AE18) |
 *
 * Rules the adapter keeps, so no caller has to:
 *
 * - **A refusal is a `rejected` answer, before anything starts** (AE16): Auto Run turned off,
 *   an agent that is not there, one on an SSH remote, one that is busy, a document outside the
 *   agent's Auto Run folder, no unchecked tasks, a stale halt marker, an empty goal.
 * - **One run per agent**, and while it runs it holds the agent's working tree (AE17): a chat
 *   message that would write waits for the run to end (`holds`).
 * - **Controls answer on delivery**, as the desktop's do. `resume` also answers a gate: there is
 *   no separate verb for one.
 * - **The last frame of a run is `state: null`**, after the counts it ended on.
 *
 * Deferred, with the reason in `Plans/maestro-tui-autorun-engine.md`: worktree runs (AE13),
 * steering notes (AE14), a working copy per loop (AE21), Agent Resilience retry (W4), and Auto Run
 * for an SSH-remote agent (W6).
 */

import * as path from 'path';

import { describeUnresolvedHaltMarker } from '../../autorunMarkers';
import type { AutoRunBroadcastState } from '../../autoRunBroadcast';
import type { GoalRunConfig } from '../../goalDriven/types';
import type { Playbook, SessionInfo } from '../../types';
import {
	registerCliActivity,
	unregisterCliActivity,
	isSessionBusyWithCli,
} from '../../cli-activity';
import { sshRecordOf } from '../agents/rules';
import type { AgentRepository } from '../agents/repository';
import { resolveAutoRunFolder } from '../autorun/documents';
import type { AutoRunDeps, AutoRunEvent } from '../autorun/engine-types';
import {
	DEFAULT_GOAL_MAX_ITERATIONS,
	validateAutoRunLaunch,
	validateGoalRunLaunch,
	type AutoRunLaunchInput,
	type GoalRunLaunchInput,
} from '../autorun/launch';
import { DESKTOP_AUTORUN_POLICY } from '../autorun/policy';
import { preflightPlaybook } from '../autorun/preflight';
import { HITL_GATE_ERROR_TYPE, parseAutoRunProgress } from '../autorun/progress';
import { createRunController, type RunController } from '../autorun/run-control';
import { runGoal } from '../autorun/run-goal';
import type { AutoRunRunEvent } from '../autorun/run-tracker';
import { runPlaybook } from '../autorun/run-playbook';
import { buildTaskSelectionBlock } from '../autorun/task-selection';
import type { EventBus } from '../client/event-bus';
import type {
	AutoRunApi,
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
} from '../client/types';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
import { createPromptLoaderFor } from '../prompts/load';
import { readHistory } from '../store/read-history';
import { readSettingsStore } from '../store/read-stores';
import { toTurnAgent } from '../turns/records';
import { createHistoryWriter } from '../turns/history';
import {
	createStatsRecorder,
	readStatsCollectionEnabled,
	type StatsRecorder,
} from '../turns/stats';
import { createAutoRunTurnRunner, type AutoRunStreamEvent } from './autorun-turns';
import type { DataDirVerdict } from './data-dir-lock';
import { commitAll, isGitRepository, readGitBranch } from './git';
import { createLocalDocuments } from './local-documents';
import type { ProcessRegistry } from './processes';
import type { RuntimeTurnDeps, RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[RuntimeAutoRun]';

/** One run in flight, for `host status` and for refusing a `host stop`. */
export interface ActiveAutoRun {
	agentId: string;
	kind: 'playbook' | 'goal';
	startedAt: number;
	/** Parked on an error or a gate, waiting for an answer. */
	paused: boolean;
}

export interface RuntimeAutoRunOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	bus: EventBus;
	registry: ProcessRegistry;
	fence(): DataDirVerdict;
	options?: RuntimeTurnOptions;
	deps?: Partial<RuntimeTurnDeps>;
	/** A run ended: whatever it held back (queued chat messages) may start now. */
	onRunEnded?(agentId: string): void;
	/** Test seam: the stats writer. Default: the library recorder over the host's SQLite loader. */
	statsRecorder?: StatsRecorder;
}

export interface RuntimeAutoRun {
	readonly api: AutoRunApi;
	activeRuns(): ActiveAutoRun[];
	/** Does a run hold this agent's working tree (AE17)? */
	holds(agentId: string): boolean;
	/** The latest progress of a live run in the wire shape, for a host's replay when a client connects. */
	latestState(agentId: string): AutoRunBroadcastState | undefined;
	/** Stop every run at once and wait for each to record how it ended. */
	stopAll(): Promise<void>;
}

interface RunHandle {
	agentId: string;
	kind: 'playbook' | 'goal';
	startedAt: number;
	controller: RunController;
	abort: AbortController;
	wire: AutoRunBroadcastState;
	/** The playbook's documents, as names under `folder`. Empty for a goal run. */
	documents: string[];
	folder: string;
	done: Promise<void>;
}

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fail<T = never>(
	method: ClientMethod,
	code: ClientErrorCode,
	message: string
): ClientResult<T> {
	const error: ClientError = { code, message, method };
	return { ok: false, error };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function noLoader(): never {
	throw new Error('This host did not provide a SQLite loader, so usage is not recorded.');
}

/** `name` under `folder` without `.md`, `/`-separated; `undefined` when `file` is outside the folder. */
function documentNameUnder(folder: string, file: string): string | undefined {
	const absolute = path.isAbsolute(file) ? file : path.join(folder, file);
	const relative = path.relative(folder, absolute);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
	return relative.replace(/\\/g, '/').replace(/\.md$/i, '');
}

export function createRuntimeAutoRun(options: RuntimeAutoRunOptions): RuntimeAutoRun {
	const { paths, repository, bus, registry } = options;
	const host = options.options ?? {};
	const now = options.deps?.now ?? (() => Date.now());

	const documents = createLocalDocuments();
	const historyWriter = createHistoryWriter({ paths, fence: options.fence });
	const statsRecorder =
		options.statsRecorder ??
		createStatsRecorder({
			paths,
			loadSqlite: host.loadSqlite ?? noLoader,
			fence: options.fence,
			isEnabled: () => readStatsCollectionEnabled(paths.settingsFile),
		});
	// Found on first use: a runtime that never runs Auto Run should not go looking for prompts.
	let loader: ReturnType<typeof createPromptLoaderFor>;
	let loaderLooked = false;
	const promptLoader = () => {
		if (!loaderLooked) {
			loaderLooked = true;
			loader = createPromptLoaderFor({
				userDataDir: paths.userDataDir,
				...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
				...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
			});
		}
		return loader;
	};

	const runs = new Map<string, RunHandle>();
	/** Agents with a launch being checked: two launches racing past the busy check must not both start. */
	const launching = new Set<string>();

	const emitRun = (agentId: string, event: AutoRunRunEvent): void =>
		bus.emit({ type: 'autorun', agentId, event });

	/** Send the run's current frame. The wire shape stays here; clients get the parsed form. */
	const publish = (handle: RunHandle): void => {
		emitRun(handle.agentId, {
			kind: 'state',
			at: now(),
			state: parseAutoRunProgress(handle.wire),
		});
	};

	const forwardStream = (agentId: string, event: AutoRunStreamEvent): void => {
		if (event.kind === 'output') {
			emitRun(agentId, { kind: 'output', at: now(), processId: event.processId, text: event.text });
		} else {
			emitRun(agentId, {
				kind: 'usage',
				at: now(),
				processId: event.processId,
				usage: event.usage,
			});
		}
	};

	// -----------------------------------------------------------------------
	// Progress: engine events to the frame a client draws
	// -----------------------------------------------------------------------

	/** Recount the run's documents after a task, as the desktop does, so the bars move with the files. */
	function recount(handle: RunHandle): void {
		if (handle.kind !== 'playbook') return;
		let total = 0;
		let done = 0;
		let currentTotal = 0;
		let currentDone = 0;
		handle.documents.forEach((name, index) => {
			const { unchecked, checked } = documents.read(handle.folder, name);
			const docChecked = checked ?? 0;
			total += unchecked + docChecked;
			done += docChecked;
			if (index === handle.wire.currentDocumentIndex) {
				currentTotal = unchecked + docChecked;
				currentDone = docChecked;
			}
		});
		handle.wire = {
			...handle.wire,
			totalTasks: currentTotal,
			completedTasks: currentDone,
			currentTaskIndex: currentDone,
			totalTasksAcrossAllDocs: total,
			completedTasksAcrossAllDocs: done,
			currentDocTasksTotal: currentTotal,
			currentDocTasksCompleted: currentDone,
		};
	}

	function clearPause(wire: AutoRunBroadcastState): AutoRunBroadcastState {
		const {
			errorPaused: _paused,
			errorMessage: _message,
			errorType: _type,
			errorRecoverable: _recoverable,
			errorDocumentIndex: _index,
			errorTaskDescription: _task,
			...rest
		} = wire;
		return rest;
	}

	function project(handle: RunHandle, event: AutoRunEvent): void {
		switch (event.type) {
			case 'document_start': {
				handle.wire = { ...handle.wire, currentDocumentIndex: event.index as number };
				recount(handle);
				break;
			}
			case 'task_complete':
			case 'document_complete':
			case 'gate_acknowledged':
				recount(handle);
				break;
			case 'loop_complete':
				handle.wire = { ...handle.wire, loopIteration: event.iteration as number };
				recount(handle);
				break;
			case 'paused': {
				const gate = event.kind === 'gate';
				const agentError = event.agentError as
					| { type: string; message: string; recoverable?: boolean }
					| undefined;
				const gateInfo = event.gate as { reason: string } | undefined;
				const documentIndex = event.documentIndex as number | undefined;
				handle.wire = {
					...handle.wire,
					errorPaused: true,
					errorMessage: gate
						? (gateInfo?.reason ?? 'Waiting on a person.')
						: (agentError?.message ?? 'The run is paused.'),
					errorType: gate ? HITL_GATE_ERROR_TYPE : (agentError?.type ?? 'unknown'),
					errorRecoverable: gate ? true : agentError?.recoverable === true,
					...(documentIndex !== undefined ? { errorDocumentIndex: documentIndex } : {}),
					...(typeof event.document === 'string' ? { errorTaskDescription: event.document } : {}),
				};
				break;
			}
			case 'resumed':
				handle.wire = clearPause(handle.wire);
				break;
			case 'goal_iteration_start':
				handle.wire = { ...handle.wire, goalIteration: event.iteration as number };
				break;
			case 'goal_iteration_complete': {
				const progress = event.progress as number;
				handle.wire = {
					...handle.wire,
					goalProgress: progress,
					completedTasks: progress,
					completedTasksAcrossAllDocs: progress,
					currentTaskIndex: progress,
					...(typeof event.rationale === 'string' ? { goalRationale: event.rationale } : {}),
				};
				break;
			}
			default:
				return;
		}
		publish(handle);
	}

	// -----------------------------------------------------------------------
	// The engine's ports
	// -----------------------------------------------------------------------

	function buildDeps(agentId: string, controller: RunController): AutoRunDeps {
		const turns = createAutoRunTurnRunner({
			agentId,
			paths,
			repository,
			registry,
			statsRecorder,
			host,
			deps: {
				runAgentTurn: options.deps?.runAgentTurn as RuntimeTurnDeps['runAgentTurn'],
				probeBinary: options.deps?.probeBinary,
				readGitBranch: options.deps?.readGitBranch,
				now,
			},
			onStream: (event) => forwardStream(agentId, event),
		});
		const loadPrompt = async (id: string): Promise<string> => {
			const text = promptLoader()?.get(id);
			if (text === undefined) throw new Error(`The prompt "${id}" could not be loaded.`);
			return text;
		};
		return {
			turns: { run: (request) => turns.run(request) },
			documents,
			history: {
				append: async (entry) => {
					const result = await historyWriter.append(agentId, entry);
					if (!result.ok) logger.warn(`History row not written: ${result.message}`, LOG_CONTEXT);
				},
				readAll: (id) => {
					const read = readHistory(paths, id, { limit: Number.MAX_SAFE_INTEGER });
					if (read.status === 'ok') return read.entries;
					if (read.status === 'missing') return [];
					throw new Error(`History could not be read: ${read.reason}`);
				},
			},
			stats: {
				startRun: async (run) => {
					const result = await statsRecorder.startAutoRun({
						sessionId: agentId,
						agentType: run.agentType,
						documentPath: run.documentPath,
						startTime: run.startTime,
						duration: 0,
						tasksTotal: run.tasksTotal,
						projectPath: run.projectPath,
					});
					return result.ok ? result.id : null;
				},
				recordTask: async (runId, task) => {
					const session = repository.getAgent(agentId);
					await statsRecorder.recordAutoTask({
						autoRunSessionId: runId,
						sessionId: agentId,
						agentType: session?.toolType ?? '',
						taskIndex: task.taskIndex,
						...(task.taskContent ? { taskContent: task.taskContent } : {}),
						startTime: task.startTime,
						duration: task.duration,
						success: task.success,
					});
				},
				endRun: async (runId, durationMs, tasksCompleted) => {
					await statsRecorder.endAutoRun(runId, durationMs, tasksCompleted);
				},
			},
			prompts: {
				get: (id) => loadPrompt(id),
				taskSelectionBlock: (mode, segment) => buildTaskSelectionBlock(loadPrompt, mode, segment),
			},
			environment: {
				gitBranch: options.deps?.readGitBranch ?? readGitBranch,
				isGitRepo: isGitRepository,
				groupName: (groupId) =>
					groupId ? repository.listGroups().find((group) => group.id === groupId)?.name : undefined,
				commitAll,
			},
			activity: {
				begin: (entry) =>
					registerCliActivity(
						{
							sessionId: entry.agentId,
							playbookId: entry.playbookId,
							playbookName: entry.playbookName,
							startedAt: entry.startedAt,
							pid: process.pid,
						},
						paths.userDataDir
					),
				end: (id) => unregisterCliActivity(id, paths.userDataDir),
			},
			clock: { now },
			log: {
				autorun: (message, context, data) =>
					logger.info(message, context ? `${LOG_CONTEXT} ${context}` : LOG_CONTEXT, data),
				warn: (message, context, data) =>
					logger.warn(message, context ? `${LOG_CONTEXT} ${context}` : LOG_CONTEXT, data),
			},
			policy: DESKTOP_AUTORUN_POLICY,
			controller,
		};
	}

	// -----------------------------------------------------------------------
	// Driving a run
	// -----------------------------------------------------------------------

	function startRun(handle: Omit<RunHandle, 'done'>, events: AsyncGenerator<AutoRunEvent>): void {
		const run: RunHandle = { ...handle, done: Promise.resolve() };
		runs.set(run.agentId, run);
		run.done = (async () => {
			publish(run);
			try {
				for await (const event of events) project(run, event);
			} catch (error) {
				logger.error(`An Auto Run failed: ${errorText(error)}`, LOG_CONTEXT);
			} finally {
				runs.delete(run.agentId);
				// The last frame: no run. A client keeps the counts it already folded.
				emitRun(run.agentId, { kind: 'state', at: now(), state: null });
				options.onRunEnded?.(run.agentId);
			}
		})();
	}

	function newController(): RunController {
		return createRunController({ clock: { now }, autoResume: DESKTOP_AUTORUN_POLICY.autoResume });
	}

	/** The checks every launch shares, before anything starts (AE16). */
	function refuseLaunch(
		method: ClientMethod,
		agentId: string
	): { session: SessionInfo } | ClientResult<never> {
		const settings = readSettingsStore(paths.settingsFile);
		if (settings.status === 'ok' && settings.data.autoRunDisabled === true) {
			return fail(method, 'rejected', 'Auto Run is turned off in Settings.');
		}
		const record = repository.getAgent(agentId);
		if (!record) return fail(method, 'not-found', `No agent ${agentId}.`);
		const agent = toTurnAgent(record);
		if (!agent) return fail(method, 'rejected', 'The agent has no working directory to run in.');
		if (sshRecordOf(record.sessionSshRemoteConfig)?.enabled === true) {
			return fail(
				method,
				'rejected',
				'Auto Run for an agent on an SSH remote runs on the desktop for now.'
			);
		}
		if (
			runs.has(agentId) ||
			launching.has(agentId) ||
			registry.isBusy(agentId) ||
			isSessionBusyWithCli(agentId, paths.userDataDir)
		) {
			return fail(method, 'rejected', 'The agent is busy: a turn or another run is working in it.');
		}
		return {
			session: { ...agent, projectRoot: agent.projectRoot ?? agent.cwd } as unknown as SessionInfo,
		};
	}

	const isRefusal = (value: unknown): value is ClientResult<never> =>
		typeof value === 'object' && value !== null && 'ok' in value;

	async function launch(agentId: string, raw: AutoRunLaunchInput): Promise<ClientResult<void>> {
		const method: ClientMethod = 'autoRun.launch';
		const checked = validateAutoRunLaunch(raw);
		if (!checked.ok) return fail(method, 'invalid', checked.reason);
		const input = checked.value;
		const refused = refuseLaunch(method, agentId);
		if (isRefusal(refused)) return refused;
		// Held from the check to the run being registered, with nothing awaited in between.
		launching.add(agentId);
		try {
			return await startPlaybookRun(method, agentId, refused.session, input);
		} finally {
			launching.delete(agentId);
		}
	}

	async function startPlaybookRun(
		method: ClientMethod,
		agentId: string,
		session: SessionInfo,
		input: AutoRunLaunchInput
	): Promise<ClientResult<void>> {
		const folder = resolveAutoRunFolder(session);
		if (!folder) return fail(method, 'rejected', 'The agent has no Auto Run folder.');
		const names: string[] = [];
		for (const document of input.documents) {
			const name = documentNameUnder(folder, document.file);
			if (!name) {
				return fail(
					method,
					'invalid',
					`${document.file} is not inside the Auto Run folder ${folder}.`
				);
			}
			names.push(name);
		}
		const startedAt = now();
		const playbook: Playbook = {
			id: `runtime-${agentId}-${startedAt}`,
			name: `Auto Run: ${names.join(', ')}`,
			createdAt: startedAt,
			updatedAt: startedAt,
			documents: input.documents.map((document, index) => ({
				filename: names[index],
				resetOnCompletion: document.resetOnCompletion === true,
			})),
			loopEnabled: input.loop === true,
			maxLoops: input.maxLoops ?? null,
			prompt: '',
		};

		const scan = await preflightPlaybook(playbook, folder, documents);
		if (scan.initialTotalTasks === 0) {
			return fail(method, 'rejected', 'There are no unchecked tasks in the chosen documents.');
		}
		if (scan.preExistingHalt) {
			return fail(
				method,
				'rejected',
				describeUnresolvedHaltMarker(scan.preExistingHalt.document, scan.preExistingHalt.halt)
			);
		}

		const controller = newController();
		const abort = new AbortController();
		startRun(
			{
				agentId,
				kind: 'playbook',
				startedAt,
				controller,
				abort,
				documents: names,
				folder,
				wire: {
					isRunning: true,
					totalTasks: scan.initialTotalTasks,
					completedTasks: 0,
					currentTaskIndex: 0,
					totalDocuments: names.length,
					currentDocumentIndex: 0,
					totalTasksAcrossAllDocs: scan.initialTotalTasks,
					completedTasksAcrossAllDocs: 0,
					documents: names,
					startTime: startedAt,
					loopEnabled: playbook.loopEnabled,
					loopIteration: 0,
				},
			},
			runPlaybook(
				session,
				playbook,
				folder,
				{
					...(input.model ? { model: input.model } : {}),
					...(input.effort ? { effort: input.effort } : {}),
					signal: abort.signal,
				},
				buildDeps(agentId, controller)
			)
		);
		return ok(undefined);
	}

	async function launchGoal(
		agentId: string,
		raw: GoalRunLaunchInput
	): Promise<ClientResult<{ tabId?: string }>> {
		const method: ClientMethod = 'autoRun.launchGoal';
		const checked = validateGoalRunLaunch(raw);
		if (!checked.ok) return fail(method, 'invalid', checked.reason);
		const input = checked.value;
		// Nothing is awaited between the check and the run being registered, so no slot is needed.
		const refused = refuseLaunch(method, agentId);
		if (isRefusal(refused)) return refused;
		const { session } = refused;

		const goalConfig: GoalRunConfig = {
			goal: input.goal,
			exitCriteria: input.exitCriteria ?? '',
			// Absent: the panel's default cap. `null` is a real answer (no cap).
			maxIterations:
				input.maxIterations === undefined ? DEFAULT_GOAL_MAX_ITERATIONS : input.maxIterations,
		};
		const startedAt = now();
		const controller = newController();
		const abort = new AbortController();
		startRun(
			{
				agentId,
				kind: 'goal',
				startedAt,
				controller,
				abort,
				documents: [],
				folder: '',
				wire: {
					isRunning: true,
					// A goal run is modeled as the desktop does: progress on the 0 to 100 task scale.
					totalTasks: 100,
					completedTasks: 0,
					currentTaskIndex: 0,
					totalTasksAcrossAllDocs: 100,
					completedTasksAcrossAllDocs: 0,
					goalMode: true,
					goalProgress: 0,
					goalIteration: 0,
					documents: [],
					startTime: startedAt,
				},
			},
			runGoal(
				session,
				goalConfig,
				{
					...(input.model ? { model: input.model } : {}),
					...(input.effort ? { effort: input.effort } : {}),
					signal: abort.signal,
				},
				buildDeps(agentId, controller)
			)
		);
		// The runtime has no tab to name.
		return ok({});
	}

	// -----------------------------------------------------------------------
	// Controls
	// -----------------------------------------------------------------------

	const noRun = (method: ClientMethod, agentId: string) =>
		fail<void>(method, 'not-found', `No Auto Run is running for agent ${agentId}.`);

	function answer(
		method: ClientMethod,
		agentId: string,
		resolution: 'resume' | 'skip' | 'abort'
	): ClientResult<void> {
		const run = runs.get(agentId);
		if (!run) return noRun(method, agentId);
		if (!run.controller.resolve(resolution)) {
			return fail(method, 'rejected', 'The run is not waiting on an answer.');
		}
		return ok(undefined);
	}

	const api: AutoRunApi = {
		launch,
		launchGoal,
		stop: async (agentId) => {
			const run = runs.get(agentId);
			if (!run) return noRun('autoRun.stop', agentId);
			run.controller.requestStop();
			run.wire = { ...run.wire, isStopping: true };
			publish(run);
			return ok(undefined);
		},
		resume: async (agentId) => answer('autoRun.resume', agentId, 'resume'),
		skip: async (agentId) => answer('autoRun.skip', agentId, 'skip'),
		abort: async (agentId) => answer('autoRun.abort', agentId, 'abort'),
	};

	return {
		api,
		activeRuns: () =>
			[...runs.values()].map((run) => ({
				agentId: run.agentId,
				kind: run.kind,
				startedAt: run.startedAt,
				paused: run.controller.isPaused(),
			})),
		holds: (agentId) => runs.has(agentId),
		latestState: (agentId) => {
			const run = runs.get(agentId);
			return run ? { ...run.wire } : undefined;
		},
		async stopAll() {
			const live = [...runs.values()];
			// The signal ends the turn in flight; a run parked on an answer has no turn, so it is
			// answered `abort` too. Either way the engine records `stopped` and returns.
			for (const run of live) {
				run.controller.requestStop();
				run.abort.abort();
			}
			await Promise.all(live.map((run) => run.done));
		},
	};
}
