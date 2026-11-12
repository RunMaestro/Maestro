/**
 * @file live-mode.test.ts
 * @description Tests for the Live Mode service pieces the IPC handler tests do
 * not reach: turning Live off from the CLI, and the tunnel's Live gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getVersion: vi.fn(() => '1.0.0') },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/tunnel-manager', () => ({
	// disableAllLive reads the singleton's status for the live:stateChanged push.
	tunnelManager: {
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: vi.fn(() => ({ isRunning: false, url: null, error: null })),
	},
}));

vi.mock('../../../shared/cli-server-discovery', () => ({
	writeCliServerInfo: vi.fn(),
	deleteCliServerInfo: vi.fn(),
	readCliServerInfo: vi.fn(() => null),
}));

vi.mock('../../../main/web-server/auth/cli-secret', () => ({
	getCliSecret: vi.fn(() => 'secret'),
}));

import {
	turnLiveModeOff,
	startTunnel,
	isLiveModeOn,
	type LiveModeDependencies,
	type TunnelManagerLike,
} from '../../../main/web-server/live-mode';

function makeServer(overrides: Record<string, unknown> = {}) {
	return {
		isActive: vi.fn(() => true),
		isLanAccessible: vi.fn(() => true),
		getSecureUrl: vi.fn(() => 'http://192.168.1.5:8080/tok'),
		getLiveSessions: vi.fn(() => [{ sessionId: 'a' }]),
		setSessionOffline: vi.fn(),
		stop: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeTunnel() {
	return {
		start: vi.fn(),
		stop: vi.fn().mockResolvedValue(undefined),
		getStatus: vi.fn(() => ({ isRunning: false, url: null, error: null })),
	} satisfies TunnelManagerLike;
}

describe('Live Mode service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('turnLiveModeOff', () => {
		it('stops the tunnel before it stops the server', async () => {
			const order: string[] = [];
			const server = makeServer({
				stop: vi.fn(async () => {
					order.push('server');
				}),
			});
			const tunnel = makeTunnel();
			tunnel.stop.mockImplementation(async () => {
				order.push('tunnel');
			});
			let current: unknown = server;
			const deps = {
				getWebServer: vi.fn(() => current),
				setWebServer: vi.fn((s: unknown) => {
					current = s;
				}),
				// The loopback CLI server that ensureCliServer brings back fails to
				// start here; only the ordering and the result matter.
				createWebServer: vi.fn(() => {
					throw new Error('no cli server in this test');
				}),
				settingsStore: { get: vi.fn() },
			} as unknown as LiveModeDependencies;

			vi.useFakeTimers();
			const pending = turnLiveModeOff(deps, tunnel);
			await vi.runAllTimersAsync();
			const result = await pending;
			vi.useRealTimers();

			expect(order).toEqual(['tunnel', 'server']);
			expect(server.setSessionOffline).toHaveBeenCalledWith('a');
			expect(result).toEqual({ success: true, count: 1 });
		});

		it('still stops the server when stopping the tunnel throws', async () => {
			const server = makeServer();
			const tunnel = makeTunnel();
			tunnel.stop.mockRejectedValue(new Error('cloudflared hung'));
			let current: unknown = server;
			const deps = {
				getWebServer: vi.fn(() => current),
				setWebServer: vi.fn((s: unknown) => {
					current = s;
				}),
				createWebServer: vi.fn(() => {
					throw new Error('no cli server in this test');
				}),
				settingsStore: { get: vi.fn() },
			} as unknown as LiveModeDependencies;

			vi.useFakeTimers();
			const pending = turnLiveModeOff(deps, tunnel);
			await vi.runAllTimersAsync();
			const result = await pending;
			vi.useRealTimers();

			expect(server.stop).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});
	});

	describe('startTunnel', () => {
		it('refuses the loopback CLI server', async () => {
			const server = makeServer({ isLanAccessible: vi.fn(() => false) });
			const tunnel = makeTunnel();

			const result = await startTunnel(server as never, tunnel);

			expect(result.success).toBe(false);
			expect(tunnel.start).not.toHaveBeenCalled();
		});

		it('appends the token path to the tunnel URL', async () => {
			const tunnel = makeTunnel();
			tunnel.start.mockResolvedValue({ success: true, url: 'https://x.trycloudflare.com' });

			const result = await startTunnel(makeServer() as never, tunnel);

			expect(tunnel.start).toHaveBeenCalledWith(8080);
			expect(result).toEqual({ success: true, url: 'https://x.trycloudflare.com/tok' });
		});
	});

	it('isLiveModeOn needs an active, LAN-accessible server', () => {
		expect(isLiveModeOn(null)).toBe(false);
		expect(isLiveModeOn(makeServer({ isActive: vi.fn(() => false) }) as never)).toBe(false);
		expect(isLiveModeOn(makeServer({ isLanAccessible: vi.fn(() => false) }) as never)).toBe(false);
		expect(isLiveModeOn(makeServer() as never)).toBe(true);
	});
});
