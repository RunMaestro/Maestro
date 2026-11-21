// Source: src/__tests__/main/ipc/handlers/maestroRun.test.ts
// Source: src/__tests__/main/web-server/handlers/maestroRunHandler.test.ts
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { registerMaestroRunHandlers } from '../../../../main/ipc/handlers/maestroRun';
import { WebSocket } from 'ws';
import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
const h = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	enabled: true,
	service: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));
vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/maestro-run', () => ({
	getMaestroRunService: () => h.service,
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
describe('maestroRun', () => {
	beforeEach(() => {
		h.handlers.clear();
		h.enabled = true;
		h.service = {
			status: vi.fn(() => ({ enabled: h.enabled })),
			install: vi.fn(async () => ({ enabled: true, installed: true })),
			requestAccess: vi.fn(async () => ({ enabled: true })),
		};
		registerMaestroRunHandlers();
	});

	describe('maestroRun IPC', () => {
		it('installs and requests access while the feature is on', async () => {
			await h.handlers.get('maestroRun:install')!({});
			expect(h.service!.install).toHaveBeenCalledOnce();
			await h.handlers.get('maestroRun:requestAccess')!({}, { reveal: true });
			expect(h.service!.requestAccess).toHaveBeenCalledWith({ reveal: true });
		});

		it('refuses install and requestAccess while the feature is off, but still reports status', async () => {
			h.enabled = false;
			await expect(h.handlers.get('maestroRun:install')!({})).rejects.toThrow('MaestroRunDisabled');
			await expect(h.handlers.get('maestroRun:requestAccess')!({}, {})).rejects.toThrow(
				'MaestroRunDisabled'
			);
			expect(h.service!.install).not.toHaveBeenCalled();
			expect(h.service!.requestAccess).not.toHaveBeenCalled();
			await expect(h.handlers.get('maestroRun:status')!({})).resolves.toEqual({ enabled: false });
		});
	});
});
describe('maestroRunHandler', () => {
	const service = {
		status: vi.fn(),
		refresh: vi.fn(),
		install: vi.fn(),
		requestAccess: vi.fn(),
	};

	function createMockClient(): WebClient {
		return {
			socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
			id: 'client-1',
			connectedAt: 0,
		};
	}

	function lastResponse(client: WebClient): Record<string, unknown> {
		const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
		return JSON.parse(calls[calls.length - 1][0] as string);
	}

	const flush = () => new Promise((resolve) => setImmediate(resolve));

	describe('maestro_run_command handler', () => {
		let handler: WebSocketMessageHandler;
		let client: WebClient;
		const send = async (message: Record<string, unknown>) => {
			handler.handleMessage(client, { type: 'maestro_run_command', requestId: 'r1', ...message });
			await flush();
			return lastResponse(client);
		};

		beforeEach(() => {
			vi.clearAllMocks();
			h.service = service;
			service.status.mockReturnValue({ enabled: true, phase: 'needs-access' });
			service.refresh.mockResolvedValue({ enabled: true, phase: 'needs-access' });
			service.install.mockResolvedValue({
				enabled: true,
				phase: 'needs-access',
				installedVersion: '0.2.0',
			});
			service.requestAccess.mockResolvedValue({
				enabled: true,
				phase: 'needs-access',
				watchingForAccess: true,
			});
			handler = new WebSocketMessageHandler();
			client = createMockClient();
		});

		it('status re-inspects instead of answering from the cache', async () => {
			expect(await send({ action: 'status' })).toMatchObject({
				type: 'maestro_run_result',
				success: true,
				requestId: 'r1',
				status: { phase: 'needs-access' },
			});
			expect(service.refresh).toHaveBeenCalledWith({ checkLatest: false });
			await send({ action: 'status', checkLatest: true });
			expect(service.refresh).toHaveBeenLastCalledWith({ checkLatest: true });
		});

		it('status works while the feature is off', async () => {
			service.status.mockReturnValue({ enabled: false, phase: 'not-installed' });
			service.refresh.mockResolvedValue({ enabled: false, phase: 'not-installed' });
			expect(await send({ action: 'status' })).toMatchObject({ success: true });
		});

		it('install and grant reach the same service the tile calls', async () => {
			expect(await send({ action: 'install' })).toMatchObject({
				success: true,
				status: { installedVersion: '0.2.0' },
			});
			expect(service.install).toHaveBeenCalledTimes(1);

			expect(await send({ action: 'grant', reveal: true })).toMatchObject({
				success: true,
				status: { watchingForAccess: true },
			});
			expect(service.requestAccess).toHaveBeenCalledWith({ reveal: true });
		});

		it.each(['install', 'grant'])('refuses %s while the feature is off', async (action) => {
			service.status.mockReturnValue({ enabled: false, phase: 'not-installed' });
			const reply = await send({ action });
			expect(reply).toMatchObject({ success: false, requestId: 'r1' });
			expect(reply.error).toContain('encore enable maestroRun');
			expect(service.install).not.toHaveBeenCalled();
			expect(service.requestAccess).not.toHaveBeenCalled();
		});

		it('answers a service failure with its reason', async () => {
			service.install.mockRejectedValue(new Error('Checksum mismatch'));
			expect(await send({ action: 'install' })).toMatchObject({
				success: false,
				error: 'Checksum mismatch',
				requestId: 'r1',
			});
		});

		it('rejects an unknown action', async () => {
			const reply = await send({ action: 'uninstall' });
			expect(reply).toMatchObject({ success: false, requestId: 'r1' });
			expect(reply.error).toContain('Unknown MaestroRun action');
		});

		it('answers when the service does not exist', async () => {
			h.service = null;
			expect(await send({ action: 'status' })).toMatchObject({
				success: false,
				error: 'MaestroRun is not available',
				requestId: 'r1',
			});
		});
	});
});
