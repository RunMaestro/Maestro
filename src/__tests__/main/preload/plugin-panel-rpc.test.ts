// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToHost, listeners } = vi.hoisted(() => ({
	sendToHost: vi.fn(),
	listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
}));
vi.mock('electron', () => ({
	ipcRenderer: {
		sendToHost,
		on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
			listeners.set(channel, listener);
		}),
	},
}));

import '../../../main/preload/plugin-panel';

const INSTANCE = 'instance-capability-0001';

function fromPanel(data: unknown): void {
	const event = new MessageEvent('message', { data });
	Object.defineProperty(event, 'source', { value: window });
	window.dispatchEvent(event);
}

function fromHost(channel: string, payload: unknown): void {
	const listener = listeners.get(channel);
	if (!listener) throw new Error(`missing host listener: ${channel}`);
	listener({}, payload);
}

beforeEach(() => {
	sendToHost.mockClear();
	fromHost('maestro:panel-init', { instanceId: INSTANCE, generation: 1 });
});

describe('closed plugin panel RPC preload transport', () => {
	it('forwards only a correlated allowlisted tool request for the current host-issued instance', () => {
		fromPanel({
			type: 'maestro:panel-request',
			instanceId: INSTANCE,
			requestId: 7,
			method: 'tool.invoke',
			payload: { localId: 'refresh', args: { limit: 3 } },
		});

		expect(sendToHost).toHaveBeenCalledWith('maestro:panel-request', {
			instanceId: INSTANCE,
			requestId: 7,
			method: 'tool.invoke',
			payload: { localId: 'refresh', args: { limit: 3 } },
		});
	});

	it('drops stale instances, arbitrary methods, oversized payloads, and more than 32 pending requests', () => {
		fromPanel({
			type: 'maestro:panel-request',
			instanceId: 'stale-instance',
			requestId: 1,
			method: 'tool.invoke',
			payload: { localId: 'refresh' },
		});
		fromPanel({
			type: 'maestro:panel-request',
			instanceId: INSTANCE,
			requestId: 2,
			method: 'anything.forward',
			payload: { localId: 'refresh' },
		});
		fromPanel({
			type: 'maestro:panel-request',
			instanceId: INSTANCE,
			requestId: 3,
			method: 'tool.invoke',
			payload: { localId: 'refresh', args: 'x'.repeat(65 * 1024) },
		});
		for (let requestId = 10; requestId < 43; requestId += 1) {
			fromPanel({
				type: 'maestro:panel-request',
				instanceId: INSTANCE,
				requestId,
				method: 'tool.invoke',
				payload: { localId: 'refresh' },
			});
		}

		expect(sendToHost).toHaveBeenCalledTimes(32);
	});

	it('delivers only subscribed host events and releases pending requests on correlated result or error', async () => {
		const observed: unknown[] = [];
		window.addEventListener('message', (event) => observed.push(event.data), { once: false });
		fromPanel({
			type: 'maestro:panel-subscribe',
			instanceId: INSTANCE,
			topic: 'workspace.context',
		});
		for (const requestId of [10, 11]) {
			fromPanel({
				type: 'maestro:panel-request',
				instanceId: INSTANCE,
				requestId,
				method: 'tool.invoke',
				payload: { localId: 'refresh' },
			});
		}
		fromHost('maestro:panel-event', {
			instanceId: INSTANCE,
			topic: 'workspace.context',
			payload: { selected: 'a' },
		});
		fromHost('maestro:panel-event', {
			instanceId: INSTANCE,
			topic: 'arbitrary.topic',
			payload: { selected: 'b' },
		});
		fromHost('maestro:panel-result', { instanceId: INSTANCE, requestId: 10, result: { ok: true } });
		fromHost('maestro:panel-error', { instanceId: INSTANCE, requestId: 11, error: 'denied' });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		expect(observed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'maestro:panel-event', topic: 'workspace.context' }),
				expect.objectContaining({ type: 'maestro:panel-result', requestId: 10 }),
				expect.objectContaining({ type: 'maestro:panel-error', requestId: 11 }),
			])
		);
		expect(observed).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ topic: 'arbitrary.topic' })])
		);
	});

	it('cleans subscriptions and pending requests when the panel unloads', () => {
		fromPanel({
			type: 'maestro:panel-subscribe',
			instanceId: INSTANCE,
			topic: 'workspace.context',
		});
		window.dispatchEvent(new Event('unload'));
		fromHost('maestro:panel-event', {
			instanceId: INSTANCE,
			topic: 'workspace.context',
			payload: { selected: 'a' },
		});

		expect(sendToHost).toHaveBeenCalledWith('maestro:panel-unsubscribe-all', {
			instanceId: INSTANCE,
		});
	});
});
