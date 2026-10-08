/**
 * The systemd notifier (`cue-systemd-notify.ts`), with `systemd-notify`
 * replaced by a fake spawn the test settles by hand.
 *
 * Off without NOTIFY_SOCKET (nothing spawned, ever); READY only once running,
 * gaps or not, with the gaps in STATUS; WATCHDOG at WATCHDOG_USEC/2 and only
 * while /healthz's rule holds; STOPPING at the drain and STATUS per phase;
 * one warning for a missing binary or a failing streak; the env stripped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnOptions } from 'child_process';
import {
	createSystemdNotifier,
	watchdogIntervalMs,
	type SystemdNotifySpawn,
} from '../../../main/cue/cue-systemd-notify';
import {
	createCueEngineHealth,
	type CueEngineHealth,
	type CueEventLoopDelay,
} from '../../../main/cue/cue-engine-health';
import type { CueReadinessReport } from '../../../main/cue/cue-readiness';

const ready: CueReadinessReport = {
	ready: true,
	checkedAt: '2026-10-06T12:00:00.000Z',
	agents: 2,
	workspaces: 1,
	subscriptions: 3,
	gaps: [],
};

interface FakeCall {
	args: string[];
	options: SpawnOptions;
	child: ChildProcess & EventEmitter;
}

/** A spawn whose children stay "running" until the test exits them. */
function fakeSpawn(behaviour: { autoExit?: number | null; error?: NodeJS.ErrnoException } = {}) {
	const calls: FakeCall[] = [];
	const spawnImpl: SystemdNotifySpawn = (command, args, options) => {
		expect(command).toBe('systemd-notify');
		const child = new EventEmitter() as ChildProcess & EventEmitter;
		calls.push({ args, options, child });
		if (behaviour.error) {
			queueMicrotask(() => child.emit('error', behaviour.error));
		} else if (behaviour.autoExit !== null) {
			queueMicrotask(() => child.emit('exit', behaviour.autoExit ?? 0, null));
		}
		return child;
	};
	return { calls, spawnImpl };
}

const sent = (calls: FakeCall[]) => calls.map((c) => c.args.join(' '));

