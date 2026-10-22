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
 * to run an `action: autorun` subscription in.
 *
 * A host that shuts down drains Cue the way `maestro-cli cue engine start` does (`CueEngine.drain`):
 * triggers disarm at once, runs in flight get the grace period, and queued events and partial
 * fan-ins are persisted for the next start. Nothing calls the engine's `stop()` after a drain,
 * because `stop()` deletes the persisted queue the drain just wrote. Switching Cue off in the
 * settings is not a shutdown and still clears the queue, as it does on the desktop.
 *
 * The lock can also be taken from under a running engine (this process was suspended past the stale
 * window, say). The engine notices on its heartbeat and stops itself; the host then gives up what it
 * built around it, ends the runs the engine would otherwise orphan, and reports the new holder.
 */

import { toCueActivityEntries } from '../../main/cue/cue-activity-entries';
import type { CueAutoRunLaunchParams } from '../../main/cue/cue-autorun-executor';
import {
	isCueEngineLockOwnedByThisProcess,
	readCueEngineLock,
	type CueEngineLockInfo,
} from '../../main/cue/cue-engine-lock';
import { toCueSubscriptionInfos } from '../../main/cue/cue-subscription-entries';
import type { CueGraphSession, CueRunResult } from '../../shared/cue/contracts';
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
	/** Clears every timer, watcher, and queue, the persisted queue included. Ends no run: `stopAll()` does that. */
	stop(): void;
	/**
	 * Disarm every trigger, let the runs in flight finish for up to `timeoutMs`, stop the rest, and
	 * persist the queue and partial fan-ins for the next start. Calling it again returns the same promise.
	 */
	drain(options: { timeoutMs: number }): Promise<unknown>;
	/** Cut a drain short, or start one with no wait: every run stopped and killed now, the queue still persisted. */
	forceStop(): void;
	triggerSubscription(name: string, prompt?: string, sourceAgentId?: string): boolean;
	/** The runs in flight. */
	getActiveRuns(): readonly unknown[];
	/** Empty the queue and stop every run in flight, each through the engine's own per-run stop. */
	stopAll(): void;
	/** Re-read one agent's `cue.yaml` from `projectRoot` and rebuild its subscriptions. */
	refreshSession(sessionId: string, projectRoot: string): void;
	removeSession(sessionId: string): void;
	/** The activity log: runs in flight and the window restored from cue.db, oldest first. */
	getActivityLog(): CueRunResult[];
	/** Every agent's subscriptions, as the desktop's `cue list` reads them. */
	getGraphData(): CueGraphSession[];
	/** Write one subscription's `enabled` flag into its cue.yaml, as the dashboard switch does. */
	setSubscriptionEnabled(subscriptionId: string, enabled: boolean): Promise<boolean>;
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
		options: Pick<StandaloneCueEngineOptions, 'onLog' | 'runAutoRun' | 'onLockLost'>
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
	/**
	 * Shut Cue down for good: disarm every trigger now, give the runs in flight up to `timeoutMs`,
	 * stop the rest, and persist what is queued. The first call starts it; later calls return the
	 * same promise. The host calls it on its first stop signal, so nothing new starts while it waits.
	 */
	drain(timeoutMs: number): Promise<void>;
	/** A second stop signal: cut the drain short, or start one with no wait. The queue is still persisted. */
	forceStop(): void;
	/** Shut Cue down: the drain already under way, or one with no wait. Idempotent. */
	stop(): Promise<void>;
	/**
	 * Answer a desktop bridge Cue message from this host's engine, with the desktop's reply type and
	 * shape, or `undefined` for a message that is not Cue's. See {@link answerCueMessage}.
	 */
	answer(message: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
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
// Answering the CLI's Cue verbs
// ---------------------------------------------------------------------------

/** The messages `cue list` and `cue activity` send: a read the CLI can also make from disk. */
const CUE_READ_MESSAGES = new Set(['get_cue_subscriptions', 'get_cue_activity']);
/** The messages `cue enable|disable` and `cue trigger` send: a change only a running engine can make. */
const CUE_WRITE_MESSAGES = new Set(['toggle_cue_subscription', 'trigger_cue_subscription']);

/** Why a Cue change cannot be made here, and what to do instead. */
export function cueUnavailableMessage(state: HostCueState): string {
	switch (state.state) {
		case 'disabled':
			return "Maestro Cue is off in this data directory's settings, so this host runs no Cue engine. Turn it on in Encore Features.";
		case 'held':
			return (
				`This host does not run Cue: a ${state.mode} Cue engine (pid ${state.pid}) holds the Cue lock for this data directory. ` +
				'Make the change where that engine runs, or stop it and restart the host so the host runs Cue.'
			);
		case 'failed':
			// Also a lock lost to an engine whose lock cannot be read, so not "did not start".
			return `This host is not running Cue: ${state.reason}`;
		case 'running':
			return 'This host is still starting its Cue engine. Retry in a moment.';
	}
}

/**
 * Why a Cue change is refused while the host drains Cue for a shutdown. A toggle would write cue.yaml
 * for an engine that is going away, and a trigger could only be queued and persisted for whichever
 * engine starts next, which is not what someone asking to run a subscription now expects.
 */
export const CUE_SHUTTING_DOWN_MESSAGE =
	'This host is shutting down Cue: its runs in flight are finishing and nothing new is accepted. ' +
	'Make the change once Cue runs again (the next `maestro-cli host start`, the desktop app, or `maestro-cli cue engine start`).';

export interface CueAnswerContext {
	/** A drain for a shutdown was asked for: the engine finishes what it runs and takes no changes. */
	shuttingDown?: boolean;
}

/**
 * The desktop's Cue answers (`messageHandlers/cue.ts` over `cueCallbacks.ts`), from the engine this
 * host runs: the same reply types, the same mappings, the same validation.
 *
 * Without a running engine a READ is left unanswered (`undefined`), which the server echoes and the
 * CLI reads as "this host cannot answer": it then reads cue.yaml or cue.db itself, which is right
 * whatever the reason (Cue held by another engine, failed, or just being switched). A WRITE has no
 * such fallback, so it is refused with the reason and what to do about it.
 *
 * The engine answers only while the state says `running`. A drain keeps it `running`, so reads go on
 * answering while the runs finish (they are real data), but writes are refused with
 * {@link CUE_SHUTTING_DOWN_MESSAGE}. After a lock loss the state names the new holder even while the
 * old engine is still winding down, so reads fall back to disk and a refused write names the holder,
 * which is where the change has to be made. Errors are the desktop's
 * `{ type: 'error', message }` frame, which the CLI's `errorFrameMessage` reads.
 */
export async function answerCueMessage(
	message: Record<string, unknown>,
	liveEngine: HostCueEngine | undefined,
	state: HostCueState,
	context: CueAnswerContext = {}
): Promise<Record<string, unknown> | undefined> {
	const type = message.type;
	if (typeof type !== 'string') return undefined;
	if (!CUE_READ_MESSAGES.has(type) && !CUE_WRITE_MESSAGES.has(type)) return undefined;
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
	const error = (text: string): Record<string, unknown> => ({ type: 'error', message: text });

	const engine = state.state === 'running' ? liveEngine : undefined;
	if (CUE_WRITE_MESSAGES.has(type)) {
		// A lost lock is the more useful answer: it says who to ask instead.
		if (context.shuttingDown && state.state !== 'held' && state.state !== 'failed') {
			return error(CUE_SHUTTING_DOWN_MESSAGE);
		}
		if (!engine) return error(cueUnavailableMessage(state));
	} else if (!engine) {
		return undefined;
	}

	switch (type) {
		case 'get_cue_subscriptions':
			return {
				type: 'cue_subscriptions',
				subscriptions: toCueSubscriptionInfos(engine.getGraphData(), sessionId),
				timestamp: Date.now(),
			};
		case 'get_cue_activity': {
			const limit = typeof message.limit === 'number' ? message.limit : 50;
			return {
				type: 'cue_activity',
				entries: toCueActivityEntries(engine.getActivityLog(), { sessionId, limit }),
				timestamp: Date.now(),
			};
		}
		case 'toggle_cue_subscription': {
			const { subscriptionId, enabled } = message;
			if (typeof subscriptionId !== 'string' || subscriptionId === '') {
				return error('Missing subscriptionId');
			}
			if (typeof enabled !== 'boolean') return error('Missing or invalid enabled flag');
			try {
				const success = await engine.setSubscriptionEnabled(subscriptionId, enabled);
				return {
					type: 'toggle_cue_subscription_result',
					success,
					subscriptionId,
					enabled,
					timestamp: Date.now(),
				};
			} catch (caught) {
				return error(`Failed to toggle Cue subscription: ${errorText(caught)}`);
			}
		}
		default: {
			// trigger_cue_subscription
			const { subscriptionName, prompt, sourceAgentId } = message;
			if (typeof subscriptionName !== 'string' || subscriptionName.trim() === '') {
				return error('Missing subscriptionName');
			}
			if (prompt !== undefined && typeof prompt !== 'string') {
				return error('Invalid prompt: must be a string when provided');
			}
			if (sourceAgentId !== undefined && typeof sourceAgentId !== 'string') {
				return error('Invalid sourceAgentId: must be a string when provided');
			}
			return {
				type: 'trigger_cue_subscription_result',
				success: engine.triggerSubscription(subscriptionName, prompt, sourceAgentId),
				subscriptionName,
				timestamp: Date.now(),
			};
		}
	}
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
	/** Set once the host is shutting Cue down: no settings change applies after it. */
	let closed = false;
	let unwatchSettings: Unsubscribe = () => undefined;
	/** The shutdown drain, once asked for. */
	let draining: Promise<void> | undefined;
	/** The engine whose drain is under way: its lock loss is the drain's to finish. */
	let drainingEngine: HostCueEngine | undefined;
	let forceRequested = false;

	// One change at a time: a toggle that arrives while the engine is still stopping waits for it.
	let pending: Promise<void> = Promise.resolve();
	const inOrder = (change: () => Promise<void>): Promise<void> => {
		pending = pending.then(change, change);
		return pending;
	};

	/** Who holds the lock now that this host lost it. */
	const stateAfterLoss = (): HostCueState => {
		try {
			const holder = deps.readLock(host.userDataDir);
			if (holder && !ownsLock(holder)) return { state: 'held', mode: holder.mode, pid: holder.pid };
		} catch {
			// Unreadable is reported below, the same as absent.
		}
		return {
			state: 'failed',
			reason:
				'another Cue engine took the Cue lock over, so Cue stopped here, and the lock cannot be read now to say whose it is (see the host log)',
		};
	};

	/**
	 * The engine's heartbeat found another engine holding the lock. It calls this from a timer, then
	 * stops itself, so this runs outside `inOrder` and must not throw: a throw would skip that stop.
	 *
	 * Its runs are ended here rather than left to finish. The engine's `stop()` forgets them without
	 * ending them, so a run left going would keep editing files and pushing beside the new holder,
	 * which owns the same triggers and may fire the same subscription again, while its row says
	 * `running` for good. Ending it records `stopped`, which says what happened.
	 */
	const lockLost = (lost: HostCueEngine): void => {
		// The engine cuts its own drain short on a loss (`forceStop`), which still persists the queue.
		// Ending the runs here would also clear that queue, so only the report changes.
		if (drainingEngine === lost) {
			current = stateAfterLoss();
			return;
		}
		const was = live;
		// A bring-down already under way has taken the engine out of `live` and ends its runs itself.
		// A stop still queued has not, and the engine forgets its runs as soon as this returns, so
		// they are ended here even then.
		if (!was || was.engine !== lost) return;
		live = undefined;
		current = stateAfterLoss();
		const steps: Array<[string, () => void]> = [
			['stop the trigger inbox', was.stopInbox],
			['stop following agents', was.unfollowAgents],
			['stop the runs in flight', () => was.engine.stopAll()],
		];
		for (const [step, run] of steps) {
			try {
				run();
			} catch (error) {
				consoleCueLog(
					'error',
					`[CUE] After losing the Cue lock, could not ${step}: ${errorText(error)}`
				);
			}
		}
		// A stop or a toggle queued from here on waits for those processes to exit.
		inOrder(async () => {
			await deps.waitForRunsToEnd();
		}).catch((error: unknown) => {
			consoleCueLog(
				'error',
				`[CUE] Waiting for the stopped runs to exit failed: ${errorText(error)}`
			);
		});
	};

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
				onLockLost: () => {
					if (engine) lockLost(engine);
				},
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

	/**
	 * Cue switched off in the settings while the host keeps running. Not a shutdown, so not a drain:
	 * the queue is cleared, as switching Cue off on the desktop clears it. A drain stamps what it
	 * persists, which exempts it from the stale drop at restore, so a queue kept here would replay
	 * whenever someone switched Cue back on, however old it was by then.
	 */
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

	await inOrder(bringUp);

	// Cue switched on or off in the settings while the host runs: the same rules, applied again.
	unwatchSettings =
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

	const drain = (timeoutMs: number): Promise<void> => {
		if (draining) return draining;
		closed = true;
		unwatchSettings();
		// In order: a settings change under way finishes first, and its engine is the one drained.
		draining = inOrder(async () => {
			const was = live;
			if (!was) return;
			// Nothing new comes in while the runs finish: no `cue trigger`, no yaml re-read.
			was.stopInbox();
			was.unfollowAgents();
			drainingEngine = was.engine;
			try {
				if (forceRequested) was.engine.forceStop();
				await was.engine.drain({ timeoutMs });
			} catch (error) {
				// As `cue engine start` does: a drain that failed is forced, which still persists.
				consoleCueLog('error', `[CUE] Drain failed: ${errorText(error)}`);
				was.engine.forceStop();
			} finally {
				drainingEngine = undefined;
				// Never `engine.stop()` here: it would delete the queue the drain persisted.
				if (live === was) live = undefined;
				// A loss during the drain already said who holds Cue now.
				if (current.state === 'running') current = { state: 'disabled' };
			}
		});
		return draining;
	};

	return {
		state: () => current,
		// Runs a drain is still waiting for count, so the host waits for them too.
		activeRuns: () => live?.engine.getActiveRuns().length ?? 0,
		answer: (message) =>
			answerCueMessage(message, live?.engine, current, { shuttingDown: draining !== undefined }),
		drain,
		forceStop: () => {
			forceRequested = true;
			if (drainingEngine) drainingEngine.forceStop();
			// Not started yet: start one, which sees the request.
			else void drain(0);
		},
		// Then whatever a lock loss queued behind it: the wait for the runs it ended.
		stop: () => drain(0).then(() => pending),
	};
}
