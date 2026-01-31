import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be declared before imports)
// ============================================================================

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../main/constants', () => ({
	CLAUDE_SESSION_PARSE_LIMITS: {
		FIRST_MESSAGE_SCAN_LINES: 50,
		FIRST_MESSAGE_PREVIEW_LENGTH: 200,
		LAST_TIMESTAMP_SCAN_LINES: 10,
	},
}));

vi.mock('../../main/utils/pricing', () => ({
	calculateClaudeCost: vi.fn((input: number, output: number, cacheRead: number, cacheCreation: number) => {
		return (input * 3 + output * 15 + cacheRead * 0.3 + cacheCreation * 3.75) / 1_000_000;
	}),
}));

vi.mock('../../main/utils/statsCache', () => ({
	encodeClaudeProjectPath: vi.fn((p: string) => p.replace(/\//g, '-')),
}));

vi.mock('../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	statRemote: vi.fn(),
}));

// Mock electron-store: each instantiation gets its own isolated in-memory store
vi.mock('electron-store', () => {
	const MockStore = function (this: Record<string, unknown>) {
		const data: Record<string, unknown> = { origins: {} };
		this.get = vi.fn((key: string, defaultVal?: unknown) => data[key] ?? defaultVal);
		this.set = vi.fn((key: string, value: unknown) => {
			data[key] = value;
		});
	};
	return { default: MockStore };
});

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		access: vi.fn(),
		writeFile: vi.fn(),
	},
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { ClaudeSessionStorage } from '../../main/storage/claude-session-storage';
import { calculateClaudeCost } from '../../main/utils/pricing';
import Store from 'electron-store';
import fs from 'fs/promises';

// ============================================================================
// Helpers
// ============================================================================

/** Build a single JSONL line */
function jsonl(...entries: Record<string, unknown>[]): string {
	return entries.map((e) => JSON.stringify(e)).join('\n');
}

/** Convenience: create a user message entry */
function userMsg(content: string | unknown[], ts = '2025-06-01T10:00:00Z', uuid = 'u1') {
	return { type: 'user', timestamp: ts, uuid, message: { role: 'user', content } };
}

/** Convenience: create an assistant message entry */
function assistantMsg(content: string | unknown[], ts = '2025-06-01T10:01:00Z', uuid = 'a1') {
	return { type: 'assistant', timestamp: ts, uuid, message: { role: 'assistant', content } };
}

/** Convenience: create a result entry with token usage */
function resultEntry(
	inputTokens: number,
	outputTokens: number,
	cacheRead = 0,
	cacheCreation = 0,
	ts = '2025-06-01T10:02:00Z'
) {
	return {
		type: 'result',
		timestamp: ts,
		usage: {
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			cache_read_input_tokens: cacheRead,
			cache_creation_input_tokens: cacheCreation,
		},
	};
}

/** Default stats object for parseSessionContent calls via listSessions */
const DEFAULT_STATS = { size: 1024, mtimeMs: new Date('2025-06-01T12:00:00Z').getTime() };

// ============================================================================
// Tests
// ============================================================================

