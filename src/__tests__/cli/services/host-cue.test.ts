import { describe, expect, it, vi } from 'vitest';

import type { CueAutoRunLaunchParams } from '../../../main/cue/cue-autorun-executor';
import type { CueEngineLockInfo } from '../../../main/cue/cue-engine-lock';
import {
	CUE_SHUTTING_DOWN_MESSAGE,
	answerCueMessage,
	runAutoRunInRuntime,
	startHostCue,
	type HostCueDeps,
	type HostCueEngine,
	type HostCueRuntime,
} from '../../../cli/services/host-cue';
import type { AutoRunProgress } from '../../../shared/maestro-lib/autorun/progress';
import { createEventBus } from '../../../shared/maestro-lib/client/event-bus';
import type { AutoRunOutcome, ClientResult } from '../../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { CueGraphSession, CueRunResult } from '../../../shared/cue/contracts';

const PATHS = { userDataDir: '/data', settingsFile: '/data/maestro-settings.json' };
const PID = 4242;

function lock(pid: number, mode: CueEngineLockInfo['mode'] = 'standalone'): CueEngineLockInfo {
	return { pid, mode, startedAt: '2026-10-04T12:00:00.000Z' };
}

function fakeEngine(overrides: Partial<HostCueEngine> = {}): HostCueEngine {
	return {
		start: vi.fn(),
		stop: vi.fn(),
		triggerSubscription: vi.fn(() => true),
		getActiveRuns: vi.fn(() => []),
		stopAll: vi.fn(),
		drain: vi.fn(async () => ({})),
		forceStop: vi.fn(),
		refreshSession: vi.fn(),
		removeSession: vi.fn(),
		getActivityLog: vi.fn(() => []),
		getGraphData: vi.fn(() => []),
		setSubscriptionEnabled: vi.fn(async () => true),
		...overrides,
	};
}

const agentRecord = (id: string, projectRoot: string, extra: Partial<AgentRecord> = {}) =>
	({
		id,
		name: id,
		toolType: 'claude-code',
		cwd: projectRoot,
		projectRoot,
		...extra,
	}) as AgentRecord;

const okResult = <T>(value: T): ClientResult<T> => ({ ok: true, value });

/** The runtime as Cue sees it: a real event bus, a list of agents, and an Auto Run API to watch. */
function fakeRuntime(agents: AgentRecord[] = []) {
	const bus = createEventBus('[test]');
	const launch = vi.fn(async (): Promise<ClientResult<void>> => okResult(undefined));
	const stop = vi.fn(async (): Promise<ClientResult<void>> => okResult(undefined));
	const runtime = {
		events: { subscribe: bus.subscribe },
		agents: { list: async () => okResult(agents) },
		autoRun: { launch, stop },
	} as unknown as HostCueRuntime;
	return { runtime, bus, launch, stop };
}

const progress = (overrides: Partial<AutoRunProgress> = {}): AutoRunProgress => ({
	isRunning: true,
	isStopping: false,
	documents: ['a.md'],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 2,
	currentDocTasksDone: 0,
	tasksTotal: 2,
	tasksDone: 0,
	loopEnabled: false,
	loopIteration: 0,
	...overrides,
});

/** Deps where the engine's start takes the lock, as the real one does. */
function deps(overrides: Partial<HostCueDeps> & { engine?: HostCueEngine } = {}) {
	let held: CueEngineLockInfo | null = null;
	const engine =
		overrides.engine ??
		fakeEngine({
			start: vi.fn(() => {
				held = lock(PID);
			}),
		});
	const stopInbox = vi.fn();
	const all: HostCueDeps = {
		isEnabled: async () => true,
		readLock: () => held,
		createEngine: async () => engine,
		startInbox: vi.fn(() => stopInbox),
		waitForRunsToEnd: vi.fn(async () => 0),
		pid: PID,
		...overrides,
	};
	return { all, engine, stopInbox };
}

