/**
 * The stop ladder's decisions: which signal each stage sends, on which
 * platform, to which kind of process, and when the next stage runs.
 *
 * Everything that would touch a real process is faked here.
 * `termination.process.test.ts` runs the same ladder against real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type * as pty from 'node-pty';

const mocks = vi.hoisted(() => ({
	isWindows: vi.fn(() => false),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
	snapshotProcessTree: vi.fn(),
	killSurvivors: vi.fn(() => 0),
	killProcessTreeNow: vi.fn(),
}));

vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: mocks.isWindows,
}));

vi.mock('child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('child_process')>()),
	execFile: mocks.execFile,
	execFileSync: mocks.execFileSync,
}));

vi.mock('../../../../shared/maestro-lib/control/process-tree', () => ({
	snapshotProcessTree: mocks.snapshotProcessTree,
	killSurvivors: mocks.killSurvivors,
	killProcessTreeNow: mocks.killProcessTreeNow,
}));

import {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
	BACKGROUND_STOP_GRACE_MS,
} from '../../../../shared/maestro-lib/control/termination';

const PID = 4242;
const GRACE_MS = 1000;
const TOOL = { pid: 5000, startedAt: 'Tue Sep 29 10:00:00 2026' };

interface FakeChild extends EventEmitter {
	pid: number | undefined;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill: ReturnType<typeof vi.fn>;
	stdin: {
		destroyed: boolean;
		writableEnded: boolean;
		write: ReturnType<typeof vi.fn>;
	} | null;
}

function fakeChild(overrides: Partial<FakeChild> = {}): FakeChild {
	const child = new EventEmitter() as FakeChild;
	child.pid = PID;
	child.exitCode = null;
	child.signalCode = null;
	child.kill = vi.fn(() => true);
	child.stdin = { destroyed: false, writableEnded: false, write: vi.fn() };
	Object.assign(child, overrides);
	return child;
}

/** Mark the child exited the way Node does, then announce it. */
function exit(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null): void {
	child.exitCode = code;
	child.signalCode = signal;
	child.emit('exit', code, signal);
}

interface FakePty {
	pid: number;
	write: ReturnType<typeof vi.fn>;
	kill: ReturnType<typeof vi.fn>;
	onExit: ReturnType<typeof vi.fn>;
	emitExit: () => void;
	exitListeners: number;
}

function fakePty(): FakePty {
	const listeners = new Set<() => void>();
	const fake: FakePty = {
		pid: PID,
		write: vi.fn(),
		kill: vi.fn(),
		onExit: vi.fn((listener: () => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		}),
		emitExit: () => [...listeners].forEach((listener) => listener()),
		get exitListeners() {
			return listeners.size;
		},
	};
	return fake;
}

