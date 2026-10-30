/**
 * @file live.test.ts
 * @description Tests for `maestro-cli live status|on|off|tunnel`, the CLI half of the Left Bar LIVE pill.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import {
	liveOff,
	liveOn,
	liveStatus,
	liveTunnel,
	LIVE_POLL_INTERVAL_MS,
	LIVE_SWITCH_TIMEOUT_MS,
	REMOTE_CONTROL_TIMEOUT_MS,
} from '../../../cli/commands/live';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { LiveCommandResult, LiveModeStatus } from '../../../shared/liveMode';

const URL = 'http://192.168.1.5:9000/token';
const REMOTE_URL = 'https://abc.trycloudflare.com/token';
const OFF: LiveModeStatus = {
	live: false,
	url: null,
	remoteControl: false,
	remoteControlUrl: null,
	revision: 2,
};
const ON: LiveModeStatus = {
	live: true,
	url: URL,
	remoteControl: false,
	remoteControlUrl: null,
	revision: 3,
};
const REMOTE: LiveModeStatus = {
	...ON,
	remoteControl: true,
	remoteControlUrl: REMOTE_URL,
	revision: 4,
};

type Answer = LiveCommandResult | Error;

/**
 * A desktop that answers each `live_command` from `answers` in order (the last
 * one repeats). An Error answer is a failed connect: the old server is gone.
 */
function mockDesktop(answers: Answer[]) {
	const sent: Array<{
		payload: Record<string, unknown>;
		responseType: string;
		timeoutMs?: number;
	}> = [];
	let index = 0;
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn(
				(payload: Record<string, unknown>, responseType: string, timeoutMs?: number) => {
					sent.push({ payload, responseType, ...(timeoutMs ? { timeoutMs } : {}) });
					const answer = answers[Math.min(index, answers.length - 1)];
					index += 1;
					return answer instanceof Error
						? Promise.reject(answer)
						: Promise.resolve({ type: 'live_command_result', ...answer });
				}
			),
		} as never)
	);
	return sent;
}

