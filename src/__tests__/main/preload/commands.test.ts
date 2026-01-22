/**
 * Tests for commands preload API
 *
 * Coverage:
 * - createSpeckitApi: getMetadata, getPrompts, getCommand, savePrompt, resetPrompt, refresh
 * - createOpenspecApi: getMetadata, getPrompts, getCommand, savePrompt, resetPrompt, refresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createSpeckitApi, createOpenspecApi } from '../../../main/preload/commands';

describe('Commands Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('createSpeckitApi', () => {
		let api: ReturnType<typeof createSpeckitApi>;

		beforeEach(() => {
			api = createSpeckitApi();
		});

		describe('getMetadata', () => {
			it('should invoke speckit:getMetadata', async () => {
				const metadata = {
					success: true,
					metadata: {
						lastRefreshed: '2024-01-01',
						commitSha: 'abc123',
						sourceVersion: '1.0.0',
						sourceUrl: 'https://github.com/example/speckit',
					},
				};
				mockInvoke.mockResolvedValue(metadata);

				const result = await api.getMetadata();

				expect(mockInvoke).toHaveBeenCalledWith('speckit:getMetadata');
				expect(result).toEqual(metadata);
			});
		});

		describe('getPrompts', () => {
			it('should invoke speckit:getPrompts', async () => {
				const response = {
					success: true,
					commands: [
						{
							id: 'cmd-1',
							command: '/test',
							description: 'Test command',
							prompt: 'Test prompt',
							isCustom: false,
							isModified: false,
						},
					],
				};
				mockInvoke.mockResolvedValue(response);

				const result = await api.getPrompts();

				expect(mockInvoke).toHaveBeenCalledWith('speckit:getPrompts');
				expect(result).toEqual(response);
			});
		});

		describe('getCommand', () => {
			it('should invoke speckit:getCommand', async () => {
				const response = {
					success: true,
					command: {
						id: 'cmd-1',
						command: '/test',
						description: 'Test command',
						prompt: 'Test prompt',
						isCustom: false,
						isModified: false,
					},
				};
				mockInvoke.mockResolvedValue(response);

				const result = await api.getCommand('/test');

				expect(mockInvoke).toHaveBeenCalledWith('speckit:getCommand', '/test');
				expect(result).toEqual(response);
			});

			it('should handle command not found', async () => {
				mockInvoke.mockResolvedValue({ success: true, command: null });

				const result = await api.getCommand('/nonexistent');

				expect(result.command).toBeNull();
			});
		});

		describe('savePrompt', () => {
			it('should invoke speckit:savePrompt', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.savePrompt('cmd-1', 'Updated prompt content');

				expect(mockInvoke).toHaveBeenCalledWith(
					'speckit:savePrompt',
					'cmd-1',
					'Updated prompt content'
				);
				expect(result.success).toBe(true);
			});

			it('should handle save error', async () => {
				mockInvoke.mockResolvedValue({ success: false, error: 'Failed to save' });

				const result = await api.savePrompt('cmd-1', 'content');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Failed to save');
			});
		});

		describe('resetPrompt', () => {
			it('should invoke speckit:resetPrompt', async () => {
				mockInvoke.mockResolvedValue({ success: true, prompt: 'Original prompt' });

				const result = await api.resetPrompt('cmd-1');

				expect(mockInvoke).toHaveBeenCalledWith('speckit:resetPrompt', 'cmd-1');
				expect(result.success).toBe(true);
				expect(result.prompt).toBe('Original prompt');
			});
		});

		describe('refresh', () => {
			it('should invoke speckit:refresh', async () => {
				const metadata = {
					success: true,
					metadata: {
						lastRefreshed: '2024-01-02',
						commitSha: 'def456',
						sourceVersion: '1.0.1',
						sourceUrl: 'https://github.com/example/speckit',
					},
				};
				mockInvoke.mockResolvedValue(metadata);

				const result = await api.refresh();

				expect(mockInvoke).toHaveBeenCalledWith('speckit:refresh');
				expect(result).toEqual(metadata);
			});
		});
	});

	describe('createOpenspecApi', () => {
		let api: ReturnType<typeof createOpenspecApi>;

		beforeEach(() => {
			api = createOpenspecApi();
		});

		describe('getMetadata', () => {
			it('should invoke openspec:getMetadata', async () => {
				const metadata = {
					success: true,
					metadata: {
						lastRefreshed: '2024-01-01',
						commitSha: 'abc123',
						sourceVersion: '1.0.0',
						sourceUrl: 'https://github.com/example/openspec',
					},
				};
				mockInvoke.mockResolvedValue(metadata);

				const result = await api.getMetadata();

				expect(mockInvoke).toHaveBeenCalledWith('openspec:getMetadata');
				expect(result).toEqual(metadata);
			});
		});

		describe('getPrompts', () => {
			it('should invoke openspec:getPrompts', async () => {
				const response = {
					success: true,
					commands: [
						{
							id: 'spec-1',
							command: '/spec',
							description: 'Spec command',
							prompt: 'Spec prompt',
							isCustom: false,
							isModified: false,
						},
					],
				};
				mockInvoke.mockResolvedValue(response);

				const result = await api.getPrompts();

				expect(mockInvoke).toHaveBeenCalledWith('openspec:getPrompts');
				expect(result).toEqual(response);
			});
		});

		describe('getCommand', () => {
			it('should invoke openspec:getCommand', async () => {
				const response = {
					success: true,
					command: {
						id: 'spec-1',
						command: '/spec',
						description: 'Spec command',
						prompt: 'Spec prompt',
						isCustom: false,
						isModified: false,
					},
				};
				mockInvoke.mockResolvedValue(response);

				const result = await api.getCommand('/spec');

				expect(mockInvoke).toHaveBeenCalledWith('openspec:getCommand', '/spec');
				expect(result).toEqual(response);
			});
		});

		describe('savePrompt', () => {
			it('should invoke openspec:savePrompt', async () => {
				mockInvoke.mockResolvedValue({ success: true });

				const result = await api.savePrompt('spec-1', 'Updated spec prompt');

				expect(mockInvoke).toHaveBeenCalledWith(
					'openspec:savePrompt',
					'spec-1',
					'Updated spec prompt'
				);
				expect(result.success).toBe(true);
			});
		});

		describe('resetPrompt', () => {
			it('should invoke openspec:resetPrompt', async () => {
				mockInvoke.mockResolvedValue({ success: true, prompt: 'Original spec prompt' });

				const result = await api.resetPrompt('spec-1');

				expect(mockInvoke).toHaveBeenCalledWith('openspec:resetPrompt', 'spec-1');
				expect(result.success).toBe(true);
				expect(result.prompt).toBe('Original spec prompt');
			});
		});

		describe('refresh', () => {
			it('should invoke openspec:refresh', async () => {
				const metadata = {
					success: true,
					metadata: {
						lastRefreshed: '2024-01-02',
						commitSha: 'xyz789',
						sourceVersion: '2.0.0',
						sourceUrl: 'https://github.com/example/openspec',
					},
				};
				mockInvoke.mockResolvedValue(metadata);

				const result = await api.refresh();

				expect(mockInvoke).toHaveBeenCalledWith('openspec:refresh');
				expect(result).toEqual(metadata);
			});
		});
	});
});
