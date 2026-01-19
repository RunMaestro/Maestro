/**
 * @file group-chat-log.test.ts
 * @description Unit tests for the Group Chat log format utilities.
 *
 * Tests cover:
 * - Content escaping (newlines, pipes)
 * - Content unescaping
 * - Log appending with correct format
 * - Log reading and parsing
 * - Edge cases (empty files, image references)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	escapeContent,
	unescapeContent,
	appendToLog,
	readLog,
	saveImage,
} from '../../../main/group-chat/group-chat-log';

describe('group-chat-log', () => {
	let testDir: string;

	beforeEach(async () => {
		// Create a unique temp directory for each test
		testDir = path.join(
			os.tmpdir(),
			`group-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		// Clean up temp directory after each test
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ===========================================================================
	// Test 1.1: escapeContent escapes newlines
	// ===========================================================================
	describe('escapeContent', () => {
		it('escapes newlines', () => {
			expect(escapeContent('line1\nline2')).toBe('line1\\nline2');
		});

		// =========================================================================
		// Test 1.2: escapeContent escapes pipe characters
		// =========================================================================
		it('escapes pipes', () => {
			expect(escapeContent('a|b|c')).toBe('a\\|b\\|c');
		});

		it('escapes both newlines and pipes', () => {
			expect(escapeContent('a|b\nc|d')).toBe('a\\|b\\nc\\|d');
		});

		it('handles empty string', () => {
			expect(escapeContent('')).toBe('');
		});

		it('handles string with no special characters', () => {
			expect(escapeContent('hello world')).toBe('hello world');
		});

		it('handles multiple consecutive newlines', () => {
			expect(escapeContent('a\n\n\nb')).toBe('a\\n\\n\\nb');
		});

		it('handles multiple consecutive pipes', () => {
			expect(escapeContent('a|||b')).toBe('a\\|\\|\\|b');
		});

		it('escapes backslashes', () => {
			expect(escapeContent('a\\b')).toBe('a\\\\b');
		});

		it('escapes backslash followed by n (literal, not newline)', () => {
			// String with literal backslash-n (not a newline character)
			const input = 'foo' + String.fromCharCode(92) + 'nbar';
			expect(escapeContent(input)).toBe('foo\\\\nbar');
		});

		it('escapes backslash followed by pipe', () => {
			const input = 'a' + String.fromCharCode(92) + '|b';
			expect(escapeContent(input)).toBe('a\\\\\\|b');
		});
	});

	// ===========================================================================
	// Test 1.3: unescapeContent reverses escaping
	// ===========================================================================
	describe('unescapeContent', () => {
		it('unescapes content', () => {
			expect(unescapeContent('line1\\nline2\\|data')).toBe('line1\nline2|data');
		});

		it('handles empty string', () => {
			expect(unescapeContent('')).toBe('');
		});

		it('handles string with no escaped characters', () => {
			expect(unescapeContent('hello world')).toBe('hello world');
		});

		it('reverses escapeContent', () => {
			const original = 'Hello\nWorld|Test';
			const escaped = escapeContent(original);
			expect(unescapeContent(escaped)).toBe(original);
		});

		it('unescapes backslashes', () => {
			expect(unescapeContent('a\\\\b')).toBe('a\\b');
		});

		it('correctly handles escaped backslash followed by n', () => {
			// \\n in file should become backslash-n (not newline)
			expect(unescapeContent('foo\\\\nbar')).toBe('foo\\nbar');
		});

		it('correctly handles escaped newline', () => {
			// \n in file should become actual newline
			expect(unescapeContent('foo\\nbar')).toBe('foo\nbar');
		});

		it('round-trips complex content with backslashes', () => {
			// String with literal backslash-n (not a newline character)
			const original = 'foo' + String.fromCharCode(92) + 'nbar';
			const escaped = escapeContent(original);
			expect(unescapeContent(escaped)).toBe(original);
		});
	});

	// ===========================================================================
	// Test 1.4: appendToLog writes correct format
	// ===========================================================================
	describe('appendToLog', () => {
		it('appends to log in correct format', async () => {
			const logPath = path.join(testDir, 'test-chat.log');
			await appendToLog(logPath, 'user', 'Hello world');
			const content = await fs.readFile(logPath, 'utf-8');
			expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T.*\|user\|Hello world\n$/);
		});

		it('creates directory if it does not exist', async () => {
			const logPath = path.join(testDir, 'nested', 'dir', 'test-chat.log');
			await appendToLog(logPath, 'user', 'Test');
			const exists = await fs
				.access(logPath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);
		});

		it('appends multiple messages', async () => {
			const logPath = path.join(testDir, 'multi-chat.log');
			await appendToLog(logPath, 'user', 'First message');
			await appendToLog(logPath, 'moderator', 'Second message');
			await appendToLog(logPath, 'Agent1', 'Third message');

			const content = await fs.readFile(logPath, 'utf-8');
			const lines = content.trim().split('\n');
			expect(lines).toHaveLength(3);
		});

		it('escapes content properly', async () => {
			const logPath = path.join(testDir, 'escape-chat.log');
			await appendToLog(logPath, 'user', 'Line1\nLine2|Data');
			const content = await fs.readFile(logPath, 'utf-8');
			expect(content).toContain('Line1\\nLine2\\|Data');
		});

		it('uses ISO 8601 timestamp format', async () => {
			const logPath = path.join(testDir, 'timestamp-chat.log');
			const beforeTime = new Date().toISOString();
			await appendToLog(logPath, 'user', 'Test');
			const afterTime = new Date().toISOString();

			const content = await fs.readFile(logPath, 'utf-8');
			const timestamp = content.split('|')[0];

			// Timestamp should be a valid ISO date between before and after
			expect(new Date(timestamp).getTime()).toBeGreaterThanOrEqual(
				new Date(beforeTime).getTime() - 1000
			);
			expect(new Date(timestamp).getTime()).toBeLessThanOrEqual(
				new Date(afterTime).getTime() + 1000
			);
		});
	});

	// ===========================================================================
	// Test 1.5: readLog parses log correctly
	// ===========================================================================
	describe('readLog', () => {
		it('reads and parses log', async () => {
			const logPath = path.join(testDir, 'parse-chat.log');
			await fs.writeFile(logPath, '2024-01-15T10:30:00.000Z|user|Hello\\nWorld\n');
			const messages = await readLog(logPath);
			expect(messages).toEqual([
				{
					timestamp: '2024-01-15T10:30:00.000Z',
					from: 'user',
					content: 'Hello\nWorld',
				},
			]);
		});

		// =========================================================================
		// Test 1.6: readLog handles empty file
		// =========================================================================
		it('returns empty array for empty file', async () => {
			const logPath = path.join(testDir, 'empty-chat.log');
			await fs.writeFile(logPath, '');
			const messages = await readLog(logPath);
			expect(messages).toEqual([]);
		});

		// =========================================================================
		// Test 1.7: readLog handles image references
		// =========================================================================
		it('preserves image references', async () => {
			const logPath = path.join(testDir, 'image-chat.log');
			await fs.writeFile(
				logPath,
				'2024-01-15T10:30:00.000Z|user|Check this [image:screenshot.png]\n'
			);
			const messages = await readLog(logPath);
			expect(messages[0].content).toBe('Check this [image:screenshot.png]');
		});

		it('returns empty array for non-existent file', async () => {
			const logPath = path.join(testDir, 'nonexistent.log');
			const messages = await readLog(logPath);
			expect(messages).toEqual([]);
		});

		it('parses multiple messages', async () => {
			const logPath = path.join(testDir, 'multi-parse.log');
			await fs.writeFile(
				logPath,
				[
					'2024-01-15T10:30:00.000Z|user|Hello',
					'2024-01-15T10:31:00.000Z|moderator|Hi there',
					'2024-01-15T10:32:00.000Z|Agent1|Ready to help',
				].join('\n') + '\n'
			);

			const messages = await readLog(logPath);
			expect(messages).toHaveLength(3);
			expect(messages[0].from).toBe('user');
			expect(messages[1].from).toBe('moderator');
			expect(messages[2].from).toBe('Agent1');
		});

		it('handles escaped pipes in content', async () => {
			const logPath = path.join(testDir, 'escaped-pipes.log');
			await fs.writeFile(logPath, '2024-01-15T10:30:00.000Z|user|Data\\|with\\|pipes\n');
			const messages = await readLog(logPath);
			expect(messages[0].content).toBe('Data|with|pipes');
		});

		it('handles whitespace-only lines', async () => {
			const logPath = path.join(testDir, 'whitespace.log');
			await fs.writeFile(
				logPath,
				'2024-01-15T10:30:00.000Z|user|Hello\n   \n\n2024-01-15T10:31:00.000Z|user|World\n'
			);
			const messages = await readLog(logPath);
			expect(messages).toHaveLength(2);
		});

		it('round-trips with appendToLog', async () => {
			const logPath = path.join(testDir, 'round-trip.log');
			const testContent = 'Hello\nWorld|Test';

			await appendToLog(logPath, 'user', testContent);
			const messages = await readLog(logPath);

			expect(messages).toHaveLength(1);
			expect(messages[0].from).toBe('user');
			expect(messages[0].content).toBe(testContent);
		});
	});

	// ===========================================================================
	// Test 1.5: saveImage saves images to the images directory
	// ===========================================================================
	describe('saveImage', () => {
		it('saves image and returns filename', async () => {
			const imagesDir = path.join(testDir, 'images');
			const imageBuffer = Buffer.from('fake-png-data');

			const filename = await saveImage(imagesDir, imageBuffer, 'screenshot.png');

			expect(filename).toMatch(/^image-[a-f0-9]{8}\.png$/);

			// Verify file was written
			const savedPath = path.join(imagesDir, filename);
			const exists = await fs
				.access(savedPath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);

			// Verify content
			const content = await fs.readFile(savedPath);
			expect(content.toString()).toBe('fake-png-data');
		});

		it('creates images directory if it does not exist', async () => {
			const imagesDir = path.join(testDir, 'nested', 'images', 'dir');
			const imageBuffer = Buffer.from('data');

			await saveImage(imagesDir, imageBuffer, 'test.jpg');

			const exists = await fs
				.access(imagesDir)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(true);
		});

		it('preserves original file extension', async () => {
			const imagesDir = path.join(testDir, 'images');

			const jpgFilename = await saveImage(imagesDir, Buffer.from('jpg'), 'photo.jpg');
			expect(jpgFilename).toMatch(/\.jpg$/);

			const gifFilename = await saveImage(imagesDir, Buffer.from('gif'), 'animation.gif');
			expect(gifFilename).toMatch(/\.gif$/);

			const webpFilename = await saveImage(imagesDir, Buffer.from('webp'), 'image.webp');
			expect(webpFilename).toMatch(/\.webp$/);
		});

		it('defaults to .png if no extension in original filename', async () => {
			const imagesDir = path.join(testDir, 'images');

			const filename = await saveImage(imagesDir, Buffer.from('data'), 'noextension');
			expect(filename).toMatch(/\.png$/);
		});

		it('generates unique filenames for each image', async () => {
			const imagesDir = path.join(testDir, 'images');
			const imageBuffer = Buffer.from('data');

			const filenames = new Set<string>();
			for (let i = 0; i < 5; i++) {
				const filename = await saveImage(imagesDir, imageBuffer, 'image.png');
				filenames.add(filename);
			}

			// All filenames should be unique
			expect(filenames.size).toBe(5);
		});
	});
});