describe('live command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const lastJson = () => JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
	const printed = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');

	/** Run a verb while the fake clock walks through its polling. */
	async function run(verb: Promise<void>, ms = LIVE_POLL_INTERVAL_MS * 10): Promise<unknown> {
		const settled = verb.then(
			() => undefined,
			(error: unknown) => error
		);
		await vi.advanceTimersByTimeAsync(ms);
		return settled;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`__exit__${code}`);
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('live status', () => {
		it('sends a status live_command and prints the state', async () => {
			const sent = mockDesktop([{ success: true, status: ON }]);

			await liveStatus({});

			expect(sent).toEqual([
				{
					payload: { type: 'live_command', action: 'status' },
					responseType: 'live_command_result',
				},
			]);
			expect(printed()).toContain('Live: on');
			expect(printed()).toContain(`URL: ${URL}`);
			expect(printed()).toContain('Remote Control: off');
		});

		it('prints the status as JSON', async () => {
			mockDesktop([{ success: true, status: REMOTE }]);

			await liveStatus({ json: true });

			expect(lastJson()).toEqual({ success: true, ...REMOTE });
		});

		it('shows the last switch failure', async () => {
			mockDesktop([{ success: true, status: { ...OFF, lastError: 'EADDRINUSE' } }]);

			await liveStatus({});

			expect(printed()).toContain('Last error: EADDRINUSE');
		});

		it('fails with the app error when the app refuses', async () => {
			mockDesktop([{ success: false, error: 'Live mode is not available yet.' }]);

			await expect(liveStatus({})).rejects.toThrow('__exit__1');
			expect(errorSpy).toHaveBeenCalledWith('Error: Live mode is not available yet.');
		});
	});

	describe('live on', () => {
		it('reports "already on" without polling when Live is on', async () => {
			const sent = mockDesktop([{ success: true, changed: false, status: ON }]);

			await liveOn({});

			expect(sent).toHaveLength(1);
			expect(sent[0].payload).toEqual({ type: 'live_command', action: 'on' });
			expect(printed()).toContain('Success: Live mode was already on');
		});

		it('waits through the reconnect until the switch reaches its revision', async () => {
			const sent = mockDesktop([
				{ success: true, changed: true, awaitRevision: 3, status: OFF },
				new Error('connect ECONNREFUSED'),
				{ success: true, status: OFF },
				{ success: true, status: ON },
			]);

			expect(await run(liveOn({}))).toBeUndefined();

			expect(sent.map((s) => s.payload.action)).toEqual(['on', 'status', 'status', 'status']);
			expect(printed()).toContain('Success: Live mode is on');
			expect(printed()).toContain(`URL: ${URL}`);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('answers --json with the resulting status and changed', async () => {
			mockDesktop([
				{ success: true, changed: true, awaitRevision: 3, status: OFF },
				{ success: true, status: ON },
			]);

			await run(liveOn({ json: true }));

			expect(lastJson()).toEqual({ success: true, changed: true, ...ON });
		});

		it('fails with the switch error when Live did not turn on', async () => {
			mockDesktop([
				{ success: true, changed: true, awaitRevision: 3, status: OFF },
				{ success: true, status: { ...OFF, revision: 3, lastError: 'EADDRINUSE' } },
			]);

			const error = await run(liveOn({ json: true }));

			expect(String(error)).toContain('__exit__1');
			expect(lastJson()).toEqual({ success: false, error: 'EADDRINUSE' });
		});

		it('gives up when the switch never finishes', async () => {
			mockDesktop([
				{ success: true, changed: true, awaitRevision: 3, status: OFF },
				{ success: true, status: OFF },
			]);

			const error = await run(liveOn({}), LIVE_SWITCH_TIMEOUT_MS + LIVE_POLL_INTERVAL_MS * 2);

			expect(String(error)).toContain('__exit__');
			expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
				'did not finish switching'
			);
		});

		it('fails with the app error when the app refuses the switch', async () => {
			mockDesktop([
				{ success: false, error: 'Live mode cannot be switched over the web interface' },
			]);

			await expect(liveOn({ json: true })).rejects.toThrow('__exit__1');
			expect(lastJson()).toEqual({
				success: false,
				error: 'Live mode cannot be switched over the web interface',
			});
		});
	});

	describe('live off', () => {
		it('sends off and waits until Live is off', async () => {
			const sent = mockDesktop([
				{ success: true, changed: true, awaitRevision: 4, status: ON },
				{ success: true, status: { ...OFF, revision: 4 } },
			]);

			await run(liveOff({}));

			expect(sent[0].payload).toEqual({ type: 'live_command', action: 'off' });
			expect(printed()).toContain('Success: Live mode is off');
			expect(printed()).toContain('Live: off');
		});

		it('reports "already off" as a success', async () => {
			mockDesktop([{ success: true, changed: false, status: OFF }]);

			await liveOff({ json: true });

			expect(lastJson()).toEqual({ success: true, changed: false, ...OFF });
		});
	});

	describe('Remote Control', () => {
		it('live on --tunnel starts Remote Control once Live is on, with a long timeout', async () => {
			const sent = mockDesktop([
				{ success: true, changed: false, status: ON },
				{ success: true, changed: true, status: REMOTE },
			]);

			await liveOn({ tunnel: true, json: true });

			expect(sent.map((s) => s.payload.action)).toEqual(['on', 'remote-on']);
			// cloudflared can take 30s to report a URL.
			expect(sent[1].timeoutMs ?? 0).toBeGreaterThan(30_000);
			expect(sent[1].timeoutMs).toBe(REMOTE_CONTROL_TIMEOUT_MS);
			expect(lastJson()).toMatchObject({ remoteControl: true, remoteControlUrl: REMOTE_URL });
		});

		it('live tunnel on prints the public URL', async () => {
			mockDesktop([{ success: true, changed: true, status: REMOTE }]);

			await liveTunnel('on', {});

			expect(printed()).toContain('Remote Control is on');
			expect(printed()).toContain(`Remote Control: ${REMOTE_URL}`);
		});

		it('points at `live on --tunnel` when Live is off', async () => {
			mockDesktop([
				{
					success: false,
					error: 'Live mode is off. Turn it on before starting Remote Control.',
					status: OFF,
				},
			]);

			await expect(liveTunnel('on', { json: true })).rejects.toThrow('__exit__1');
			expect(lastJson().error).toContain('maestro-cli live on --tunnel');
		});

		it('names the install step when cloudflared is missing', async () => {
			mockDesktop([{ success: false, error: 'cloudflared is not installed', status: ON }]);

			await expect(liveTunnel('on', { json: true })).rejects.toThrow('__exit__1');
			expect(lastJson().error).toContain('brew install cloudflared');
		});

		it('live tunnel off stops Remote Control', async () => {
			const sent = mockDesktop([{ success: true, changed: true, status: ON }]);

			await liveTunnel('off', { json: true });

			expect(sent.map((s) => s.payload.action)).toEqual(['remote-off']);
			expect(lastJson()).toMatchObject({ success: true, remoteControl: false });
		});

		it('rejects a state other than on or off before connecting', async () => {
			await expect(liveTunnel('maybe', { json: true })).rejects.toThrow('__exit__1');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});
});
