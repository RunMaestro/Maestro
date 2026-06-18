import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Track registered handlers
const registeredHandlers = new Map<string, Function>();

// Mock ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: Function) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

// Mock app
const mockApp = {
	getPath: vi.fn().mockReturnValue(path.resolve('/mock/userData')),
};

// Mock fs/promises module
vi.mock('fs/promises', () => ({
	default: {
		mkdir: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
		readdir: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

import { registerAttachmentsHandlers } from '../../../../main/ipc/handlers/attachments';
import fs from 'fs/promises';

describe('attachments handlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();
		registerAttachmentsHandlers({ app: mockApp as any });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('handler registration', () => {
		it('should register all attachments handlers', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith('attachments:save', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('attachments:load', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('attachments:delete', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('attachments:list', expect.any(Function));
			expect(ipcMain.handle).toHaveBeenCalledWith('attachments:getPath', expect.any(Function));
		});
	});

	describe('attachments:save', () => {
		it('should save attachment with data URL prefix', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('attachments:save');
			const base64Data =
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
			const result = await handler!({}, 'session-123', base64Data, 'test-image');

			expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining('attachments'), {
				recursive: true,
			});
			expect(fs.writeFile).toHaveBeenCalled();
			expect(result.success).toBe(true);
			expect(result.filename).toBe('test-image.png');
		});

		it('should save raw base64 attachment', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('attachments:save');
			const rawBase64 =
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
			const result = await handler!({}, 'session-123', rawBase64, 'image.png');

			expect(result.success).toBe(true);
			expect(result.filename).toBe('image.png');
		});

		it('should handle save errors gracefully', async () => {
			vi.mocked(fs.mkdir).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('attachments:save');
			const result = await handler!({}, 'session-123', 'data:image/png;base64,abc', 'test');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
		});
	});

	describe('attachments:load', () => {
		it('should load attachment and return as data URL', async () => {
			const mockBuffer = Buffer.from('fake-image-data');
			vi.mocked(fs.readFile).mockResolvedValue(mockBuffer as any);

			const handler = registeredHandlers.get('attachments:load');
			const result = await handler!({}, 'session-123', 'image.png');

			expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('session-123'));
			expect(result.success).toBe(true);
			expect(result.dataUrl).toMatch(/^data:image\/png;base64,/);
		});

		it('should detect correct MIME type from extension', async () => {
			const mockBuffer = Buffer.from('fake-image-data');
			vi.mocked(fs.readFile).mockResolvedValue(mockBuffer as any);

			const handler = registeredHandlers.get('attachments:load');

			// Test JPEG
			const jpegResult = await handler!({}, 'session-123', 'photo.jpg');
			expect(jpegResult.dataUrl).toMatch(/^data:image\/jpeg;base64,/);

			// Test GIF
			const gifResult = await handler!({}, 'session-123', 'animation.gif');
			expect(gifResult.dataUrl).toMatch(/^data:image\/gif;base64,/);

			// Test SVG
			const svgResult = await handler!({}, 'session-123', 'icon.svg');
			expect(svgResult.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
		});

		it('should handle load errors gracefully', async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));

			const handler = registeredHandlers.get('attachments:load');
			const result = await handler!({}, 'session-123', 'missing.png');

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});
	});

	describe('attachments:delete', () => {
		it('should delete attachment file', async () => {
			vi.mocked(fs.unlink).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('attachments:delete');
			const result = await handler!({}, 'session-123', 'image.png');

			expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('image.png'));
			expect(result.success).toBe(true);
		});

		it('should handle delete errors gracefully', async () => {
			vi.mocked(fs.unlink).mockRejectedValue(new Error('File not found'));

			const handler = registeredHandlers.get('attachments:delete');
			const result = await handler!({}, 'session-123', 'missing.png');

			expect(result.success).toBe(false);
			expect(result.error).toContain('File not found');
		});
	});

	describe('attachments:list', () => {
		it('should list image files in attachments directory', async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				'image1.png',
				'image2.jpg',
				'document.pdf', // Should be filtered out
				'animation.gif',
				'readme.txt', // Should be filtered out
			] as any);

			const handler = registeredHandlers.get('attachments:list');
			const result = await handler!({}, 'session-123');

			expect(result.success).toBe(true);
			expect(result.files).toHaveLength(3);
			expect(result.files).toContain('image1.png');
			expect(result.files).toContain('image2.jpg');
			expect(result.files).toContain('animation.gif');
			expect(result.files).not.toContain('document.pdf');
			expect(result.files).not.toContain('readme.txt');
		});

		it('should return empty array when directory does not exist', async () => {
			const error: any = new Error('ENOENT');
			error.code = 'ENOENT';
			vi.mocked(fs.readdir).mockRejectedValue(error);

			const handler = registeredHandlers.get('attachments:list');
			const result = await handler!({}, 'session-123');

			expect(result.success).toBe(true);
			expect(result.files).toEqual([]);
		});

		it('should handle other errors gracefully', async () => {
			vi.mocked(fs.readdir).mockRejectedValue(new Error('Permission denied'));

			const handler = registeredHandlers.get('attachments:list');
			const result = await handler!({}, 'session-123');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
			expect(result.files).toEqual([]);
		});
	});

	describe('attachments:getPath', () => {
		it('should return the attachments directory path', async () => {
			const handler = registeredHandlers.get('attachments:getPath');
			const result = await handler!({}, 'session-123');

			expect(result.success).toBe(true);
			expect(result.path).toContain('attachments');
			expect(result.path).toContain('session-123');
		});
	});

	describe('sessionId path traversal protection', () => {
		it('should reject sessionId with path traversal in save', async () => {
			const handler = registeredHandlers.get('attachments:save');
			const result = await handler!(
				{},
				'../../../../../../../tmp',
				'data:image/png;base64,abc',
				'evil.png'
			);

			expect(result.success).toBe(false);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('should reject sessionId with directory separators in save', async () => {
			const handler = registeredHandlers.get('attachments:save');
			const result = await handler!(
				{},
				'../../etc/passwd',
				'data:image/png;base64,abc',
				'evil.png'
			);

			expect(result.success).toBe(false);
			expect(fs.writeFile).not.toHaveBeenCalled();
		});

		it('should reject path traversal in load', async () => {
			const handler = registeredHandlers.get('attachments:load');
			const result = await handler!({}, '../../../tmp', 'image.png');

			expect(result.success).toBe(false);
			expect(fs.readFile).not.toHaveBeenCalled();
		});

		it('should reject path traversal in delete', async () => {
			const handler = registeredHandlers.get('attachments:delete');
			const result = await handler!({}, '../../../tmp', 'image.png');

			expect(result.success).toBe(false);
			expect(fs.unlink).not.toHaveBeenCalled();
		});

		it('should reject path traversal in list', async () => {
			const handler = registeredHandlers.get('attachments:list');
			const result = await handler!({}, '../../../tmp');

			expect(result.success).toBe(false);
		});

		it('should allow valid UUID-style sessionId', async () => {
			vi.mocked(fs.mkdir).mockResolvedValue(undefined);
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			const handler = registeredHandlers.get('attachments:save');
			const result = await handler!(
				{},
				'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
				'test.png'
			);

			expect(result.success).toBe(true);
		});
	});
});