describe('startHostCue', () => {
	it('starts no engine when Cue is off', async () => {
		const { all, engine } = deps({ isEnabled: async () => false });
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'disabled' });
		expect(engine.start).not.toHaveBeenCalled();
	});

	it('leaves Cue to whoever holds the lock, and says who', async () => {
		const { all, engine } = deps({ readLock: () => lock(77, 'desktop') });
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 77 });
		expect(engine.start).not.toHaveBeenCalled();
	});

	it('reads a lock under another token as held, even when its pid is this process', async () => {
		// Two containers on one data directory: both engines run as pid 1, so only the token tells
		// another container's lock from this process's own.
		const { all, engine } = deps({
			readLock: () => ({ ...lock(PID), token: 'another-container' }),
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'held', mode: 'standalone', pid: PID });
		expect(engine.start).not.toHaveBeenCalled();
	});

	it('runs the engine, serves the trigger inbox, and stops both', async () => {
		const { all, engine, stopInbox } = deps();
		const cue = await startHostCue(PATHS, all);
		expect(engine.start).toHaveBeenCalledWith('system-boot');
		expect(cue.state()).toEqual({ state: 'running' });
		expect(all.startInbox).toHaveBeenCalledWith(engine, '/data');

		await Promise.all([cue.stop(), cue.stop()]);
		// A stop with no signal before it drains with no wait, which still persists the queue.
		expect(engine.drain).toHaveBeenCalledTimes(1);
		expect(engine.drain).toHaveBeenCalledWith({ timeoutMs: 0 });
		expect(engine.stop).not.toHaveBeenCalled();
		expect(stopInbox).toHaveBeenCalledTimes(1);
		expect(cue.state()).toEqual({ state: 'disabled' });
	});

	it('reports the winner when another engine took the lock first', async () => {
		let reads = 0;
		const { all, engine } = deps({
			engine: fakeEngine(),
			readLock: () => (++reads === 1 ? null : lock(88)),
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'held', mode: 'standalone', pid: 88 });
		expect(engine.stop).toHaveBeenCalled();
		expect(all.startInbox).not.toHaveBeenCalled();
	});

	it('reports a start that took no lock as a failure', async () => {
		const { all } = deps({ engine: fakeEngine(), readLock: () => null });
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toMatchObject({ state: 'failed' });
	});

	it('reports why the engine refused to start, from what it logged', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { all } = deps({
			readLock: () => null,
			createEngine: async ({ onLog }) =>
				fakeEngine({
					// The real engine refuses by logging and returning, never by throwing.
					start: vi.fn(() =>
						onLog?.(
							'error',
							'[CUE] Failed to initialize Cue database - engine will not start: better-sqlite3 cannot be loaded.\nTo fix this:\n  - reinstall'
						)
					),
				}),
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({
			state: 'failed',
			reason:
				'Failed to initialize Cue database - engine will not start: better-sqlite3 cannot be loaded. (the host log has the rest)',
		});
		vi.restoreAllMocks();
	});

	it('never throws: a broken engine is the reported state', async () => {
		const { all } = deps({
			createEngine: async () => {
				throw new Error('no sqlite');
			},
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'failed', reason: 'no sqlite' });
	});
});

