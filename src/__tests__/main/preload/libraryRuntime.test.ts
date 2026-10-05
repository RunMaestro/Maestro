import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createLibraryRuntimeApi } from '../../../main/preload/libraryRuntime';

describe('Library runtime preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('asks main for the hosting status over its own channel', async () => {
		mockInvoke.mockResolvedValue({ hosting: true });
		await expect(createLibraryRuntimeApi().status()).resolves.toEqual({ hosting: true });
		expect(mockInvoke).toHaveBeenCalledWith('libraryRuntime:status');
	});

	it('reads the snapshot, sends a command, and sends a fold over their own channels', async () => {
		mockInvoke.mockResolvedValue('answer');
		const api = createLibraryRuntimeApi();
		await expect(api.snapshot()).resolves.toBe('answer');
		expect(mockInvoke).toHaveBeenLastCalledWith('libraryRuntime:snapshot');
		const request = { commandId: 'c', command: { method: 'agents.remove', agentId: 'a' } } as const;
		await api.command(request);
		expect(mockInvoke).toHaveBeenLastCalledWith('libraryRuntime:command', request);
		const fold = { agents: [] };
		await api.fold(fold);
		expect(mockInvoke).toHaveBeenLastCalledWith('libraryRuntime:fold', fold);
	});

	it('delivers a forwarded runtime event to the listener, without the IPC event object', () => {
		const listener = vi.fn();
		createLibraryRuntimeApi().onEvent(listener);

		const [channel, handler] = mockOn.mock.calls[0];
		expect(channel).toBe('libraryRuntime:event');

		const message = { event: { type: 'agent.removed', agentId: 'a1' } };
		handler({ sender: 'ipc' }, message);
		expect(listener).toHaveBeenCalledWith(message);
	});

	it('removes exactly the handler it added when unsubscribed', () => {
		const stop = createLibraryRuntimeApi().onEvent(vi.fn());
		const handler = mockOn.mock.calls[0][1];

		stop();
		expect(mockRemoveListener).toHaveBeenCalledWith('libraryRuntime:event', handler);
	});
});
