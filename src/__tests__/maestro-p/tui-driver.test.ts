/**
 * @file tui-driver.test.ts
 * @description Tests for src/maestro-p/tui-driver.ts — the slim PTY driver
 * that surfaces 'ready' / 'limit-hit' / 'line' / 'exit' events to maestro-p's
 * run and status flows.
 *
 * node-pty is mocked so tests can synchronously feed data through the
 * captured onData listener and trigger exit through the captured onExit
 * listener, without spawning a real PTY.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────

type DataListener = (data: string) => void;
type ExitListener = (event: { exitCode: number; signal?: number }) => void;

const dataListeners: DataListener[] = [];
const exitListeners: ExitListener[] = [];

const mockPtyProcess = {
	pid: 12345,
	onData: vi.fn((listener: DataListener) => {
		dataListeners.push(listener);
		return {
			dispose: vi.fn(() => {
				const i = dataListeners.indexOf(listener);
				if (i >= 0) dataListeners.splice(i, 1);
			}),
		};
	}),
	onExit: vi.fn((listener: ExitListener) => {
		exitListeners.push(listener);
		return {
			dispose: vi.fn(() => {
				const i = exitListeners.indexOf(listener);
				if (i >= 0) exitListeners.splice(i, 1);
			}),
		};
	}),
	write: vi.fn(),
	kill: vi.fn(),
	resize: vi.fn(),
};

type SpawnOptions = {
	name: string;
	cwd: string;
	cols: number;
	rows: number;
	env: Record<string, string>;
};

const mockSpawn = vi.fn((_file: string, _args: string[], _options: SpawnOptions) => mockPtyProcess);

vi.mock('node-pty', () => ({
	spawn: (file: string, args: string[], options: SpawnOptions) => mockSpawn(file, args, options),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { QUIT_GRACE_MS, TuiDriver } from '../../maestro-p/tui-driver';

// ── Helpers ────────────────────────────────────────────────────────────────

function feed(data: string): void {
	for (const listener of [...dataListeners]) listener(data);
}

function triggerExit(exitCode: number): void {
	for (const listener of [...exitListeners]) listener({ exitCode });
}

async function makeDriver(): Promise<TuiDriver> {
	const driver = new TuiDriver({
		binPath: 'claude',
		args: ['--cwd', '/tmp'],
		cwd: '/tmp',
		env: { HOME: '/home/test' },
	});
	await driver.start();
	return driver;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TuiDriver', () => {
	beforeEach(() => {
		dataListeners.length = 0;
		exitListeners.length = 0;
		mockSpawn.mockClear();
		mockPtyProcess.onData.mockClear();
		mockPtyProcess.onExit.mockClear();
		mockPtyProcess.write.mockClear();
		mockPtyProcess.kill.mockClear();
		mockPtyProcess.resize.mockClear();
	});

	describe('start()', () => {
		it('spawns node-pty with xterm-256color, the provided cwd, and default 200x50 dimensions', async () => {
			await makeDriver();
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			const [file, args, options] = mockSpawn.mock.calls[0] as unknown as [
				string,
				string[],
				{ name: string; cwd: string; cols: number; rows: number; env: Record<string, string> },
			];
			expect(file).toBe('claude');
			expect(args).toEqual(['--cwd', '/tmp']);
			expect(options.name).toBe('xterm-256color');
			expect(options.cwd).toBe('/tmp');
			expect(options.cols).toBe(200);
			expect(options.rows).toBe(50);
			expect(options.env.TERM).toBe('xterm-256color');
			expect(options.env.HOME).toBe('/home/test');
		});

		it('honors cols/rows overrides from constructor options', async () => {
			const driver = new TuiDriver({
				binPath: 'claude',
				args: [],
				cwd: '/tmp',
				env: {},
				cols: 120,
				rows: 40,
			});
			await driver.start();
			const options = mockSpawn.mock.calls[0][2] as { cols: number; rows: number };
			expect(options.cols).toBe(120);
			expect(options.rows).toBe(40);
		});

		it('rejects a second start() call', async () => {
			const driver = await makeDriver();
			await expect(driver.start()).rejects.toThrow(/start\(\) called twice/);
		});
	});

	describe("'line' event (a)", () => {
		it('emits ANSI-stripped completed lines, one per newline', async () => {
			const driver = await makeDriver();
			const lines: string[] = [];
			driver.on('line', (line: unknown) => lines.push(line as string));
			feed('\x1b[31mhello\x1b[0m\nworld\n');
			expect(lines).toEqual(['hello', 'world']);
		});

		it('buffers partial lines across multiple data chunks', async () => {
			const driver = await makeDriver();
			const lines: string[] = [];
			driver.on('line', (line: unknown) => lines.push(line as string));
			feed('hel');
			feed('lo\nwor');
			feed('ld\n');
			expect(lines).toEqual(['hello', 'world']);
		});

		it('does not emit a trailing line until newline arrives', async () => {
			const driver = await makeDriver();
			const lines: string[] = [];
			driver.on('line', (line: unknown) => lines.push(line as string));
			feed('no-newline');
			expect(lines).toEqual([]);
		});

		it('flushes the trailing partial line as a final line on exit', async () => {
			const driver = await makeDriver();
			const lines: string[] = [];
			driver.on('line', (line: unknown) => lines.push(line as string));
			feed('lonely tail');
			triggerExit(0);
			expect(lines).toEqual(['lonely tail']);
		});
	});

	describe("'ready' event (b, d)", () => {
		it('fires exactly once when ❯ first appears, even on subsequent prompt redraws', async () => {
			const driver = await makeDriver();
			const readyHandler = vi.fn();
			driver.on('ready', readyHandler);
			feed('starting up\n');
			expect(readyHandler).not.toHaveBeenCalled();
			feed('❯ \n');
			expect(readyHandler).toHaveBeenCalledTimes(1);
			feed('❯ \n');
			feed('redraw ❯ \n');
			expect(readyHandler).toHaveBeenCalledTimes(1);
		});

		it('matches the alternate `›` indicator', async () => {
			const driver = await makeDriver();
			const readyHandler = vi.fn();
			driver.on('ready', readyHandler);
			feed('› hello\n');
			expect(readyHandler).toHaveBeenCalledTimes(1);
		});

		it('matches the indicator even when the line begins with a \\r cursor return (d)', async () => {
			const driver = await makeDriver();
			const readyHandler = vi.fn();
			driver.on('ready', readyHandler);
			// Real captures arrive with \r prepended by the PTY before the indicator —
			// a ^-anchored regex would miss this. The unanchored regex catches it.
			feed('\r❯ \n');
			expect(readyHandler).toHaveBeenCalledTimes(1);
		});

		it('matches across chunk boundaries via the rolling buffer', async () => {
			const driver = await makeDriver();
			const readyHandler = vi.fn();
			driver.on('ready', readyHandler);
			feed('\r❯');
			expect(readyHandler).not.toHaveBeenCalled();
			feed(' \n');
			expect(readyHandler).toHaveBeenCalledTimes(1);
		});
	});

	describe("'limit-hit' event (c)", () => {
		it('fires on a 5-hour limit message', async () => {
			const driver = await makeDriver();
			const limitHandler = vi.fn();
			driver.on('limit-hit', limitHandler);
			feed('Your 5-hour limit reached. Try again later.\n');
			expect(limitHandler).toHaveBeenCalledTimes(1);
			expect(limitHandler).toHaveBeenCalledWith('Your 5-hour limit reached. Try again later.');
		});

		it('fires on a weekly limit message', async () => {
			const driver = await makeDriver();
			const limitHandler = vi.fn();
			driver.on('limit-hit', limitHandler);
			feed('Weekly limit exceeded for this account.\n');
			expect(limitHandler).toHaveBeenCalledTimes(1);
		});

		it('fires at most once even on repeated occurrences', async () => {
			const driver = await makeDriver();
			const limitHandler = vi.fn();
			driver.on('limit-hit', limitHandler);
			feed('5-hour limit reached\n5-hour limit reached again\n');
			expect(limitHandler).toHaveBeenCalledTimes(1);
		});

		it('does not fire on unrelated lines', async () => {
			const driver = await makeDriver();
			const limitHandler = vi.fn();
			driver.on('limit-hit', limitHandler);
			feed('Reading file... done.\n');
			feed('Limit reached on disk usage\n');
			feed('weekly status report\n');
			expect(limitHandler).not.toHaveBeenCalled();
		});
	});

	describe('send()', () => {
		it('writes text followed by \\r to the PTY', async () => {
			const driver = await makeDriver();
			driver.send('hello world');
			expect(mockPtyProcess.write).toHaveBeenCalledWith('hello world\r');
		});

		it('throws if called before start()', () => {
			const driver = new TuiDriver({ binPath: 'claude', args: [], cwd: '/tmp', env: {} });
			expect(() => driver.send('hello')).toThrow(/before start\(\)/);
		});

		it('becomes a no-op after exit', async () => {
			const driver = await makeDriver();
			triggerExit(0);
			mockPtyProcess.write.mockClear();
			driver.send('ignored');
			expect(mockPtyProcess.write).not.toHaveBeenCalled();
		});
	});

	describe("'exit' event", () => {
		it('emits exit with the PTY exit code', async () => {
			const driver = await makeDriver();
			const exitHandler = vi.fn();
			driver.on('exit', exitHandler);
			triggerExit(42);
			expect(exitHandler).toHaveBeenCalledWith(42);
		});

		it('emits exit at most once even if onExit fires twice', async () => {
			const driver = await makeDriver();
			const exitHandler = vi.fn();
			driver.on('exit', exitHandler);
			triggerExit(0);
			triggerExit(0);
			expect(exitHandler).toHaveBeenCalledTimes(1);
		});
	});

	describe('quit() (e)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('writes /quit\\r and resolves on natural exit within 2s', async () => {
			const driver = await makeDriver();
			const promise = driver.quit();
			expect(mockPtyProcess.write).toHaveBeenCalledWith('/quit\r');
			triggerExit(0);
			await promise;
			expect(mockPtyProcess.kill).not.toHaveBeenCalled();
		});

		it('falls through to SIGTERM after 2s if exit never fires', async () => {
			const driver = await makeDriver();
			const promise = driver.quit();
			expect(mockPtyProcess.write).toHaveBeenCalledWith('/quit\r');
			await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS);
			await promise;
			expect(mockPtyProcess.kill).toHaveBeenCalledWith('SIGTERM');
		});

		it('is a no-op when called before start()', async () => {
			const driver = new TuiDriver({ binPath: 'claude', args: [], cwd: '/tmp', env: {} });
			await driver.quit();
			expect(mockPtyProcess.write).not.toHaveBeenCalled();
			expect(mockPtyProcess.kill).not.toHaveBeenCalled();
		});

		it('is a no-op when called after exit', async () => {
			const driver = await makeDriver();
			triggerExit(0);
			mockPtyProcess.write.mockClear();
			await driver.quit();
			expect(mockPtyProcess.write).not.toHaveBeenCalled();
			expect(mockPtyProcess.kill).not.toHaveBeenCalled();
		});
	});

	describe('kill() (f)', () => {
		it('sends SIGKILL immediately', async () => {
			const driver = await makeDriver();
			driver.kill();
			expect(mockPtyProcess.kill).toHaveBeenCalledWith('SIGKILL');
		});

		it('is a no-op before start()', () => {
			const driver = new TuiDriver({ binPath: 'claude', args: [], cwd: '/tmp', env: {} });
			driver.kill();
			expect(mockPtyProcess.kill).not.toHaveBeenCalled();
		});

		it('is a no-op after exit', async () => {
			const driver = await makeDriver();
			triggerExit(0);
			mockPtyProcess.kill.mockClear();
			driver.kill();
			expect(mockPtyProcess.kill).not.toHaveBeenCalled();
		});
	});
});
