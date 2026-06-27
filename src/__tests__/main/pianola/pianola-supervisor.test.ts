/**
 * @file pianola-supervisor.test.ts
 *
 * Unit tests for the supervised-daemon lifecycle: spawn, unexpected-exit
 * backoff, restart cap, clean-exit handling, the intentional-stop flag, the
 * stable-run reset, reconcile spawn/stop, kind-aware liveness/relaunch, the
 * health log buffer, and Encore-off teardown.
 *
 * No real processes: a fake ChildProcess (an EventEmitter with .pid/.kill and
 * stdout/stderr EventEmitters) is injected via the supervisor's spawnChild dep,
 * and fake timers drive backoff and stable-run timing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// The store read/path are stubbed so reconcile/relaunch work off a controllable
// target list without touching electron, fs, or a real watcher.
vi.mock('../../../main/pianola/pianola-store-main', () => ({
	readSupervisorTargets: vi.fn(() => []),
	supervisorFilePath: vi.fn(() => '/fake/maestro-pianola-supervisor.json'),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/fake/maestro-cli.js',
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Force the POSIX kill path so killProcess uses child.kill (our spy) instead of
// shelling out to taskkill against a fake pid on Windows.
vi.mock('../../../shared/platformDetection', () => ({ isWindows: () => false }));

import { PianolaSupervisor } from '../../../main/pianola/pianola-supervisor';
import { readSupervisorTargets } from '../../../main/pianola/pianola-store-main';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';

// Mirror the (unexported) source constants so timing assertions stay in sync.
const MAX_RESTARTS = 5;
const BACKOFF_CAP_MS = 30_000;
const STABLE_RUN_MS = 60_000;

/** A child stream stub: an EventEmitter that also answers setEncoding. */
class FakeStream extends EventEmitter {
	setEncoding(): this {
		return this;
	}
}

/** Minimal ChildProcess double the supervisor can drive in tests. */
class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	killed = false;
	lastSignal: NodeJS.Signals | number | undefined;

	constructor(readonly pid: number) {
		super();
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		this.lastSignal = signal;
		return true;
	}

	/** Simulate the OS reporting this child exited. */
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit('exit', code, signal);
	}

	/** Simulate a line of stdout. */
	emitStdout(data: string): void {
		this.stdout.emit('data', data);
	}

	/** Simulate a line of stderr. */
	emitStderr(data: string): void {
		this.stderr.emit('data', data);
	}
}

let spawned: FakeChild[];
let pidSeq: number;
let enabled: boolean;
let sup: PianolaSupervisor;

function makeSupervisor(): PianolaSupervisor {
	return new PianolaSupervisor({
		isEnabled: () => enabled,
		getPianolaAgentId: () => 'pianola-agent',
		spawnChild: () => {
			const child = new FakeChild(++pidSeq);
			spawned.push(child);
			return child as unknown as ChildProcess;
		},
	});
}

function watchTarget(id = 'w1', enabledFlag = true): PianolaSupervisedTarget {
	return { id, kind: 'watch', enabled: enabledFlag, createdAt: 0, tabId: 't1', agentId: 'a1' };
}

function orchestrateTarget(id = 'o1', enabledFlag = true): PianolaSupervisedTarget {
	return { id, kind: 'orchestrate', enabled: enabledFlag, createdAt: 0, planId: 'p1' };
}

