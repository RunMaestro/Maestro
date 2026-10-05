// Covers the runtime router on the web server's message handler (Phase 9): with the library runtime
// hosted, its fifteen agent, group, and tab messages are answered from it, tagged with the caller's
// request id; every other message and every un-hosted run keeps the desktop's own path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getVersion: () => '9.9.9', getAppPath: () => '/repo' },
}));
vi.mock('../../../../main/utils/build-info', () => ({ getCommitHash: () => 'deadbeef' }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import type { RuntimeMessageRouter } from '../../../../main/library-runtime/bridge';

function createMockClient(): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

const sent = (client: WebClient): Array<Record<string, unknown>> =>
	(client.socket.send as ReturnType<typeof vi.fn>).mock.calls.map(([text]) => JSON.parse(text));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function router(
	reply: Record<string, unknown> | undefined,
	handled: string[] = ['new_tab']
): RuntimeMessageRouter & { handle: ReturnType<typeof vi.fn> } {
	return {
		handles: (type) => typeof type === 'string' && handled.includes(type),
		handle: vi.fn(async () => reply),
	};
}

describe('WebSocketMessageHandler runtime router', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
	});

	it('answers a routed message from the runtime and echoes the request id', async () => {
		const runtime = router({ type: 'new_tab_result', success: true, tabId: 't9' });
		handler.setRuntimeRouter(runtime);
		const newTab = vi.fn(async () => ({ tabId: 'renderer-tab' }));
		handler.setCallbacks({ newTab });

		handler.handleMessage(client, { type: 'new_tab', sessionId: 'a1', requestId: 'req-1' });
		await flush();

		expect(runtime.handle).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'new_tab', sessionId: 'a1' })
		);
		expect(newTab).not.toHaveBeenCalled();
		expect(sent(client)).toEqual([
			expect.objectContaining({
				type: 'new_tab_result',
				success: true,
				tabId: 't9',
				requestId: 'req-1',
			}),
		]);
	});

	it('omits the request id when the caller sent none', async () => {
		handler.setRuntimeRouter(router({ type: 'new_tab_result', success: true }));
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'a1' });
		await flush();
		expect(sent(client)[0]).not.toHaveProperty('requestId');
	});

	it("leaves a message the router does not claim to the desktop's handler", async () => {
		const runtime = router({ type: 'x' });
		handler.setRuntimeRouter(runtime);
		handler.handleMessage(client, { type: 'ping' });
		await flush();

		expect(runtime.handle).not.toHaveBeenCalled();
		expect(sent(client)[0]).toMatchObject({ type: 'pong' });
	});

	it('routes nothing without a router, so an un-hosted run is unchanged', async () => {
		const newTab = vi.fn(async () => ({ tabId: 'renderer-tab' }));
		handler.setCallbacks({ newTab });
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'a1', requestId: 'r' });
		await flush();

		expect(newTab).toHaveBeenCalled();
		expect(sent(client)[0]).toMatchObject({ type: 'new_tab_result', tabId: 'renderer-tab' });
		expect(handler.isRuntimeHosting()).toBe(false);
	});

	it('goes back to the desktop path when the router is cleared', async () => {
		const runtime = router({ type: 'new_tab_result', success: true });
		handler.setRuntimeRouter(runtime);
		expect(handler.isRuntimeHosting()).toBe(true);
		handler.setRuntimeRouter(null);
		expect(handler.isRuntimeHosting()).toBe(false);

		handler.setCallbacks({ newTab: vi.fn(async () => ({ tabId: 'r' })) });
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'a1' });
		await flush();
		expect(runtime.handle).not.toHaveBeenCalled();
	});

	it('says so when the router claims a message and then does not know it', async () => {
		handler.setRuntimeRouter(router(undefined));
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'a1' });
		await flush();
		expect(sent(client)[0]).toMatchObject({ type: 'error' });
		expect(String(sent(client)[0].message)).toContain('new_tab');
	});

	it('reports a router that throws as an error frame instead of dropping the request', async () => {
		const runtime = router({ type: 'x' });
		runtime.handle.mockRejectedValue(new Error('disk full'));
		handler.setRuntimeRouter(runtime);
		handler.handleMessage(client, { type: 'new_tab', sessionId: 'a1' });
		await flush();

		const [frame] = sent(client);
		expect(frame).toMatchObject({ type: 'error' });
		expect(String(frame.message)).toContain('disk full');
	});

	it('reports the hosting mode in app_info', () => {
		handler.setRuntimeRouter(router({ type: 'x' }));
		handler.handleMessage(client, { type: 'get_app_info', requestId: 'r' });
		expect(sent(client)[0]).toMatchObject({ type: 'app_info', runtimeHosting: true });

		const plain = createMockClient();
		new WebSocketMessageHandler().handleMessage(plain, { type: 'get_app_info', requestId: 'r' });
		expect(sent(plain)[0]).toMatchObject({ type: 'app_info', runtimeHosting: false });
	});
});
