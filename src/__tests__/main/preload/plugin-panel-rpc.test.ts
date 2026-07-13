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
	stageResource(name: string, mediaType: string, bytes: Uint8Array): Promise<unknown>;
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
	fromHost('maestro:panel-init', { instanceId: INSTANCE, generation: '2' });
});

describe('closed plugin panel guest API', () => {
	it('exposes only frozen request/subscribe methods and correlates an exact request response', async () => {
		const api = guestApi();
		expect(Object.isFrozen(api)).toBe(true);
		expect(Object.keys(api).sort()).toEqual(['request', 'stageResource', 'subscribe']);
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

	it('stages bytes on the dedicated channel and accepts only a matching opaque resource response', async () => {
		const api = guestApi();
		const staged = api.stageResource('image.png', 'image/png', new Uint8Array([1, 2, 3]));
		expect(sendToHost).toHaveBeenLastCalledWith('maestro:panel-stage-resource', {
			instanceId: INSTANCE,
			stageId: 1,
			name: 'image.png',
			mediaType: 'image/png',
			bytes: new Uint8Array([1, 2, 3]),
		});
		fromHost('maestro:panel-resource-staged', {
			instanceId: INSTANCE,
			stageId: 1,
			resource: {
				ref: 'a3a2c574-aeb6-4ba7-9634-4f8ddbe8e1e8',
				name: 'image.png',
				mediaType: 'image/png',
				size: 3,
				sha256: 'a'.repeat(64),
			},
		});
		await expect(staged).resolves.toEqual({
			ref: 'a3a2c574-aeb6-4ba7-9634-4f8ddbe8e1e8',
			name: 'image.png',
			mediaType: 'image/png',
			size: 3,
			sha256: 'a'.repeat(64),
		});
		await expect(
			api.stageResource('large.png', 'image/png', new Uint8Array(2 * 1024 * 1024 + 1))
		).rejects.toThrow('interactive panel resource capability unavailable');
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

	it('fails closed when malformed, overflowing, or stale INIT invalidates its authority', async () => {
		const api = guestApi();
		const pending = api.request('ping', {});
		sendToHost.mockClear();
		fromHost('maestro:panel-init', { instanceId: 'malformed-instance-0001', generation: '02' });
		await expect(pending).rejects.toThrow('panel init rejected');
		fromHost('maestro:panel-init', {
			instanceId: 'overflow-instance-0001',
			generation: '18446744073709551616',
		});
		fromHost('maestro:panel-init', { instanceId: 'stale-instance-0001', generation: '1' });
		expect(sendToHost).not.toHaveBeenCalled();
	});
});
