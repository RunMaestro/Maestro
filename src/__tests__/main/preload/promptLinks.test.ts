/**
 * Prompt Links preload API. A verb pointed at the wrong channel, or one that
 * drops an argument, fails silently, so the mapping is pinned here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createPromptLinksApi } from '../../../main/preload/promptLinks';

describe('Prompt Links Preload API', () => {
	let api: ReturnType<typeof createPromptLinksApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		api = createPromptLinksApi();
	});

	it('exposes exactly the four verbs', () => {
		expect(Object.keys(api).sort()).toEqual(['create', 'list', 'rendererReady', 'revoke']);
	});

	it('maps each verb to its channel with its arguments', async () => {
		const input = { agentId: 'a', prompt: 'p' };
		await api.list();
		await api.create(input);
		await api.revoke('l1');
		await api.rendererReady();
		expect(mockInvoke.mock.calls).toEqual([
			['promptLinks:list'],
			['promptLinks:create', input],
			['promptLinks:revoke', 'l1'],
			['promptLinks:rendererReady'],
		]);
	});
});