const asChild = (child: FakeChild) => child as unknown as ChildProcess;
const asPty = (fake: FakePty) => fake as unknown as pty.IPty;

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.isWindows.mockReturnValue(false);
	mocks.snapshotProcessTree.mockReturnValue({ owned: true, descendants: [] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('grace periods', () => {
	it('keeps the two values the launchers used before they shared a ladder', () => {
		expect(INTERACTIVE_STOP_GRACE_MS).toBe(2000);
		expect(BACKGROUND_STOP_GRACE_MS).toBe(5000);
	});
});

describe('stopProcess on a POSIX pipe child', () => {
	it('walks interrupt, terminate, kill, one grace period apart', () => {
		const child = fakeChild();

		const handle = stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		expect(child.kill.mock.calls).toEqual([['SIGINT']]);
		expect(handle.stage()).toBe('interrupt');

		vi.advanceTimersByTime(GRACE_MS - 1);
		expect(child.kill).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
		expect(handle.stage()).toBe('terminate');

		vi.advanceTimersByTime(GRACE_MS);
		expect(mocks.killProcessTreeNow).toHaveBeenCalledWith(PID, expect.any(Object));
		expect(handle.stage()).toBe('kill');
	});

	it('escalates even though Node marks the child killed as soon as a signal is sent', () => {
		// `child.killed` flips to true on a SENT signal. A ladder that read it as
		// "dead" never escalated past an agent that ignored the interrupt.
		const child = fakeChild();
		child.kill = vi.fn(() => {
			(child as unknown as { killed: boolean }).killed = true;
			return true;
		});

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		vi.advanceTimersByTime(GRACE_MS);

		expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
	});

	it('starts at terminate for a stop that is not a user interrupt', () => {
		const child = fakeChild();

		stopProcess({ child: asChild(child) }, { from: 'terminate', graceMs: GRACE_MS });

		expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
	});

	it('stops escalating once the child exits', () => {
		const child = fakeChild();

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		exit(child, 0);
		vi.advanceTimersByTime(GRACE_MS * 3);

		expect(child.kill.mock.calls).toEqual([['SIGINT']]);
		expect(mocks.killProcessTreeNow).not.toHaveBeenCalled();
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('records the stop before the first signal is sent', () => {
		const order: string[] = [];
		const child = fakeChild();
		child.kill = vi.fn(() => {
			order.push('signal');
			return true;
		});

		stopProcess(
			{ child: asChild(child) },
			{ from: 'interrupt', graceMs: GRACE_MS, onStopRequested: () => order.push('requested') }
		);

		expect(order).toEqual(['requested', 'signal']);
	});

	it('records the stop but sends nothing to a child that has already exited', () => {
		const child = fakeChild({ exitCode: 0 });
		const onStopRequested = vi.fn();

		const handle = stopProcess(
			{ child: asChild(child) },
			{ from: 'interrupt', graceMs: GRACE_MS, onStopRequested }
		);

		expect(onStopRequested).toHaveBeenCalledTimes(1);
		expect(child.kill).not.toHaveBeenCalled();
		expect(mocks.snapshotProcessTree).not.toHaveBeenCalled();
		expect(handle.stage()).toBeUndefined();
	});

	it('kills only through the handle when the pid is not a child of this process', () => {
		// A reused pid, or a pid that was never ours. Its tree is not ours to kill.
		mocks.snapshotProcessTree.mockReturnValue({ owned: false, descendants: [] });
		const child = fakeChild();

		stopProcess({ child: asChild(child) }, { from: 'terminate', graceMs: GRACE_MS });
		vi.advanceTimersByTime(GRACE_MS);

		expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
		expect(mocks.killProcessTreeNow).not.toHaveBeenCalled();
	});

	it('sends nothing more after dispose', () => {
		const child = fakeChild();

		const handle = stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		handle.dispose();
		vi.advanceTimersByTime(GRACE_MS * 3);

		expect(child.kill.mock.calls).toEqual([['SIGINT']]);
		expect(child.listenerCount('exit')).toBe(0);
	});
});

describe('descendants', () => {
	it('are recorded before the first signal', () => {
		const order: string[] = [];
		mocks.snapshotProcessTree.mockImplementation(() => {
			order.push('snapshot');
			return { owned: true, descendants: [TOOL] };
		});
		const child = fakeChild();
		child.kill = vi.fn(() => {
			order.push('signal');
			return true;
		});

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(order).toEqual(['snapshot', 'signal']);
	});

	it('are swept once the process exits', () => {
		mocks.snapshotProcessTree.mockReturnValue({ owned: true, descendants: [TOOL] });
		const child = fakeChild();

		stopProcess(
			{ child: asChild(child) },
			{ from: 'interrupt', graceMs: GRACE_MS, sessionId: 'agent-1' }
		);
		expect(mocks.killSurvivors).not.toHaveBeenCalled();

		exit(child, 0);

		expect(mocks.killSurvivors).toHaveBeenCalledWith([TOOL], {
			sessionId: 'agent-1',
			label: undefined,
		});
	});

	it('are not recorded, swept or tree-killed when the caller opts out', () => {
		const child = fakeChild();

		stopProcess(
			{ child: asChild(child) },
			{ from: 'terminate', graceMs: GRACE_MS, includeDescendants: false }
		);
		vi.advanceTimersByTime(GRACE_MS);
		exit(child, null, 'SIGKILL');

		expect(mocks.snapshotProcessTree).not.toHaveBeenCalled();
		expect(mocks.killProcessTreeNow).not.toHaveBeenCalled();
		expect(mocks.killSurvivors).not.toHaveBeenCalled();
		expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
	});
});

describe('a second stop on the same process', () => {
	it('advances the ladder already running instead of starting another', () => {
		const child = fakeChild();

		const first = stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		const second = stopProcess({ child: asChild(child) }, { from: 'terminate', graceMs: GRACE_MS });

		expect(second).toBe(first);
		expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
		expect(mocks.snapshotProcessTree).toHaveBeenCalledTimes(1);
		expect(child.listenerCount('exit')).toBe(1);

		// One pending escalation, not two.
		vi.advanceTimersByTime(GRACE_MS);
		expect(mocks.killProcessTreeNow).toHaveBeenCalledTimes(1);
	});

	it('does not repeat a stage that has already run', () => {
		const child = fakeChild();

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(child.kill.mock.calls).toEqual([['SIGINT']]);
	});

	it('finishes a pending stop at once when shutdown arrives', () => {
		const child = fakeChild();

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		stopProcess(
			{ child: asChild(child) },
			{ from: 'terminate', graceMs: GRACE_MS, immediate: true }
		);

		expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
		expect(mocks.killProcessTreeNow).toHaveBeenCalledTimes(1);
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('starts over for a process stopped after the last ladder finished', () => {
		const child = fakeChild();
		const first = stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		first.dispose();

		const second = stopProcess({ child: asChild(child) }, { from: 'terminate', graceMs: GRACE_MS });

		expect(second).not.toBe(first);
		expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
	});
});

describe('the shutdown path', () => {
	it('runs every stage at once, with no timer and no listener left behind', () => {
		const child = fakeChild();

		stopProcess(
			{ child: asChild(child) },
			{ from: 'terminate', graceMs: GRACE_MS, immediate: true }
		);

		expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
		expect(mocks.killProcessTreeNow).toHaveBeenCalledTimes(1);
		expect(child.listenerCount('exit')).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('kills a PTY outright without subscribing to its exit', () => {
		const fake = fakePty();

		stopProcess({ pty: asPty(fake) }, { from: 'kill', graceMs: GRACE_MS, immediate: true });

		expect(fake.kill.mock.calls).toEqual([['SIGKILL']]);
		expect(fake.onExit).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('stopProcess on a POSIX PTY', () => {
	it('sends Ctrl+C, then SIGTERM, then SIGKILL', () => {
		const fake = fakePty();

		stopProcess({ pty: asPty(fake) }, { from: 'interrupt', graceMs: GRACE_MS });
		expect(fake.write).toHaveBeenCalledWith('\x03');
		expect(fake.kill).not.toHaveBeenCalled();

		vi.advanceTimersByTime(GRACE_MS);
		expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);

		vi.advanceTimersByTime(GRACE_MS);
		expect(fake.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
		expect(mocks.killProcessTreeNow).toHaveBeenCalledWith(PID, expect.any(Object));
	});

	it('kills only the shell when the tab keeps what it started', () => {
		const fake = fakePty();

		stopProcess(
			{ pty: asPty(fake) },
			{ from: 'terminate', graceMs: GRACE_MS, includeDescendants: false }
		);
		vi.advanceTimersByTime(GRACE_MS);

		expect(fake.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
		expect(mocks.killProcessTreeNow).not.toHaveBeenCalled();
	});

	it('stops escalating once the PTY exits, and drops its subscription', () => {
		const fake = fakePty();

		stopProcess({ pty: asPty(fake) }, { from: 'terminate', graceMs: GRACE_MS });
		expect(fake.exitListeners).toBe(1);

		fake.emitExit();
		vi.advanceTimersByTime(GRACE_MS * 2);

		expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
		expect(fake.exitListeners).toBe(0);
	});

	it('survives a PTY that throws because it is already closed', () => {
		const fake = fakePty();
		fake.write.mockImplementation(() => {
			throw new Error('write after end');
		});

		expect(() =>
			stopProcess({ pty: asPty(fake) }, { from: 'interrupt', graceMs: GRACE_MS })
		).not.toThrow();

		vi.advanceTimersByTime(GRACE_MS);
		expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
	});
});

describe('stopProcess on Windows', () => {
	beforeEach(() => {
		mocks.isWindows.mockReturnValue(true);
		// The real snapshot is empty and unowned on Windows.
		mocks.snapshotProcessTree.mockReturnValue({ owned: false, descendants: [] });
	});

	it('interrupts through stdin, because a signal does not reach a shell-spawned child', () => {
		const child = fakeChild();

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(child.stdin!.write).toHaveBeenCalledWith('\x03');
		expect(child.kill).not.toHaveBeenCalled();
	});

	it('still escalates when stdin is closed and the interrupt could not be sent', () => {
		const child = fakeChild({
			stdin: { destroyed: true, writableEnded: true, write: vi.fn() },
		});

		stopProcess({ child: asChild(child) }, { from: 'interrupt', graceMs: GRACE_MS });
		expect(child.stdin!.write).not.toHaveBeenCalled();

		vi.advanceTimersByTime(GRACE_MS);
		expect(mocks.execFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', String(PID), '/t', '/f'],
			expect.any(Function)
		);
	});

	it('terminates the whole tree with taskkill and has no later stage', () => {
		const child = fakeChild();

		const handle = stopProcess({ child: asChild(child) }, { from: 'terminate', graceMs: GRACE_MS });
		vi.advanceTimersByTime(GRACE_MS * 3);

		expect(mocks.execFile).toHaveBeenCalledTimes(1);
		expect(mocks.execFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', String(PID), '/t', '/f'],
			expect.any(Function)
		);
		expect(child.kill).not.toHaveBeenCalled();
		expect(handle.stage()).toBe('terminate');
	});

	it('waits for taskkill when the host is about to exit', () => {
		const child = fakeChild();

		stopProcess(
			{ child: asChild(child) },
			{ from: 'terminate', graceMs: GRACE_MS, immediate: true, blocking: true }
		);

		expect(mocks.execFileSync).toHaveBeenCalledWith('taskkill', ['/pid', String(PID), '/t', '/f'], {
			timeout: 5000,
		});
		expect(mocks.execFile).not.toHaveBeenCalled();
	});

	it('treats a failed blocking taskkill as a process that was already gone', () => {
		mocks.execFileSync.mockImplementation(() => {
			throw new Error('ERROR: The process "4242" not found.');
		});
		const child = fakeChild();

		expect(() =>
			stopProcess(
				{ child: asChild(child) },
				{ from: 'terminate', graceMs: GRACE_MS, immediate: true, blocking: true }
			)
		).not.toThrow();
	});

	it('uses taskkill for a PTY too, since node-pty ends only the shell', () => {
		const fake = fakePty();

		stopProcess({ pty: asPty(fake) }, { from: 'terminate', graceMs: GRACE_MS });

		expect(mocks.execFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', String(PID), '/t', '/f'],
			expect.any(Function)
		);
		expect(fake.kill).not.toHaveBeenCalled();
	});

	it('never hands node-pty a signal when there is no pid to taskkill', () => {
		// ConPTY reports pid 0 when the shell failed to launch. node-pty throws
		// on any signal argument on Windows, from a stack no caller can catch.
		const fake = fakePty();
		fake.pid = 0;

		stopProcess({ pty: asPty(fake) }, { from: 'terminate', graceMs: GRACE_MS });
		vi.advanceTimersByTime(GRACE_MS);

		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(fake.kill.mock.calls).toEqual([[undefined], [undefined]]);
	});

	it('falls back to the handle for a pipe child with no pid', () => {
		const child = fakeChild({ pid: undefined });

		stopProcess({ child: asChild(child) }, { from: 'terminate', graceMs: GRACE_MS });

		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
	});
});

describe('a target with nothing to stop', () => {
	it('returns an inert handle', () => {
		const handle = stopProcess({}, { from: 'interrupt', graceMs: GRACE_MS });

		expect(handle.stage()).toBeUndefined();
		expect(() => handle.dispose()).not.toThrow();
	});
});
