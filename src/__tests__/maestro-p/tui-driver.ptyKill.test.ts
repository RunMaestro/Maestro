/**
 * @file tui-driver.ptyKill.test.ts
 * @description Windows regression for how TuiDriver tears down its PTY.
 *
 * node-pty's Windows backend throws `Signals not supported on windows.` for any
 * signal argument, and it throws from a DEFERRED that is flushed later on a
 * socket `data` event - so the throw lands on an unrelated stack and the
 * try/catch wrapped around the call site does not contain it. In maestro-p that
 * escapes as an uncaught exception and the CLI dies with a non-zero exit code,
 * which is what `--status` reports back to Maestro.
 *
 * Same defect that produced 822 fatal events from a single Windows install in
 * the desktop process manager (Sentry MAESTRO-XZ); this is the maestro-p half.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number; signal?: number }) => void;

const dataListeners: DataListener[] = [];
const exitListeners: ExitListener[] = [];

const mockIsWindows = vi.fn(() => true);

/**
 * A node-pty `IPty` reproducing the two Windows behaviours that matter here:
 *
 *  1. Any signal argument throws `Signals not supported on windows.`
 *  2. The call is QUEUED as a deferred until the ConPTY agent reports ready,
 *     and the queue is flushed later from a socket `data` handler.
 *
 * (2) is what makes the call site's try/catch decorative, so a fake that threw
 * synchronously would let the bug pass. `flushDeferreds()` stands in for the
 * socket event.
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
	onData = vi.fn((listener: DataListener) => {
		dataListeners.push(listener);
		return { dispose: vi.fn() };
	});
	onExit = vi.fn((listener: ExitListener) => {
		exitListeners.push(listener);
		return { dispose: vi.fn() };
	});
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

let fakePty: FakeWindowsPty;

vi.mock('node-pty', () => ({
	spawn: () => fakePty,
}));

vi.mock('../../shared/platformDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../shared/platformDetection')>()),
	isWindows: () => mockIsWindows(),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { QUIT_GRACE_MS, TuiDriver } from '../../maestro-p/tui-driver';

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeDriver(): Promise<TuiDriver> {
	const driver = new TuiDriver({
		binPath: 'claude',
		args: [],
		cwd: '/tmp',
		env: {},
	});
	await driver.start();
	return driver;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TuiDriver PTY teardown on Windows', () => {
	beforeEach(() => {
		dataListeners.length = 0;
		exitListeners.length = 0;
		fakePty = new FakeWindowsPty();
		mockIsWindows.mockReturnValue(true);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('kill() hands node-pty no signal on Windows', async () => {
		const driver = await makeDriver();

		driver.kill();

		expect(fakePty.kill).toHaveBeenCalledWith(undefined);
		expect(fakePty.kill).not.toHaveBeenCalledWith('SIGKILL');
	});

	it('kill() survives the deferred flush - the throw never reaches an unrelated stack', async () => {
		const driver = await makeDriver();

		driver.kill();

		// The ConPTY agent becomes ready and node-pty drains its queue. With a
		// signal in that queue this is where the uncaught exception is born.
		expect(() => fakePty.flushDeferreds()).not.toThrow();
	});

	it("quit()'s grace-timer escalation hands node-pty no signal on Windows", async () => {
		const driver = await makeDriver();

		const promise = driver.quit();
		expect(fakePty.write).toHaveBeenCalledWith('/quit\r');

		// The TUI ignores /quit, so the grace timer escalates. This is the
		// `maestro-p --status` path.
		await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS);
		await promise;

		expect(fakePty.kill).toHaveBeenCalledWith(undefined);
		expect(fakePty.kill).not.toHaveBeenCalledWith('SIGTERM');
		expect(() => fakePty.flushDeferreds()).not.toThrow();
	});

	it('still passes the signal through on POSIX', async () => {
		mockIsWindows.mockReturnValue(false);
		const driver = await makeDriver();

		driver.kill();

		expect(fakePty.kill).toHaveBeenCalledWith('SIGKILL');
	});
});
