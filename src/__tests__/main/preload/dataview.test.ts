/**
 * Tests for the Dataview preload API (`window.maestro.dataview`): one request object per channel, and a
 * `dataview:changed` subscription that hands over the event and unsubscribes cleanly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { createDataviewApi } from '../../../main/preload/dataview';

describe('Dataview Preload API', () => {
	let api: ReturnType<typeof createDataviewApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createDataviewApi();
	});

	it('sends a block query as one request object', async () => {
		const request = { filePath: '/vault/A.md', source: 'LIST', agentId: 'agent-1' };
		mockInvoke.mockResolvedValue({ root: '/vault', revision: 1, result: { kind: 'list' } });
		await api.query(request);
		expect(mockInvoke).toHaveBeenCalledWith('dataview:query', request);
	});

	it('sends an inline query as one request object', async () => {
		const request = { filePath: '/vault/A.md', expression: '= 1 + 1', agentId: 'agent-1' };
		await api.queryInline(request);
		expect(mockInvoke).toHaveBeenCalledWith('dataview:queryInline', request);
	});

	it('asks for every open root when status gets no request', async () => {
		await api.status();
		expect(mockInvoke).toHaveBeenCalledWith('dataview:status', {});
		await api.status({ root: '/vault' });
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:status', { root: '/vault' });
	});

	it('rebuilds a root', async () => {
		await api.rebuild({ root: '/vault', agentId: 'agent-1' });
		expect(mockInvoke).toHaveBeenCalledWith('dataview:rebuild', {
			root: '/vault',
			agentId: 'agent-1',
		});
	});

	it('asks for the DataviewJS snapshot and in-root reads on their own channels', async () => {
		const snapshotRequest = { filePath: '/vault/A.md', agentId: 'agent-1' };
		await api.jsSnapshot(snapshotRequest);
		expect(mockInvoke).toHaveBeenCalledWith('dataview:jsSnapshot', snapshotRequest);

		const readRequest = { ...snapshotRequest, path: 'data/people.csv' };
		await api.readInRoot(readRequest);
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:readInRoot', readRequest);
	});

	it('asks for the trust gate on its own channels', async () => {
		const note = { filePath: '/vault/A.md', agentId: 'agent-1' };
		await api.jsRoot(note);
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:jsRoot', note);
		await api.jsRunOnce(note);
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:jsRunOnce', note);
		await api.trustedRoots();
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:trustedRoots');
		await api.trust({ root: '/vault' });
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:trust', { root: '/vault' });
		await api.untrust({ root: '/vault' });
		expect(mockInvoke).toHaveBeenLastCalledWith('dataview:untrust', { root: '/vault' });
	});

	it('subscribes to dataview:changed and unsubscribes the same listener', () => {
		const handler = vi.fn();
		const unsubscribe = api.onChanged(handler);

		expect(mockOn).toHaveBeenCalledWith('dataview:changed', expect.any(Function));
		const listener = mockOn.mock.calls[0][1] as (event: unknown, change: unknown) => void;
		const change = { root: '/vault', sshRemoteId: null, revision: 2, changedPaths: ['A.md'] };
		listener({}, change);
		expect(handler).toHaveBeenCalledWith(change);

		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('dataview:changed', listener);
	});
});