describe('stopping the host with Cue runs in flight', () => {
	it('counts the runs in flight as work', async () => {
		const runs: unknown[] = [];
		const { all } = deps({
			engine: fakeEngine({
				start: vi.fn(),
				getActiveRuns: () => runs,
			}),
			readLock: () => lock(PID),
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.activeRuns()).toBe(0);
		runs.push({ runId: 'r1' }, { runId: 'r2' });
		expect(cue.activeRuns()).toBe(2);
	});

	it('drains instead of stopping: triggers disarm at once, the runs keep counting, and the queue survives', async () => {
		const runs: unknown[] = [{ runId: 'r1' }];
		let finishDrain!: () => void;
		const order: string[] = [];
		const { all, engine, stopInbox } = deps({
			engine: fakeEngine({
				getActiveRuns: () => runs,
				drain: vi.fn(
					() =>
						new Promise((resolve) => {
							order.push('drain');
							finishDrain = () => {
								runs.length = 0;
								resolve({});
							};
						})
				),
			}),
			readLock: () => lock(PID),
		});
		const fake = fakeRuntime();
		const cue = await startHostCue({ ...PATHS, runtime: fake.runtime }, all);

		const drained = cue.drain(30_000);
		await vi.waitFor(() => expect(engine.drain).toHaveBeenCalledWith({ timeoutMs: 30_000 }));
		// No `cue trigger` and no yaml re-read while the runs finish.
		expect(stopInbox).toHaveBeenCalledTimes(1);
		fake.bus.emit({ type: 'agent.added', agent: agentRecord('a2', '/two') });
		expect(engine.refreshSession).not.toHaveBeenCalled();
		// A run still finishing is work the host waits for.
		expect(cue.activeRuns()).toBe(1);
		expect(cue.state()).toEqual({ state: 'running' });

		// The host's stop after the grace joins the same drain rather than starting another.
		let stopped = false;
		const stopping = cue.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		finishDrain();
		await Promise.all([drained, stopping]);
		expect(engine.drain).toHaveBeenCalledTimes(1);
		// `stop()` deletes the persisted queue; nothing may call it after a drain.
		expect(engine.stop).not.toHaveBeenCalled();
		expect(engine.stopAll).not.toHaveBeenCalled();
		expect(cue.activeRuns()).toBe(0);
		expect(cue.state()).toEqual({ state: 'disabled' });
	});

	it('no settings change applies once the drain started', async () => {
		const fake = fakeRuntime();
		const { all, engine } = deps({ readLock: () => lock(PID) });
		const createEngine = vi.fn(all.createEngine);
		const cue = await startHostCue({ ...PATHS, runtime: fake.runtime }, { ...all, createEngine });
		await cue.drain(10_000);
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(createEngine).toHaveBeenCalledTimes(1);
		expect(engine.stopAll).not.toHaveBeenCalled();
	});

	it('forces the drain on a second signal, and forces one with no wait when none started', async () => {
		let finishDrain!: () => void;
		const { all, engine } = deps({
			engine: fakeEngine({
				drain: vi.fn(
					() =>
						new Promise((resolve) => {
							finishDrain = () => resolve({});
						})
				),
				forceStop: vi.fn(() => finishDrain?.()),
			}),
			readLock: () => lock(PID),
		});
		const cue = await startHostCue(PATHS, all);
		const drained = cue.drain(30_000);
		await vi.waitFor(() => expect(engine.drain).toHaveBeenCalled());
		cue.forceStop();
		expect(engine.forceStop).toHaveBeenCalledTimes(1);
		await drained;
		await cue.stop();
		expect(engine.stop).not.toHaveBeenCalled();

		// A second signal with no drain yet: the engine's forceStop starts one with no wait.
		const second = deps({ readLock: () => lock(PID) });
		const other = await startHostCue(PATHS, second.all);
		other.forceStop();
		await other.stop();
		expect(second.engine.forceStop).toHaveBeenCalledTimes(1);
		expect(second.engine.forceStop.mock.invocationCallOrder[0]).toBeLessThan(
			(second.engine.drain as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
		);
		expect(second.engine.stop).not.toHaveBeenCalled();
	});

	it('forces a drain that failed, and still resolves the stop without calling stop()', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { all, engine } = deps({
			engine: fakeEngine({
				drain: vi.fn(async () => {
					throw new Error('db closed');
				}),
			}),
			readLock: () => lock(PID),
		});
		const cue = await startHostCue(PATHS, all);
		await expect(cue.stop()).resolves.toBeUndefined();
		expect(engine.forceStop).toHaveBeenCalledTimes(1);
		expect(engine.stop).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});

describe('what the engine learns after it started', () => {
	async function running(agents: AgentRecord[]) {
		const fake = fakeRuntime(agents);
		const { all, engine } = deps({ engine: fakeEngine(), readLock: () => lock(PID) });
		const cue = await startHostCue({ ...PATHS, runtime: fake.runtime }, all);
		return { ...fake, all, engine, cue };
	}

	it('gives a new agent its Cue session', async () => {
		const { bus, engine } = await running([agentRecord('a1', '/one')]);
		bus.emit({ type: 'agent.added', agent: agentRecord('a2', '/two') });
		expect(engine.refreshSession).toHaveBeenCalledWith('a2', '/two');
	});

	it('re-reads an agent that now points at another directory, and only then', async () => {
		const { bus, engine } = await running([agentRecord('a1', '/one')]);

		// Every turn and tab change is an `agent.updated`: none of these may rebuild the triggers.
		bus.emit({ type: 'agent.updated', agent: agentRecord('a1', '/one', { name: 'renamed' }) });
		bus.emit({ type: 'agent.updated', agent: agentRecord('a1', '/one', { activeTabId: 't9' }) });
		expect(engine.refreshSession).not.toHaveBeenCalled();

		bus.emit({ type: 'agent.updated', agent: agentRecord('a1', '/elsewhere') });
		expect(engine.refreshSession).toHaveBeenCalledTimes(1);
		expect(engine.refreshSession).toHaveBeenCalledWith('a1', '/elsewhere');

		bus.emit({ type: 'agent.updated', agent: agentRecord('a1', '/elsewhere') });
		expect(engine.refreshSession).toHaveBeenCalledTimes(1);
	});

	it('drops the session of a removed agent', async () => {
		const { bus, engine } = await running([agentRecord('a1', '/one')]);
		bus.emit({ type: 'agent.removed', agentId: 'a1' });
		expect(engine.removeSession).toHaveBeenCalledWith('a1');
	});

	it('stops listening once Cue is stopped', async () => {
		const { bus, engine, cue } = await running([]);
		await cue.stop();
		bus.emit({ type: 'agent.added', agent: agentRecord('a2', '/two') });
		expect(engine.refreshSession).not.toHaveBeenCalled();
	});

	it('stops the engine when Cue is switched off in the settings, and starts one when it is switched on', async () => {
		let enabled = true;
		let held: CueEngineLockInfo | null = null;
		const engines: HostCueEngine[] = [];
		const fake = fakeRuntime();
		const { all } = deps({
			isEnabled: async () => enabled,
			readLock: () => held,
			createEngine: async () => {
				const engine = fakeEngine({
					start: vi.fn(() => {
						held = lock(PID);
					}),
					stop: vi.fn(() => {
						held = null;
					}),
				});
				engines.push(engine);
				return engine;
			},
		});
		const cue = await startHostCue({ ...PATHS, runtime: fake.runtime }, all);
		expect(cue.state()).toEqual({ state: 'running' });

		// A settings write that does not touch the Encore flags changes nothing.
		fake.bus.emit({ type: 'settings.changed', keys: ['fontSize'] });
		enabled = false;
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		await vi.waitFor(() => expect(cue.state()).toEqual({ state: 'disabled' }));
		expect(engines[0].stopAll).toHaveBeenCalledTimes(1);
		expect(engines[0].stop).toHaveBeenCalledTimes(1);
		// Switched off is not a shutdown: the queue is cleared, as on the desktop, not drained.
		expect(engines[0].drain).not.toHaveBeenCalled();

		enabled = true;
		fake.bus.emit({ type: 'settings.changed', keys: 'unknown' });
		await vi.waitFor(() => expect(cue.state()).toEqual({ state: 'running' }));
		expect(engines).toHaveLength(2);
		expect(engines[1].start).toHaveBeenCalledWith('system-boot');

		await cue.stop();
		expect(engines[1].drain).toHaveBeenCalledTimes(1);
		expect(engines[1].stop).not.toHaveBeenCalled();
	});

	it('hands the engine a way to run Auto Run actions in the runtime', async () => {
		const fake = fakeRuntime();
		const createEngine = vi.fn(async () => fakeEngine());
		const { all } = deps({ createEngine, readLock: () => lock(PID) });
		await startHostCue({ ...PATHS, runtime: fake.runtime }, all);
		expect(createEngine).toHaveBeenCalledWith(
			expect.objectContaining({ runAutoRun: expect.any(Function) })
		);
	});
});

describe('another engine taking the lock over', () => {
	/**
	 * A host running Cue over a lock the test controls. `takeOver` does what the engine's heartbeat
	 * does on a lost lock: the new holder's lock is on disk, `onLockLost` is called, then the engine
	 * stops itself.
	 */
	async function hosted(
		options: {
			runs?: unknown[];
			runtime?: HostCueRuntime;
			waitForRunsToEnd?: () => Promise<unknown>;
		} = {}
	) {
		let held: CueEngineLockInfo | null = null;
		let enabled = true;
		/** While set, reading the settings waits on it: a settings change held in progress. */
		let settingsGate: Promise<void> | undefined;
		let lockLost: (() => void) | undefined;
		const runs = options.runs ?? [];
		const order: string[] = [];
		const engine = fakeEngine({
			start: vi.fn(() => {
				held = lock(PID);
			}),
			stop: vi.fn(() => void order.push('stop')),
			stopAll: vi.fn(() => {
				order.push('stopAll');
				runs.length = 0;
			}),
			getActiveRuns: () => runs,
		});
		const engines = [engine];
		const { all, stopInbox } = deps({
			engine,
			isEnabled: async () => {
				if (settingsGate) await settingsGate;
				return enabled;
			},
			readLock: () => held,
			createEngine: vi.fn(async ({ onLockLost }) => {
				lockLost = onLockLost;
				return engines.shift() ?? fakeEngine();
			}),
			...(options.waitForRunsToEnd ? { waitForRunsToEnd: options.waitForRunsToEnd } : {}),
		});
		const cue = await startHostCue(
			{ ...PATHS, ...(options.runtime ? { runtime: options.runtime } : {}) },
			all
		);
		const takeOver = (holder: CueEngineLockInfo | null = lock(99, 'desktop')): void => {
			held = holder;
			lockLost?.();
			engine.stop();
		};
		/** The same during a drain: the engine forces its drain instead of stopping. */
		const takeOverDuringDrain = (holder: CueEngineLockInfo = lock(99, 'desktop')): void => {
			held = holder;
			lockLost?.();
			engine.forceStop();
		};
		return {
			cue,
			all,
			engine,
			stopInbox,
			order,
			takeOver,
			takeOverDuringDrain,
			setEnabled: (on: boolean) => {
				enabled = on;
			},
			/** Hold the next settings read until the returned release is called. */
			holdSettings: (): (() => void) => {
				let release!: () => void;
				settingsGate = new Promise<void>((resolve) => {
					release = resolve;
				});
				return () => {
					settingsGate = undefined;
					release();
				};
			},
		};
	}

	it('reports the new holder and gives up the inbox and agent following', async () => {
		const fake = fakeRuntime();
		const { cue, engine, stopInbox, takeOver } = await hosted({ runtime: fake.runtime });
		expect(cue.state()).toEqual({ state: 'running' });

		takeOver();
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 });
		expect(cue.activeRuns()).toBe(0);
		expect(stopInbox).toHaveBeenCalledTimes(1);
		fake.bus.emit({ type: 'agent.added', agent: agentRecord('a2', '/two') });
		expect(engine.refreshSession).not.toHaveBeenCalled();
	});

	it('reads a lock under another token, at this pid, as the new holder', async () => {
		const { cue, takeOver } = await hosted();
		takeOver({ ...lock(PID), token: 'another-container' });
		expect(cue.state()).toEqual({ state: 'held', mode: 'standalone', pid: PID });
	});

	it('reports a failure, not running, when the lock cannot be read after the loss', async () => {
		const { cue, takeOver } = await hosted();
		takeOver(null);
		expect(cue.state()).toMatchObject({ state: 'failed' });
		expect((cue.state() as { reason: string }).reason).toContain('took the Cue lock over');
	});

	it('ends the runs in flight before the engine forgets them, and a stop waits for their processes', async () => {
		let exited!: () => void;
		const waitForRunsToEnd = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					exited = resolve;
				})
		);
		const { cue, order, takeOver } = await hosted({
			runs: [{ runId: 'r1' }],
			waitForRunsToEnd,
		});
		expect(cue.activeRuns()).toBe(1);

		takeOver();
		// stopAll first: the engine's own stop() right after forgets the runs without ending them.
		expect(order).toEqual(['stopAll', 'stop']);
		expect(cue.activeRuns()).toBe(0);

		let stopped = false;
		const stopping = cue.stop().then(() => {
			stopped = true;
		});
		await vi.waitFor(() => expect(waitForRunsToEnd).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		expect(stopped).toBe(false);
		exited();
		await stopping;
		expect(stopped).toBe(true);
	});

	it('resolves a later stop cleanly, without ending anything a second time', async () => {
		const { cue, engine, stopInbox, takeOver } = await hosted();
		takeOver();
		await expect(cue.stop()).resolves.toBeUndefined();
		await expect(cue.stop()).resolves.toBeUndefined();
		// Nothing is left to drain: the loss already gave the engine up.
		expect(engine.drain).not.toHaveBeenCalled();
		expect(engine.stopAll).toHaveBeenCalledTimes(1);
		expect(engine.stop).toHaveBeenCalledTimes(1);
		expect(stopInbox).toHaveBeenCalledTimes(1);
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 });
	});

	it('still ends the runs when the loss lands while a stop is queued', async () => {
		let exited!: () => void;
		const fake = fakeRuntime();
		const { cue, engine, takeOver, holdSettings } = await hosted({
			runtime: fake.runtime,
			runs: [{ runId: 'r1' }],
			waitForRunsToEnd: () =>
				new Promise<void>((resolve) => {
					exited = resolve;
				}),
		});
		// A settings change in progress holds the queue, so the stop below waits behind it.
		const release = holdSettings();
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		let stopped = false;
		const stopping = cue.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(engine.stopAll).not.toHaveBeenCalled();

		takeOver();
		expect(engine.stopAll).toHaveBeenCalledTimes(1);
		release();
		// The stop was queued before the loss, and still waits for the runs the loss ended.
		await vi.waitFor(() => expect(exited).toBeDefined());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(stopped).toBe(false);
		exited();
		await stopping;
		expect(engine.stopAll).toHaveBeenCalledTimes(1);
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 });
	});

	it('does nothing when the loss lands during a bring-down, which ends the runs itself', async () => {
		let exited!: () => void;
		const fake = fakeRuntime();
		const { cue, engine, stopInbox, takeOver, setEnabled } = await hosted({
			runtime: fake.runtime,
			waitForRunsToEnd: () =>
				new Promise<void>((resolve) => {
					exited = resolve;
				}),
		});
		setEnabled(false);
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		await vi.waitFor(() => expect(engine.stopAll).toHaveBeenCalledTimes(1));

		expect(() => takeOver()).not.toThrow();
		expect(engine.stopAll).toHaveBeenCalledTimes(1);
		expect(stopInbox).toHaveBeenCalledTimes(1);
		exited();
		await vi.waitFor(() => expect(cue.state()).toEqual({ state: 'disabled' }));
		await expect(cue.stop()).resolves.toBeUndefined();
	});

	it('reports Cue off when it is switched off after the loss', async () => {
		const fake = fakeRuntime();
		const { cue, takeOver, setEnabled } = await hosted({ runtime: fake.runtime });
		takeOver();
		setEnabled(false);
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		await vi.waitFor(() => expect(cue.state()).toEqual({ state: 'disabled' }));
	});

	it('reports the holder, and starts no engine, when Cue is switched on again after the loss', async () => {
		const fake = fakeRuntime();
		const { cue, all, takeOver, setEnabled } = await hosted({ runtime: fake.runtime });
		takeOver();
		setEnabled(false);
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		await vi.waitFor(() => expect(cue.state()).toEqual({ state: 'disabled' }));

		setEnabled(true);
		fake.bus.emit({ type: 'settings.changed', keys: ['encoreFeatures'] });
		await vi.waitFor(() =>
			expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 })
		);
		expect(all.createEngine).toHaveBeenCalledTimes(1);
		await cue.stop();
	});

	it('leaves a loss during the drain to the drain, which the engine forces itself', async () => {
		let finishDrain!: () => void;
		const { cue, engine, takeOverDuringDrain } = await hosted();
		(engine.drain as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishDrain = () => resolve({});
				})
		);
		(engine.forceStop as ReturnType<typeof vi.fn>).mockImplementation(() => finishDrain());
		const drained = cue.drain(30_000);
		await vi.waitFor(() => expect(engine.drain).toHaveBeenCalled());

		expect(() => takeOverDuringDrain()).not.toThrow();
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 });
		// stopAll would clear the queue the forced drain is about to persist.
		expect(engine.stopAll).not.toHaveBeenCalled();

		await drained;
		await cue.stop();
		expect(engine.drain).toHaveBeenCalledTimes(1);
		expect(engine.forceStop).toHaveBeenCalledTimes(1);
		expect(engine.stop).not.toHaveBeenCalled();
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 });
	});

	it('survives a host step that throws, and still reports the holder', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { cue, engine, stopInbox, takeOver } = await hosted();
		stopInbox.mockImplementation(() => {
			throw new Error('inbox gone');
		});
		expect(() => takeOver()).not.toThrow();
		expect(engine.stopAll).toHaveBeenCalledTimes(1);
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 99 });
		vi.restoreAllMocks();
	});
	describe('the Cue answers it gives the CLI, around a drain and a loss', () => {
		const toggle = {
			type: 'toggle_cue_subscription',
			subscriptionId: 'a1::beat::beat',
			enabled: false,
		};
		const trigger = { type: 'trigger_cue_subscription', subscriptionName: 'beat' };
		const list = { type: 'get_cue_subscriptions' };
		const subs = [
			{
				sessionId: 'a1',
				sessionName: 'One',
				toolType: 'claude-code',
				subscriptions: [{ name: 'beat', event: 'time.heartbeat', prompt: 'p' }],
			},
		] as unknown as CueGraphSession[];

		/** A host mid-drain: the engine's drain waits until `finish` is called. */
		async function draining() {
			const host = await hosted();
			vi.mocked(host.engine.getGraphData).mockReturnValue(subs);
			let finish!: () => void;
			vi.mocked(host.engine.drain).mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = () => resolve({});
					})
			);
			vi.mocked(host.engine.forceStop).mockImplementation(() => finish());
			const drained = host.cue.drain(30_000);
			await vi.waitFor(() => expect(host.engine.drain).toHaveBeenCalled());
			return { ...host, drained, finish: () => finish() };
		}

		it('still answers a read while the runs finish, from the draining engine', async () => {
			const { cue, drained, finish } = await draining();
			await expect(cue.answer(list)).resolves.toMatchObject({
				type: 'cue_subscriptions',
				subscriptions: [{ id: 'a1::beat::beat' }],
			});
			await expect(cue.answer({ type: 'get_cue_activity' })).resolves.toMatchObject({
				type: 'cue_activity',
			});
			finish();
			await drained;
		});

		it('refuses a toggle and a trigger once the drain started, and the engine sees neither', async () => {
			const { cue, engine, drained, finish } = await draining();
			for (const message of [toggle, trigger]) {
				await expect(cue.answer(message)).resolves.toEqual({
					type: 'error',
					message: CUE_SHUTTING_DOWN_MESSAGE,
				});
			}
			expect(engine.setSubscriptionEnabled).not.toHaveBeenCalled();
			expect(engine.triggerSubscription).not.toHaveBeenCalled();
			finish();
			await drained;
		});

		it('after the drain, leaves reads to disk and still says it is shutting down, not that Cue is off', async () => {
			const { cue, drained, finish } = await draining();
			finish();
			await drained;
			expect(cue.state()).toEqual({ state: 'disabled' });
			await expect(cue.answer(list)).resolves.toBeUndefined();
			await expect(cue.answer(toggle)).resolves.toEqual({
				type: 'error',
				message: CUE_SHUTTING_DOWN_MESSAGE,
			});
		});

		it('after a lock loss, leaves reads to disk and names the new holder on a write', async () => {
			const { cue, engine, takeOver } = await hosted();
			vi.mocked(engine.getGraphData).mockReturnValue(subs);
			takeOver(lock(99, 'desktop'));

			await expect(cue.answer(list)).resolves.toBeUndefined();
			await expect(cue.answer({ type: 'get_cue_activity' })).resolves.toBeUndefined();
			for (const message of [toggle, trigger]) {
				await expect(cue.answer(message)).resolves.toEqual({
					type: 'error',
					message: expect.stringContaining('a desktop Cue engine (pid 99) holds the Cue lock'),
				});
			}
			expect(engine.setSubscriptionEnabled).not.toHaveBeenCalled();
		});

		it('after a loss during the drain, stops answering from the old engine and names the holder', async () => {
			const { cue, engine, drained, takeOverDuringDrain } = await draining();
			takeOverDuringDrain(lock(77, 'standalone'));

			// The old engine is still winding down, but the data is no longer its to give.
			await expect(cue.answer(list)).resolves.toBeUndefined();
			await expect(cue.answer(toggle)).resolves.toEqual({
				type: 'error',
				message: expect.stringContaining('a standalone Cue engine (pid 77) holds the Cue lock'),
			});
			expect(engine.setSubscriptionEnabled).not.toHaveBeenCalled();
			await drained;
		});

		it('names the loss when the new holder cannot be read, rather than "did not start"', async () => {
			const { cue, takeOver } = await hosted();
			takeOver(null);
			const reply = await cue.answer(toggle);
			expect(reply).toEqual({
				type: 'error',
				message: expect.stringMatching(
					/^This host is not running Cue: another Cue engine took the Cue lock over/
				),
			});
		});
	});
});

