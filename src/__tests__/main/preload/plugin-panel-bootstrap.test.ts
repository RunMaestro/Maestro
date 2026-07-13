// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const { exposeInMainWorld, sendToHost, listeners } = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn(),
	sendToHost: vi.fn(),
	listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
}));

vi.mock('electron', () => ({
	contextBridge: { exposeInMainWorld },
	ipcRenderer: {
		sendToHost,
		on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
			listeners.set(channel, listener);
		}),
	},
}));

import '../../../main/preload/plugin-panel';

type GuestApi = {
	request(kind: string, payload: unknown): Promise<unknown>;
	subscribe(kind: string, listener: (payload: unknown) => void): () => void;
};

function fromHost(channel: string, payload: unknown): void {
	const listener = listeners.get(channel);
	if (!listener) throw new Error(`missing host listener: ${channel}`);
	listener({}, payload);
}

function guestApi(): GuestApi {
	const call = exposeInMainWorld.mock.calls[exposeInMainWorld.mock.calls.length - 1];
	if (!call) throw new Error('guest API was not exposed');
	return call[1] as GuestApi;
}

describe('closed panel pre-init bootstrap', () => {
	it('queues bounded requests and deduplicated subscriptions until valid INIT, then flushes once in order', async () => {
		const api = guestApi();
		await expect(api.request('ping', 'x'.repeat(64 * 1024))).rejects.toThrow(
			'interactive panel capability unavailable'
		);
		const callbacks = Array.from({ length: 32 }, () => vi.fn());
		const requests = callbacks.map((_, order) => api.request('ping', { order }));
		await expect(api.request('ping', { order: 32 })).rejects.toThrow(
			'interactive panel backpressure'
		);
		const removeFirst = api.subscribe('status', callbacks[0]);
		const removeSecond = api.subscribe('status', callbacks[1]);
		removeSecond();

		expect(sendToHost).not.toHaveBeenCalled();
		fromHost('maestro:panel-init', { instanceId: 'bootstrap-instance-0001', generation: '1' });

		expect(sendToHost).toHaveBeenCalledTimes(33);
		for (let order = 0; order < 32; order += 1) {
			expect(sendToHost).toHaveBeenNthCalledWith(order + 1, 'maestro:panel-request', {
				instanceId: 'bootstrap-instance-0001',
				requestId: order + 1,
				kind: 'ping',
				payload: { order },
			});
		}
		expect(sendToHost).toHaveBeenLastCalledWith('maestro:panel-subscribe', {
			instanceId: 'bootstrap-instance-0001',
			kind: 'status',
		});
		fromHost('maestro:panel-init', { instanceId: 'bootstrap-instance-0001', generation: '1' });
		expect(sendToHost).toHaveBeenCalledTimes(33);
		removeFirst();
		expect(sendToHost).toHaveBeenLastCalledWith('maestro:panel-unsubscribe', {
			instanceId: 'bootstrap-instance-0001',
			kind: 'status',
		});
		for (const request of requests) {
			request.catch(() => undefined);
		}
	});

	it('fails closed for stale INIT, replacement, and unload', async () => {
		listeners.clear();
		exposeInMainWorld.mockClear();
		sendToHost.mockClear();
		vi.resetModules();
		// Intentional module reload: each preload boot owns singleton panel authority.
		await import('../../../main/preload/plugin-panel');
		const api = guestApi();
		fromHost('maestro:panel-init', { instanceId: 'first-instance-0001', generation: '2' });
		const stale = api.request('ping', { phase: 'stale' });
		fromHost('maestro:panel-init', { instanceId: 'stale-instance-0001', generation: '1' });
		await expect(stale).rejects.toThrow('panel init rejected');
		fromHost('maestro:panel-init', { instanceId: 'second-instance-0001', generation: '3' });
		const replaced = api.request('ping', { phase: 'replaced' });
		fromHost('maestro:panel-init', { instanceId: 'third-instance-0001', generation: '4' });
		await expect(replaced).rejects.toThrow('panel instance replaced');
		const unloaded = api.request('ping', { phase: 'unloaded' });
		window.dispatchEvent(new Event('unload'));
		await expect(unloaded).rejects.toThrow('panel unloaded');
	});
});
