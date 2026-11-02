/**
 * The Live mode controller: the ONE switch behind the Left Bar LIVE pill
 * (`live:set`), the raw `live:startServer|stopServer|disableAll` channels, and
 * `maestro-cli live on|off`. These tests drive it against a fake web server and
 * check that `set()` makes the same server calls the pill always made, stays
 * idempotent, runs single-flight, and tells every window the result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));
vi.mock('../../../shared/cli-server-discovery', () => ({
	deleteCliServerInfo: vi.fn(),
}));

import {
	createLiveModeController,
	getLiveModeController,
	setLiveModeController,
	type LiveModeControllerDeps,
} from '../../../main/web-server/live-mode';
import { deleteCliServerInfo } from '../../../shared/cli-server-discovery';
import type { WebServer } from '../../../main/web-server/WebServer';

interface FakeServer {
	lan: boolean;
	active: boolean;
	token: string;
	port: number;
	liveSessions: Array<{ sessionId: string }>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	isActive: () => boolean;
	isLanAccessible: () => boolean;
	getSecureUrl: () => string;
	getPort: () => number;
	getSecurityToken: () => string;
	getLiveSessions: () => Array<{ sessionId: string }>;
	setSessionOffline: ReturnType<typeof vi.fn>;
}

let serial = 0;

function fakeServer(lan: boolean, active = false): FakeServer {
	serial += 1;
	const server: FakeServer = {
		lan,
		active,
		token: `token-${serial}`,
		port: 9000 + serial,
		liveSessions: [],
		start: vi.fn(async () => {
			server.active = true;
			return { port: server.port, token: server.token, url: server.getSecureUrl() };
		}),
		stop: vi.fn(async () => {
			server.active = false;
		}),
		isActive: () => server.active,
		isLanAccessible: () => server.lan,
		getSecureUrl: () => `http://192.168.1.5:${server.port}/${server.token}`,
		getPort: () => server.port,
		getSecurityToken: () => server.token,
		getLiveSessions: () => server.liveSessions,
		setSessionOffline: vi.fn(),
	};
	return server;
}

function harness(initial: FakeServer | null = null, settings: Record<string, unknown> = {}) {
	let current: FakeServer | null = initial;
	const created: FakeServer[] = [];
	const deps = {
		getWebServer: vi.fn(() => current as unknown as WebServer | null),
		setWebServer: vi.fn((server: WebServer | null) => {
			current = server as unknown as FakeServer | null;
		}),
		createWebServer: vi.fn((options?: { lanAccess?: boolean }) => {
			const server = fakeServer(options?.lanAccess === true);
			created.push(server);
			return server as unknown as WebServer;
		}),
		settingsStore: {
			get: vi.fn((key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback)),
		} as unknown as LiveModeControllerDeps['settingsStore'],
		ensureCliServer: vi.fn(async () => true),
		publishCliDiscovery: vi.fn(),
		tunnel: {
			start: vi.fn(
				async (_port: number): Promise<{ success: boolean; url?: string; error?: string }> => ({
					success: true,
					url: 'https://abc.trycloudflare.com',
				})
			),
			stop: vi.fn(async () => {}),
			getStatus: vi.fn((): { isRunning: boolean; url: string | null; error: string | null } => ({
				isRunning: false,
				url: null,
				error: null,
			})),
		},
		onStateChanged: vi.fn(),
	};
	const controller = createLiveModeController(deps);
	return { controller, deps, created, current: () => current };
}

describe('createLiveModeController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getStatus', () => {
		it('reports off with no server', () => {
			const { controller } = harness();
			expect(controller.getStatus()).toEqual({
				live: false,
				url: null,
				remoteControl: false,
				remoteControlUrl: null,
				revision: 0,
			});
		});

		it('reports off while only the loopback CLI server runs', () => {
			const { controller } = harness(fakeServer(false, true));
			expect(controller.getStatus()).toMatchObject({ live: false, url: null });
		});

		it('reports on, with the LAN URL, while a LAN server runs', () => {
			const server = fakeServer(true, true);
			const { controller } = harness(server);
			expect(controller.getStatus()).toMatchObject({ live: true, url: server.getSecureUrl() });
		});

		it('reads Remote Control from the tunnel, and treats a throwing tunnel as off', () => {
			const server = fakeServer(true, true);
			const { controller, deps } = harness(server);
			deps.tunnel.getStatus.mockReturnValue({
				isRunning: true,
				url: 'https://abc.trycloudflare.com',
				error: null,
			});
			// The public URL carries the server's token path, as the LAN URL does.
			expect(controller.getStatus()).toMatchObject({
				remoteControl: true,
				remoteControlUrl: `https://abc.trycloudflare.com/${server.token}`,
			});
			deps.tunnel.getStatus.mockImplementation(() => {
				throw new Error('no tunnel manager');
			});
			expect(controller.getStatus()).toMatchObject({
				remoteControl: false,
				remoteControlUrl: null,
			});
		});

		it('reports why Remote Control is down', () => {
			const { controller, deps } = harness();
			deps.tunnel.getStatus.mockReturnValue({ isRunning: false, url: null, error: 'exited' });
			expect(controller.getStatus()).toMatchObject({
				remoteControl: false,
				remoteControlError: 'exited',
			});
		});
	});

	describe('set(true)', () => {
		it('creates and starts a LAN server, publishes discovery, and broadcasts', async () => {
			const { controller, deps, created } = harness();

			const result = await controller.set(true);

			expect(deps.createWebServer).toHaveBeenCalledWith({ lanAccess: true });
			expect(created).toHaveLength(1);
			expect(created[0].start).toHaveBeenCalledTimes(1);
			expect(deps.publishCliDiscovery).toHaveBeenCalledWith(created[0].port, created[0].token);
			expect(result).toMatchObject({
				success: true,
				changed: true,
				status: { live: true, url: created[0].getSecureUrl(), revision: 1 },
			});
			expect(deps.onStateChanged).toHaveBeenCalledWith({
				live: true,
				url: created[0].getSecureUrl(),
				remoteControl: false,
				remoteControlUrl: null,
			});
		});

		it('replaces the loopback CLI server with a LAN server', async () => {
			const loopback = fakeServer(false, true);
			const { controller, deps, current } = harness(loopback);

			await controller.set(true);

			expect(loopback.stop).toHaveBeenCalledTimes(1);
			expect(deps.setWebServer).toHaveBeenCalledWith(null);
			expect(current()?.lan).toBe(true);
			expect(current()?.active).toBe(true);
		});

		it('is a no-op while Live is already on, so the token never rotates', async () => {
			const server = fakeServer(true, true);
			const { controller, deps } = harness(server);

			const result = await controller.set(true);

			expect(result).toMatchObject({ success: true, changed: false, status: { revision: 0 } });
			expect(server.stop).not.toHaveBeenCalled();
			expect(deps.createWebServer).not.toHaveBeenCalled();
			expect(deps.onStateChanged).not.toHaveBeenCalled();
		});

		it('never starts the tunnel', async () => {
			const { controller, deps } = harness();
			await controller.set(true);
			expect(deps.tunnel.start).not.toHaveBeenCalled();
			expect(deps.tunnel.stop).not.toHaveBeenCalled();
		});

		it('runs two concurrent switches single-flight: one server, one start', async () => {
			const { controller, deps, created } = harness();

			const [first, second] = await Promise.all([controller.set(true), controller.set(true)]);

			expect(deps.createWebServer).toHaveBeenCalledTimes(1);
			expect(created[0].start).toHaveBeenCalledTimes(1);
			expect(first.changed).toBe(true);
			expect(second.changed).toBe(false);
		});

		it('reports a failed start, records lastError, and still broadcasts', async () => {
			const { controller, deps } = harness();
			deps.createWebServer.mockImplementationOnce(() => {
				const server = fakeServer(true);
				server.start.mockRejectedValue(new Error('EADDRINUSE'));
				return server as unknown as WebServer;
			});

			const result = await controller.set(true);

			expect(result).toMatchObject({
				success: false,
				changed: true,
				error: 'EADDRINUSE',
				status: { live: false, revision: 1, lastError: 'EADDRINUSE' },
			});
			expect(deps.onStateChanged).toHaveBeenCalledWith({
				live: false,
				url: null,
				remoteControl: false,
				remoteControlUrl: null,
			});

			// The next success clears the error.
			const retry = await controller.set(true);
			expect(retry.success).toBe(true);
			expect(retry.status.lastError).toBeUndefined();
			expect(retry.status.revision).toBe(2);
		});
	});

	describe('set(false)', () => {
		it('stops the tunnel first, takes sessions offline, stops the server, and restores the CLI server', async () => {
			const server = fakeServer(true, true);
			server.liveSessions = [{ sessionId: 'a' }, { sessionId: 'b' }];
			const { controller, deps, current } = harness(server);
			const order: string[] = [];
			deps.tunnel.stop.mockImplementation(async () => {
				order.push('tunnel');
			});
			server.stop.mockImplementation(async () => {
				order.push('server');
				server.active = false;
			});
			deps.ensureCliServer.mockImplementation(async () => {
				order.push('cli');
				return true;
			});

			const result = await controller.set(false);

			expect(order).toEqual(['tunnel', 'server', 'cli']);
			expect(server.setSessionOffline).toHaveBeenCalledWith('a');
			expect(server.setSessionOffline).toHaveBeenCalledWith('b');
			expect(deleteCliServerInfo).toHaveBeenCalled();
			expect(current()).toBeNull();
			expect(result).toMatchObject({
				success: true,
				changed: true,
				status: { live: false, url: null, revision: 1 },
			});
			expect(deps.onStateChanged).toHaveBeenCalledWith({
				live: false,
				url: null,
				remoteControl: false,
				remoteControlUrl: null,
			});
		});

		it('still stops the server when the tunnel fails to stop', async () => {
			const server = fakeServer(true, true);
			const { controller, deps } = harness(server);
			deps.tunnel.stop.mockRejectedValue(new Error('tunnel stuck'));

			const result = await controller.set(false);

			expect(server.stop).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});

		it('is a no-op while Live is already off', async () => {
			const loopback = fakeServer(false, true);
			const { controller, deps } = harness(loopback);

			const result = await controller.set(false);

			expect(result).toMatchObject({ success: true, changed: false });
			expect(loopback.stop).not.toHaveBeenCalled();
			expect(deps.tunnel.stop).not.toHaveBeenCalled();
			expect(deps.onStateChanged).not.toHaveBeenCalled();
		});
	});

	describe('raw switches', () => {
		it('startServer rotates a running LAN server unless Persistent Web Link is on', async () => {
			const server = fakeServer(true, true);
			const { controller, deps } = harness(server);

			await controller.startServer();

			expect(server.stop).toHaveBeenCalled();
			expect(deps.createWebServer).toHaveBeenCalledWith({ lanAccess: true });
		});

		it('startServer keeps a running LAN server when Persistent Web Link is on', async () => {
			const server = fakeServer(true, true);
			const { controller, deps } = harness(server, { persistentWebLink: true });

			const result = await controller.startServer();

			expect(server.stop).not.toHaveBeenCalled();
			expect(deps.createWebServer).not.toHaveBeenCalled();
			expect(deps.publishCliDiscovery).toHaveBeenCalledWith(server.port, server.token);
			expect(result).toEqual({ success: true, url: server.getSecureUrl() });
		});

		it('two concurrent startServer calls leave exactly one server listening', async () => {
			const { controller, created } = harness();

			await Promise.all([controller.startServer(), controller.startServer()]);

			expect(created.filter((server) => server.active)).toHaveLength(1);
		});

		it('stopServer stops the server and restores the CLI server', async () => {
			const server = fakeServer(true, true);
			const { controller, deps, current } = harness(server);

			expect(await controller.stopServer()).toEqual({ success: true });
			expect(server.stop).toHaveBeenCalled();
			expect(current()).toBeNull();
			expect(deps.ensureCliServer).toHaveBeenCalled();
			expect(deps.tunnel.stop).not.toHaveBeenCalled();
		});

		it('disableAll with no server only restores the CLI server', async () => {
			const { controller, deps } = harness();
			expect(await controller.disableAll()).toEqual({ success: true, count: 0 });
			expect(deps.ensureCliServer).toHaveBeenCalled();
		});

		it('every raw switch advances the revision and broadcasts', async () => {
			const { controller, deps } = harness();
			await controller.startServer();
			await controller.stopServer();
			expect(controller.getStatus().revision).toBe(2);
			expect(deps.onStateChanged).toHaveBeenCalledTimes(2);
		});
	});
});

describe('Remote Control', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refuses to start while Live is off, without touching the tunnel', async () => {
		// Only the loopback CLI server runs: tunneling it would publish the CLI's
		// control channel to the internet.
		const { controller, deps } = harness(fakeServer(false, true));
		const result = await controller.startRemoteControl();

		expect(result).toMatchObject({ success: false, status: { live: false } });
		expect(result.error).toMatch(/Live mode is off/);
		expect(deps.tunnel.start).not.toHaveBeenCalled();
	});

	it('tunnels the LAN server port and answers with the tokenized URL', async () => {
		const server = fakeServer(true, true);
		const { controller, deps } = harness(server);
		const result = await controller.startRemoteControl();

		expect(deps.tunnel.start).toHaveBeenCalledWith(server.port);
		expect(result).toMatchObject({
			success: true,
			url: `https://abc.trycloudflare.com/${server.token}`,
		});
		expect(deps.onStateChanged).toHaveBeenCalledTimes(1);
		expect(controller.getStatus().revision).toBe(1);
	});

	it('reports a tunnel failure as the switch error', async () => {
		const { controller, deps } = harness(fakeServer(true, true));
		deps.tunnel.start.mockResolvedValue({ success: false, error: 'cloudflared is not installed' });

		const result = await controller.startRemoteControl();
		expect(result).toMatchObject({ success: false, error: 'cloudflared is not installed' });
		expect(controller.getStatus().lastError).toBe('cloudflared is not installed');
	});

	it('stops the tunnel and leaves Live on', async () => {
		const server = fakeServer(true, true);
		const { controller, deps } = harness(server);
		const result = await controller.stopRemoteControl();

		expect(deps.tunnel.stop).toHaveBeenCalledTimes(1);
		expect(server.stop).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: true, status: { live: true } });
	});

	it('waits for a Live switch already in flight before starting', async () => {
		const { controller, deps } = harness();
		const order: string[] = [];
		deps.tunnel.start.mockImplementation(async () => {
			order.push(`tunnel:${controller.getStatus().live}`);
			return { success: true, url: 'https://abc.trycloudflare.com' };
		});

		await Promise.all([controller.set(true), controller.startRemoteControl()]);
		// Queued behind the Live start, so it sees the LAN server and goes ahead.
		expect(order).toEqual(['tunnel:true']);
	});
});

describe('Live mode controller registry', () => {
	it('returns the registered controller, and null once cleared', () => {
		const { controller } = harness();
		setLiveModeController(controller);
		expect(getLiveModeController()).toBe(controller);
		setLiveModeController(null);
		expect(getLiveModeController()).toBeNull();
	});
});
