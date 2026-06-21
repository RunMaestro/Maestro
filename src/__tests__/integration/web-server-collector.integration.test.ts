import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebServer } from '../../main/web-server';

const mocks = vi.hoisted(() => ({
	isCloudflaredInstalled: vi.fn(),
	getTunnelStatus: vi.fn(),
}));

vi.mock('../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: mocks.isCloudflaredInstalled,
}));

vi.mock('../../main/tunnel-manager', () => ({
	tunnelManager: {
		getStatus: mocks.getTunnelStatus,
	},
}));

import { collectWebServer } from '../../main/debug-package/collectors/web-server';

function webServer(overrides: Partial<WebServer> = {}): WebServer {
	return {
		isActive: vi.fn(() => true),
		getPort: vi.fn(() => 34123),
		getWebClientCount: vi.fn(() => 3),
		getLiveSessions: vi.fn(() => [
			{ id: 'session-from-id', enabledAt: 11 },
			{ sessionId: 'session-from-session-id', enabledAt: 22 },
			{},
		]),
		...overrides,
	} as unknown as WebServer;
}

describe('web server collector integration', () => {
	beforeEach(() => {
		vi.setSystemTime(new Date('2026-05-27T07:00:00Z'));
		mocks.isCloudflaredInstalled.mockResolvedValue(true);
		mocks.getTunnelStatus.mockReturnValue({
			isRunning: true,
			url: 'https://redacted.example',
			error: 'last tunnel warning',
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('collects live web server state without exposing session content or tunnel URL', async () => {
		const result = await collectWebServer(webServer());

		expect(result).toEqual({
			isRunning: true,
			port: 34123,
			connectedClients: 3,
			liveSessions: [
				{ sessionId: 'session-from-id', enabledAt: 11 },
				{ sessionId: 'session-from-session-id', enabledAt: 22 },
				{ sessionId: 'unknown', enabledAt: Date.now() },
			],
			tunnel: {
				cloudflaredInstalled: true,
				isRunning: true,
				hasUrl: true,
				error: 'last tunnel warning',
			},
		});
	});

	it('uses safe defaults for missing server and empty tunnel status fields', async () => {
		mocks.isCloudflaredInstalled.mockResolvedValue(false);
		mocks.getTunnelStatus.mockReturnValue({});

		const result = await collectWebServer(null);

		expect(result).toEqual({
			isRunning: false,
			connectedClients: 0,
			liveSessions: [],
			tunnel: {
				cloudflaredInstalled: false,
				isRunning: false,
				hasUrl: false,
				error: undefined,
			},
		});
	});

	it('keeps defaults when dependency checks fail', async () => {
		mocks.isCloudflaredInstalled.mockRejectedValue(new Error('missing cloudflared'));
		mocks.getTunnelStatus.mockImplementation(() => {
			throw new Error('tunnel unavailable');
		});

		const result = await collectWebServer(
			webServer({
				isActive: vi.fn(() => false),
				getPort: vi.fn(() => undefined),
				getWebClientCount: vi.fn(() => 0),
				getLiveSessions: vi.fn(() => null),
			} as Partial<WebServer>)
		);

		expect(result).toEqual({
			isRunning: false,
			port: undefined,
			connectedClients: 0,
			liveSessions: [],
			tunnel: {
				cloudflaredInstalled: false,
				isRunning: false,
				hasUrl: false,
			},
		});
	});
});
