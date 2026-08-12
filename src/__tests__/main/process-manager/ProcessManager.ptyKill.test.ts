import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPtySpawn, mockChildSpawn, mockExecFile, mockExecFileSync, mockIsWindows } = vi.hoisted(
	() => ({
		mockPtySpawn: vi.fn(),
		mockChildSpawn: vi.fn(),
		mockExecFile: vi.fn(),
		mockExecFileSync: vi.fn(),
		mockIsWindows: vi.fn(() => true),
	})
);

vi.mock('node-pty', () => ({
	spawn: mockPtySpawn,
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const overrides = {
		spawn: mockChildSpawn,
		execFile: mockExecFile,
		execFileSync: mockExecFileSync,
	};
	return {
		...actual,
		...overrides,
		default: { ...actual, ...overrides },
	};
});

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../shared/platformDetection', () => ({
	isWindows: () => mockIsWindows(),
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';

/**
 * A node-pty `IPty` that reproduces the Windows backend's two defining
 * behaviours, because both are load-bearing for this regression:
 *
 *  1. Any signal argument throws `Signals not supported on windows.`
 *  2. The call is QUEUED as a deferred until the ConPTY agent reports ready,
 *     and the queue is later flushed from a socket `data` handler.
 *
 * (2) is why a try/catch at the call site does not contain the throw: it
 * surfaces on an unrelated stack as an uncaught exception. `flushDeferreds()`
 * stands in for that socket event.
 */
class FakeWindowsPty {
	/** ConPTY reports pid 0 when the shell fails to launch - the field case. */
	pid = 0;
	kill = vi.fn((signal?: string) => {
		const run = () => {
			if (signal) throw new Error('Signals not supported on windows.');
		};
		if (this.isReady) {
			run();
			return;
		}
		this.deferreds.push(run);
	});
	onData = vi.fn();
	onExit = vi.fn();
	write = vi.fn();
	resize = vi.fn();

	private isReady = false;
	private deferreds: Array<() => void> = [];

	flushDeferreds(): void {
		this.isReady = true;
		const queued = this.deferreds;
		this.deferreds = [];
		for (const fn of queued) fn();
	}
}

function spawnTerminal(pm: ProcessManager, sessionId: string) {
	return pm.spawn({
		sessionId,
		toolType: 'terminal',
		cwd: '/tmp/project',
		command: 'bash',
		args: [],
	});
}

describe('ProcessManager PTY kill on Windows (MAESTRO-XZ)', () => {
	let fakePty: FakeWindowsPty;

	beforeEach(() => {
		vi.clearAllMocks();
		mockIsWindows.mockReturnValue(true);
		fakePty = new FakeWindowsPty();
		mockPtySpawn.mockReturnValue(fakePty);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('never hands node-pty a signal when the ConPTY pid is unavailable', () => {
		const pm = new ProcessManager();
		spawnTerminal(pm, 'win-no-pid');

		pm.kill('win-no-pid');

		expect(fakePty.kill).toHaveBeenCalledTimes(1);
		// The argument itself is the bug: any truthy signal throws on Windows.
		expect(fakePty.kill).toHaveBeenCalledWith(undefined);
	});

	it('does not raise a deferred exception once the ConPTY agent becomes ready', () => {
		const pm = new ProcessManager();
		spawnTerminal(pm, 'win-deferred');

		pm.kill('win-deferred');

		// Before the fix this threw `Signals not supported on windows.` from the
		// socket data handler, escaping the caller's try/catch as a fatal.
		expect(() => fakePty.flushDeferreds()).not.toThrow();
	});

	it('sends no signal on the shutdown path either', () => {
		const pm = new ProcessManager();
		spawnTerminal(pm, 'win-shutdown');

		pm.killAll({ shutdown: true });

		expect(fakePty.kill).toHaveBeenCalledWith(undefined);
		expect(() => fakePty.flushDeferreds()).not.toThrow();
	});

	it('sends no signal when the SIGTERM escalation timer fires', () => {
		vi.useFakeTimers();
		const pm = new ProcessManager();
		spawnTerminal(pm, 'win-escalation');

		pm.kill('win-escalation');
		vi.advanceTimersByTime(5000);

		expect(fakePty.kill).toHaveBeenCalledTimes(2);
		for (const call of fakePty.kill.mock.calls) {
			expect(call[0]).toBeUndefined();
		}
		expect(() => fakePty.flushDeferreds()).not.toThrow();
	});

	it('still kills the whole tree via taskkill when a real pid is known', () => {
		fakePty.pid = 4242;
		const pm = new ProcessManager();
		spawnTerminal(pm, 'win-with-pid');

		pm.kill('win-with-pid');

		expect(mockExecFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', '4242', '/t', '/f'],
			expect.any(Function)
		);
		expect(fakePty.kill).not.toHaveBeenCalled();
	});

	it('still delivers real POSIX signals off Windows', () => {
		mockIsWindows.mockReturnValue(false);
		const pm = new ProcessManager();
		spawnTerminal(pm, 'posix-kill');

		pm.kill('posix-kill');

		expect(fakePty.kill).toHaveBeenCalledWith('SIGTERM');
	});
});
