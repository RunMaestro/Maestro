import { beforeEach, describe, expect, it, vi } from 'vitest';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

const { listeners, mockOn, mockRemoveListener } = vi.hoisted(() => {
	const listeners = new Map<string, Set<IpcListener>>();
	const mockOn = vi.fn((channel: string, listener: IpcListener) => {
		const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
		channelListeners.add(listener);
		listeners.set(channel, channelListeners);
	});
	const mockRemoveListener = vi.fn((channel: string, listener: IpcListener) => {
		listeners.get(channel)?.delete(listener);
	});

	return { listeners, mockOn, mockRemoveListener };
});

vi.mock('electron', () => ({
	ipcRenderer: {
		on: mockOn,
		removeListener: mockRemoveListener,
	},
}));

import { subscribeIpc } from '../../../main/preload/ipcSubscription';

function emit(channel: string, ...args: unknown[]): void {
	for (const listener of listeners.get(channel) ?? []) {
		listener({}, ...args);
	}
}

describe('subscribeIpc', () => {
	beforeEach(() => {
		listeners.clear();
		vi.clearAllMocks();
	});

	it('keeps multiple subscribers isolated on the same channel', () => {
		const first = vi.fn();
		const second = vi.fn();
		const unsubscribeFirst = subscribeIpc<[string]>('test:message', first);
		subscribeIpc<[string]>('test:message', second);

		emit('test:message', 'before-unsubscribe');
		unsubscribeFirst();
		emit('test:message', 'after-unsubscribe');

		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenLastCalledWith('before-unsubscribe');
		expect(second).toHaveBeenCalledTimes(2);
	});

	it('removes the exact wrapper once and ignores a late queued event after unsubscribe', () => {
		const callback = vi.fn();
		const unrelatedListener = vi.fn();
		listeners.set('test:message', new Set([unrelatedListener]));
		const unsubscribe = subscribeIpc<[string]>('test:message', callback);
		const registeredWrapper = mockOn.mock.calls[0][1] as IpcListener;

		unsubscribe();
		unsubscribe();
		registeredWrapper({}, 'late');
		emit('test:message', 'still-active');

		expect(mockRemoveListener).toHaveBeenCalledTimes(1);
		expect(mockRemoveListener).toHaveBeenCalledWith('test:message', registeredWrapper);
		expect(callback).not.toHaveBeenCalled();
		expect(unrelatedListener).toHaveBeenCalledWith({}, 'still-active');
	});

	it('does not invoke callers after a destroyed renderer unsubscribes', () => {
		const callback = vi.fn();
		const unsubscribe = subscribeIpc<[string]>('test:message', callback);
		const registeredWrapper = mockOn.mock.calls[0][1] as IpcListener;

		unsubscribe();
		registeredWrapper({ sender: { isDestroyed: () => true } }, 'queued-after-destruction');

		expect(callback).not.toHaveBeenCalled();
	});
});
