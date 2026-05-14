/**
 * @file tui-driver.test.ts
 * @description Tests for the maestro-p TUI driver in isolation, with node-pty
 *              mocked so we can feed synthetic PTY data and exit events into
 *              the driver and assert the lifecycle events it emits.
 *
 * Covers the cases listed in the phase 1 playbook:
 *   (a) non-spinner lines emit `line` events with ANSI stripped
 *   (b) lines matching the spinner pattern emit `spinner-start` exactly once
 *       per cycle and are NOT re-emitted as `line`
 *   (c) after 800ms of no spinner pattern AND the prompt indicator is visible,
 *       `spinner-stop` then `ready` fire in order
 *   (d) a limit-hit line emits `limit-hit`
 *   (e) `quit()` writes `/quit\r`, resolves on `'exit'` within 2s, otherwise
 *       falls through to SIGTERM
 *   (f) `kill()` sends SIGKILL immediately
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

describe('TuiDriver — spinner detection', () => {
	it('emits `spinner-start` exactly once per cycle and suppresses the spinner line', async () => {
		const { driver, pty } = await newDriver();
		let spinnerStartCount = 0;
		const lines: string[] = [];
		driver.on('spinner-start', () => spinnerStartCount++);
		driver.on('line', (line: string) => lines.push(line));

		// Three consecutive spinner ticks (each refreshes the idle timer but
		// must not produce a second spinner-start or any `line` events).
		pty.emitData('Pouncing… (3s · ↑ 100 tokens · esc)\n');
		pty.emitData('Crunching… (5s · ↓ 200 tokens · esc)\n');
		pty.emitData('Pondering… (8s · ↑ 300 tokens · esc)\n');

		expect(spinnerStartCount).toBe(1);
		expect(lines).toEqual([]);
	});

	it('does NOT classify a line as spinner when only the verb is present without the status fragment', async () => {
		// Defensive: the regex anchors on the parenthesized status fragment, not
		// the verb. A bare "Pouncing…" line should flow through as content.
		const { driver, pty } = await newDriver();
		const lines: string[] = [];
		const spinnerStarts: number[] = [];
		driver.on('line', (line: string) => lines.push(line));
		driver.on('spinner-start', () => spinnerStarts.push(1));

		pty.emitData('Pouncing… still warming up\n');

		expect(lines).toEqual(['Pouncing… still warming up']);
		expect(spinnerStarts).toEqual([]);
	});
});

describe('TuiDriver — spinner-stop / ready', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits `spinner-stop` then `ready` after 800ms idle when the prompt indicator is visible', async () => {
		const { driver, pty } = await newDriver();
		const events: string[] = [];
		driver.on('spinner-start', () => events.push('spinner-start'));
		driver.on('spinner-stop', () => events.push('spinner-stop'));
		driver.on('ready', () => events.push('ready'));
		driver.on('line', () => events.push('line'));

		// Generation cycle starts.
		pty.emitData('Pouncing… (3s · ↑ 100 tokens · esc)\n');
		// Response content arrives, then the input prompt indicator returns.
		pty.emitData('Here is your answer.\n› \n');

		// Spinner has fired and prompt is visible, but the 800ms idle window
		// has not elapsed yet — completion transition must NOT fire.
		expect(events).toEqual(['spinner-start', 'line', 'line']);

		vi.advanceTimersByTime(799);
		expect(events).toEqual(['spinner-start', 'line', 'line']);

		// Crossing the 800ms threshold pairs spinner-stop and ready atomically.
		vi.advanceTimersByTime(1);
		expect(events).toEqual(['spinner-start', 'line', 'line', 'spinner-stop', 'ready']);
	});

	it('keeps the 800ms idle timer reset while the spinner is still ticking', async () => {
		const { driver, pty } = await newDriver();
		const completionEvents: string[] = [];
		driver.on('spinner-stop', () => completionEvents.push('spinner-stop'));
		driver.on('ready', () => completionEvents.push('ready'));

		// Spinner active + prompt visible, but spinner refreshes every 400ms so
		// the idle window never elapses.
		pty.emitData('Pouncing… (3s · ↑ 100 tokens · esc)\n');
		pty.emitData('› \n');

		vi.advanceTimersByTime(400);
		pty.emitData('Pouncing… (4s · ↑ 110 tokens · esc)\n');
		vi.advanceTimersByTime(799);

		expect(completionEvents).toEqual([]);

		// One more ms after the second timer scheduled time (400 + 800 = 1200)
		// trips the completion transition.
		vi.advanceTimersByTime(1);
		expect(completionEvents).toEqual(['spinner-stop', 'ready']);
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
