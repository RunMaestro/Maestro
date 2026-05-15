/**
 * @file tui-driver.test.ts
 * @description Tests for the maestro-p TUI driver in isolation, with node-pty
 *              mocked so we can feed synthetic PTY data and exit events into
 *              the driver and assert the lifecycle events it emits.
 *
 * The driver was simplified after run mode switched to jsonl-tail: spinner
 * tracking and the spinner-stop/ready completion transition are gone, since
 * run-mode completion is now driven by `stop_reason: end_turn` in the
 * session jsonl, not the screen. What remains:
 *   (a) non-spinner lines emit `line` events with ANSI stripped
 *   (b) `ready` fires once when the input prompt indicator first appears
 *   (c) a limit-hit line emits `limit-hit`
 *   (d) `quit()` writes `/quit\r`, resolves on `'exit'` within 2s, otherwise
 *       falls through to SIGTERM
 *   (e) `kill()` sends SIGKILL immediately
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockPtySpawn } = vi.hoisted(() => ({
	mockPtySpawn: vi.fn(),
}));

vi.mock('node-pty', () => ({
	spawn: mockPtySpawn,
}));

import { TuiDriver } from '../../maestro-p/tui-driver';

// Minimal fake of node-pty's IPty surface — only the methods TuiDriver touches
// (onData, onExit, write, kill). emitData / emitExit are test-only seams that
// route through whichever callback the driver registered during start().
interface FakePty {
	emitData(chunk: string): void;
	emitExit(exitCode: number): void;
	writes: string[];
	killSignals: string[];
	onData(cb: (data: string) => void): void;
	onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
	write(text: string): void;
	kill(signal?: string): void;
}

function createFakePty(): FakePty {
	const writes: string[] = [];
	const killSignals: string[] = [];
	let dataCallback: ((data: string) => void) | null = null;
	let exitCallback: ((event: { exitCode: number; signal?: number }) => void) | null = null;

	return {
		writes,
		killSignals,
		onData(cb) {
			dataCallback = cb;
		},
		onExit(cb) {
			exitCallback = cb;
		},
		write(text) {
			writes.push(text);
		},
		kill(signal = 'SIGTERM') {
			killSignals.push(signal);
		},
		emitData(chunk) {
			dataCallback?.(chunk);
		},
		emitExit(exitCode) {
			exitCallback?.({ exitCode });
		},
	};
}

async function newDriver(): Promise<{ driver: TuiDriver; pty: FakePty }> {
	const pty = createFakePty();
	mockPtySpawn.mockReturnValue(pty);
	const driver = new TuiDriver({
		binPath: 'claude',
		args: [],
		cwd: '/tmp',
		env: {},
	});
	await driver.start();
	return { driver, pty };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('TuiDriver — line events', () => {
	it('emits `line` for non-spinner lines, ANSI-stripped', async () => {
		const { driver, pty } = await newDriver();
		const lines: string[] = [];
		driver.on('line', (line: string) => lines.push(line));

		pty.emitData('\x1b[31mhello\x1b[0m\n\x1b[32mworld\x1b[0m\n');

		expect(lines).toEqual(['hello', 'world']);
	});

	it('does not emit a trailing partial line until a newline arrives', async () => {
		const { driver, pty } = await newDriver();
		const lines: string[] = [];
		driver.on('line', (line: string) => lines.push(line));

		pty.emitData('partial');
		expect(lines).toEqual([]);

		pty.emitData(' line\n');
		expect(lines).toEqual(['partial line']);
	});

	it('strips a trailing \\r from \\r\\n line endings', async () => {
		const { driver, pty } = await newDriver();
		const lines: string[] = [];
		driver.on('line', (line: string) => lines.push(line));

		pty.emitData('hello\r\nworld\r\n');
		expect(lines).toEqual(['hello', 'world']);
	});
});

describe('TuiDriver — ready', () => {
	it('emits `ready` exactly once when the input prompt indicator (›) first appears', async () => {
		const { driver, pty } = await newDriver();
		const events: string[] = [];
		driver.on('ready', () => events.push('ready'));

		pty.emitData('Welcome banner\n› \n');
		expect(events).toEqual(['ready']);

		// Subsequent prompt-indicator lines must not re-fire ready.
		pty.emitData('› \n› \n');
		expect(events).toEqual(['ready']);
	});

	it('emits `ready` for the real claude 2.1.141 ❯ prompt indicator (U+276F)', async () => {
		// Regression guard: real claude (captured from .claude-gmail and
		// .claude-smash) uses ❯ (U+276F), not the original playbook's
		// › (U+203A). PROMPT_INDICATOR_PATTERN must match either.
		const { driver, pty } = await newDriver();
		const events: string[] = [];
		driver.on('ready', () => events.push('ready'));

		pty.emitData('Welcome banner\n❯ \n');
		expect(events).toEqual(['ready']);
	});

	it('does not emit `ready` until the prompt indicator has been seen', async () => {
		const { driver, pty } = await newDriver();
		const events: string[] = [];
		driver.on('ready', () => events.push('ready'));

		pty.emitData('banner\nmore banner\n');
		expect(events).toEqual([]);
	});
});

describe('TuiDriver — limit-hit', () => {
	it('emits `limit-hit` for a 5-hour limit message', async () => {
		const { driver, pty } = await newDriver();
		const hits: string[] = [];
		driver.on('limit-hit', (line: string) => hits.push(line));

		pty.emitData('Your 5-hour limit reached. Try again later.\n');

		expect(hits).toEqual(['Your 5-hour limit reached. Try again later.']);
	});

	it('emits `limit-hit` for a weekly limit message', async () => {
		const { driver, pty } = await newDriver();
		const hits: string[] = [];
		driver.on('limit-hit', (line: string) => hits.push(line));

		pty.emitData('Weekly limit exceeded.\n');

		expect(hits).toEqual(['Weekly limit exceeded.']);
	});

	it('matches the limit pattern case-insensitively', async () => {
		const { driver, pty } = await newDriver();
		const hits: string[] = [];
		driver.on('limit-hit', (line: string) => hits.push(line));

		pty.emitData('5-HOUR LIMIT REACHED for this account.\n');

		expect(hits).toEqual(['5-HOUR LIMIT REACHED for this account.']);
	});
});

describe('TuiDriver — quit()', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes /quit\\r and resolves when `exit` fires within the 2s grace window', async () => {
		const { driver, pty } = await newDriver();
		const quitPromise = driver.quit();

		expect(pty.writes).toEqual(['/quit\r']);

		// Clean exit before the grace window elapses.
		pty.emitExit(0);

		await expect(quitPromise).resolves.toBeUndefined();
		expect(pty.killSignals).toEqual([]);
	});

	it('falls through to SIGTERM after 2s when no `exit` arrives', async () => {
		const { driver, pty } = await newDriver();
		const quitPromise = driver.quit();

		expect(pty.writes).toEqual(['/quit\r']);
		expect(pty.killSignals).toEqual([]);

		vi.advanceTimersByTime(2000);

		await expect(quitPromise).resolves.toBeUndefined();
		expect(pty.killSignals).toEqual(['SIGTERM']);
	});
});

describe('TuiDriver — kill()', () => {
	it('sends SIGKILL immediately', async () => {
		const { driver, pty } = await newDriver();

		driver.kill();

		expect(pty.killSignals).toEqual(['SIGKILL']);
	});

	it('is a no-op when the process has already exited', async () => {
		const { driver, pty } = await newDriver();
		pty.emitExit(0);

		driver.kill();

		expect(pty.killSignals).toEqual([]);
	});
});