let delay: CueEventLoopDelay | null;
function makeHealth(): CueEngineHealth {
	const health = createCueEngineHealth({
		version: 't',
		dataDir: '/d',
		eventLoop: { read: () => delay, dispose: () => {} },
	});
	health.setReadiness(ready);
	return health;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('watchdogIntervalMs', () => {
	it('is half of WATCHDOG_USEC, for this pid only', () => {
		expect(watchdogIntervalMs('30000000', undefined, 7)).toBe(15_000);
		expect(watchdogIntervalMs('30000000', '7', 7)).toBe(15_000);
		expect(watchdogIntervalMs('30000000', '8', 7)).toBeNull();
		expect(watchdogIntervalMs(undefined, undefined, 7)).toBeNull();
		expect(watchdogIntervalMs('0', undefined, 7)).toBeNull();
		expect(watchdogIntervalMs('abc', undefined, 7)).toBeNull();
	});
});

describe('createSystemdNotifier', () => {
	let onLog: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		delay = null;
		onLog = vi.fn();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(env: NodeJS.ProcessEnv, behaviour?: Parameters<typeof fakeSpawn>[0]) {
		const { calls, spawnImpl } = fakeSpawn(behaviour);
		const health = makeHealth();
		const notifier = createSystemdNotifier({ env, health, onLog, spawnImpl, pid: 4242 });
		notifier?.start();
		return { calls, health, notifier };
	}

	it('does nothing at all without NOTIFY_SOCKET', async () => {
		const spawnImpl = vi.fn();
		const health = makeHealth();
		const notifier = createSystemdNotifier({
			env: { WATCHDOG_USEC: '30000000' },
			health,
			onLog,
			spawnImpl: spawnImpl as unknown as SystemdNotifySpawn,
		});
		expect(notifier).toBeNull();
		health.markRunning();
		health.markDraining();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(spawnImpl).not.toHaveBeenCalled();
	});

	it('sends READY with MAINPID and STATUS only once running', async () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n', PATH: '/bin' });
		await flush();
		expect(calls).toHaveLength(0);
		health.markRunning();
		expect(sent(calls)).toEqual([
			'READY=1 MAINPID=4242 STATUS=Running: 2 agent(s), 3 subscription(s)',
		]);
		expect(calls[0].options).toMatchObject({
			stdio: 'ignore',
			timeout: 5000,
			killSignal: 'SIGKILL',
			env: { NOTIFY_SOCKET: '/run/n', PATH: '/bin' },
		});
	});

	it('still sends READY with readiness gaps, naming them in STATUS', () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n' });
		health.setReadiness({
			...ready,
			ready: false,
			gaps: [{ kind: 'tool-missing', tool: 'gh', message: 'gh missing' }],
		});
		expect(calls).toHaveLength(0); // readiness updates before running send nothing
		health.markRunning();
		expect(sent(calls)[0]).toBe(
			'READY=1 MAINPID=4242 STATUS=Running with 1 readiness gap(s); see /readyz or cue engine check'
		);
	});

	it('removes NOTIFY_SOCKET and WATCHDOG_* from the environment it was given', () => {
		const env: NodeJS.ProcessEnv = {
			NOTIFY_SOCKET: '/run/n',
			WATCHDOG_USEC: '30000000',
			WATCHDOG_PID: '4242',
			OTHER: 'kept',
		};
		setup(env);
		expect(env).toEqual({ OTHER: 'kept' });
	});

	it('pings the watchdog at WATCHDOG_USEC/2, starting at READY', async () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '30000000' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(0); // no READY yet, no watchdog yet
		health.markRunning();
		await flush();
		await vi.advanceTimersByTimeAsync(14_999);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(3);
	});

	it('does not ping while the event loop is saturated, and resumes when it recovers', async () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000' });
		health.markRunning();
		await flush();
		delay = { p50: 1500, p99: 3000, max: 4000, mean: 1600, windowMs: 30_000 };
		await vi.advanceTimersByTimeAsync(5_000);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(0);
		delay = { p50: 1, p99: 2, max: 3, mean: 1, windowMs: 30_000 };
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(1);
	});

	it('never pings again once the lock is lost', async () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000' });
		health.markRunning();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(1);
		health.markLockLost();
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(1);
		expect(sent(calls)).toContain(
			'STATUS=Stopped dispatching: another Cue engine took over the lock'
		);
	});

	it('arms no watchdog for another pid or without WATCHDOG_USEC', async () => {
		for (const env of [
			{ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000', WATCHDOG_PID: '1' },
			{ NOTIFY_SOCKET: '/run/n' },
		]) {
			const { calls, health, notifier } = setup(env);
			expect(notifier!.watchdogIntervalMs).toBeNull();
			health.markRunning();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(sent(calls).filter((a) => a === 'WATCHDOG=1')).toHaveLength(0);
		}
	});

	it('skips a ping while a previous systemd-notify is still running', async () => {
		const { calls, health } = setup(
			{ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000' },
			{ autoExit: null }
		);
		health.markRunning(); // READY never exits
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls).toHaveLength(1);
		calls[0].child.emit('exit', 0, null);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(2);
		expect(calls[1].args).toEqual(['WATCHDOG=1']);
	});

	it('sends STOPPING at the drain, a STATUS per drain phase, and keeps the watchdog going', async () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000' });
		health.markRunning();
		await flush();
		health.markDraining();
		await flush();
		health.noteDrainPhase('disarmed', 'stopped 2 trigger source(s)');
		await flush();
		health.noteDrainPhase('finished', '1 run(s) finished, 0 stopped');
		await flush();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sent(calls)).toEqual([
			expect.stringMatching(/^READY=1/),
			'STOPPING=1 STATUS=Draining',
			'STATUS=Draining: stopped 2 trigger source(s)',
			'STATUS=Draining: 1 run(s) finished, 0 stopped',
			'WATCHDOG=1',
		]);
	});

	it('coalesces STATUS updates waiting behind a slow child', () => {
		const { calls, health } = setup({ NOTIFY_SOCKET: '/run/n' }, { autoExit: null });
		health.markRunning();
		health.markDraining();
		health.noteDrainPhase('waiting', 'a');
		health.noteDrainPhase('stopping', 'b');
		health.noteDrainPhase('persisted', 'c');
		const exitNext = () => calls[calls.length - 1].child.emit('exit', 0, null);
		exitNext();
		exitNext();
		exitNext();
		expect(sent(calls)).toEqual([
			expect.stringMatching(/^READY=1/),
			'STOPPING=1 STATUS=Draining',
			'STATUS=Draining: c',
		]);
	});

	it('warns once and stops for good when systemd-notify is missing', async () => {
		const enoent = Object.assign(new Error('spawn systemd-notify ENOENT'), { code: 'ENOENT' });
		const { calls, health } = setup(
			{ NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000' },
			{ error: enoent }
		);
		health.markRunning();
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		health.markDraining();
		expect(calls).toHaveLength(1);
		expect(onLog).toHaveBeenCalledTimes(1);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('not found'));
	});

	it('warns once per failing streak and once on recovery', async () => {
		let code = 1;
		const calls: FakeCall[] = [];
		const spawnImpl: SystemdNotifySpawn = (_c, args, options) => {
			const child = new EventEmitter() as ChildProcess & EventEmitter;
			calls.push({ args, options, child });
			const exitCode = code;
			queueMicrotask(() => child.emit('exit', exitCode, null));
			return child;
		};
		const health = makeHealth();
		createSystemdNotifier({
			env: { NOTIFY_SOCKET: '/run/n', WATCHDOG_USEC: '2000000' },
			health,
			onLog,
			spawnImpl,
		})!.start();
		health.markRunning();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls.length).toBeGreaterThan(3);
		expect(onLog.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(1);
		code = 0;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(onLog).toHaveBeenLastCalledWith('info', expect.stringContaining('works again'));
		expect(onLog.mock.calls.filter((c) => c[0] === 'warn')).toHaveLength(1);
	});

	it('flush waits for queued messages, and gives up after its timeout', async () => {
		const { calls, health, notifier } = setup({ NOTIFY_SOCKET: '/run/n' }, { autoExit: null });
		health.markRunning();
		health.markDraining();
		let flushed = false;
		void notifier!.flush(10_000).then(() => {
			flushed = true;
		});
		calls[0].child.emit('exit', 0, null);
		await flush();
		expect(flushed).toBe(false); // STOPPING still in flight
		calls[1].child.emit('exit', 0, null);
		await flush();
		expect(flushed).toBe(true);

		health.noteDrainPhase('finished', 'x');
		let gaveUp = false;
		void notifier!.flush(1_000).then(() => {
			gaveUp = true;
		});
		await vi.advanceTimersByTimeAsync(1_000);
		expect(gaveUp).toBe(true);
	});

	it('stop() ends the watchdog and sends nothing more', async () => {
		const { calls, health, notifier } = setup({
			NOTIFY_SOCKET: '/run/n',
			WATCHDOG_USEC: '2000000',
		});
		health.markRunning();
		await flush();
		notifier!.stop();
		health.markDraining();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls).toHaveLength(1);
	});
});
