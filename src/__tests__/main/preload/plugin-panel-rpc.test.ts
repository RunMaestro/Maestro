// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const INSTANCE = 'instance-capability-0001';

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
	const call = exposeInMainWorld.mock.calls.find(([name]) => name === 'maestroInteractivePanel');
	if (!call) throw new Error('guest API was not exposed');
	return call[1] as GuestApi;
}

beforeEach(() => {
	sendToHost.mockClear();
	fromHost('maestro:panel-init', { instanceId: INSTANCE, generation: 1 });
});

describe('closed plugin panel guest API', () => {
	it('exposes only frozen request/subscribe methods and correlates an exact request response', async () => {
		const api = guestApi();
		expect(Object.isFrozen(api)).toBe(true);
		expect(Object.keys(api).sort()).toEqual(['request', 'subscribe']);
		const result = api.request('ping', { value: 1 });
		expect(sendToHost).toHaveBeenCalledWith('maestro:panel-request', {
			instanceId: INSTANCE,
			requestId: 1,
			kind: 'ping',
			payload: { value: 1 },
		});
		fromHost('maestro:panel-result', {
			instanceId: INSTANCE,
			requestId: 1,
			kind: 'ping',
			payload: { ok: true },
		});
		await expect(result).resolves.toEqual({ ok: true });
	});

	it('delivers only subscribed descriptor events and releases subscriptions on dispose', () => {
		const api = guestApi();
		const listener = vi.fn();
		const dispose = api.subscribe('status', listener);
		expect(sendToHost).toHaveBeenCalledWith('maestro:panel-subscribe', {
			instanceId: INSTANCE,
			kind: 'status',
		});
		fromHost('maestro:panel-event', {
			instanceId: INSTANCE,
			kind: 'status',
			payload: { ready: true },
		});
		expect(listener).toHaveBeenCalledWith({ ready: true });
		dispose();
		expect(sendToHost).toHaveBeenLastCalledWith('maestro:panel-unsubscribe', {
			instanceId: INSTANCE,
			kind: 'status',
		});
	});
});