describe('runAutoRunInRuntime', () => {
	const params = (overrides: Partial<CueAutoRunLaunchParams> = {}): CueAutoRunLaunchParams => ({
		sessionId: 'a1',
		documents: [{ filename: '/p/.maestro/playbooks/a.md', resetOnCompletion: true }],
		...overrides,
	});
	const state = (value: AutoRunProgress | null, agentId = 'a1') =>
		({ type: 'autorun', agentId, event: { kind: 'state', at: 1, state: value } }) as const;
	const endedWith = (outcome: AutoRunOutcome, agentId = 'a1') =>
		({ type: 'autorun.ended', agentId, at: 2, outcome }) as const;
	/** A run's frames, then its end and the `null` that follows it, as the runtime sends them. */
	const runEnds = (bus: ReturnType<typeof fakeRuntime>['bus'], outcome: AutoRunOutcome): void => {
		bus.emit(endedWith(outcome));
		bus.emit(state(null));
	};

	async function launched(overrides: Partial<CueAutoRunLaunchParams> = {}) {
		const fake = fakeRuntime();
		const abort = new AbortController();
		const answer = await runAutoRunInRuntime(fake.runtime)(params(overrides), abort.signal);
		if (!answer.started) throw new Error(`expected a started run, got: ${answer.error}`);
		return { ...fake, abort, ended: answer.ended };
	}

	it("launches the documents on the subscription's agent", async () => {
		const { launch } = await launched({
			loopEnabled: true,
			maxLoops: 3,
			model: 'm',
			effort: 'low',
			prompt: 'Only the first task.',
			ignoreModelHints: true,
		});
		expect(launch).toHaveBeenCalledWith('a1', {
			documents: [{ file: '/p/.maestro/playbooks/a.md', resetOnCompletion: true }],
			loop: true,
			maxLoops: 3,
			model: 'm',
			effort: 'low',
			prompt: 'Only the first task.',
			ignoreModelHints: true,
		});
	});

	it('reports a refused launch with the reason', async () => {
		const fake = fakeRuntime();
		fake.launch.mockResolvedValue({
			ok: false,
			error: { code: 'rejected', message: 'The agent is busy.', method: 'autoRun.launch' },
		});
		const answer = await runAutoRunInRuntime(fake.runtime)(params(), new AbortController().signal);
		expect(answer).toEqual({ started: false, error: 'The agent is busy.' });
	});

	it('ends well when the run does, and not before', async () => {
		const { bus, ended } = await launched();
		let end: unknown;
		void ended.then((value) => {
			end = value;
		});
		// Another agent's run ending, and a stale end from before this run, are not this run's end.
		bus.emit(endedWith({ status: 'failed', reason: 'an earlier run' }));
		bus.emit(state(progress(), 'other'));
		bus.emit(endedWith({ status: 'completed' }, 'other'));
		await Promise.resolve();
		expect(end).toBeUndefined();

		bus.emit(state(progress()));
		bus.emit(state(progress({ tasksDone: 2 })));
		// The `null` that closes the frames says nothing about how it went; the end does.
		bus.emit(state(null));
		await Promise.resolve();
		expect(end).toBeUndefined();
		bus.emit(endedWith({ status: 'completed' }));
		expect(await ended).toEqual({ ok: true });
	});

	it("reports a failed run with the engine's reason", async () => {
		const { bus, ended } = await launched();
		bus.emit(state(progress()));
		runEnds(bus, { status: 'failed', reason: 'the run halted: tests are red' });
		expect(await ended).toEqual({ ok: false, reason: 'the run halted: tests are red' });
	});

	it('reports a run a person stopped as not done', async () => {
		const { bus, ended } = await launched();
		bus.emit(state(progress()));
		runEnds(bus, { status: 'stopped' });
		expect(await ended).toEqual({ ok: false, reason: 'the run was stopped before it finished' });
	});

	it('reports an engine crash as a failure, not a completed run', async () => {
		// The last frame of a run the engine threw out of looks like any finished run's.
		const { bus, ended } = await launched();
		bus.emit(state(progress({ tasksDone: 1 })));
		runEnds(bus, { status: 'error', reason: 'ENOSPC: no space left on device' });
		expect(await ended).toEqual({
			ok: false,
			reason: 'the Auto Run engine failed: ENOSPC: no space left on device',
		});
	});

	it('does not read a pause in the last frame as the end', async () => {
		// A run aborted from a pause is a stop, and the engine says so.
		const { bus, ended } = await launched();
		bus.emit(
			state(
				progress({
					pause: { message: 'Rate limit reached', type: 'rate_limited', recoverable: true },
				})
			)
		);
		runEnds(bus, { status: 'stopped' });
		expect(await ended).toEqual({ ok: false, reason: 'the run was stopped before it finished' });
	});

	it('reports a run cut off by losing the data directory', async () => {
		const { bus, ended } = await launched();
		bus.emit(state(progress()));
		bus.emit({ type: 'host.lost', reason: 'a desktop took over' });
		expect(await ended).toMatchObject({ ok: false, reason: expect.stringContaining('took over') });
	});

	it('stops the Auto Run when the Cue run is stopped', async () => {
		const { abort, stop } = await launched();
		expect(stop).not.toHaveBeenCalled();
		abort.abort();
		expect(stop).toHaveBeenCalledWith('a1');
	});

	it('refuses a worktree run instead of running it in the wrong directory', async () => {
		const fake = fakeRuntime();
		const answer = await runAutoRunInRuntime(fake.runtime)(
			params({
				worktreeTarget: { mode: 'create-new' } as CueAutoRunLaunchParams['worktreeTarget'],
			}),
			new AbortController().signal
		);
		expect(answer).toMatchObject({ started: false, error: expect.stringContaining('worktree') });
		expect(fake.launch).not.toHaveBeenCalled();
	});
});

