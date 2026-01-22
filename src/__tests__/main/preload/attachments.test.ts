/**
 * Tests for attachments preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createAttachmentsApi } from '../../../main/preload/attachments';

describe('Attachments Preload API', () => {
	let api: ReturnType<typeof createAttachmentsApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createAttachmentsApi();
	});

	describe('save', () => {
		it('should invoke attachments:save with sessionId, base64Data, and filename', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				path: '/path/to/file',
				filename: 'image.png',
			});

			const result = await api.save('session-123', 'base64data', 'image.png');

			expect(mockInvoke).toHaveBeenCalledWith(
				'attachments:save',
				'session-123',
				'base64data',
				'image.png'
			);
			expect(result.success).toBe(true);
			expect(result.path).toBe('/path/to/file');
			expect(result.filename).toBe('image.png');
		});

		it('should handle errors', async () => {
			mockInvoke.mockResolvedValue({ success: false, error: 'Save failed' });

			const result = await api.save('session-123', 'base64data', 'image.png');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Save failed');
		});
	});

	describe('load', () => {
		it('should invoke attachments:load with sessionId and filename', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				dataUrl: 'data:image/png;base64,abc123',
			});

			const result = await api.load('session-123', 'image.png');

			expect(mockInvoke).toHaveBeenCalledWith('attachments:load', 'session-123', 'image.png');
			expect(result.success).toBe(true);
			expect(result.dataUrl).toBe('data:image/png;base64,abc123');
		});

		it('should handle missing files', async () => {
			mockInvoke.mockResolvedValue({ success: false, error: 'File not found' });

			const result = await api.load('session-123', 'nonexistent.png');

			expect(result.success).toBe(false);
			expect(result.error).toBe('File not found');
		});
	});

	describe('delete', () => {
		it('should invoke attachments:delete with sessionId and filename', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.delete('session-123', 'image.png');

			expect(mockInvoke).toHaveBeenCalledWith('attachments:delete', 'session-123', 'image.png');
			expect(result.success).toBe(true);
		});
	});

	describe('list', () => {
		it('should invoke attachments:list with sessionId', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				files: ['image1.png', 'image2.jpg'],
			});

			const result = await api.list('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('attachments:list', 'session-123');
			expect(result.success).toBe(true);
			expect(result.files).toEqual(['image1.png', 'image2.jpg']);
		});

		it('should return empty array when no files exist', async () => {
			mockInvoke.mockResolvedValue({ success: true, files: [] });

			const result = await api.list('session-123');

			expect(result.files).toEqual([]);
		});
	});

	describe('getPath', () => {
		it('should invoke attachments:getPath with sessionId', async () => {
			mockInvoke.mockResolvedValue({
				success: true,
				path: '/home/user/.maestro/attachments/session-123',
			});

			const result = await api.getPath('session-123');

			expect(mockInvoke).toHaveBeenCalledWith('attachments:getPath', 'session-123');
			expect(result.success).toBe(true);
			expect(result.path).toBe('/home/user/.maestro/attachments/session-123');
		});
	});
});
