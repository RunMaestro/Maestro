/**
 * @file live.test.ts
 * @description Tests for the `live status|on|off|tunnel` CLI commands.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import { liveStatus, liveOn, liveOff, liveTunnel } from '../../../cli/commands/live';
import { withMaestroClient } from '../../../cli/services/maestro-client';

type Reply = Record<string, unknown> | Error;

const OFF = {
	success: true,
	live: false,
	url: null,
	tunnel: { isRunning: false, url: null, error: null },
};
const ON = {
	success: true,
	live: true,
	url: 'http://192.168.1.5:8080/tok',
	tunnel: { isRunning: false, url: null, error: null },
};
const ON_TUNNEL = {
	...ON,
	tunnel: { isRunning: true, url: 'https://abc.trycloudflare.com/tok', error: null },
};

/**
 * Answer each message type from its own queue; the last reply repeats. An
 * Error reply rejects, the way a dropped connection mid-swap does.
 */
function route(replies: Record<string, Reply[]>) {
	const sent: Array<{ type: string; timeout?: number }> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: { type: string }, _rt: string, timeout?: number) => {
					sent.push({ type: payload.type, timeout });
					const queue = replies[payload.type];
					if (!queue) return Promise.reject(new Error(`unexpected ${payload.type}`));
					const reply = queue.length > 1 ? queue.shift()! : queue[0];
					return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
				}),
		} as never)
	);
	return sent;
}

function lastJson(logSpy: MockInstance): Record<string, unknown> {
	const calls = logSpy.mock.calls;
	return JSON.parse(String(calls[calls.length - 1][0]));
}

describe('live commands', () => {
	let processExitSpy: MockInstance;
	let logSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('status', () => {
		it('reports the state as JSON', async () => {
			route({ live_status: [{ ...ON_TUNNEL, cloudflaredInstalled: true }] });
			await liveStatus({ json: true });
			expect(lastJson(logSpy)).toEqual({
				success: true,
				live: true,
				url: 'http://192.168.1.5:8080/tok',
				tunnel: { running: true, url: 'https://abc.trycloudflare.com/tok', error: null },
				cloudflaredInstalled: true,
			});
		});
	});

	describe('on', () => {
		it('reconnects after the server swap and waits until Live is on', async () => {
			// The first poll lands on the dying loopback server, the second fails to
			// connect mid-swap, the third reaches the LAN server.
			const sent = route({
				live_start: [{ success: true, restarting: true }],
				live_status: [OFF, new Error('ECONNREFUSED'), ON],
			});
			const run = liveOn({ json: true });
			await vi.runAllTimersAsync();
			await run;

			expect(sent.map((s) => s.type)).toEqual([
				'live_start',
				'live_status',
				'live_status',
				'live_status',
				'live_status',
			]);
			expect(lastJson(logSpy)).toMatchObject({ success: true, live: true, url: ON.url });
		});

		it('does not wait when Live was already on', async () => {
			const sent = route({
				live_start: [{ ...ON, restarting: false }],
				live_status: [ON],
			});
			await liveOn({ json: true });
			expect(sent.map((s) => s.type)).toEqual(['live_start', 'live_status']);
		});

		it('starts the tunnel with a timeout longer than cloudflared startup when --tunnel is set', async () => {
			const sent = route({
				live_start: [{ ...ON, restarting: false }],
				live_tunnel_start: [{ success: true, url: 'https://abc.trycloudflare.com/tok' }],
				live_status: [ON_TUNNEL],
			});
			await liveOn({ tunnel: true, json: true });

			const tunnel = sent.find((s) => s.type === 'live_tunnel_start');
			expect(tunnel?.timeout ?? 0).toBeGreaterThan(30_000);
			expect(lastJson(logSpy)).toMatchObject({
				tunnel: { running: true, url: 'https://abc.trycloudflare.com/tok' },
			});
		});

		it('fails with an install hint when cloudflared is missing', async () => {
			route({
				live_start: [{ ...ON, restarting: false }],
				live_tunnel_start: [{ success: false, error: 'cloudflared is not installed' }],
			});
			await expect(liveOn({ tunnel: true, json: true })).rejects.toThrow('__exit__');
			expect(processExitSpy).toHaveBeenCalledWith(1);
			expect(String(lastJson(logSpy).error)).toContain('brew install cloudflared');
		});

		it('gives up when the server never comes back', async () => {
			route({
				live_start: [{ success: true, restarting: true }],
				live_status: [new Error('Maestro desktop app is not running')],
			});
			const run = liveOn({ json: true });
			const settled = expect(run).rejects.toThrow('__exit__');
			await vi.runAllTimersAsync();
			await settled;
			expect(String(lastJson(logSpy).error)).toContain('did not start');
		});
	});

	describe('off', () => {
		it('waits until Live is off after the swap', async () => {
			const sent = route({
				live_stop: [{ success: true, restarting: true }],
				live_status: [OFF],
			});
			const run = liveOff({ json: true });
			await vi.runAllTimersAsync();
			await run;
			expect(sent.map((s) => s.type)).toEqual(['live_stop', 'live_status']);
			expect(lastJson(logSpy)).toMatchObject({ success: true, live: false });
		});
	});

	describe('tunnel', () => {
		it('rejects a state other than on or off before connecting', async () => {
			await expect(liveTunnel('maybe', { json: true })).rejects.toThrow('__exit__');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('points at `live on --tunnel` when Live is off', async () => {
			route({
				live_tunnel_start: [
					{
						success: false,
						error: 'Live mode is off. Turn on the web interface before starting the tunnel.',
					},
				],
			});
			await expect(liveTunnel('on', { json: true })).rejects.toThrow('__exit__');
			expect(String(lastJson(logSpy).error)).toContain('maestro-cli live on --tunnel');
		});

		it('stops the tunnel and reports the state', async () => {
			const sent = route({
				live_tunnel_stop: [{ success: true }],
				live_status: [ON],
			});
			await liveTunnel('off', { json: true });
			expect(sent.map((s) => s.type)).toEqual(['live_tunnel_stop', 'live_status']);
			expect(lastJson(logSpy)).toMatchObject({ tunnel: { running: false } });
		});
	});
});
