import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: invokeMock,
	},
}));

import { createPromptsApi } from '../../main/preload/prompts';

describe('prompts preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('uses the registered read-only prompts channels without exposing new ones', async () => {
		invokeMock.mockResolvedValue({ success: true });
		const prompts = createPromptsApi();

		await prompts.getPath();
		await prompts.listFiles();

		expect(invokeMock).toHaveBeenNthCalledWith(1, 'prompts:getPath');
		expect(invokeMock).toHaveBeenNthCalledWith(2, 'prompts:listFiles');
	});
});
