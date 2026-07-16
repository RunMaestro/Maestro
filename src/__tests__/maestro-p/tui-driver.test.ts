/**
 * @file tui-driver.test.ts
 * @description Tests for src/maestro-p/tui-driver.ts - the slim PTY driver
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

import {
	QUIT_GRACE_MS,
	READY_MAX_TAPS,
	READY_TAP_INTERVAL_MS,
	READY_TIMEOUT_MS,
	SEND_ENTER_DELAY_MS,
	SUBMIT_ENTER_RETRIES,
	SUBMIT_ENTER_RETRY_INTERVAL_MS,
	TuiDriver,
} from '../../maestro-p/tui-driver';

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
			// Real captures arrive with \r prepended by the PTY before the indicator -
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

	describe("'trust-accepted' event (b')", () => {
		it('auto-sends Enter and emits trust-accepted when the trust prompt arrives', async () => {
			const driver = await makeDriver();
			const trustHandler = vi.fn();
			driver.on('trust-accepted', trustHandler);
			// Claude TUI v2.1.143+ trust prompt - the ANSI-stripped form
			// collapses cursor-positioning whitespace, so the highlighted
			// option appears as `❯1.Yes,Itrustthisfolder` with no space.
			feed(
				'Accessingworkspace:\n\nQuicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?\n\n❯1.Yes,Itrustthisfolder\n2.No,exit\n'
			);
			expect(trustHandler).toHaveBeenCalledTimes(1);
			expect(mockPtyProcess.write).toHaveBeenCalledWith('\r');
		});

		it('matches the trust prompt even with the raw (un-collapsed) wording', async () => {
			const driver = await makeDriver();
			const trustHandler = vi.fn();
			driver.on('trust-accepted', trustHandler);
			feed('Yes, I trust this folder\n');
			expect(trustHandler).toHaveBeenCalledTimes(1);
			expect(mockPtyProcess.write).toHaveBeenCalledWith('\r');
		});

		it('fires at most once even if the trust line redraws', async () => {
			const driver = await makeDriver();
			const trustHandler = vi.fn();
			driver.on('trust-accepted', trustHandler);
			feed('❯1.Yes,Itrustthisfolder\n');
			feed('❯1.Yes,Itrustthisfolder\n');
			expect(trustHandler).toHaveBeenCalledTimes(1);
			// Only one Enter written, even with the redraw.
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
		});

		it('does NOT fire on unrelated lines that mention "trust" in passing', async () => {
			const driver = await makeDriver();
			const trustHandler = vi.fn();
			driver.on('trust-accepted', trustHandler);
			feed('Building trust between modules...\n');
			feed('I trust the linter to catch this.\n');
			expect(trustHandler).not.toHaveBeenCalled();
		});

		it('does NOT block the ready handshake - both can fire from one feed', async () => {
			const driver = await makeDriver();
			const trustHandler = vi.fn();
			const readyHandler = vi.fn();
			driver.on('trust-accepted', trustHandler);
			driver.on('ready', readyHandler);
			// Trust prompt followed (in the same rolling buffer window) by
			// the real input indicator. Real captures often coalesce many
			// redraws across short windows, so both regexes should match.
			feed('❯1.Yes,Itrustthisfolder\n');
			feed('\r❯ Try "edit <filepath>"\n');
			expect(trustHandler).toHaveBeenCalledTimes(1);
			expect(readyHandler).toHaveBeenCalledTimes(1);
		});
	});

	describe("'bypass-accepted' event (--dangerously-skip-permissions gate)", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('selects "Yes, I accept" (Down then Enter) instead of the "No, exit" default', async () => {
			const driver = await makeDriver();
			const bypassHandler = vi.fn();
			driver.on('bypass-accepted', bypassHandler);
			// ANSI-stripped bypass dialog. Default highlight is `❯ 1. No, exit`.
			feed('WARNING:ClaudeCoderunninginBypassPermissionsmode\n\n❯1.No,exit\n2.Yes,Iaccept\n');
			// Down arrow goes out immediately to move off the "No, exit" default.
			expect(mockPtyProcess.write).toHaveBeenCalledWith('\x1b[B');
			expect(bypassHandler).toHaveBeenCalledTimes(1);
			// The confirming Enter is split from the Down keystroke by SEND_ENTER_DELAY_MS.
			expect(mockPtyProcess.write).not.toHaveBeenCalledWith('\r');
			vi.advanceTimersByTime(SEND_ENTER_DELAY_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledWith('\r');
		});

		it("does NOT prematurely fire ready on the dialog's own ❯ selector glyph", async () => {
			const driver = await makeDriver();
			const readyHandler = vi.fn();
			driver.on('ready', readyHandler);
			// The dialog renders `❯ 1. No, exit`, whose `❯ ` would satisfy
			// READY_REGEX; the handler clears the rolling buffer so it can't.
			feed('Bypass Permissions mode\n❯ 1. No, exit\n2. Yes, I accept\n');
			expect(readyHandler).not.toHaveBeenCalled();
			// Real editor prompt re-paints after acceptance -> ready fires now.
			feed('\r❯ Try "edit <filepath>"\n');
			expect(readyHandler).toHaveBeenCalledTimes(1);
		});

		it('fires at most once even if the dialog redraws', async () => {
			const driver = await makeDriver();
			const bypassHandler = vi.fn();
			driver.on('bypass-accepted', bypassHandler);
			feed('❯1.No,exit\n2.Yes,Iaccept\n');
			feed('❯1.No,exit\n2.Yes,Iaccept\n');
			expect(bypassHandler).toHaveBeenCalledTimes(1);
			// Exactly one Down written despite the redraw.
			expect(mockPtyProcess.write.mock.calls.filter((c) => c[0] === '\x1b[B')).toHaveLength(1);
		});

		it('does NOT fire on unrelated lines mentioning permissions in passing', async () => {
			const driver = await makeDriver();
			const bypassHandler = vi.fn();
			driver.on('bypass-accepted', bypassHandler);
			feed('Checking file permissions...\n');
			feed('Accepted the changes.\n');
			expect(bypassHandler).not.toHaveBeenCalled();
		});
	});

	describe('blind-tap fallback + ready-timeout (g)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('sends Enter every READY_TAP_INTERVAL_MS until ready fires or budget is exhausted', async () => {
			await makeDriver();
			expect(mockPtyProcess.write).not.toHaveBeenCalled();
			// First tap at +1500ms.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			expect(mockPtyProcess.write).toHaveBeenLastCalledWith('\r');
			// Second tap at +3000ms.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(2);
			// Third (and final) tap at +4500ms.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(READY_MAX_TAPS);
			// Budget exhausted - no further taps even though ready never matched.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS * 5);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(READY_MAX_TAPS);
		});

		it('stops tapping the instant READY_REGEX matches', async () => {
			const driver = await makeDriver();
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			// Real input prompt arrives between tap 1 and tap 2.
			feed('\r❯ Try "edit <filepath>"\n');
			// No more taps even though we advance far past the next interval.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS * 5);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			expect(driver).toBeDefined();
		});

		it('counts the trust-regex fast-path Enter toward the tap budget', async () => {
			await makeDriver();
			// Trust prompt arrives immediately - fast-path writes Enter (tap 1/3).
			feed('❯1.Yes,Itrustthisfolder\n');
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			// Interval still has 2 taps remaining if ready still doesn't match.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(3);
			// Total budget exhausted.
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS * 5);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(READY_MAX_TAPS);
		});

		it("emits 'ready-timeout' after READY_TIMEOUT_MS if ready never matches", async () => {
			const driver = await makeDriver();
			const timeoutHandler = vi.fn();
			driver.on('ready-timeout', timeoutHandler);
			await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - 1);
			expect(timeoutHandler).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(timeoutHandler).toHaveBeenCalledTimes(1);
		});

		it("does NOT emit 'ready-timeout' if ready fires first", async () => {
			const driver = await makeDriver();
			const timeoutHandler = vi.fn();
			driver.on('ready-timeout', timeoutHandler);
			feed('\r❯ Try\n');
			await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2);
			expect(timeoutHandler).not.toHaveBeenCalled();
		});

		it("does NOT emit 'ready-timeout' if the PTY exits first", async () => {
			const driver = await makeDriver();
			const timeoutHandler = vi.fn();
			driver.on('ready-timeout', timeoutHandler);
			triggerExit(0);
			await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2);
			expect(timeoutHandler).not.toHaveBeenCalled();
		});

		it('stops the tap interval on exit so no Enters leak past PTY teardown', async () => {
			await makeDriver();
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			triggerExit(0);
			await vi.advanceTimersByTimeAsync(READY_TAP_INTERVAL_MS * 5);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
		});

		it('keeps the tap window inside the ready-timeout (all taps fire before timeout)', async () => {
			// Documents the timing contract: by the time 'ready-timeout' fires,
			// the runner knows every blind tap got its chance.
			expect(READY_MAX_TAPS * READY_TAP_INTERVAL_MS).toBeLessThan(READY_TIMEOUT_MS);
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

		// Real Max-plan banners Claude actually paints. The match is ANCHORED to
		// these literal wordings on purpose (see LIMIT_REGEX comment): the regex
		// runs against every line of rendered TUI output, so it must catch the
		// genuine banner without matching the assistant's own prose.
		it.each([
			'5-hour limit reached',
			'Your 5-hour limit exceeded for this account.',
			'weekly limit reached',
			'weekly limit exceeded',
			'Claude Opus weekly limit reached',
			'Claude AI usage limit reached|1781551200',
			'Claude usage limit reached',
		])('fires on a real plan-quota banner: %s', async (msg) => {
			const driver = await makeDriver();
			const limitHandler = vi.fn();
			driver.on('limit-hit', limitHandler);
			feed(`${msg}\n`);
			expect(limitHandler).toHaveBeenCalledTimes(1);
		});

		// CRITICAL false-positive guard. The agent's own conversational text and
		// tool output stream through the SAME line scanner. A broad "limit +
		// reached/hit/exceeded" match silently aborts a good turn and swaps it for
		// an API replay (the user sees a no-response "dead in the water" turn).
		// This is exactly what regressed when an agent deployed Maestro's own
		// token-mode feature copy. None of these benign lines may fire limit-hit.
		it.each([
			// Assistant prose that merely DISCUSSES limits.
			'we hit the limit of 4 feature cards, so I trimmed the list',
			'When your usage limit is reached, Maestro falls back to API.',
			'Done. The chat interface limit was reached for free-tier users.',
			'the message "usage limit reached" appears in the feature box',
			"You've reached your usage limit",
			// Quota/credit prose that isn't Claude's banner.
			'Your quota has been exceeded',
			'You are out of credits',
			'Monthly limit reached',
			// Non-quota resource limits: switching the token source wouldn't help.
			'Maximum token limit reached. Start a new session.',
			'Context limit exceeded. Start a new session.',
			'Rate limit exceeded. Please wait.',
			'Limit reached on disk usage',
			// Capacity warnings (no reached/exceeded word in the banner form).
			'Approaching your weekly limit',
			'Upgrade to raise your usage limit',
		])('does not fire on benign line: %s', async (msg) => {
			const driver = await makeDriver();
			const limitHandler = vi.fn();
			driver.on('limit-hit', limitHandler);
			feed(`${msg}\n`);
			expect(limitHandler).not.toHaveBeenCalled();
		});
	});

	describe('send()', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('writes text first, then \\r at SEND_ENTER_DELAY_MS, then retry taps', async () => {
			const driver = await makeDriver();
			// Reach 'ready' first so the blind-tap ready loop is cleared; otherwise
			// advancing fake time past READY_TAP_INTERVAL_MS below would inject
			// unrelated taps and pollute the write count. Feeding the ❯ indicator
			// emits ready without writing.
			feed('❯ \n');
			mockPtyProcess.write.mockClear();
			driver.send('hello world');
			// First write is the text body alone - no trailing \r, because
			// claude's TUI swallows a same-chunk \r as a literal newline in its
			// multi-line input editor and the prompt sits unsubmitted.
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			expect(mockPtyProcess.write).toHaveBeenNthCalledWith(1, 'hello world');
			// First Enter arrives as a separate write after the delay.
			vi.advanceTimersByTime(SEND_ENTER_DELAY_MS);
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(2);
			expect(mockPtyProcess.write).toHaveBeenNthCalledWith(2, '\r');
			// A single Enter is unreliable on a cold TUI (the input editor may not
			// accept a submit yet), so send() re-taps Enter SUBMIT_ENTER_RETRIES
			// more times at SUBMIT_ENTER_RETRY_INTERVAL_MS spacing. After all
			// retries fire, total writes = 1 (text) + 1 (first Enter) + retries.
			for (let i = 0; i < SUBMIT_ENTER_RETRIES; i += 1) {
				vi.advanceTimersByTime(SUBMIT_ENTER_RETRY_INTERVAL_MS);
			}
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(2 + SUBMIT_ENTER_RETRIES);
			// Every retry write is a bare carriage return.
			for (let n = 3; n <= 2 + SUBMIT_ENTER_RETRIES; n += 1) {
				expect(mockPtyProcess.write).toHaveBeenNthCalledWith(n, '\r');
			}
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
			vi.advanceTimersByTime(SEND_ENTER_DELAY_MS);
			expect(mockPtyProcess.write).not.toHaveBeenCalled();
		});

		it('skips the trailing \\r if exit fires between writes', async () => {
			const driver = await makeDriver();
			mockPtyProcess.write.mockClear();
			driver.send('hello');
			// Text write already happened; PTY dies before the deferred Enter.
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			triggerExit(1);
			vi.advanceTimersByTime(SEND_ENTER_DELAY_MS);
			// No second write - we'd otherwise be writing to a dead PTY.
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
		});
	});

	describe('resubmit()', () => {
		it('writes a bare \\r so a parked prompt gets re-submitted', async () => {
			const driver = await makeDriver();
			feed('❯ \n');
			mockPtyProcess.write.mockClear();
			driver.resubmit();
			expect(mockPtyProcess.write).toHaveBeenCalledTimes(1);
			expect(mockPtyProcess.write).toHaveBeenCalledWith('\r');
		});

		it('never re-types the prompt body (avoids a double prompt)', async () => {
			const driver = await makeDriver();
			feed('❯ \n');
			mockPtyProcess.write.mockClear();
			driver.resubmit();
			driver.resubmit();
			// Every write is a bare carriage return, never any text.
			for (const call of mockPtyProcess.write.mock.calls) {
				expect(call[0]).toBe('\r');
			}
		});

		it('is a no-op before start() and after exit', async () => {
			const notStarted = new TuiDriver({ binPath: 'claude', args: [], cwd: '/tmp', env: {} });
			expect(() => notStarted.resubmit()).not.toThrow();

			const driver = await makeDriver();
			triggerExit(0);
			mockPtyProcess.write.mockClear();
			driver.resubmit();
			expect(mockPtyProcess.write).not.toHaveBeenCalled();
		});
	});

	describe('getScreenTail()', () => {
		it('returns the ANSI-stripped rolling buffer, capped to maxBytes', async () => {
			const driver = await makeDriver();
			feed('\x1b[1mhello\x1b[0m world');
			// ANSI escapes are stripped before buffering.
			expect(driver.getScreenTail()).toBe('hello world');
			// Cap keeps only the trailing bytes.
			expect(driver.getScreenTail(5)).toBe('world');
		});

		it('returns empty string before any data', async () => {
			const driver = await makeDriver();
			expect(driver.getScreenTail()).toBe('');
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
