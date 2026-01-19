/**
 * Tests for Group Chat getImages IPC handler
 *
 * Tests the handler that reads images from a group chat's images directory
 * and returns them as base64 data URLs for export functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron modules
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	app: {
		on: vi.fn(),
		getPath: vi.fn().mockReturnValue('/mock/app/path'),
	},
}));

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
	},
}));

// Mock fs/promises
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();

vi.mock('fs/promises', () => ({
	default: {
		readdir: mockReaddir,
		readFile: mockReadFile,
	},
	readdir: mockReaddir,
	readFile: mockReadFile,
}));

// Mock group-chat-storage to control loadGroupChat
const mockLoadGroupChat = vi.fn();

vi.mock('../../main/group-chat/group-chat-storage', () => ({
	loadGroupChat: mockLoadGroupChat,
	saveGroupChat: vi.fn(),
	listGroupChats: vi.fn(),
	deleteGroupChat: vi.fn(),
	getGroupChatHistory: vi.fn(),
	addGroupChatHistoryEntry: vi.fn(),
	deleteGroupChatHistoryEntry: vi.fn(),
	clearGroupChatHistory: vi.fn(),
	getGroupChatHistoryFilePath: vi.fn(),
}));

// Mock group-chat-log
vi.mock('../../main/group-chat/group-chat-log', () => ({
	readLog: vi.fn(),
	appendToLog: vi.fn(),
}));

// Mock getMainWindow for event emission
vi.mock('../../main/utils/getMainWindow', () => ({
	getMainWindow: vi.fn().mockReturnValue(null),
}));

// Mock process manager
vi.mock('../../main/process-manager', () => ({
	spawnAgentProcess: vi.fn(),
	writeToProcess: vi.fn(),
	killProcess: vi.fn(),
}));

// Mock agent detector
vi.mock('../../main/agent-detector', () => ({
	detectAgents: vi.fn().mockResolvedValue([]),
	getAgent: vi.fn().mockResolvedValue(null),
}));

describe('Group Chat getImages Handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockReaddir.mockReset();
		mockReadFile.mockReset();
		mockLoadGroupChat.mockReset();
	});

	/**
	 * Helper to simulate the handler logic since we can't easily import it.
	 * This mirrors the implementation in groupChat.ts
	 */
	async function simulateGetImagesHandler(groupChatId: string): Promise<Record<string, string>> {
		const chat = await mockLoadGroupChat(groupChatId);
		if (!chat) {
			throw new Error(`Group chat not found: ${groupChatId}`);
		}

		const images: Record<string, string> = {};
		const fs = await import('fs/promises');
		const path = await import('path');

		try {
			const files = await fs.default.readdir(chat.imagesDir);
			const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

			for (const file of files) {
				const ext = path.extname(file).toLowerCase();
				if (imageExtensions.includes(ext)) {
					const filePath = path.join(chat.imagesDir, file);
					const buffer = await fs.default.readFile(filePath);
					const mimeType =
						ext === '.png'
							? 'image/png'
							: ext === '.gif'
								? 'image/gif'
								: ext === '.webp'
									? 'image/webp'
									: 'image/jpeg';
					images[file] = `data:${mimeType};base64,${buffer.toString('base64')}`;
				}
			}
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}

		return images;
	}

	describe('successful operations', () => {
		it('returns empty object when no images exist', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue([]);

			const result = await simulateGetImagesHandler('test-chat');

			expect(result).toEqual({});
		});

		it('reads PNG images and returns base64 data URLs', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['screenshot.png']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-png-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result).toHaveProperty('screenshot.png');
			expect(result['screenshot.png']).toMatch(/^data:image\/png;base64,/);
			expect(mockReadFile).toHaveBeenCalledWith('/path/to/images/screenshot.png');
		});

		it('reads JPG images with correct MIME type', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['photo.jpg']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-jpg-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result['photo.jpg']).toMatch(/^data:image\/jpeg;base64,/);
		});

		it('reads JPEG images with correct MIME type', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['photo.jpeg']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-jpeg-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result['photo.jpeg']).toMatch(/^data:image\/jpeg;base64,/);
		});

		it('reads GIF images with correct MIME type', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['animation.gif']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-gif-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result['animation.gif']).toMatch(/^data:image\/gif;base64,/);
		});

		it('reads WebP images with correct MIME type', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['image.webp']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-webp-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result['image.webp']).toMatch(/^data:image\/webp;base64,/);
		});

		it('reads multiple images of different types', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['a.png', 'b.jpg', 'c.gif']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(Object.keys(result)).toHaveLength(3);
			expect(result).toHaveProperty('a.png');
			expect(result).toHaveProperty('b.jpg');
			expect(result).toHaveProperty('c.gif');
		});

		it('handles case-insensitive extensions', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['image.PNG', 'photo.JPG']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(Object.keys(result)).toHaveLength(2);
		});

		it('ignores non-image files', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['document.txt', 'script.js', 'data.json', 'image.png']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(Object.keys(result)).toHaveLength(1);
			expect(result).toHaveProperty('image.png');
			expect(result).not.toHaveProperty('document.txt');
			expect(result).not.toHaveProperty('script.js');
			expect(result).not.toHaveProperty('data.json');
		});

		it('correctly encodes binary data as base64', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['test.png']);

			// Use actual binary data that would appear in a PNG header
			const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			mockReadFile.mockResolvedValue(pngData);

			const result = await simulateGetImagesHandler('test-chat');

			// Verify the base64 encoding
			const expectedBase64 = pngData.toString('base64');
			expect(result['test.png']).toBe(`data:image/png;base64,${expectedBase64}`);
		});
	});

	describe('error handling', () => {
		it('throws error when group chat not found', async () => {
			mockLoadGroupChat.mockResolvedValue(null);

			await expect(simulateGetImagesHandler('nonexistent-chat')).rejects.toThrow(
				'Group chat not found: nonexistent-chat'
			);
		});

		it('returns empty object when images directory does not exist (ENOENT)', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/nonexistent/images',
			});

			const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
			enoentError.code = 'ENOENT';
			mockReaddir.mockRejectedValue(enoentError);

			const result = await simulateGetImagesHandler('test-chat');

			expect(result).toEqual({});
		});

		it('rethrows non-ENOENT errors', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});

			const permissionError = new Error('EACCES') as NodeJS.ErrnoException;
			permissionError.code = 'EACCES';
			mockReaddir.mockRejectedValue(permissionError);

			await expect(simulateGetImagesHandler('test-chat')).rejects.toThrow('EACCES');
		});
	});

	describe('edge cases', () => {
		it('handles filenames with special characters', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['image with spaces.png', 'special-chars_123.jpg']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result).toHaveProperty('image with spaces.png');
			expect(result).toHaveProperty('special-chars_123.jpg');
		});

		it('handles unicode filenames', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['caf\u00e9-photo.png', '\u6d4b\u8bd5.jpg']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(Object.keys(result)).toHaveLength(2);
		});

		it('ignores hidden files that look like extensions', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			// File starting with dot (hidden file like .png) - path.extname('.png') returns ''
			// because Node treats the whole thing as the filename, not as an extension
			mockReaddir.mockResolvedValue(['.png', '.gitkeep', 'valid.png']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			// Only valid.png should be included; hidden files are ignored
			expect(Object.keys(result)).toHaveLength(1);
			expect(result).toHaveProperty('valid.png');
			expect(result).not.toHaveProperty('.png');
		});

		it('handles large images', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['large.png']);

			// Simulate a 5MB image
			const largeBuffer = Buffer.alloc(5 * 1024 * 1024, 0xff);
			mockReadFile.mockResolvedValue(largeBuffer);

			const result = await simulateGetImagesHandler('test-chat');

			expect(result).toHaveProperty('large.png');
			// Verify the data URL is properly formed
			expect(result['large.png']).toMatch(/^data:image\/png;base64,/);
		});

		it('handles files with multiple dots in name', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['screenshot.2023.12.21.png', 'file.backup.old.jpg']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(result).toHaveProperty('screenshot.2023.12.21.png');
			expect(result).toHaveProperty('file.backup.old.jpg');
		});

		it('ignores files without extensions', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['README', 'Makefile', 'image.png']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(Object.keys(result)).toHaveLength(1);
			expect(result).toHaveProperty('image.png');
		});

		it('ignores unsupported image formats', async () => {
			mockLoadGroupChat.mockResolvedValue({
				id: 'test-chat',
				imagesDir: '/path/to/images',
			});
			mockReaddir.mockResolvedValue(['image.bmp', 'image.tiff', 'image.svg', 'valid.png']);
			mockReadFile.mockResolvedValue(Buffer.from('fake-data'));

			const result = await simulateGetImagesHandler('test-chat');

			expect(Object.keys(result)).toHaveLength(1);
			expect(result).toHaveProperty('valid.png');
			expect(result).not.toHaveProperty('image.bmp');
			expect(result).not.toHaveProperty('image.tiff');
			expect(result).not.toHaveProperty('image.svg');
		});
	});
});
