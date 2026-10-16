import { describe, expect, it, vi } from 'vitest';

import type { CueAutoRunLaunchParams } from '../../../main/cue/cue-autorun-executor';
import type { CueEngineLockInfo } from '../../../main/cue/cue-engine-lock';
import {
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
		refreshSession: vi.fn(),
		removeSession: vi.fn(),
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
		expect(engine.stop).toHaveBeenCalledTimes(1);
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

	it('stops every run, waits for its process to exit, and only then stops the engine', async () => {
		const order: string[] = [];
		let exited!: () => void;
		const { all, engine } = deps({
			engine: fakeEngine({
				stopAll: vi.fn(() => void order.push('stopAll')),
				stop: vi.fn(() => void order.push('stop')),
			}),
			readLock: () => lock(PID),
			waitForRunsToEnd: () =>
				new Promise<void>((resolve) => {
					order.push('waiting');
					exited = () => {
						order.push('exited');
						resolve();
					};
				}),
		});
		const cue = await startHostCue(PATHS, all);

		let stopped = false;
		const stopping = cue.stop().then(() => {
			stopped = true;
		});
		await vi.waitFor(() => expect(order).toEqual(['stopAll', 'waiting']));
		// The engine's own stop forgets its runs without ending them, so it must not run yet.
		expect(engine.stop).not.toHaveBeenCalled();
		expect(stopped).toBe(false);

		exited();
		await stopping;
		expect(order).toEqual(['stopAll', 'waiting', 'exited', 'stop']);
		expect(cue.activeRuns()).toBe(0);
	});

	it('still stops the engine when stopping a run throws', async () => {
		const { all, engine } = deps({
			engine: fakeEngine({
				stopAll: vi.fn(() => {
					throw new Error('db closed');
				}),
			}),
			readLock: () => lock(PID),
		});
		const cue = await startHostCue(PATHS, all);
		await expect(cue.stop()).rejects.toThrow('db closed');
		expect(engine.stop).toHaveBeenCalledTimes(1);
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

		enabled = true;
		fake.bus.emit({ type: 'settings.changed', keys: 'unknown' });
		await vi.waitFor(() => expect(cue.state()).toEqual({ state: 'running' }));
		expect(engines).toHaveLength(2);
		expect(engines[1].start).toHaveBeenCalledWith('system-boot');

		await cue.stop();
		expect(engines[1].stop).toHaveBeenCalledTimes(1);
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
