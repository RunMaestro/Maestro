/**
 * Tests for the Claude Session IPC handlers
 *
 * These tests verify the Claude Code session management functionality:
 * - List sessions (regular and paginated)
 * - Read session messages
 * - Delete message pairs
 * - Search sessions
 * - Get project and global stats
 * - Session timestamps for activity graphs
 * - Session origins tracking (Maestro vs CLI)
 * - Get available slash commands
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, app, BrowserWindow } from 'electron';
import {
	registerClaudeHandlers,
	ClaudeHandlerDependencies,
} from '../../../../main/ipc/handlers/claude';

// Mock electron's ipcMain and app
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	app: {
		getPath: vi.fn().mockReturnValue('/mock/app/path'),
	},
	BrowserWindow: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
	},
}));

// Mock path - we need to preserve the actual path functionality but mock specific behaviors
vi.mock('path', async () => {
	const actual = await vi.importActual<typeof import('path')>('path');
	return {
		default: {
			...actual,
			join: vi.fn((...args: string[]) => args.join('/')),
			dirname: vi.fn((p: string) => p.split('/').slice(0, -1).join('/')),
		},
	};
});

// Mock os module
vi.mock('os', () => ({
	default: {
		homedir: vi.fn().mockReturnValue('/mock/home'),
	},
}));

// Mock statsCache module
vi.mock('../../../../main/utils/statsCache', () => ({
	encodeClaudeProjectPath: vi.fn((p: string) => p.replace(/\//g, '-').replace(/^-/, '')),
	loadStatsCache: vi.fn(),
	saveStatsCache: vi.fn(),
	STATS_CACHE_VERSION: 1,
}));

// Mock constants
vi.mock('../../../../main/constants', () => ({
	CLAUDE_SESSION_PARSE_LIMITS: {
		FIRST_MESSAGE_SCAN_LINES: 10,
		FIRST_MESSAGE_PREVIEW_LENGTH: 100,
		LAST_TIMESTAMP_SCAN_LINES: 5,
		OLDEST_TIMESTAMP_SCAN_LINES: 10,
	},
}));

// Mock pricing utility
vi.mock('../../../../main/utils/pricing', () => ({
	calculateClaudeCost: vi.fn(
		(input: number, output: number, cacheRead: number, cacheCreation: number) => {
			const inputCost = (input / 1_000_000) * 3;
			const outputCost = (output / 1_000_000) * 15;
			const cacheReadCost = (cacheRead / 1_000_000) * 0.3;
			const cacheCreationCost = (cacheCreation / 1_000_000) * 3.75;
			return inputCost + outputCost + cacheReadCost + cacheCreationCost;
		}
	),
}));

describe('Claude IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockClaudeSessionOriginsStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
	};
	let mockGetMainWindow: ReturnType<typeof vi.fn>;
	let mockDependencies: ClaudeHandlerDependencies;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Create mock dependencies
		mockClaudeSessionOriginsStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
		};

		mockGetMainWindow = vi.fn().mockReturnValue(null);

		mockDependencies = {
			claudeSessionOriginsStore:
				mockClaudeSessionOriginsStore as unknown as ClaudeHandlerDependencies['claudeSessionOriginsStore'],
			getMainWindow: mockGetMainWindow,
		};

		// Register handlers
		registerClaudeHandlers(mockDependencies);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all claude handlers', () => {
			// All ipcMain.handle('claude:*') calls identified from src/main/ipc/handlers/claude.ts:
			// Line 153:  ipcMain.handle('claude:listSessions', ...)        - List sessions for a project
			// Line 316:  ipcMain.handle('claude:listSessionsPaginated', ...)  - Paginated session listing
			// Line 504:  ipcMain.handle('claude:getProjectStats', ...)     - Get stats for a specific project
			// Line 689:  ipcMain.handle('claude:getSessionTimestamps', ...)  - Get session timestamps for activity graphs
			// Line 742:  ipcMain.handle('claude:getGlobalStats', ...)      - Get global stats across all projects
			// Line 949:  ipcMain.handle('claude:readSessionMessages', ...)  - Read messages from a session
			// Line 1025: ipcMain.handle('claude:deleteMessagePair', ...)   - Delete a message pair from session
			// Line 1192: ipcMain.handle('claude:searchSessions', ...)      - Search sessions by query
			// Line 1337: ipcMain.handle('claude:getCommands', ...)         - Get available slash commands
			// Line 1422: ipcMain.handle('claude:registerSessionOrigin', ...)  - Register session origin (user/auto)
			// Line 1438: ipcMain.handle('claude:updateSessionName', ...)   - Update session name
			// Line 1459: ipcMain.handle('claude:updateSessionStarred', ...)  - Update session starred status
			// Line 1461: ipcMain.handle('claude:updateSessionContextUsage', ...)  - Update context usage percentage
			// Line 1482: ipcMain.handle('claude:getSessionOrigins', ...)   - Get session origins for a project
			// Line 1490: ipcMain.handle('claude:getAllNamedSessions', ...)  - Get all sessions with names
			const expectedChannels = [
				'claude:listSessions',
				'claude:listSessionsPaginated',
				'claude:getProjectStats',
				'claude:getSessionTimestamps',
				'claude:getGlobalStats',
				'claude:readSessionMessages',
				'claude:deleteMessagePair',
				'claude:searchSessions',
				'claude:getCommands',
				'claude:registerSessionOrigin',
				'claude:updateSessionName',
				'claude:updateSessionStarred',
				'claude:updateSessionContextUsage',
				'claude:getSessionOrigins',
				'claude:getAllNamedSessions',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel), `Handler for ${channel} should be registered`).toBe(true);
			}

			// Verify total count matches - ensures no handlers are added without updating this test
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	describe('claude:listSessions', () => {
		it('should return sessions from ~/.claude directory', async () => {
			const fs = await import('fs/promises');

			// Mock directory access - directory exists
			vi.mocked(fs.default.access).mockResolvedValue(undefined);

			// Mock readdir to return session files
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-abc123.jsonl',
				'session-def456.jsonl',
				'not-a-session.txt', // Should be filtered out
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Mock file stats - return valid non-zero size files
			const mockMtime = new Date('2024-01-15T10:00:00Z');
			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: mockMtime,
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			// Mock session file content with user message
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Hello world"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Hi there!"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(2);
			expect(result[0]).toMatchObject({
				sessionId: expect.stringMatching(/^session-/),
				projectPath: '/test/project',
				firstMessage: 'Hello world',
			});
		});

		it('should return empty array when project directory does not exist', async () => {
			const fs = await import('fs/promises');

			// Mock directory access - directory does not exist
			vi.mocked(fs.default.access).mockRejectedValue(
				new Error('ENOENT: no such file or directory')
			);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/nonexistent/project');

			expect(result).toEqual([]);
		});

		it('should filter out 0-byte session files', async () => {
			const fs = await import('fs/promises');

			// Mock directory access
			vi.mocked(fs.default.access).mockResolvedValue(undefined);

			// Mock readdir
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-valid.jsonl',
				'session-empty.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Mock file stats - first file has content, second is empty
			let callCount = 0;
			vi.mocked(fs.default.stat).mockImplementation(async () => {
				callCount++;
				return {
					size: callCount === 1 ? 1024 : 0, // First call returns 1024, second returns 0
					mtime: new Date('2024-01-15T10:00:00Z'),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			// Mock session file content
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			// Only the non-empty session should be returned
			expect(result).toHaveLength(1);
			expect(result[0].sessionId).toBe('session-valid');
		});

		it('should parse session JSON files and extract token counts', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-123.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 2048,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			// Session content with token usage information
			const sessionContent = `{"type":"user","message":{"role":"user","content":"What is 2+2?"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"The answer is 4"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20,"cache_creation_input_tokens":10}}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				sessionId: 'session-123',
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 20,
				cacheCreationTokens: 10,
				messageCount: 2,
			});
		});

		it('should add origin info from origins store', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-abc.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			// Mock origins store with session info
			mockClaudeSessionOriginsStore.get.mockReturnValue({
				'/test/project': {
					'session-abc': { origin: 'user', sessionName: 'My Session' },
				},
			});

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				sessionId: 'session-abc',
				origin: 'user',
				sessionName: 'My Session',
			});
		});

		it('should handle string-only origin data from origins store', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-xyz.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			// Mock origins store with simple string origin (legacy format)
			mockClaudeSessionOriginsStore.get.mockReturnValue({
				'/test/project': {
					'session-xyz': 'auto', // Simple string instead of object
				},
			});

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				sessionId: 'session-xyz',
				origin: 'auto',
			});
			expect(result[0].sessionName).toBeUndefined();
		});

		it('should extract first user message text from array content', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-multi.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 2048,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			// Session content with array-style content (includes images and text)
			const sessionContent = `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"..."}},{"type":"text","text":"Describe this image"}]},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(1);
			// Should extract only the text content, not the image
			expect(result[0].firstMessage).toBe('Describe this image');
		});

		it('should sort sessions by modified date descending', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-old.jsonl',
				'session-new.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Return different mtimes for each file
			let callIdx = 0;
			vi.mocked(fs.default.stat).mockImplementation(async () => {
				callIdx++;
				return {
					size: 1024,
					mtime:
						callIdx === 1
							? new Date('2024-01-10T10:00:00Z') // Older
							: new Date('2024-01-15T10:00:00Z'), // Newer
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(2);
			// Newer session should come first
			expect(result[0].sessionId).toBe('session-new');
			expect(result[1].sessionId).toBe('session-old');
		});

		it('should handle malformed JSON lines gracefully', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-corrupt.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			// Session with some malformed lines
			const sessionContent = `not valid json at all
{"type":"user","message":{"role":"user","content":"Valid message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{broken json here
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			// Should still return the session, skipping malformed lines
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				sessionId: 'session-corrupt',
				firstMessage: 'Valid message',
				messageCount: 2, // Still counts via regex
			});
		});

		it('should calculate cost estimate from token counts', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-cost.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			// Session with known token counts for cost calculation
			// Using mocked pricing: INPUT=3, OUTPUT=15, CACHE_READ=0.3, CACHE_CREATION=3.75 per million
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2","usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":1000000,"cache_creation_input_tokens":1000000}}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessions');
			const result = await handler!({} as any, '/test/project');

			expect(result).toHaveLength(1);
			// Cost = (1M * 3 + 1M * 15 + 1M * 0.3 + 1M * 3.75) / 1M = 3 + 15 + 0.3 + 3.75 = 22.05
			expect(result[0].costUsd).toBeCloseTo(22.05, 2);
		});
	});

	describe('claude:listSessionsPaginated', () => {
		it('should return paginated sessions with limit', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-1.jsonl',
				'session-2.jsonl',
				'session-3.jsonl',
				'session-4.jsonl',
				'session-5.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Mock stats - return descending mtimes so sessions are in order 5,4,3,2,1
			let statCallCount = 0;
			vi.mocked(fs.default.stat).mockImplementation(async () => {
				statCallCount++;
				const baseTime = new Date('2024-01-15T10:00:00Z').getTime();
				// Each session is 1 hour apart, newer sessions first
				const mtime = new Date(baseTime - (statCallCount - 1) * 3600000);
				return {
					size: 1024,
					mtime,
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', { limit: 2 });

			expect(result.sessions).toHaveLength(2);
			expect(result.totalCount).toBe(5);
			expect(result.hasMore).toBe(true);
			expect(result.nextCursor).toBeDefined();
		});

		it('should return sessions starting from cursor position', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-a.jsonl',
				'session-b.jsonl',
				'session-c.jsonl',
				'session-d.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Mock stats to control sort order - d is newest, a is oldest
			vi.mocked(fs.default.stat).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				const dates: Record<string, Date> = {
					'session-a.jsonl': new Date('2024-01-10T10:00:00Z'),
					'session-b.jsonl': new Date('2024-01-11T10:00:00Z'),
					'session-c.jsonl': new Date('2024-01-12T10:00:00Z'),
					'session-d.jsonl': new Date('2024-01-13T10:00:00Z'),
				};
				return {
					size: 1024,
					mtime: dates[filename] || new Date(),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');

			// First page (sorted: d, c, b, a - newest first)
			const page1 = await handler!({} as any, '/test/project', { limit: 2 });
			expect(page1.sessions).toHaveLength(2);
			expect(page1.sessions[0].sessionId).toBe('session-d');
			expect(page1.sessions[1].sessionId).toBe('session-c');
			expect(page1.hasMore).toBe(true);
			expect(page1.nextCursor).toBe('session-c');

			// Reset stat mock for second call
			vi.mocked(fs.default.stat).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				const dates: Record<string, Date> = {
					'session-a.jsonl': new Date('2024-01-10T10:00:00Z'),
					'session-b.jsonl': new Date('2024-01-11T10:00:00Z'),
					'session-c.jsonl': new Date('2024-01-12T10:00:00Z'),
					'session-d.jsonl': new Date('2024-01-13T10:00:00Z'),
				};
				return {
					size: 1024,
					mtime: dates[filename] || new Date(),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			// Second page using cursor
			const page2 = await handler!({} as any, '/test/project', { cursor: 'session-c', limit: 2 });
			expect(page2.sessions).toHaveLength(2);
			expect(page2.sessions[0].sessionId).toBe('session-b');
			expect(page2.sessions[1].sessionId).toBe('session-a');
			expect(page2.hasMore).toBe(false);
			expect(page2.nextCursor).toBeNull();
		});

		it('should return totalCount correctly', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-1.jsonl',
				'session-2.jsonl',
				'session-3.jsonl',
				'session-4.jsonl',
				'session-5.jsonl',
				'session-6.jsonl',
				'session-7.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', { limit: 3 });

			expect(result.totalCount).toBe(7);
			expect(result.sessions).toHaveLength(3);
			expect(result.hasMore).toBe(true);
		});

		it('should return empty results when project directory does not exist', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockRejectedValue(
				new Error('ENOENT: no such file or directory')
			);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/nonexistent/project', {});

			expect(result).toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});
		});

		it('should return empty results when no session files exist', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'readme.txt',
				'notes.md',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/empty/project', {});

			expect(result.sessions).toHaveLength(0);
			expect(result.totalCount).toBe(0);
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeNull();
		});

		it('should filter out 0-byte session files from totalCount and results', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-valid1.jsonl',
				'session-empty.jsonl',
				'session-valid2.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Return different sizes - empty session has 0 bytes
			vi.mocked(fs.default.stat).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				const size = filename === 'session-empty.jsonl' ? 0 : 1024;
				return {
					size,
					mtime: new Date('2024-01-15T10:00:00Z'),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', {});

			// Should only have 2 valid sessions, not 3
			expect(result.totalCount).toBe(2);
			expect(result.sessions).toHaveLength(2);
			expect(result.sessions.map((s) => s.sessionId)).not.toContain('session-empty');
		});

		it('should use default limit of 100 when not specified', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);

			// Create 150 session files
			const files = Array.from(
				{ length: 150 },
				(_, i) => `session-${String(i).padStart(3, '0')}.jsonl`
			);
			vi.mocked(fs.default.readdir).mockResolvedValue(
				files as unknown as Awaited<ReturnType<typeof fs.default.readdir>>
			);

			let idx = 0;
			vi.mocked(fs.default.stat).mockImplementation(async () => {
				idx++;
				return {
					size: 1024,
					mtime: new Date(Date.now() - idx * 1000),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
			});

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', {}); // No limit specified

			expect(result.sessions).toHaveLength(100); // Default limit
			expect(result.totalCount).toBe(150);
			expect(result.hasMore).toBe(true);
		});

		it('should add origin info from origins store', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-with-origin.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			// Mock origins store
			mockClaudeSessionOriginsStore.get.mockReturnValue({
				'/test/project': {
					'session-with-origin': { origin: 'auto', sessionName: 'Auto Run Session' },
				},
			});

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', {});

			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0]).toMatchObject({
				sessionId: 'session-with-origin',
				origin: 'auto',
				sessionName: 'Auto Run Session',
			});
		});

		it('should handle invalid cursor gracefully by starting from beginning', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-a.jsonl',
				'session-b.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 1024,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			// Use a cursor that doesn't exist
			const result = await handler!({} as any, '/test/project', {
				cursor: 'nonexistent-session',
				limit: 10,
			});

			// Should start from beginning since cursor wasn't found
			expect(result.sessions).toHaveLength(2);
			expect(result.totalCount).toBe(2);
		});

		it('should parse session content and extract token counts', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-tokens.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 2048,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Hi"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2","usage":{"input_tokens":500,"output_tokens":200,"cache_read_input_tokens":100,"cache_creation_input_tokens":50}}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', {});

			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0]).toMatchObject({
				inputTokens: 500,
				outputTokens: 200,
				cacheReadTokens: 100,
				cacheCreationTokens: 50,
				messageCount: 2,
			});
		});

		it('should calculate duration from first to last timestamp', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-duration.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.stat).mockResolvedValue({
				size: 2048,
				mtime: new Date('2024-01-15T10:00:00Z'),
			} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

			// Session spanning 5 minutes
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Start"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Mid"},"timestamp":"2024-01-15T09:02:30Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"End"},"timestamp":"2024-01-15T09:05:00Z","uuid":"uuid-3"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:listSessionsPaginated');
			const result = await handler!({} as any, '/test/project', {});

			expect(result.sessions).toHaveLength(1);
			// Duration = 9:05:00 - 9:00:00 = 5 minutes = 300 seconds
			expect(result.sessions[0].durationSeconds).toBe(300);
		});
	});

	describe('claude:readSessionMessages', () => {
		it('should return full session content with messages array', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Hello, how are you?"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"I'm doing well, thank you!"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"Can you help me with code?"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"Of course! What do you need?"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-4"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-123', {});

			expect(result.total).toBe(4);
			expect(result.messages).toHaveLength(4);
			expect(result.messages[0]).toMatchObject({
				type: 'user',
				content: 'Hello, how are you?',
				uuid: 'uuid-1',
			});
			expect(result.messages[3]).toMatchObject({
				type: 'assistant',
				content: 'Of course! What do you need?',
				uuid: 'uuid-4',
			});
		});

		it('should handle missing session file gracefully by throwing error', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.readFile).mockRejectedValue(
				new Error('ENOENT: no such file or directory')
			);

			const handler = handlers.get('claude:readSessionMessages');

			await expect(
				handler!({} as any, '/test/project', 'nonexistent-session', {})
			).rejects.toThrow();
		});

		it('should handle corrupted JSON lines gracefully', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Valid message 1"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
not valid json at all
{"type":"assistant","message":{"role":"assistant","content":"Valid response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{broken: json here
{"type":"user","message":{"role":"user","content":"Valid message 2"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-3"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-corrupt', {});

			// Should skip malformed lines and return only valid messages
			expect(result.total).toBe(3);
			expect(result.messages).toHaveLength(3);
			expect(result.messages[0].content).toBe('Valid message 1');
			expect(result.messages[1].content).toBe('Valid response');
			expect(result.messages[2].content).toBe('Valid message 2');
		});

		it('should return messages array with correct structure', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Test question"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-test-1"}
{"type":"assistant","message":{"role":"assistant","content":"Test answer"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-test-2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-abc', {});

			expect(result.messages).toHaveLength(2);

			// Verify message structure
			expect(result.messages[0]).toHaveProperty('type', 'user');
			expect(result.messages[0]).toHaveProperty('role', 'user');
			expect(result.messages[0]).toHaveProperty('content', 'Test question');
			expect(result.messages[0]).toHaveProperty('timestamp', '2024-01-15T09:00:00Z');
			expect(result.messages[0]).toHaveProperty('uuid', 'uuid-test-1');

			expect(result.messages[1]).toHaveProperty('type', 'assistant');
			expect(result.messages[1]).toHaveProperty('role', 'assistant');
			expect(result.messages[1]).toHaveProperty('content', 'Test answer');
		});

		it('should support pagination with offset and limit', async () => {
			const fs = await import('fs/promises');

			// Create 10 messages
			const messages = [];
			for (let i = 1; i <= 10; i++) {
				const type = i % 2 === 1 ? 'user' : 'assistant';
				messages.push(
					`{"type":"${type}","message":{"role":"${type}","content":"Message ${i}"},"timestamp":"2024-01-15T09:${String(i).padStart(2, '0')}:00Z","uuid":"uuid-${i}"}`
				);
			}
			const sessionContent = messages.join('\n');

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');

			// Get last 5 messages (offset 0, limit 5 returns messages 6-10)
			const result1 = await handler!({} as any, '/test/project', 'session-paginate', {
				offset: 0,
				limit: 5,
			});
			expect(result1.total).toBe(10);
			expect(result1.messages).toHaveLength(5);
			expect(result1.messages[0].content).toBe('Message 6');
			expect(result1.messages[4].content).toBe('Message 10');
			expect(result1.hasMore).toBe(true);

			// Get next 5 messages (offset 5, limit 5 returns messages 1-5)
			const result2 = await handler!({} as any, '/test/project', 'session-paginate', {
				offset: 5,
				limit: 5,
			});
			expect(result2.total).toBe(10);
			expect(result2.messages).toHaveLength(5);
			expect(result2.messages[0].content).toBe('Message 1');
			expect(result2.messages[4].content).toBe('Message 5');
			expect(result2.hasMore).toBe(false);
		});

		it('should use default offset 0 and limit 20 when not specified', async () => {
			const fs = await import('fs/promises');

			// Create 25 messages
			const messages = [];
			for (let i = 1; i <= 25; i++) {
				const type = i % 2 === 1 ? 'user' : 'assistant';
				messages.push(
					`{"type":"${type}","message":{"role":"${type}","content":"Msg ${i}"},"timestamp":"2024-01-15T09:${String(i).padStart(2, '0')}:00Z","uuid":"uuid-${i}"}`
				);
			}
			const sessionContent = messages.join('\n');

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-defaults', {});

			expect(result.total).toBe(25);
			// Default limit is 20, so should get last 20 messages (6-25)
			expect(result.messages).toHaveLength(20);
			expect(result.messages[0].content).toBe('Msg 6');
			expect(result.messages[19].content).toBe('Msg 25');
			expect(result.hasMore).toBe(true);
		});

		it('should handle array content with text blocks', async () => {
			const fs = await import('fs/promises');

			// Message with array content containing text blocks
			const sessionContent = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"First paragraph"},{"type":"text","text":"Second paragraph"}]},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-array-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Response paragraph 1"},{"type":"text","text":"Response paragraph 2"}]},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-array-2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-array', {});

			expect(result.total).toBe(2);
			// Text blocks should be joined with newline
			expect(result.messages[0].content).toBe('First paragraph\nSecond paragraph');
			expect(result.messages[1].content).toBe('Response paragraph 1\nResponse paragraph 2');
		});

		it('should extract tool_use blocks from assistant messages', async () => {
			const fs = await import('fs/promises');

			// Message with tool_use blocks
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Read this file for me"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-tool-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read that file for you."},{"type":"tool_use","id":"tool-123","name":"read_file","input":{"path":"/test.txt"}}]},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-tool-2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-tools', {});

			expect(result.total).toBe(2);
			expect(result.messages[1]).toMatchObject({
				type: 'assistant',
				content: "I'll read that file for you.",
			});
			// Should include tool_use blocks in the toolUse property
			expect(result.messages[1].toolUse).toBeDefined();
			expect(result.messages[1].toolUse).toHaveLength(1);
			expect(result.messages[1].toolUse[0]).toMatchObject({
				type: 'tool_use',
				id: 'tool-123',
				name: 'read_file',
			});
		});

		it('should skip messages with only whitespace content', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Valid message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-valid"}
{"type":"assistant","message":{"role":"assistant","content":"   "},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-whitespace"}
{"type":"user","message":{"role":"user","content":""},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-empty"}
{"type":"assistant","message":{"role":"assistant","content":"Another valid message"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-valid-2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-whitespace', {});

			// Should only include messages with actual content
			expect(result.total).toBe(2);
			expect(result.messages[0].content).toBe('Valid message');
			expect(result.messages[1].content).toBe('Another valid message');
		});

		it('should skip non-user and non-assistant message types', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"User message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-user"}
{"type":"system","message":{"role":"system","content":"System prompt"},"timestamp":"2024-01-15T09:00:01Z","uuid":"uuid-system"}
{"type":"result","content":"Some result data","timestamp":"2024-01-15T09:00:02Z","uuid":"uuid-result"}
{"type":"assistant","message":{"role":"assistant","content":"Assistant response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-assistant"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');
			const result = await handler!({} as any, '/test/project', 'session-types', {});

			// Should only include user and assistant messages
			expect(result.total).toBe(2);
			expect(result.messages[0].type).toBe('user');
			expect(result.messages[1].type).toBe('assistant');
		});

		it('should return hasMore correctly based on remaining messages', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Msg 1"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Msg 2"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"Msg 3"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-3"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:readSessionMessages');

			// Get last 2 messages - there should be 1 more
			const result1 = await handler!({} as any, '/test/project', 'session-has-more', {
				offset: 0,
				limit: 2,
			});
			expect(result1.total).toBe(3);
			expect(result1.messages).toHaveLength(2);
			expect(result1.hasMore).toBe(true);

			// Get all remaining - no more left
			const result2 = await handler!({} as any, '/test/project', 'session-has-more', {
				offset: 0,
				limit: 10,
			});
			expect(result2.total).toBe(3);
			expect(result2.messages).toHaveLength(3);
			expect(result2.hasMore).toBe(false);
		});
	});

	describe('claude:searchSessions', () => {
		it('should return empty array for empty query', async () => {
			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', '', 'all');

			expect(result).toEqual([]);
		});

		it('should return empty array for whitespace-only query', async () => {
			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', '   ', 'all');

			expect(result).toEqual([]);
		});

		it('should return empty array when project directory does not exist', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockRejectedValue(
				new Error('ENOENT: no such file or directory')
			);

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/nonexistent/project', 'search term', 'all');

			expect(result).toEqual([]);
		});

		it('should find sessions matching search term in user messages', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-match.jsonl',
				'session-nomatch.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Mock different content for each session
			vi.mocked(fs.default.readFile).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				if (filename === 'session-match.jsonl') {
					return `{"type":"user","message":{"role":"user","content":"I need help with authentication"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"I can help with that."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`;
				} else {
					return `{"type":"user","message":{"role":"user","content":"How do I configure the database?"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"Here's how to set it up."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-4"}`;
				}
			});

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'authentication', 'user');

			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				sessionId: 'session-match',
				matchType: 'user',
				matchCount: 1,
			});
			expect(result[0].matchPreview).toContain('authentication');
		});

		it('should perform case-insensitive search', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-case.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":"Help me with AUTHENTICATION please"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`
			);

			const handler = handlers.get('claude:searchSessions');

			// Search with lowercase should match uppercase content
			const result1 = await handler!({} as any, '/test/project', 'authentication', 'all');
			expect(result1).toHaveLength(1);

			// Search with uppercase should match lowercase content
			const result2 = await handler!({} as any, '/test/project', 'HELP', 'all');
			expect(result2).toHaveLength(1);

			// Search with mixed case should work
			const result3 = await handler!({} as any, '/test/project', 'AuThEnTiCaTiOn', 'all');
			expect(result3).toHaveLength(1);
		});

		it('should search only in user messages when mode is user', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-target.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// "keyword" appears in assistant message only
			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":"What is a variable?"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"A variable stores a keyword value."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`
			);

			const handler = handlers.get('claude:searchSessions');

			// Should not find when searching user messages only
			const result = await handler!({} as any, '/test/project', 'keyword', 'user');
			expect(result).toHaveLength(0);
		});

		it('should search only in assistant messages when mode is assistant', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-assistant.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// "secret" appears in user message only
			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":"What is the secret of success?"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Hard work and persistence."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`
			);

			const handler = handlers.get('claude:searchSessions');

			// Should not find when searching assistant messages only
			const result = await handler!({} as any, '/test/project', 'secret', 'assistant');
			expect(result).toHaveLength(0);

			// But should find in user mode
			const result2 = await handler!({} as any, '/test/project', 'secret', 'user');
			expect(result2).toHaveLength(1);
		});

		it('should search in both user and assistant messages when mode is all', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-user-has.jsonl',
				'session-assistant-has.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.readFile).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				if (filename === 'session-user-has.jsonl') {
					return `{"type":"user","message":{"role":"user","content":"Tell me about microservices"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"They are a design pattern."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`;
				} else {
					return `{"type":"user","message":{"role":"user","content":"What is this architecture?"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"This is microservices architecture."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-4"}`;
				}
			});

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'microservices', 'all');

			// Should find both sessions
			expect(result).toHaveLength(2);
		});

		it('should return matched context snippets with ellipsis', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-context.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Long message where the match is in the middle
			const longMessage =
				'This is a long prefix text that comes before the match. ' +
				'And here is a really long sentence with the keyword TARGET_WORD_HERE right in the middle of it all. ' +
				'This is a long suffix text that comes after the match to demonstrate context truncation.';

			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":"${longMessage}"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`
			);

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'TARGET_WORD_HERE', 'user');

			expect(result).toHaveLength(1);
			expect(result[0].matchPreview).toContain('TARGET_WORD_HERE');
			// Should have ellipsis since match is not at start/end
			expect(result[0].matchPreview).toMatch(/^\.\.\./);
			expect(result[0].matchPreview).toMatch(/\.\.\.$/);
		});

		it('should count multiple matches in matchCount', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-multi.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			// Multiple occurrences of "error" across messages
			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":"I got an error"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"What error did you see?"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"The error says file not found"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"This error is common."},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-4"}`
			);

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'error', 'all');

			expect(result).toHaveLength(1);
			// 2 user matches + 2 assistant matches = 4 total
			expect(result[0].matchCount).toBe(4);
		});

		it('should handle title search mode correctly', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-title.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			// First user message contains the search term (title match)
			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":"Help me with React hooks"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"React hooks are useful."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"More about React please"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-3"}`
			);

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'React', 'title');

			expect(result).toHaveLength(1);
			expect(result[0].matchType).toBe('title');
			// Title match counts as 1, regardless of how many times term appears
			expect(result[0].matchCount).toBe(1);
		});

		it('should handle array content with text blocks in search', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue(['session-array.jsonl'] as unknown as Awaited<
				ReturnType<typeof fs.default.readdir>
			>);

			// Content with array-style text blocks
			vi.mocked(fs.default.readFile).mockResolvedValue(
				`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Describe this"},{"type":"image","source":"..."}]},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"This shows the SEARCHTERM in context"}]},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`
			);

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'SEARCHTERM', 'all');

			expect(result).toHaveLength(1);
			expect(result[0].matchPreview).toContain('SEARCHTERM');
		});

		it('should skip malformed JSON lines gracefully during search', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-corrupt.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			// Some malformed lines mixed with valid ones
			vi.mocked(fs.default.readFile).mockResolvedValue(
				`not valid json
{"type":"user","message":{"role":"user","content":"Find this UNIQUETERM please"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{broken json here
{"type":"assistant","message":{"role":"assistant","content":"I found it!"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`
			);

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'UNIQUETERM', 'user');

			// Should still find the match in the valid lines
			expect(result).toHaveLength(1);
			expect(result[0].matchPreview).toContain('UNIQUETERM');
		});

		it('should skip files that cannot be read', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-readable.jsonl',
				'session-unreadable.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.readFile).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				if (filename === 'session-unreadable.jsonl') {
					throw new Error('Permission denied');
				}
				return `{"type":"user","message":{"role":"user","content":"Searchable content"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
			});

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'Searchable', 'all');

			// Should only return the readable session
			expect(result).toHaveLength(1);
			expect(result[0].sessionId).toBe('session-readable');
		});

		it('should return sessions with correct matchType based on where match is found', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.access).mockResolvedValue(undefined);
			vi.mocked(fs.default.readdir).mockResolvedValue([
				'session-user-match.jsonl',
				'session-assistant-match.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

			vi.mocked(fs.default.readFile).mockImplementation(async (filePath) => {
				const filename = String(filePath).split('/').pop() || '';
				if (filename === 'session-user-match.jsonl') {
					// Match in user message - gets reported as 'title' since first user match is considered title
					// Note: The handler considers the first matching user message as the "title",
					// so any user match will report matchType as 'title' in 'all' mode
					return `{"type":"user","message":{"role":"user","content":"Tell me about FINDME please"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"Sure, I can help."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}`;
				} else {
					// Match only in assistant message - no user match
					return `{"type":"user","message":{"role":"user","content":"Hello world"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"The answer includes FINDME."},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-4"}`;
				}
			});

			const handler = handlers.get('claude:searchSessions');
			const result = await handler!({} as any, '/test/project', 'FINDME', 'all');

			expect(result).toHaveLength(2);

			// In 'all' mode, matchType prioritizes: title (any user match) > assistant
			const userMatch = result.find((s) => s.sessionId === 'session-user-match');
			const assistantMatch = result.find((s) => s.sessionId === 'session-assistant-match');

			// User match gets reported as 'title' because the handler treats any user match as title
			expect(userMatch?.matchType).toBe('title');
			expect(assistantMatch?.matchType).toBe('assistant');
		});
	});

	describe('claude:deleteMessagePair', () => {
		it('should delete a message pair by UUID', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"First message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"First response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"Delete this message"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-delete"}
{"type":"assistant","message":{"role":"assistant","content":"This response should be deleted too"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-delete-response"}
{"type":"user","message":{"role":"user","content":"Third message"},"timestamp":"2024-01-15T09:04:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"Third response"},"timestamp":"2024-01-15T09:05:00Z","uuid":"uuid-4"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-delete');

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 2,
			});

			// Verify writeFile was called with correct content (deleted lines removed)
			expect(fs.default.writeFile).toHaveBeenCalledTimes(1);
			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;

			// Should not contain the deleted messages
			expect(writtenContent).not.toContain('uuid-delete');
			expect(writtenContent).not.toContain('Delete this message');
			expect(writtenContent).not.toContain('This response should be deleted too');

			// Should still contain other messages
			expect(writtenContent).toContain('uuid-1');
			expect(writtenContent).toContain('uuid-3');
		});

		it('should return error when user message is not found', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Some message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-existing"}
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-response"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-nonexistent');

			expect(result).toMatchObject({
				success: false,
				error: 'User message not found',
			});

			// writeFile should not be called since no deletion occurred
			expect(fs.default.writeFile).not.toHaveBeenCalled();
		});

		it('should find message by fallback content when UUID match fails', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"First message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"First response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"Find me by content"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-different"}
{"type":"assistant","message":{"role":"assistant","content":"Response to delete"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-response"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			// UUID doesn't match, but fallback content should find it
			const result = await handler!(
				{} as any,
				'/test/project',
				'session-123',
				'uuid-wrong',
				'Find me by content'
			);

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 2,
			});

			// Verify the correct messages were deleted
			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;
			expect(writtenContent).not.toContain('Find me by content');
			expect(writtenContent).not.toContain('Response to delete');
			expect(writtenContent).toContain('First message');
		});

		it('should delete all assistant messages until next user message', async () => {
			const fs = await import('fs/promises');

			// Multiple assistant messages between user messages
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Question"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-question"}
{"type":"assistant","message":{"role":"assistant","content":"First part of answer"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-ans-1"}
{"type":"assistant","message":{"role":"assistant","content":"Second part of answer"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-ans-2"}
{"type":"assistant","message":{"role":"assistant","content":"Third part of answer"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-ans-3"}
{"type":"user","message":{"role":"user","content":"Next question"},"timestamp":"2024-01-15T09:04:00Z","uuid":"uuid-next"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-question');

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 4, // 1 user + 3 assistant messages
			});

			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;
			// Should only contain the last user message
			expect(writtenContent).toContain('Next question');
			expect(writtenContent).not.toContain('Question');
			expect(writtenContent).not.toContain('First part of answer');
		});

		it('should delete to end of file when there is no next user message', async () => {
			const fs = await import('fs/promises');

			// Last message pair in session
			const sessionContent = `{"type":"user","message":{"role":"user","content":"First message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":"First response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":"Delete this last message"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-last"}
{"type":"assistant","message":{"role":"assistant","content":"Last response"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-last-response"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-last');

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 2,
			});

			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;
			expect(writtenContent).toContain('First message');
			expect(writtenContent).toContain('First response');
			expect(writtenContent).not.toContain('Delete this last message');
			expect(writtenContent).not.toContain('Last response');
		});

		it('should handle array content when matching by fallback content', async () => {
			const fs = await import('fs/promises');

			// Message with array-style content
			const sessionContent = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Find me by array text"}]},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-array"}
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-response"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!(
				{} as any,
				'/test/project',
				'session-123',
				'uuid-wrong',
				'Find me by array text'
			);

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 2,
			});
		});

		it('should clean up orphaned tool_result blocks when deleting message with tool_use', async () => {
			const fs = await import('fs/promises');

			// Message pair with tool_use that gets deleted, and a subsequent message with tool_result
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Read the file"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Reading file..."},{"type":"tool_use","id":"tool-123","name":"read_file","input":{"path":"test.txt"}}]},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-2"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-123","content":"File contents here"}]},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-3"}
{"type":"assistant","message":{"role":"assistant","content":"Here is the file content"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-4"}
{"type":"user","message":{"role":"user","content":"Next question"},"timestamp":"2024-01-15T09:04:00Z","uuid":"uuid-5"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			// Delete the first message pair which contains tool_use
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-1');

			expect(result.success).toBe(true);

			// Check that the orphaned tool_result was cleaned up
			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;
			// The tool_result message should be gone since its tool_use was deleted
			expect(writtenContent).not.toContain('tool-123');
			// But the "Next question" message should still be there
			expect(writtenContent).toContain('Next question');
		});

		it('should handle malformed JSON lines gracefully', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `not valid json
{"type":"user","message":{"role":"user","content":"Valid message to delete"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-delete"}
{broken json here
{"type":"assistant","message":{"role":"assistant","content":"Valid response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-response"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-delete');

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 3, // user message + broken line + response
			});

			// Malformed lines are kept with null entry
			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;
			// Only the first malformed line should remain (it's before the deleted message)
			expect(writtenContent).toContain('not valid json');
		});

		it('should throw error when session file does not exist', async () => {
			const fs = await import('fs/promises');

			vi.mocked(fs.default.readFile).mockRejectedValue(
				new Error('ENOENT: no such file or directory')
			);

			const handler = handlers.get('claude:deleteMessagePair');

			await expect(
				handler!({} as any, '/test/project', 'nonexistent-session', 'uuid-1')
			).rejects.toThrow();
		});

		it('should preserve messages before and after deleted pair', async () => {
			const fs = await import('fs/promises');

			const sessionContent = `{"type":"user","message":{"role":"user","content":"Message A"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-a"}
{"type":"assistant","message":{"role":"assistant","content":"Response A"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-a-response"}
{"type":"user","message":{"role":"user","content":"Message B - DELETE"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-b"}
{"type":"assistant","message":{"role":"assistant","content":"Response B - DELETE"},"timestamp":"2024-01-15T09:03:00Z","uuid":"uuid-b-response"}
{"type":"user","message":{"role":"user","content":"Message C"},"timestamp":"2024-01-15T09:04:00Z","uuid":"uuid-c"}
{"type":"assistant","message":{"role":"assistant","content":"Response C"},"timestamp":"2024-01-15T09:05:00Z","uuid":"uuid-c-response"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-b');

			expect(result.success).toBe(true);

			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;

			// Before messages preserved
			expect(writtenContent).toContain('Message A');
			expect(writtenContent).toContain('Response A');

			// Deleted messages gone
			expect(writtenContent).not.toContain('Message B - DELETE');
			expect(writtenContent).not.toContain('Response B - DELETE');

			// After messages preserved
			expect(writtenContent).toContain('Message C');
			expect(writtenContent).toContain('Response C');
		});

		it('should handle message with only assistant response (no subsequent user)', async () => {
			const fs = await import('fs/promises');

			// Delete a message where there's only an assistant response after (no next user)
			const sessionContent = `{"type":"user","message":{"role":"user","content":"Question"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-q"}
{"type":"assistant","message":{"role":"assistant","content":"Answer part 1"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-a1"}
{"type":"assistant","message":{"role":"assistant","content":"Answer part 2"},"timestamp":"2024-01-15T09:02:00Z","uuid":"uuid-a2"}`;

			vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);
			vi.mocked(fs.default.writeFile).mockResolvedValue(undefined);

			const handler = handlers.get('claude:deleteMessagePair');
			const result = await handler!({} as any, '/test/project', 'session-123', 'uuid-q');

			expect(result).toMatchObject({
				success: true,
				linesRemoved: 3, // user + 2 assistant messages
			});

			const writtenContent = vi.mocked(fs.default.writeFile).mock.calls[0][1] as string;
			// Only newline should remain (empty file basically)
			expect(writtenContent.trim()).toBe('');
		});
	});

	describe('error handling', () => {
		describe('file permission errors', () => {
			it('should handle EACCES permission error in listSessions gracefully', async () => {
				const fs = await import('fs/promises');

				// Simulate permission denied when accessing directory
				const permissionError = new Error('EACCES: permission denied');
				(permissionError as NodeJS.ErrnoException).code = 'EACCES';
				vi.mocked(fs.default.access).mockRejectedValue(permissionError);

				const handler = handlers.get('claude:listSessions');
				const result = await handler!({} as any, '/restricted/project');

				// Should return empty array instead of throwing
				expect(result).toEqual([]);
			});

			it('should handle EACCES permission error in listSessionsPaginated gracefully', async () => {
				const fs = await import('fs/promises');

				const permissionError = new Error('EACCES: permission denied');
				(permissionError as NodeJS.ErrnoException).code = 'EACCES';
				vi.mocked(fs.default.access).mockRejectedValue(permissionError);

				const handler = handlers.get('claude:listSessionsPaginated');
				const result = await handler!({} as any, '/restricted/project', {});

				expect(result).toEqual({
					sessions: [],
					hasMore: false,
					totalCount: 0,
					nextCursor: null,
				});
			});

			it('should skip individual session files with permission errors in listSessions', async () => {
				const fs = await import('fs/promises');

				vi.mocked(fs.default.access).mockResolvedValue(undefined);
				vi.mocked(fs.default.readdir).mockResolvedValue([
					'session-readable.jsonl',
					'session-restricted.jsonl',
				] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

				// First stat call succeeds, second fails with permission error
				let statCallCount = 0;
				vi.mocked(fs.default.stat).mockImplementation(async () => {
					statCallCount++;
					if (statCallCount === 2) {
						const permissionError = new Error('EACCES: permission denied');
						(permissionError as NodeJS.ErrnoException).code = 'EACCES';
						throw permissionError;
					}
					return {
						size: 1024,
						mtime: new Date('2024-01-15T10:00:00Z'),
					} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
				});

				const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
				vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

				const handler = handlers.get('claude:listSessions');
				const result = await handler!({} as any, '/test/project');

				// Should only return the readable session
				expect(result).toHaveLength(1);
				expect(result[0].sessionId).toBe('session-readable');
			});

			it('should handle EACCES when reading session file in readSessionMessages', async () => {
				const fs = await import('fs/promises');

				const permissionError = new Error('EACCES: permission denied');
				(permissionError as NodeJS.ErrnoException).code = 'EACCES';
				vi.mocked(fs.default.readFile).mockRejectedValue(permissionError);

				const handler = handlers.get('claude:readSessionMessages');

				await expect(
					handler!({} as any, '/test/project', 'session-restricted', {})
				).rejects.toThrow('EACCES');
			});

			it('should handle EACCES when writing in deleteMessagePair', async () => {
				const fs = await import('fs/promises');

				const sessionContent = `{"type":"user","message":{"role":"user","content":"Delete me"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-del"}
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-resp"}`;

				vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

				const permissionError = new Error('EACCES: permission denied, open for writing');
				(permissionError as NodeJS.ErrnoException).code = 'EACCES';
				vi.mocked(fs.default.writeFile).mockRejectedValue(permissionError);

				const handler = handlers.get('claude:deleteMessagePair');

				await expect(
					handler!({} as any, '/test/project', 'session-123', 'uuid-del')
				).rejects.toThrow('EACCES');
			});

			it('should handle permission error in searchSessions gracefully', async () => {
				const fs = await import('fs/promises');

				const permissionError = new Error('EACCES: permission denied');
				(permissionError as NodeJS.ErrnoException).code = 'EACCES';
				vi.mocked(fs.default.access).mockRejectedValue(permissionError);

				const handler = handlers.get('claude:searchSessions');
				const result = await handler!({} as any, '/restricted/project', 'search', 'all');

				expect(result).toEqual([]);
			});
		});

		describe('disk full errors (ENOSPC)', () => {
			it('should throw appropriate error when disk is full during deleteMessagePair write', async () => {
				const fs = await import('fs/promises');

				const sessionContent = `{"type":"user","message":{"role":"user","content":"Delete me"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-del"}
{"type":"assistant","message":{"role":"assistant","content":"Response"},"timestamp":"2024-01-15T09:01:00Z","uuid":"uuid-resp"}`;

				vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

				const diskFullError = new Error('ENOSPC: no space left on device');
				(diskFullError as NodeJS.ErrnoException).code = 'ENOSPC';
				vi.mocked(fs.default.writeFile).mockRejectedValue(diskFullError);

				const handler = handlers.get('claude:deleteMessagePair');

				await expect(
					handler!({} as any, '/test/project', 'session-123', 'uuid-del')
				).rejects.toThrow('ENOSPC');
			});

			it('should propagate disk full error with appropriate error code', async () => {
				const fs = await import('fs/promises');

				const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
				vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

				const diskFullError = new Error('ENOSPC: no space left on device');
				(diskFullError as NodeJS.ErrnoException).code = 'ENOSPC';
				vi.mocked(fs.default.writeFile).mockRejectedValue(diskFullError);

				const handler = handlers.get('claude:deleteMessagePair');

				try {
					await handler!({} as any, '/test/project', 'session-123', 'uuid-1');
					expect.fail('Should have thrown');
				} catch (error) {
					expect((error as NodeJS.ErrnoException).code).toBe('ENOSPC');
					expect((error as Error).message).toContain('no space left on device');
				}
			});
		});

		describe('network path unavailable errors', () => {
			it('should handle ENOENT for network path in listSessions gracefully', async () => {
				const fs = await import('fs/promises');

				// Simulate network path not available (appears as ENOENT or similar)
				const networkError = new Error(
					'ENOENT: no such file or directory, access //network/share/project'
				);
				(networkError as NodeJS.ErrnoException).code = 'ENOENT';
				vi.mocked(fs.default.access).mockRejectedValue(networkError);

				const handler = handlers.get('claude:listSessions');
				const result = await handler!({} as any, '//network/share/project');

				// Should return empty array for unavailable network path
				expect(result).toEqual([]);
			});

			it('should handle ETIMEDOUT for network operations gracefully', async () => {
				const fs = await import('fs/promises');

				vi.mocked(fs.default.access).mockResolvedValue(undefined);
				vi.mocked(fs.default.readdir).mockResolvedValue(['session-1.jsonl'] as unknown as Awaited<
					ReturnType<typeof fs.default.readdir>
				>);

				vi.mocked(fs.default.stat).mockResolvedValue({
					size: 1024,
					mtime: new Date('2024-01-15T10:00:00Z'),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

				// Simulate timeout when reading file from network share
				const timeoutError = new Error('ETIMEDOUT: connection timed out');
				(timeoutError as NodeJS.ErrnoException).code = 'ETIMEDOUT';
				vi.mocked(fs.default.readFile).mockRejectedValue(timeoutError);

				const handler = handlers.get('claude:listSessions');
				const result = await handler!({} as any, '//network/share/project');

				// Should return empty array when network operations fail
				// (the session is skipped due to read failure)
				expect(result).toEqual([]);
			});

			it('should handle EHOSTUNREACH for network operations in listSessionsPaginated', async () => {
				const fs = await import('fs/promises');

				// Simulate host unreachable
				const hostUnreachableError = new Error('EHOSTUNREACH: host unreachable');
				(hostUnreachableError as NodeJS.ErrnoException).code = 'EHOSTUNREACH';
				vi.mocked(fs.default.access).mockRejectedValue(hostUnreachableError);

				const handler = handlers.get('claude:listSessionsPaginated');
				const result = await handler!({} as any, '//network/share/project', {});

				expect(result).toEqual({
					sessions: [],
					hasMore: false,
					totalCount: 0,
					nextCursor: null,
				});
			});

			it('should handle ECONNREFUSED for network operations in searchSessions', async () => {
				const fs = await import('fs/promises');

				// Simulate connection refused
				const connRefusedError = new Error('ECONNREFUSED: connection refused');
				(connRefusedError as NodeJS.ErrnoException).code = 'ECONNREFUSED';
				vi.mocked(fs.default.access).mockRejectedValue(connRefusedError);

				const handler = handlers.get('claude:searchSessions');
				const result = await handler!({} as any, '//network/share/project', 'test query', 'all');

				expect(result).toEqual([]);
			});

			it('should handle EIO (I/O error) for network paths in readSessionMessages', async () => {
				const fs = await import('fs/promises');

				// Simulate I/O error (common with network file systems)
				const ioError = new Error('EIO: input/output error');
				(ioError as NodeJS.ErrnoException).code = 'EIO';
				vi.mocked(fs.default.readFile).mockRejectedValue(ioError);

				const handler = handlers.get('claude:readSessionMessages');

				await expect(
					handler!({} as any, '//network/share/project', 'session-123', {})
				).rejects.toThrow('EIO');
			});
		});

		describe('combined error scenarios', () => {
			it('should handle mixed errors when some sessions are readable and others fail', async () => {
				const fs = await import('fs/promises');

				vi.mocked(fs.default.access).mockResolvedValue(undefined);
				vi.mocked(fs.default.readdir).mockResolvedValue([
					'session-ok.jsonl',
					'session-permission.jsonl',
					'session-io-error.jsonl',
					'session-ok2.jsonl',
				] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

				// All stat calls succeed
				vi.mocked(fs.default.stat).mockResolvedValue({
					size: 1024,
					mtime: new Date('2024-01-15T10:00:00Z'),
				} as unknown as Awaited<ReturnType<typeof fs.default.stat>>);

				// Different errors for different files
				vi.mocked(fs.default.readFile).mockImplementation(async (filePath) => {
					const filename = String(filePath).split('/').pop() || '';

					if (filename === 'session-permission.jsonl') {
						const permError = new Error('EACCES: permission denied');
						(permError as NodeJS.ErrnoException).code = 'EACCES';
						throw permError;
					}
					if (filename === 'session-io-error.jsonl') {
						const ioError = new Error('EIO: input/output error');
						(ioError as NodeJS.ErrnoException).code = 'EIO';
						throw ioError;
					}

					return `{"type":"user","message":{"role":"user","content":"Test message"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
				});

				const handler = handlers.get('claude:listSessions');
				const result = await handler!({} as any, '/test/project');

				// Should return only the two readable sessions
				expect(result).toHaveLength(2);
				const sessionIds = result.map((s: { sessionId: string }) => s.sessionId);
				expect(sessionIds).toContain('session-ok');
				expect(sessionIds).toContain('session-ok2');
				expect(sessionIds).not.toContain('session-permission');
				expect(sessionIds).not.toContain('session-io-error');
			});

			it('should handle stat failures mixed with successful stats', async () => {
				const fs = await import('fs/promises');

				vi.mocked(fs.default.access).mockResolvedValue(undefined);
				vi.mocked(fs.default.readdir).mockResolvedValue([
					'session-good.jsonl',
					'session-stat-fail.jsonl',
					'session-good2.jsonl',
				] as unknown as Awaited<ReturnType<typeof fs.default.readdir>>);

				// Stat fails for the middle file
				vi.mocked(fs.default.stat).mockImplementation(async (filePath) => {
					const filename = String(filePath).split('/').pop() || '';
					if (filename === 'session-stat-fail.jsonl') {
						const statError = new Error('ENOENT: file disappeared');
						(statError as NodeJS.ErrnoException).code = 'ENOENT';
						throw statError;
					}
					return {
						size: 1024,
						mtime: new Date('2024-01-15T10:00:00Z'),
					} as unknown as Awaited<ReturnType<typeof fs.default.stat>>;
				});

				const sessionContent = `{"type":"user","message":{"role":"user","content":"Test"},"timestamp":"2024-01-15T09:00:00Z","uuid":"uuid-1"}`;
				vi.mocked(fs.default.readFile).mockResolvedValue(sessionContent);

				const handler = handlers.get('claude:listSessionsPaginated');
				const result = await handler!({} as any, '/test/project', {});

				// Should only include sessions where stat succeeded
				expect(result.totalCount).toBe(2);
				expect(result.sessions).toHaveLength(2);
			});
		});
	});
});