function setTargets(targets: PianolaSupervisedTarget[]): void {
	vi.mocked(readSupervisorTargets).mockReturnValue(targets);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.setSystemTime(0);
	spawned = [];
	pidSeq = 0;
	enabled = true;
	vi.mocked(readSupervisorTargets).mockReturnValue([]);
	sup = makeSupervisor();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('PianolaSupervisor spawn + exit lifecycle', () => {
	it('schedules a backoff on an unexpected exit', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(spawned).toHaveLength(1);

		spawned[0].exit(1);

		const [health] = sup.getHealth();
		expect(health.state).toBe('backing-off');
		expect(health.restarts).toBe(1);
		expect(health.lastError).toContain('code 1');
	});

	it('marks a target failed after exceeding MAX_RESTARTS', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		for (let i = 0; i <= MAX_RESTARTS; i++) {
			spawned[spawned.length - 1].exit(1);
			if (sup.getHealth()[0]?.state === 'failed') break;
			// Fire the backoff timer to respawn the next crashing child.
			vi.advanceTimersByTime(BACKOFF_CAP_MS);
		}

		const [health] = sup.getHealth();
		expect(health.state).toBe('failed');
		expect(health.restarts).toBe(MAX_RESTARTS + 1);
	});

	it('stops without scheduling a restart on a clean exit (code 0)', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].exit(0);

		expect(sup.getHealth()[0].state).toBe('stopped');
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
	});

	it('does not restart when the stopping flag is set', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(spawned).toHaveLength(1);

		// Disabling the target marks the child stopping and kills it.
		setTargets([watchTarget('w1', false)]);
		sup.reconcile();
		expect(spawned[0].killed).toBe(true);

		// A crash-code exit after an intentional stop must not trigger a restart.
		spawned[0].exit(1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
	});

	it('resets the restart counter after a stable run', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].exit(1);
		vi.advanceTimersByTime(1000); // fire the first backoff -> respawn
		expect(spawned).toHaveLength(2);
		expect(sup.getHealth()[0].restarts).toBe(1);

		// The respawned child runs long enough to count as recovered.
		vi.advanceTimersByTime(STABLE_RUN_MS);
		spawned[1].exit(1);

		// Reset to 0 on the stable run, then +1 for this fresh failure: 1, not 2.
		expect(sup.getHealth()[0].restarts).toBe(1);
		expect(sup.getHealth()[0].state).toBe('backing-off');
	});
});

describe('PianolaSupervisor reconcile', () => {
	it('spawns an enabled target with no child and stops a removed one', () => {
		setTargets([watchTarget('w1'), orchestrateTarget('o1')]);
		sup.reconcile();
		expect(spawned).toHaveLength(2);
		expect(
			sup
				.getHealth()
				.map((h) => h.id)
				.sort()
		).toEqual(['o1', 'w1']);

		// Removing w1 should stop and forget its child but leave o1 running.
		setTargets([orchestrateTarget('o1')]);
		sup.reconcile();
		expect(spawned[0].killed).toBe(true);
		expect(sup.getHealth().map((h) => h.id)).toEqual(['o1']);
	});

	it('kills all children when Encore is off', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(spawned).toHaveLength(1);

		enabled = false;
		sup.reconcile();
		expect(spawned[0].killed).toBe(true);
		expect(sup.getHealth()).toHaveLength(0);
	});
});

describe('PianolaSupervisor stopAll', () => {
	it('kills every child and clears the health snapshot', () => {
		setTargets([watchTarget('w1'), orchestrateTarget('o1')]);
		sup.reconcile();
		expect(spawned).toHaveLength(2);

		sup.stopAll();

		expect(spawned[0].killed).toBe(true);
		expect(spawned[1].killed).toBe(true);
		expect(sup.getHealth()).toHaveLength(0);
	});
});

describe('PianolaSupervisor kind-aware relaunch', () => {
	it('relaunches a stopped enabled watch target (stale)', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		spawned[0].exit(0); // a watch that cleanly exits should be relaunched
		expect(sup.getHealth()[0].state).toBe('stopped');

		expect(sup.relaunchStale()).toBe(1);
		expect(spawned).toHaveLength(2);
		expect(sup.getHealth()[0].state).toBe('running');
	});

	it('does not relaunch a stopped orchestrate target (terminal)', () => {
		setTargets([orchestrateTarget()]);
		sup.reconcile();
		spawned[0].exit(0); // an orchestrate plan finishing is terminal
		expect(sup.getHealth()[0].state).toBe('stopped');

		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(1);
	});

	it('does not relaunch a running target', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(1);
	});

	it('does not relaunch a disabled target', () => {
		setTargets([watchTarget('w1', false)]);
		sup.reconcile();
		expect(spawned).toHaveLength(0);
		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(0);
	});
});

describe('PianolaSupervisor health log buffer', () => {
	it('exposes recent child logs in the health snapshot', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].emitStdout('line a\nline b\n');
		spawned[0].emitStderr('err c\n');

		expect(sup.getHealth()[0].recentLogs).toEqual(['line a', 'line b', 'err c']);
	});

	it('bounds recentLogs to the most recent lines', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		for (let i = 0; i < 120; i++) spawned[0].emitStdout(`line ${i}\n`);

		const logs = sup.getHealth()[0].recentLogs;
		expect(logs).toHaveLength(50);
		expect(logs[0]).toBe('line 70');
		expect(logs[49]).toBe('line 119');
	});
});
