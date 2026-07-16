import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const { listeners, mockOn, mockRemoveListener, mockSend } = vi.hoisted(() => {
	const listeners = new Map<string, Set<IpcListener>>();
	const mockOn = vi.fn((channel: string, listener: IpcListener) => {
		const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
		channelListeners.add(listener);
		listeners.set(channel, channelListeners);
	});
	const mockRemoveListener = vi.fn((channel: string, listener: IpcListener) => {
		listeners.get(channel)?.delete(listener);
	});
	const mockSend = vi.fn();
	return { listeners, mockOn, mockRemoveListener, mockSend };
});

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: vi.fn(),
		on: mockOn,
		removeListener: mockRemoveListener,
		send: mockSend,
	},
}));

import { createCoworkingApi } from '../../../main/preload/coworking';

const bufferChannel = 'coworking:response:buffer:00000000-0000-0000-0000-000000000001';
const browserChannel = 'coworking:response:browser-op:00000000-0000-0000-0000-000000000002';

function emit(channel: string, ...args: unknown[]): void {
	for (const listener of listeners.get(channel) ?? []) {
		listener({}, ...args);
	}
}

describe('coworking preload response channels', () => {
	beforeEach(() => {
		listeners.clear();
		vi.clearAllMocks();
	});

	it('exposes only minted buffer channels and consumes each response channel once', () => {
		const api = createCoworkingApi();
		const onRequest = vi.fn();
		api.onRequestBuffer(onRequest);

		emit('coworking:requestBuffer', 'tab', 'session', 'coworking:bufferResponse:1');
		expect(onRequest).not.toHaveBeenCalled();

		emit('coworking:requestBuffer', 'tab', 'session', bufferChannel);
		expect(onRequest).toHaveBeenCalledWith('tab', 'session', bufferChannel);

		api.sendBufferResponse(bufferChannel, 'scrollback');
		api.sendBufferResponse(bufferChannel, 'duplicate');
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledWith(bufferChannel, 'scrollback', undefined);
	});

	it('keeps buffer and browser response channels separate and cleans subscriptions exactly', () => {
		const api = createCoworkingApi();
		const onBrowserRequest = vi.fn();
		const unsubscribe = api.onRequestBrowserOp(onBrowserRequest);
		const wrapper = mockOn.mock.calls[0][1] as IpcListener;

		emit('coworking:requestBrowserOp', 'tab', 'session', { kind: 'back' }, bufferChannel);
		expect(onBrowserRequest).not.toHaveBeenCalled();

		emit('coworking:requestBrowserOp', 'tab', 'session', { kind: 'back' }, browserChannel, false);
		expect(onBrowserRequest).toHaveBeenCalledWith(
			'tab',
			'session',
			{ kind: 'back' },
			browserChannel,
			false
		);

		unsubscribe();
		unsubscribe();
		wrapper({}, 'tab', 'session', { kind: 'back' }, browserChannel, false);
		api.sendBrowserOpResponse(browserChannel, { ok: true });
		expect(mockRemoveListener).toHaveBeenCalledTimes(1);
		expect(mockSend).not.toHaveBeenCalled();
	});
});
