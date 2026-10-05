import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const isolated = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => isolated.directory } }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
beforeEach(() => {
	isolated.directory = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-revocation-'));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(isolated.directory, { recursive: true, force: true });
});
describe('independent browser-account and paired-device revocation', () => {
	it('closes sockets whose session no longer resolves and leaves the rest alone', async () => {
		const listeners: Array<() => void> = [];
		const live = new Set(['sid-live']);
		const fakeStore = {
			onChange: (l: () => void) => {
				listeners.push(l);
				return () => {};
			},
			resolveSession: (sid?: string) =>
				sid && live.has(sid) ? { id: 'u1', username: 'ada', displayName: 'Ada' } : undefined,
		};
		// WebServer is already imported at the top of this file, so the mock has
		// to reach a FRESH module graph.
		vi.resetModules();
		vi.doMock('../../../main/web-server/auth/web-user-store', () => ({
			getWebUserStore: () => fakeStore,
		}));
		const { WebServer: IsolatedWebServer } = await import('../../../main/web-server/WebServer');
		const { WEB_LOGIN_WS_CLOSE_CODE } = await import('../../../shared/webLogin');
		const server = new IsolatedWebServer(0);

		const make = (id: string, sessionId?: string) => ({
			id,
			socket: { close: vi.fn(), readyState: 1, send: vi.fn() },
			connectedAt: Date.now(),
			...(sessionId ? { user: { id: 'u1', username: 'ada', displayName: 'Ada' }, sessionId } : {}),
		});
		const revoked = make('c-revoked', 'sid-reset');
		const kept = make('c-kept', 'sid-live');
		const cli = make('c-cli');
		const device = {
			...make('c-device'),
			user: { id: 'paired-device:abc', username: 'paired-device', displayName: 'Laptop' },
		};
		const clients = (server as any).webClients as Map<string, unknown>;
		clients.set(revoked.id, revoked);
		clients.set(kept.id, kept);
		clients.set(cli.id, cli);
		clients.set(device.id, device);

		(server as any).watchWebUserStore();
		expect(listeners).toHaveLength(1);
		listeners[0]();

		expect(revoked.socket.close).toHaveBeenCalledWith(WEB_LOGIN_WS_CLOSE_CODE, 'Login required');
		expect(kept.socket.close).not.toHaveBeenCalled();
		expect(cli.socket.close).not.toHaveBeenCalled();
		expect(device.socket.close).not.toHaveBeenCalled();

		vi.doUnmock('../../../main/web-server/auth/web-user-store');
		vi.resetModules();
	});
});
