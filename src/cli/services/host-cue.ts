/**
 * Cue inside a detached host (spec D3 and Q5).
 *
 * `maestro-cli host` is the long-lived process, so it is where Cue runs when nothing else runs it.
 * It is not a second engine: it composes the standalone one (`cue-standalone-engine.ts`) behind the
 * same cross-process Cue lock the desktop and `maestro-cli cue engine start` use. The rule, in
 * order: Cue off in the shared Encore settings means no engine; a live holder of the lock means no
 * engine here either, and `status` says whose; otherwise start one and check that the lock is ours,
 * because `CueEngine.start()` refuses silently when it loses the race.
 *
 * The engine reads its agents once, when it starts, and the host outlives that moment. So the host
 * tells it what the runtime did afterwards: an agent added, removed, or pointed at another
 * directory, and Cue switched on or off in the settings. It is also what gives the engine a runtime
 * to run an `action: autorun` subscription in, and the one that stops the engine's runs before the
 * process goes away, because the engine's own `stop()` forgets its runs without ending them.
 */

import type { CueAutoRunLaunchParams } from '../../main/cue/cue-autorun-executor';
import {
	isCueEngineLockOwnedByThisProcess,
	readCueEngineLock,
	type CueEngineLockInfo,
} from '../../main/cue/cue-engine-lock';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import type { HostCueState } from '../../shared/maestro-lib/client/host-control';
import type {
	AutoRunOutcome,
	MaestroClient,
	Unsubscribe,
} from '../../shared/maestro-lib/client/types';
import { readStoreDocument } from '../../shared/maestro-lib/store/io';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import {
	consoleCueLog,
	createStandaloneCueEngine,
	waitForStandaloneCueProcesses,
	type StandaloneCueAutoRun,
	type StandaloneCueAutoRunEnd,
	type StandaloneCueEngineOptions,
} from './cue-standalone-engine';
import { startCueTriggerInbox } from './cue-trigger-inbox';

/** The part of `CueEngine` the host drives. */
export interface HostCueEngine {
	start(reason: 'system-boot'): void;
	/** Clears every timer, watcher, and queue. Ends no run: `stopAll()` does that. */
	stop(): void;
	triggerSubscription(name: string, prompt?: string, sourceAgentId?: string): boolean;
	/** The runs in flight. */
	getActiveRuns(): readonly unknown[];
	/** Empty the queue and stop every run in flight, each through the engine's own per-run stop. */
	stopAll(): void;
	/** Re-read one agent's `cue.yaml` from `projectRoot` and rebuild its subscriptions. */
	refreshSession(sessionId: string, projectRoot: string): void;
	removeSession(sessionId: string): void;
}

/** The part of the in-process runtime Cue uses: Auto Runs to launch, and the events that say what changed. */
export type HostCueRuntime = Pick<MaestroClient, 'agents' | 'autoRun' | 'events'>;

export interface HostCueContext {
	userDataDir: string;
	settingsFile: string;
	/** The runtime this host serves. Without it the engine runs as `maestro-cli cue engine start` does: no Auto Run actions, no agent or settings changes. */
	runtime?: HostCueRuntime;
}

export interface HostCueDeps {
	/** Is Cue on in the shared settings? Default: the Encore flags in `settingsFile`, resolved over the shared defaults. */
	isEnabled(settingsFile: string): Promise<boolean>;
	readLock(dataDir: string): CueEngineLockInfo | null;
	createEngine(
		options: Pick<StandaloneCueEngineOptions, 'onLog' | 'runAutoRun'>
	): Promise<HostCueEngine>;
	/** Serve `maestro-cli cue trigger`, which has no desktop WebSocket to reach this process by. Returns the stop. */
	startInbox(engine: HostCueEngine, dataDir: string): () => void;
	/** Settles once the child of every stopped run has exited. */
	waitForRunsToEnd(): Promise<unknown>;
	pid: number;
	/**
	 * Is this live lock this process's own? Default: the lock's token, which only the process that
	 * wrote it holds (`isCueEngineLockOwnedByThisProcess`). A lock from a build before tokens is
	 * judged by `pid`, the rule such a lock always had.
	 */
	ownsLock?(lock: CueEngineLockInfo): boolean;
}