describe('ClaudeSessionStorage', () => {
	let storage: ClaudeSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		storage = new ClaudeSessionStorage();
	});

	// ==========================================================================
	// extractTextFromContent (tested indirectly via parseSessionContent / listSessions)
	// ==========================================================================

	describe('extractTextFromContent (via session parsing)', () => {
		it('should extract plain string content as the preview message', async () => {
			const content = jsonl(
				userMsg('Hello, how are you?'),
				assistantMsg('I am doing well, thank you!')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-1.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 1024, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			// Assistant message is preferred as preview
			expect(sessions[0].firstMessage).toBe('I am doing well, thank you!');
		});

		it('should extract text from array content with type=text blocks', async () => {
			const content = jsonl(
				userMsg([
					{ type: 'text', text: 'First part' },
					{ type: 'image', source: {} },
					{ type: 'text', text: 'Second part' },
				]),
				assistantMsg([
					{ type: 'text', text: 'Response here' },
					{ type: 'tool_use', id: 'tool-1', name: 'read_file' },
				])
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-2.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 512, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			// Should have extracted the assistant text block only
			expect(sessions[0].firstMessage).toBe('Response here');
		});

		it('should return empty string for non-string, non-array content', async () => {
			// Content that is neither string nor array (e.g., number, null, object) should yield ''
			const content = jsonl(
				{ type: 'user', timestamp: '2025-06-01T10:00:00Z', uuid: 'u1', message: { role: 'user', content: 12345 } },
				{ type: 'assistant', timestamp: '2025-06-01T10:01:00Z', uuid: 'a1', message: { role: 'assistant', content: null } }
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-3.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 200, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			// No meaningful text extracted, so firstMessage should be empty
			expect(sessions[0].firstMessage).toBe('');
		});

		it('should skip text blocks that are whitespace-only', async () => {
			const content = jsonl(
				userMsg([
					{ type: 'text', text: '   ' },
					{ type: 'text', text: '' },
				]),
				assistantMsg('Actual response')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-4.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 300, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			// Should fall through to assistant message since user text blocks are whitespace-only
			expect(sessions[0].firstMessage).toBe('Actual response');
		});
	});

	// ==========================================================================
	// parseSessionContent (tested indirectly via listSessions)
	// ==========================================================================

	describe('parseSessionContent (via listSessions)', () => {
		it('should count user and assistant messages via regex', async () => {
			const content = jsonl(
				userMsg('msg 1'),
				assistantMsg('reply 1'),
				userMsg('msg 2', '2025-06-01T10:03:00Z', 'u2'),
				assistantMsg('reply 2', '2025-06-01T10:04:00Z', 'a2'),
				userMsg('msg 3', '2025-06-01T10:05:00Z', 'u3')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-count.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 2048, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			// 3 user + 2 assistant = 5
			expect(sessions[0].messageCount).toBe(5);
		});

		it('should prefer first assistant message as preview over user message', async () => {
			const content = jsonl(
				userMsg('User says hello'),
				assistantMsg('Assistant responds helpfully')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-preview.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 500, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].firstMessage).toBe('Assistant responds helpfully');
		});

		it('should fall back to first user message when no assistant message exists', async () => {
			const content = jsonl(userMsg('Only user message here'));

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-fallback.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 300, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].firstMessage).toBe('Only user message here');
		});

		it('should sum token counts using regex extraction', async () => {
			const content = jsonl(
				userMsg('Hello'),
				assistantMsg('World'),
				resultEntry(100, 50, 20, 10),
				resultEntry(200, 75, 30, 15)
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-tokens.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 1024, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			expect(sessions[0].inputTokens).toBe(300); // 100 + 200
			expect(sessions[0].outputTokens).toBe(125); // 50 + 75
			expect(sessions[0].cacheReadTokens).toBe(50); // 20 + 30
			expect(sessions[0].cacheCreationTokens).toBe(25); // 10 + 15
		});

		it('should calculate cost via calculateClaudeCost', async () => {
			const content = jsonl(
				userMsg('Hello'),
				assistantMsg('World'),
				resultEntry(1000, 500, 200, 100)
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-cost.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 1024, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(calculateClaudeCost).toHaveBeenCalledWith(1000, 500, 200, 100);
			expect(sessions[0].costUsd).toBeDefined();
			// Using mock formula: (1000*3 + 500*15 + 200*0.3 + 100*3.75) / 1000000
			const expectedCost = (1000 * 3 + 500 * 15 + 200 * 0.3 + 100 * 3.75) / 1_000_000;
			expect(sessions[0].costUsd).toBeCloseTo(expectedCost, 10);
		});

		it('should extract last timestamp for duration calculation', async () => {
			const content = jsonl(
				userMsg('Start', '2025-06-01T10:00:00Z'),
				assistantMsg('Middle', '2025-06-01T10:05:00Z'),
				resultEntry(10, 5, 0, 0, '2025-06-01T10:10:00Z')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-dur.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 800, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			// First timestamp comes from first user message: 10:00:00
			// Last timestamp comes from result entry: 10:10:00
			// Duration = 10 minutes = 600 seconds
			expect(sessions[0].durationSeconds).toBe(600);
		});

		it('should truncate firstMessage to FIRST_MESSAGE_PREVIEW_LENGTH (200)', async () => {
			const longMessage = 'A'.repeat(300);
			const content = jsonl(assistantMsg(longMessage));

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-trunc.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 500, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].firstMessage).toHaveLength(200);
		});

		it('should set sizeBytes and modifiedAt from stats', async () => {
			const content = jsonl(userMsg('Test'));
			const mtimeMs = new Date('2025-07-15T08:30:00Z').getTime();

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-meta.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 4096, mtimeMs, mtime: new Date(mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].sizeBytes).toBe(4096);
			expect(sessions[0].modifiedAt).toBe(new Date(mtimeMs).toISOString());
		});

		it('should skip malformed JSONL lines gracefully', async () => {
			const content = [
				JSON.stringify(userMsg('Valid message')),
				'this is not valid json',
				JSON.stringify(assistantMsg('Valid reply')),
			].join('\n');

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-malformed.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 512, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			// Should still parse valid lines; 1 user + 1 assistant = 2
			expect(sessions[0].messageCount).toBe(2);
		});

		it('should filter empty lines from content', async () => {
			const content = [
				JSON.stringify(userMsg('Hello')),
				'',
				'   ',
				JSON.stringify(assistantMsg('World')),
			].join('\n');

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-empty.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 400, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions).toHaveLength(1);
			expect(sessions[0].messageCount).toBe(2);
		});

		it('should filter out zero-byte sessions', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['empty.jsonl', 'valid.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockImplementation((filePath: unknown) => {
				const fp = filePath as string;
				if (fp.includes('empty')) {
					return Promise.resolve({ size: 0, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) }) as unknown as ReturnType<typeof fs.stat>;
				}
				return Promise.resolve({ size: 512, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) }) as unknown as ReturnType<typeof fs.stat>;
			});
			vi.mocked(fs.readFile).mockResolvedValue(jsonl(userMsg('Content')));

			const sessions = await storage.listSessions('/test/project');
			// Only valid.jsonl should remain (empty.jsonl has size 0)
			expect(sessions).toHaveLength(1);
			expect(sessions[0].sessionId).toBe('valid');
		});

		it('should handle session with zero tokens', async () => {
			const content = jsonl(
				userMsg('Question'),
				assistantMsg('Answer')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-notokens.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 256, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].inputTokens).toBe(0);
			expect(sessions[0].outputTokens).toBe(0);
			expect(sessions[0].cacheReadTokens).toBe(0);
			expect(sessions[0].cacheCreationTokens).toBe(0);
		});

		it('should return empty array when project directory does not exist', async () => {
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			const sessions = await storage.listSessions('/nonexistent/path');
			expect(sessions).toEqual([]);
		});
	});

	// ==========================================================================
	// Origin Management
	// ==========================================================================

	describe('registerSessionOrigin', () => {
		it('should store origin as a plain string when no sessionName provided', () => {
			storage.registerSessionOrigin('/test/project', 'sess-abc', 'user');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-abc']).toEqual({ origin: 'user' });
		});

		it('should store origin with sessionName as an object', () => {
			storage.registerSessionOrigin('/test/project', 'sess-abc', 'auto', 'My Session');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-abc']).toEqual({
				origin: 'auto',
				sessionName: 'My Session',
			});
		});

		it('should handle multiple sessions in the same project', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'user');
			storage.registerSessionOrigin('/test/project', 'sess-2', 'auto', 'Auto Session');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({ origin: 'user' });
			expect(origins['sess-2']).toEqual({ origin: 'auto', sessionName: 'Auto Session' });
		});

		it('should handle sessions across different projects', () => {
			storage.registerSessionOrigin('/project-a', 'sess-1', 'user');
			storage.registerSessionOrigin('/project-b', 'sess-2', 'auto');

			expect(storage.getSessionOrigins('/project-a')['sess-1']).toEqual({ origin: 'user' });
			expect(storage.getSessionOrigins('/project-b')['sess-2']).toEqual({ origin: 'auto' });
		});

		it('should overwrite existing origin when re-registered', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'user');
			storage.registerSessionOrigin('/test/project', 'sess-1', 'auto');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({ origin: 'auto' });
		});
	});

	describe('updateSessionName', () => {
		it('should create entry with default origin "user" if no existing entry', () => {
			storage.updateSessionName('/test/project', 'sess-new', 'Brand New');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-new']).toEqual({
				origin: 'user',
				sessionName: 'Brand New',
			});
		});

		it('should upgrade a string origin to an object with sessionName', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'auto');
			storage.updateSessionName('/test/project', 'sess-1', 'Named Session');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'auto',
				sessionName: 'Named Session',
			});
		});

		it('should update sessionName on an existing object origin', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'user', 'Old Name');
			storage.updateSessionName('/test/project', 'sess-1', 'New Name');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'user',
				sessionName: 'New Name',
			});
		});

		it('should preserve starred when updating sessionName on an existing object', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'user');
			storage.updateSessionStarred('/test/project', 'sess-1', true);
			storage.updateSessionName('/test/project', 'sess-1', 'Named');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'user',
				sessionName: 'Named',
				starred: true,
			});
		});
	});

	describe('updateSessionStarred', () => {
		it('should create entry with default origin "user" if no existing entry', () => {
			storage.updateSessionStarred('/test/project', 'sess-new', true);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-new']).toEqual({
				origin: 'user',
				starred: true,
			});
		});

		it('should upgrade a string origin to an object with starred', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'auto');
			storage.updateSessionStarred('/test/project', 'sess-1', true);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'auto',
				starred: true,
			});
		});

		it('should update starred on an existing object origin', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'user', 'My Session');
			storage.updateSessionStarred('/test/project', 'sess-1', true);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'user',
				sessionName: 'My Session',
				starred: true,
			});
		});

		it('should be able to un-star a session', () => {
			storage.updateSessionStarred('/test/project', 'sess-1', true);
			storage.updateSessionStarred('/test/project', 'sess-1', false);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1'].starred).toBe(false);
		});

		it('should preserve sessionName when updating starred', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'auto', 'Important');
			storage.updateSessionStarred('/test/project', 'sess-1', true);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'auto',
				sessionName: 'Important',
				starred: true,
			});
		});
	});

	describe('updateSessionContextUsage', () => {
		it('should create entry with default origin "user" if no existing entry', () => {
			storage.updateSessionContextUsage('/test/project', 'sess-new', 75);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-new']).toEqual({
				origin: 'user',
				contextUsage: 75,
			});
		});

		it('should upgrade a string origin to an object with contextUsage', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'auto');
			storage.updateSessionContextUsage('/test/project', 'sess-1', 50);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'auto',
				contextUsage: 50,
			});
		});

		it('should update contextUsage on an existing object origin', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'user', 'Session');
			storage.updateSessionContextUsage('/test/project', 'sess-1', 85);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'user',
				sessionName: 'Session',
				contextUsage: 85,
			});
		});

		it('should preserve other fields when updating contextUsage', () => {
			storage.registerSessionOrigin('/test/project', 'sess-1', 'auto', 'Named');
			storage.updateSessionStarred('/test/project', 'sess-1', true);
			storage.updateSessionContextUsage('/test/project', 'sess-1', 42);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1']).toEqual({
				origin: 'auto',
				sessionName: 'Named',
				starred: true,
				contextUsage: 42,
			});
		});

		it('should overwrite previous contextUsage value', () => {
			storage.updateSessionContextUsage('/test/project', 'sess-1', 30);
			storage.updateSessionContextUsage('/test/project', 'sess-1', 90);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-1'].contextUsage).toBe(90);
		});
	});

	// ==========================================================================
	// getSessionOrigins
	// ==========================================================================

	describe('getSessionOrigins', () => {
		it('should normalize string origins to SessionOriginInfo objects', () => {
			// Register a plain string origin
			storage.registerSessionOrigin('/test/project', 'sess-plain', 'user');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-plain']).toEqual({ origin: 'user' });
			expect(origins['sess-plain'].sessionName).toBeUndefined();
			expect(origins['sess-plain'].starred).toBeUndefined();
			expect(origins['sess-plain'].contextUsage).toBeUndefined();
		});

		it('should return full object origins with all fields', () => {
			storage.registerSessionOrigin('/test/project', 'sess-full', 'auto', 'My Session');
			storage.updateSessionStarred('/test/project', 'sess-full', true);
			storage.updateSessionContextUsage('/test/project', 'sess-full', 60);

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-full']).toEqual({
				origin: 'auto',
				sessionName: 'My Session',
				starred: true,
				contextUsage: 60,
			});
		});

		it('should return empty object for unknown project path', () => {
			const origins = storage.getSessionOrigins('/unknown/project');
			expect(origins).toEqual({});
		});

		it('should return origins for the correct project only', () => {
			storage.registerSessionOrigin('/project-a', 'sess-1', 'user');
			storage.registerSessionOrigin('/project-b', 'sess-2', 'auto');

			const originsA = storage.getSessionOrigins('/project-a');
			const originsB = storage.getSessionOrigins('/project-b');

			expect(Object.keys(originsA)).toEqual(['sess-1']);
			expect(Object.keys(originsB)).toEqual(['sess-2']);
		});

		it('should handle mixed string and object origins in the same project', () => {
			storage.registerSessionOrigin('/test/project', 'sess-string', 'user');
			storage.registerSessionOrigin('/test/project', 'sess-object', 'auto', 'Named');

			const origins = storage.getSessionOrigins('/test/project');
			expect(origins['sess-string']).toEqual({ origin: 'user' });
			expect(origins['sess-object']).toEqual({ origin: 'auto', sessionName: 'Named' });
		});
	});

	// ==========================================================================
	// getSessionPath
	// ==========================================================================

	describe('getSessionPath', () => {
		it('should return correct local file path', () => {
			const result = storage.getSessionPath('/Users/test/my-project', 'sess-abc123');
			expect(result).not.toBeNull();
			// The path should contain the encoded project path and session id
			expect(result).toContain('sess-abc123.jsonl');
			expect(result).toContain('.claude');
			expect(result).toContain('projects');
		});

		it('should return remote POSIX path when sshConfig is provided', () => {
			const sshConfig = { enabled: true, host: 'remote-host', user: 'testuser' };
			const result = storage.getSessionPath('/home/user/project', 'sess-remote', sshConfig as any);

			expect(result).not.toBeNull();
			expect(result).toContain('sess-remote.jsonl');
			expect(result).toContain('~/.claude/projects');
			// Remote paths use forward slashes (POSIX)
			expect(result).not.toContain('\\');
		});

		it('should use encodeClaudeProjectPath for the directory', async () => {
			const { encodeClaudeProjectPath } = await import('../../main/utils/statsCache');
			storage.getSessionPath('/my/project', 'sess-1');
			expect(encodeClaudeProjectPath).toHaveBeenCalledWith('/my/project');
		});
	});

	// ==========================================================================
	// Constructor
	// ==========================================================================

	describe('constructor', () => {
		it('should use provided store when passed', () => {
			const customStore = new Store({ name: 'custom', defaults: { origins: {} } });
			const customStorage = new ClaudeSessionStorage(customStore as any);
			expect(customStorage).toBeDefined();
		});

		it('should create a default store when none is provided', () => {
			const defaultStorage = new ClaudeSessionStorage();
			expect(defaultStorage).toBeDefined();
		});

		it('should have agentId set to claude-code', () => {
			expect(storage.agentId).toBe('claude-code');
		});
	});

	// ==========================================================================
	// listSessions - directory and file handling
	// ==========================================================================

	describe('listSessions', () => {
		it('should only process .jsonl files', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue([
				'session-1.jsonl',
				'notes.txt',
				'readme.md',
				'session-2.jsonl',
				'.hidden',
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 512, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(jsonl(userMsg('Test')));

			const sessions = await storage.listSessions('/test/project');
			// Should only have parsed the two .jsonl files
			expect(sessions).toHaveLength(2);
			const ids = sessions.map((s) => s.sessionId);
			expect(ids).toContain('session-1');
			expect(ids).toContain('session-2');
		});

		it('should sort sessions by modified date descending', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue([
				'old.jsonl',
				'new.jsonl',
			] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockImplementation((filePath: unknown) => {
				const fp = filePath as string;
				if (fp.includes('old')) {
					return Promise.resolve({
						size: 256,
						mtimeMs: new Date('2025-01-01T00:00:00Z').getTime(),
						mtime: new Date('2025-01-01T00:00:00Z'),
					}) as unknown as ReturnType<typeof fs.stat>;
				}
				return Promise.resolve({
					size: 256,
					mtimeMs: new Date('2025-06-15T00:00:00Z').getTime(),
					mtime: new Date('2025-06-15T00:00:00Z'),
				}) as unknown as ReturnType<typeof fs.stat>;
			});
			vi.mocked(fs.readFile).mockResolvedValue(jsonl(userMsg('Test')));

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].sessionId).toBe('new');
			expect(sessions[1].sessionId).toBe('old');
		});

		it('should attach origin info to sessions', async () => {
			storage.registerSessionOrigin('/test/project', 'sess-with-origin', 'auto', 'My Auto Session');
			storage.updateSessionStarred('/test/project', 'sess-with-origin', true);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-with-origin.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 512, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(jsonl(userMsg('Hello')));

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].origin).toBe('auto');
			expect(sessions[0].sessionName).toBe('My Auto Session');
			expect(sessions[0].starred).toBe(true);
		});

		it('should set sessionId from filename without extension', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['abc-123-def.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 256, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(jsonl(userMsg('Test')));

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].sessionId).toBe('abc-123-def');
		});

		it('should set projectPath on each session', async () => {
			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['s1.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 256, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(jsonl(userMsg('Test')));

			const sessions = await storage.listSessions('/my/special/project');
			expect(sessions[0].projectPath).toBe('/my/special/project');
		});
	});

	// ==========================================================================
	// Edge cases for token regex extraction
	// ==========================================================================

	describe('token regex extraction edge cases', () => {
		it('should handle multiple token entries scattered throughout content', async () => {
			const content = jsonl(
				userMsg('Hello'),
				{ type: 'result', timestamp: '2025-06-01T10:01:00Z', usage: { input_tokens: 50, output_tokens: 25 } },
				assistantMsg('Reply'),
				{ type: 'result', timestamp: '2025-06-01T10:02:00Z', usage: { input_tokens: 75, output_tokens: 50, cache_read_input_tokens: 10 } },
				userMsg('Follow up', '2025-06-01T10:03:00Z', 'u2'),
				{ type: 'result', timestamp: '2025-06-01T10:04:00Z', usage: { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 5 } }
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-multi.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 2048, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].inputTokens).toBe(225); // 50 + 75 + 100
			expect(sessions[0].outputTokens).toBe(105); // 25 + 50 + 30
			expect(sessions[0].cacheReadTokens).toBe(10);
			expect(sessions[0].cacheCreationTokens).toBe(5);
		});

		it('should handle content with no token information at all', async () => {
			const content = jsonl(
				userMsg('Just a message'),
				assistantMsg('Just a reply')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-notoken.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 256, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].inputTokens).toBe(0);
			expect(sessions[0].outputTokens).toBe(0);
		});
	});

	// ==========================================================================
	// Duration calculation edge cases
	// ==========================================================================

	describe('duration calculation', () => {
		it('should return 0 duration when only one timestamp exists', async () => {
			const content = jsonl(
				userMsg('Single message', '2025-06-01T10:00:00Z')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-single.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 128, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].durationSeconds).toBe(0);
		});

		it('should never return negative duration', async () => {
			// If last timestamp is somehow before first timestamp,
			// Math.max(0, ...) ensures non-negative
			const content = jsonl(
				userMsg('Later message', '2025-06-01T12:00:00Z'),
				assistantMsg('Earlier response', '2025-06-01T10:00:00Z')
			);

			vi.mocked(fs.access).mockResolvedValue(undefined);
			vi.mocked(fs.readdir).mockResolvedValue(['sess-neg.jsonl'] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
			vi.mocked(fs.stat).mockResolvedValue({ size: 256, mtimeMs: DEFAULT_STATS.mtimeMs, mtime: new Date(DEFAULT_STATS.mtimeMs) } as unknown as Awaited<ReturnType<typeof fs.stat>>);
			vi.mocked(fs.readFile).mockResolvedValue(content);

			const sessions = await storage.listSessions('/test/project');
			expect(sessions[0].durationSeconds).toBeGreaterThanOrEqual(0);
		});
	});

	// ==========================================================================
	// Combined origin operations (integration-style)
	// ==========================================================================

	describe('combined origin operations', () => {
		it('should support full lifecycle: register, name, star, contextUsage, read', () => {
			// Register
			storage.registerSessionOrigin('/proj', 'sess-lc', 'auto');
			expect(storage.getSessionOrigins('/proj')['sess-lc']).toEqual({ origin: 'auto' });

			// Name
			storage.updateSessionName('/proj', 'sess-lc', 'Lifecycle Test');
			expect(storage.getSessionOrigins('/proj')['sess-lc']).toEqual({
				origin: 'auto',
				sessionName: 'Lifecycle Test',
			});

			// Star
			storage.updateSessionStarred('/proj', 'sess-lc', true);
			expect(storage.getSessionOrigins('/proj')['sess-lc']).toEqual({
				origin: 'auto',
				sessionName: 'Lifecycle Test',
				starred: true,
			});

			// Context usage
			storage.updateSessionContextUsage('/proj', 'sess-lc', 95);
			expect(storage.getSessionOrigins('/proj')['sess-lc']).toEqual({
				origin: 'auto',
				sessionName: 'Lifecycle Test',
				starred: true,
				contextUsage: 95,
			});
		});

		it('should handle multiple sessions in different projects independently', () => {
			storage.registerSessionOrigin('/proj-a', 'sess-1', 'user', 'Alpha');
			storage.registerSessionOrigin('/proj-b', 'sess-1', 'auto', 'Beta');

			storage.updateSessionStarred('/proj-a', 'sess-1', true);

			const originsA = storage.getSessionOrigins('/proj-a');
			const originsB = storage.getSessionOrigins('/proj-b');

			expect(originsA['sess-1'].starred).toBe(true);
			expect(originsB['sess-1'].starred).toBeUndefined();
			expect(originsA['sess-1'].origin).toBe('user');
			expect(originsB['sess-1'].origin).toBe('auto');
		});
	});
});