describe('the Cue answers a host gives the CLI', () => {
	const run = (id: string, sessionId: string, stdout: string): CueRunResult => ({
		runId: id,
		sessionId,
		sessionName: sessionId,
		subscriptionName: 'beat',
		event: {
			id,
			type: 'time.heartbeat',
			timestamp: '2026-10-19T07:00:00.000Z',
			triggerName: 'beat',
			payload: {},
		},
		status: 'completed',
		stdout,
		stderr: '',
		exitCode: 0,
		durationMs: 1200,
		startedAt: '2026-10-19T07:00:00.000Z',
		endedAt: '2026-10-19T07:00:01.200Z',
	});
	const graph = [
		{
			sessionId: 'a1',
			sessionName: 'One',
			toolType: 'claude-code',
			subscriptions: [{ name: 'beat', event: 'time.heartbeat', prompt: 'p', interval_minutes: 5 }],
		},
		{
			sessionId: 'a2',
			sessionName: 'Two',
			toolType: 'codex',
			subscriptions: [{ name: 'other', event: 'file.changed', prompt: 'p', enabled: false }],
		},
	] as unknown as CueGraphSession[];
	const running = { state: 'running' } as const;

	it('lists subscriptions from the engine, with the desktop reply type and mapping', async () => {
		const engine = fakeEngine({ getGraphData: vi.fn(() => graph) });
		const reply = await answerCueMessage(
			{ type: 'get_cue_subscriptions', sessionId: 'a1' },
			engine,
			running
		);
		expect(reply).toMatchObject({
			type: 'cue_subscriptions',
			subscriptions: [
				{
					id: 'a1::beat::beat',
					name: 'beat',
					eventType: 'time.heartbeat',
					schedule: 'every 5m',
					sessionId: 'a1',
					sessionName: 'One',
					enabled: true,
					triggerCount: 0,
				},
			],
		});
	});

	it('answers activity from the engine log, newest first, limited, with run output', async () => {
		const engine = fakeEngine({
			getActivityLog: vi.fn(() => [
				run('r1', 'a1', 'first'),
				run('r2', 'a2', 'x'),
				run('r3', 'a1', 'third'),
			]),
		});
		const reply = await answerCueMessage(
			{ type: 'get_cue_activity', sessionId: 'a1', limit: 1 },
			engine,
			running
		);
		expect(reply?.type).toBe('cue_activity');
		expect(reply?.entries).toEqual([
			expect.objectContaining({ id: 'r3', status: 'completed', result: 'third', duration: 1200 }),
		]);
	});

	it('toggles through the engine, and validates the message as the desktop does', async () => {
		const engine = fakeEngine();
		await expect(
			answerCueMessage(
				{ type: 'toggle_cue_subscription', subscriptionId: 'a1::beat::beat', enabled: false },
				engine,
				running
			)
		).resolves.toMatchObject({
			type: 'toggle_cue_subscription_result',
			success: true,
			subscriptionId: 'a1::beat::beat',
			enabled: false,
		});
		expect(engine.setSubscriptionEnabled).toHaveBeenCalledWith('a1::beat::beat', false);

		await expect(
			answerCueMessage({ type: 'toggle_cue_subscription', subscriptionId: 'x' }, engine, running)
		).resolves.toEqual({ type: 'error', message: 'Missing or invalid enabled flag' });
	});

	it('reports a toggle the engine could not write as an error frame', async () => {
		const engine = fakeEngine({
			setSubscriptionEnabled: vi.fn(async () => {
				throw new Error('cue.yaml is read-only');
			}),
		});
		await expect(
			answerCueMessage(
				{ type: 'toggle_cue_subscription', subscriptionId: 'x', enabled: true },
				engine,
				running
			)
		).resolves.toEqual({
			type: 'error',
			message: 'Failed to toggle Cue subscription: cue.yaml is read-only',
		});
	});

	it('triggers through the engine', async () => {
		const engine = fakeEngine();
		await expect(
			answerCueMessage(
				{ type: 'trigger_cue_subscription', subscriptionName: 'beat', prompt: 'now' },
				engine,
				running
			)
		).resolves.toMatchObject({ type: 'trigger_cue_subscription_result', success: true });
		expect(engine.triggerSubscription).toHaveBeenCalledWith('beat', 'now', undefined);
	});

	it('leaves a read unanswered without a running engine, so the CLI reads disk', async () => {
		for (const state of [
			{ state: 'held', mode: 'standalone', pid: 77 } as const,
			{ state: 'disabled' } as const,
			{ state: 'failed', reason: 'cue.db is locked' } as const,
		]) {
			await expect(
				answerCueMessage({ type: 'get_cue_activity' }, undefined, state)
			).resolves.toBeUndefined();
			await expect(
				answerCueMessage({ type: 'get_cue_subscriptions' }, undefined, state)
			).resolves.toBeUndefined();
		}
	});

	it('refuses a change without a running engine, naming why and what to do', async () => {
		const held = await answerCueMessage(
			{ type: 'toggle_cue_subscription', subscriptionId: 'x', enabled: true },
			undefined,
			{ state: 'held', mode: 'standalone', pid: 77 }
		);
		expect(held).toEqual({
			type: 'error',
			message: expect.stringContaining('a standalone Cue engine (pid 77) holds the Cue lock'),
		});
		const failed = await answerCueMessage(
			{ type: 'trigger_cue_subscription', subscriptionName: 'beat' },
			undefined,
			{ state: 'failed', reason: 'cue.db is locked' }
		);
		expect(failed).toEqual({
			type: 'error',
			message: 'This host is not running Cue: cue.db is locked',
		});
	});

	it('leaves every other message to the echo', async () => {
		await expect(
			answerCueMessage({ type: 'cue_pipeline_list' }, fakeEngine(), running)
		).resolves.toBeUndefined();
		await expect(
			answerCueMessage({ type: 'list_sessions' }, undefined, running)
		).resolves.toBeUndefined();
	});

	it('answers from the engine only while the host runs it', async () => {
		const { all, engine } = deps();
		vi.mocked(engine.getGraphData).mockReturnValue(graph);
		const cue = await startHostCue(PATHS, all);
		await expect(cue.answer({ type: 'get_cue_subscriptions' })).resolves.toMatchObject({
			type: 'cue_subscriptions',
		});

		await cue.stop();
		await expect(cue.answer({ type: 'get_cue_subscriptions' })).resolves.toBeUndefined();
	});

	it('answers nothing when another engine holds the lock', async () => {
		const { all } = deps({ readLock: () => lock(77, 'standalone') });
		const cue = await startHostCue(PATHS, all);
		await expect(cue.answer({ type: 'get_cue_activity' })).resolves.toBeUndefined();
		await expect(
			cue.answer({ type: 'toggle_cue_subscription', subscriptionId: 'x', enabled: true })
		).resolves.toMatchObject({ type: 'error' });
	});
});
