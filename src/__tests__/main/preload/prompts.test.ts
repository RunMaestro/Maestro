// ABOUTME: Tests for the core prompts preload API.
// ABOUTME: Verifies that createPromptsApi correctly invokes IPC channels for get, getAll, getAllIds, save, and reset.

/**
 * Tests for prompts preload API
 *
 * Coverage:
 * - createPromptsApi: get, getAll, getAllIds, save, reset
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createPromptsApi } from '../../../main/preload/prompts';

describe('Prompts Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createPromptsApi', () => {
		let api: ReturnType<typeof createPromptsApi>;

		beforeEach(() => {
			api = createPromptsApi();
		});

		describe('get', () => {
			it('should invoke prompts:get with id', async () => {
				const response = { success: true, content: 'prompt content' };
				mockInvoke.mockResolvedValue(response);

				const result = await api.get('wizard-system');

				expect(mockInvoke).toHaveBeenCalledWith('prompts:get', 'wizard-system');
				expect(result).toEqual(response);
			});

			it('should handle error response', async () => {
				const response = { success: false, error: 'Prompts not yet initialized' };
				mockInvoke.mockResolvedValue(response);

				const result = await api.get('invalid');

				expect(result).toEqual(response);
			});
		});

		describe('getAll', () => {
			it('should invoke prompts:getAll', async () => {
				const response = {
					success: true,
					prompts: [
						{
							id: 'wizard-system',
							filename: 'wizard-system.md',
							description: 'Main wizard system prompt',
							category: 'wizard',
							content: 'wizard content',
							isModified: false,
						},
					],
				};
				mockInvoke.mockResolvedValue(response);

				const result = await api.getAll();

				expect(mockInvoke).toHaveBeenCalledWith('prompts:getAll');
				expect(result).toEqual(response);
			});
		});

		describe('getAllIds', () => {
			it('should invoke prompts:getAllIds', async () => {
				const response = { success: true, ids: ['wizard-system', 'autorun-default'] };
				mockInvoke.mockResolvedValue(response);

				const result = await api.getAllIds();

				expect(mockInvoke).toHaveBeenCalledWith('prompts:getAllIds');
				expect(result).toEqual(response);
			});
		});

		describe('save', () => {
			it('should invoke prompts:save with id and content', async () => {
				const response = { success: true };
				mockInvoke.mockResolvedValue(response);

				const result = await api.save('wizard-system', 'new content');

				expect(mockInvoke).toHaveBeenCalledWith('prompts:save', 'wizard-system', 'new content');
				expect(result).toEqual(response);
			});
		});

		describe('reset', () => {
			it('should invoke prompts:reset with id', async () => {
				const response = { success: true, content: 'bundled default' };
				mockInvoke.mockResolvedValue(response);

				const result = await api.reset('wizard-system');

				expect(mockInvoke).toHaveBeenCalledWith('prompts:reset', 'wizard-system');
				expect(result).toEqual(response);
			});
		});
	});
});
