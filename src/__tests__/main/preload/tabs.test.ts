import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createTabsApi } from '../../../main/preload/tabs';

describe('Tabs Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('notifies main that an AI tab closed, fire-and-forget', () => {
		const api = createTabsApi();

		const result = api.notifyAiTabClosed('agent-1', 'tab-7');

		expect(mockSend).toHaveBeenCalledWith('tabs:aiTabClosed', 'agent-1', 'tab-7');
		// send() is one-way: nothing to await, nothing to unwrap.
		expect(result).toBeUndefined();
	});
});