export interface HostCue {
	state(): HostCueState;
	/** Cue runs in flight in this host's engine: work a stop would cut off. */
	activeRuns(): number;
	/** Stop every run in flight, wait for their processes to exit, then stop the engine. Idempotent. */
	stop(): Promise<void>;
}

async function encoreCueEnabled(settingsFile: string): Promise<boolean> {
	const read = await readStoreDocument<Record<string, unknown>>(settingsFile);
	const document = read.status === 'ok' ? read.data : {};
	return resolveEncoreFeatures(document.encoreFeatures).maestroCue;
}

const defaultDeps: HostCueDeps = {
	isEnabled: encoreCueEnabled,
	readLock: (dataDir) => readCueEngineLock(dataDir),
	createEngine: (options) => createStandaloneCueEngine(options) as Promise<HostCueEngine>,
	startInbox: (engine, dataDir) =>
		startCueTriggerInbox(
			(name, prompt, sourceAgentId) => engine.triggerSubscription(name, prompt, sourceAgentId),
			dataDir
		),
	waitForRunsToEnd: () => waitForStandaloneCueProcesses(),
	pid: process.pid,
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Auto Run actions
// ---------------------------------------------------------------------------

/**
 * A run's end as Cue records it, from the engine's own verdict (`autorun.ended`). Only a run that
 * completed is a success: one a person stopped did not do what the subscription asked for.
 */
function autoRunEnd(outcome: AutoRunOutcome): StandaloneCueAutoRunEnd {
	switch (outcome.status) {
		case 'completed':
			return { ok: true };
		case 'stopped':
			return { ok: false, reason: 'the run was stopped before it finished' };
		case 'failed':
			return { ok: false, reason: outcome.reason };
		case 'error':
			return { ok: false, reason: `the Auto Run engine failed: ${outcome.reason}` };
	}
}

/**
 * Run a Cue subscription's Auto Run in the host's own runtime, on the subscription's agent.
 *
 * The runtime answers a launch once the run is registered and reports the rest as events, so the
 * end is watched for there: the `autorun.ended` that follows the run's own frames, which says how
 * it went.
 */
export function runAutoRunInRuntime(runtime: HostCueRuntime): StandaloneCueAutoRun {
	return async (params: CueAutoRunLaunchParams, signal: AbortSignal) => {
		// The runtime's launch runs in the agent's own checkout. Running a worktree run there
		// would do the work in the wrong directory, so it is refused rather than moved.
		if (params.worktreeTarget) {
			return {
				started: false,
				error:
					"an Auto Run in a worktree runs on the desktop for now; `maestro-cli host` runs one in the agent's own directory only",
			};
		}

		const agentId = params.sessionId;
		let sawRun = false;
		let settle!: (end: StandaloneCueAutoRunEnd) => void;
		const ended = new Promise<StandaloneCueAutoRunEnd>((resolve) => {
			settle = resolve;
		});
		// Subscribed before the launch: the run's first frame leaves before the launch answers.
		const unsubscribe = runtime.events.subscribe(
			(event) => {
				if (event.type === 'host.lost') {
					settle({ ok: false, reason: `the host lost the data directory: ${event.reason}` });
					return;
				}
				if (event.type === 'autorun' && event.agentId === agentId) {
					// This run's first frame. An end seen before it belongs to an earlier run.
					if (event.event.kind === 'state' && event.event.state !== null) sawRun = true;
				} else if (event.type === 'autorun.ended' && event.agentId === agentId && sawRun) {
					settle(autoRunEnd(event.outcome));
				}
			},
			{ types: ['autorun', 'autorun.ended', 'host.lost'] }
		);
		const stop = (): void => void runtime.autoRun.stop(agentId);

		const launched = await runtime.autoRun
			.launch(agentId, {
				documents: params.documents.map((document) => ({
					file: document.filename,
					resetOnCompletion: document.resetOnCompletion === true,
				})),
				...(params.loopEnabled ? { loop: true, maxLoops: params.maxLoops ?? null } : {}),
				...(params.model ? { model: params.model } : {}),
				...(params.effort ? { effort: params.effort } : {}),
				...(params.prompt ? { prompt: params.prompt } : {}),
				...(params.ignoreModelHints ? { ignoreModelHints: true } : {}),
			})
			.catch((error: unknown) => ({ ok: false as const, error: { message: errorText(error) } }));
		if (!launched.ok) {
			unsubscribe();
			return { started: false, error: launched.error.message };
		}

		// Stopping the Cue run stops the Auto Run it is.
		if (signal.aborted) stop();
		else signal.addEventListener('abort', stop, { once: true });
		return {
			started: true,
			ended: ended.finally(() => {
				unsubscribe();
				signal.removeEventListener('abort', stop);
			}),
		};
	};
}

// ---------------------------------------------------------------------------
// Agents that change after the engine started
// ---------------------------------------------------------------------------

function projectRootOf(agent: AgentRecord): string | undefined {
	return agent.projectRoot || agent.cwd || agent.fullPath || undefined;
}

/**
 * Keep the engine's sessions in step with the runtime's agents. Returns the stop.
 *
 * `agent.updated` fires for every tab and every turn, and a refresh rebuilds a session's triggers
 * (a heartbeat subscription fires again as it does), so an update refreshes only when the agent
 * now points at another directory, which is where its `cue.yaml` is read from. The agents the
 * engine read at its own start are listed first, to have something to compare the first update
 * against.
 */
async function followAgents(runtime: HostCueRuntime, engine: HostCueEngine): Promise<Unsubscribe> {
	/** Each agent's project root as the engine last saw it; '' for an agent with none. */
	const known = new Map<string, string>();
	const rootKey = (agent: AgentRecord): string => projectRootOf(agent) ?? '';
	const refresh = (agent: AgentRecord): void => {
		known.set(agent.id, rootKey(agent));
		const projectRoot = projectRootOf(agent);
		if (projectRoot) engine.refreshSession(agent.id, projectRoot);
		else engine.removeSession(agent.id);
	};
	const unsubscribe = runtime.events.subscribe(
		(event) => {
			if (event.type === 'agent.added') {
				refresh(event.agent);
			} else if (event.type === 'agent.updated') {
				const before = known.get(event.agent.id);
				if (before === undefined) known.set(event.agent.id, rootKey(event.agent));
				else if (before !== rootKey(event.agent)) refresh(event.agent);
			} else if (event.type === 'agent.removed') {
				known.delete(event.agentId);
				engine.removeSession(event.agentId);
			}
		},
		{ types: ['agent.added', 'agent.updated', 'agent.removed'] }
	);
	const listed = await runtime.agents.list();
	if (listed.ok) {
		// An event that arrived while listing is newer than the list.
		for (const agent of listed.value) {
			if (!known.has(agent.id)) known.set(agent.id, rootKey(agent));
		}
	}
	return unsubscribe;
}

// ---------------------------------------------------------------------------
// The engine's lifetime in this host
// ---------------------------------------------------------------------------

/**
 * Why the engine did not start, from what it logged. `CueEngine.start()` refuses by logging an
 * error and returning (a database it cannot open, say), so its last error is the reason; the first
 * line is enough to act on and the log holds the rest.
 */
function startFailure(errors: readonly string[]): string {
	const last = errors[errors.length - 1];
	if (!last) return 'The engine did not start (see the host log).';
	const firstLine = last
		.replace(/^\[CUE\]\s*/, '')
		.split('\n')[0]
		.trim();
	return `${firstLine} (the host log has the rest)`;
}

interface LiveEngine {
	engine: HostCueEngine;
	stopInbox(): void;
	unfollowAgents(): void;
}

/** Start Cue in this process when the rules allow it. Never throws: a failure is the reported state. */
export async function startHostCue(
	host: HostCueContext,
	overrides: Partial<HostCueDeps> = {}
): Promise<HostCue> {
	const deps = { ...defaultDeps, ...overrides };
	// Ownership is the token, not the pid: two containers sharing a data directory both run their
	// engine as pid 1, so a pid match would read another container's lock as this one's.
	const ownsLock =
		deps.ownsLock ??
		((lock: CueEngineLockInfo) =>
			lock.token !== undefined ? isCueEngineLockOwnedByThisProcess(lock) : lock.pid === deps.pid);
	const { runtime } = host;
	let current: HostCueState = { state: 'disabled' };
	let live: LiveEngine | undefined;
	let closed = false;

	const bringUp = async (): Promise<void> => {
		let engine: HostCueEngine | undefined;
		let unfollowAgents: Unsubscribe = () => undefined;
		const startErrors: string[] = [];
		let starting = true;
		try {
			if (!(await deps.isEnabled(host.settingsFile))) {
				current = { state: 'disabled' };
				return;
			}
			const holder = deps.readLock(host.userDataDir);
			if (holder && !ownsLock(holder)) {
				current = { state: 'held', mode: holder.mode, pid: holder.pid };
				return;
			}

			engine = await deps.createEngine({
				// Logged as ever, and kept while starting so a refusal can be reported with its reason.
				onLog: (level, message) => {
					if (starting && level === 'error') startErrors.push(message);
					consoleCueLog(level, message);
				},
				...(runtime ? { runAutoRun: runAutoRunInRuntime(runtime) } : {}),
			});
			if (runtime) unfollowAgents = await followAgents(runtime, engine);
			engine.start('system-boot');
			starting = false;
			const after = deps.readLock(host.userDataDir);
			if (!after || !ownsLock(after)) {
				unfollowAgents();
				engine.stop();
				current = after
					? { state: 'held', mode: after.mode, pid: after.pid }
					: { state: 'failed', reason: startFailure(startErrors) };
				return;
			}

			live = { engine, stopInbox: deps.startInbox(engine, host.userDataDir), unfollowAgents };
			current = { state: 'running' };
		} catch (error) {
			unfollowAgents();
			current = { state: 'failed', reason: errorText(error) };
		}
	};

	const bringDown = async (): Promise<void> => {
		const was = live;
		if (!was) return;
		live = undefined;
		current = { state: 'disabled' };
		was.stopInbox();
		was.unfollowAgents();
		try {
			// `stop()` alone would drop the runs from the engine's books and leave their processes
			// running, reparented once this one exits, with rows that say `running` for good.
			was.engine.stopAll();
			await deps.waitForRunsToEnd();
		} finally {
			was.engine.stop();
		}
	};

	// One change at a time: a toggle that arrives while the engine is still stopping waits for it.
	let pending: Promise<void> = Promise.resolve();
	const inOrder = (change: () => Promise<void>): Promise<void> => {
		pending = pending.then(change, change);
		return pending;
	};

	await inOrder(bringUp);

	// Cue switched on or off in the settings while the host runs: the same rules, applied again.
	const unwatchSettings =
		runtime?.events.subscribe(
			(event) => {
				if (event.type !== 'settings.changed') return;
				if (event.keys !== 'unknown' && !event.keys.includes('encoreFeatures')) return;
				inOrder(async () => {
					if (closed) return;
					const enabled = await deps.isEnabled(host.settingsFile);
					if (closed) return;
					if (!enabled) {
						await bringDown();
						current = { state: 'disabled' };
					} else if (!live) {
						await bringUp();
					}
				}).catch((error: unknown) => {
					current = { state: 'failed', reason: errorText(error) };
				});
			},
			{ types: ['settings.changed'] }
		) ?? (() => undefined);

	return {
		state: () => current,
		activeRuns: () => live?.engine.getActiveRuns().length ?? 0,
		stop: () => {
			if (!closed) {
				closed = true;
				unwatchSettings();
			}
			return inOrder(bringDown);
		},
	};
}
