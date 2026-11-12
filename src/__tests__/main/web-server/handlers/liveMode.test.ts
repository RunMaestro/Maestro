/**
 * @file liveMode.test.ts
 * @description Tests for the live_* WebSocket handlers behind `maestro-cli live`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../../main/web-server/live-mode', () => ({
	getLiveModeDependencies: vi.fn(),
	getLiveModeState: vi.fn(),
	isLiveModeOn: vi.fn(),
	startLiveServer: vi.fn(),
	startTunnel: vi.fn(),
	stopTunnel: vi.fn(),
	turnLiveModeOff: vi.fn(),
}));

import {
	handleLiveStatus,
	handleLiveStart,
	handleLiveStop,
	handleLiveTunnelStart,
	handleLiveTunnelStop,
} from '../../../../main/web-server/handlers/messageHandlers/liveMode';
import {
	getLiveModeDependencies,
	getLiveModeState,
	isLiveModeOn,
	startLiveServer,
	startTunnel,
	stopTunnel,
	turnLiveModeOff,
} from '../../../../main/web-server/live-mode';

const STATE = {
	live: true,
	url: 'http://192.168.1.5:8080/tok',
	tunnel: { isRunning: false, url: null, error: null },
};

function makeCtx() {
	return { send: vi.fn(), sendError: vi.fn(), reportHandlerError: vi.fn(), callbacks: {} };
}

/** A socket whose send callback fires only when the test says it was written. */
function makeClient() {
	let flush: (() => void) | null = null;
	const socket = {
		send: vi.fn((_data: string, cb?: () => void) => {
			flush = cb ?? null;
		}),
	};
	return {
		client: { socket, id: 'c1', connectedAt: 0, cli: true } as never,
		socket,
		flush: () => flush?.(),
	};
}

const deps = { getWebServer: vi.fn(() => ({})) };

/** A socket that presented this boot's CLI secret. */
const CLI = { id: 'cli', cli: true } as never;

describe('live_* WebSocket handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getLiveModeDependencies).mockReturnValue(deps as never);
		vi.mocked(getLiveModeState).mockReturnValue(STATE);
	});

	it('live_status reports the state and whether cloudflared is installed', async () => {
		const ctx = makeCtx();
		await handleLiveStatus(ctx, CLI, { type: 'live_status', requestId: 'r1' });
		expect(ctx.send).toHaveBeenCalledWith(
			CLI,
			expect.objectContaining({
				type: 'live_status_result',
				success: true,
				...STATE,
				cloudflaredInstalled: true,
				requestId: 'r1',
			})
		);
	});

	it.each([
		['live_status', handleLiveStatus],
		['live_start', handleLiveStart],
		['live_stop', handleLiveStop],
		['live_tunnel_start', handleLiveTunnelStart],
		['live_tunnel_stop', handleLiveTunnelStop],
	] as const)('%s refuses a browser client (LAN or tunnel)', async (type, handle) => {
		const ctx = makeCtx();
		const browser = { id: 'phone' } as never;
		await handle(ctx, browser, { type, requestId: 'r1' });

		expect(ctx.send).toHaveBeenCalledWith(
			browser,
			expect.objectContaining({
				type: `${type}_result`,
				success: false,
				error: 'Live mode cannot be switched over the web interface',
			})
		);
		expect(getLiveModeDependencies).not.toHaveBeenCalled();
		expect(startLiveServer).not.toHaveBeenCalled();
		expect(turnLiveModeOff).not.toHaveBeenCalled();
		expect(startTunnel).not.toHaveBeenCalled();
		expect(stopTunnel).not.toHaveBeenCalled();
	});

	it('answers with an error before startup has registered the deps', async () => {
		vi.mocked(getLiveModeDependencies).mockReturnValue(null);
		const ctx = makeCtx();
		await handleLiveStatus(ctx, CLI, { type: 'live_status', requestId: 'r1' });
		expect(ctx.send).toHaveBeenCalledWith(
			CLI,
			expect.objectContaining({ type: 'live_status_result', success: false })
		);
	});

	describe('live_start', () => {
		it('answers without a swap when Live is already on', () => {
			vi.mocked(isLiveModeOn).mockReturnValue(true);
			const ctx = makeCtx();
			const { client } = makeClient();
			handleLiveStart(ctx, client, { type: 'live_start', requestId: 'r1' });
			expect(ctx.send).toHaveBeenCalledWith(
				client,
				expect.objectContaining({ type: 'live_start_result', restarting: false, ...STATE })
			);
			expect(startLiveServer).not.toHaveBeenCalled();
		});

		it('swaps the server only after the answer is on the wire', () => {
			// The swap closes this socket; starting it first would lose the answer.
			vi.mocked(isLiveModeOn).mockReturnValue(false);
			vi.mocked(startLiveServer).mockResolvedValue({ success: true, url: STATE.url });
			const { client, socket, flush } = makeClient();
			handleLiveStart(makeCtx(), client, { type: 'live_start', requestId: 'r1' });

			expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
				type: 'live_start_result',
				success: true,
				restarting: true,
				requestId: 'r1',
			});
			expect(startLiveServer).not.toHaveBeenCalled();
			flush();
			expect(startLiveServer).toHaveBeenCalledWith(deps);
		});
	});

	describe('live_stop', () => {
		it('turns Live off after the answer is written', () => {
			vi.mocked(isLiveModeOn).mockReturnValue(true);
			vi.mocked(turnLiveModeOff).mockResolvedValue({ success: true, count: 0 });
			const { client, socket, flush } = makeClient();
			handleLiveStop(makeCtx(), client, { type: 'live_stop', requestId: 'r1' });

			expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
				type: 'live_stop_result',
				restarting: true,
			});
			expect(turnLiveModeOff).not.toHaveBeenCalled();
			flush();
			expect(turnLiveModeOff).toHaveBeenCalledWith(deps);
		});

		it('only stops the tunnel when Live is already off', async () => {
			vi.mocked(isLiveModeOn).mockReturnValue(false);
			vi.mocked(stopTunnel).mockResolvedValue({ success: true });
			const ctx = makeCtx();
			handleLiveStop(ctx, CLI, { type: 'live_stop', requestId: 'r1' });
			await vi.waitFor(() =>
				expect(ctx.send).toHaveBeenCalledWith(
					CLI,
					expect.objectContaining({ type: 'live_stop_result', restarting: false })
				)
			);
			expect(stopTunnel).toHaveBeenCalled();
			expect(turnLiveModeOff).not.toHaveBeenCalled();
		});
	});

	it('live_tunnel_start relays the service result', async () => {
		vi.mocked(startTunnel).mockResolvedValue({ success: false, error: 'Live mode is off.' });
		const ctx = makeCtx();
		await handleLiveTunnelStart(ctx, CLI, { type: 'live_tunnel_start', requestId: 'r1' });
		expect(ctx.send).toHaveBeenCalledWith(
			CLI,
			expect.objectContaining({
				type: 'live_tunnel_start_result',
				success: false,
				error: 'Live mode is off.',
				requestId: 'r1',
			})
		);
	});

	it('live_tunnel_stop stops the tunnel and reports the state', async () => {
		vi.mocked(stopTunnel).mockResolvedValue({ success: true });
		const ctx = makeCtx();
		await handleLiveTunnelStop(ctx, CLI, { type: 'live_tunnel_stop', requestId: 'r1' });
		expect(stopTunnel).toHaveBeenCalled();
		expect(ctx.send).toHaveBeenCalledWith(
			CLI,
			expect.objectContaining({ type: 'live_tunnel_stop_result', success: true, ...STATE })
		);
	});
});
