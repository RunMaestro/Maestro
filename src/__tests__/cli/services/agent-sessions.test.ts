/**
 * @file agent-sessions.test.ts
 * @description Tests for the CLI agent-sessions service
 *
 * Tests session listing from Claude Code's .jsonl files on disk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { listClaudeSessions } from '../../../cli/services/agent-sessions';

// Mock fs
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
	statSync: vi.fn(),
}));

// Mock os
vi.mock('os', () => ({
	homedir: vi.fn(() => '/home/testuser'),
	platform: vi.fn(() => 'darwin'),
}));

describe('listClaudeSessions', () => {
	const projectPath = '/path/to/project';
	// encodeClaudeProjectPath: replace / and . with -
	const encodedPath = '-path-to-project';
	const sessionsDir = `/home/testuser/.claude/projects/${encodedPath}`;

	const makeJsonlContent = (opts: {
		userMessage?: string;
		assistantMessage?: string;
		timestamp?: string;
		inputTokens?: number;
		outputTokens?: number;
	} = {}) => {
		const lines: string[] = [];
		const ts = opts.timestamp || '2026-02-08T10:00:00.000Z';

		if (opts.userMessage) {
			lines.push(JSON.stringify({
				type: 'user',
				timestamp: ts,
				message: { role: 'user', content: opts.userMessage },
			}));
		}
		if (opts.assistantMessage) {
			lines.push(JSON.stringify({
				type: 'assistant',
				timestamp: ts,
				message: { role: 'assistant', content: opts.assistantMessage },
			}));
		}
		if (opts.inputTokens || opts.outputTokens) {
			lines.push(JSON.stringify({
				type: 'result',
				timestamp: ts,
				usage: {
					input_tokens: opts.inputTokens || 0,
					output_tokens: opts.outputTokens || 0,
				},
			}));
		}
		return lines.join('\n');
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should return empty result when project directory does not exist', () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);

		const result = listClaudeSessions(projectPath);

		expect(result.sessions).toEqual([]);
		expect(result.totalCount).toBe(0);
	});

	it('should parse session files and return sorted results', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			// Origins file doesn't exist
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-old.jsonl' as unknown as fs.Dirent,
			'session-new.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-old')) {
				return { size: 500, mtimeMs: new Date('2026-02-01T00:00:00Z').getTime() } as fs.Stats;
			}
			return { size: 800, mtimeMs: new Date('2026-02-08T00:00:00Z').getTime() } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-old')) {
				return makeJsonlContent({
					userMessage: 'Old task',
					assistantMessage: 'Old response',
					timestamp: '2026-02-01T00:00:00.000Z',
					inputTokens: 100,
					outputTokens: 50,
				});
			}
			if (pStr.includes('session-new')) {
				return makeJsonlContent({
					userMessage: 'New task',
					assistantMessage: 'New response',
					timestamp: '2026-02-08T00:00:00.000Z',
					inputTokens: 200,
					outputTokens: 100,
				});
			}
			// Origins store - not found
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.totalCount).toBe(2);
		expect(result.sessions).toHaveLength(2);
		// Newest first
		expect(result.sessions[0].sessionId).toBe('session-new');
		expect(result.sessions[1].sessionId).toBe('session-old');
	});

	it('should skip empty (0-byte) session files', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-empty.jsonl' as unknown as fs.Dirent,
			'session-valid.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-empty')) {
				return { size: 0, mtimeMs: Date.now() } as fs.Stats;
			}
			return { size: 500, mtimeMs: Date.now() } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-valid')) {
				return makeJsonlContent({
					userMessage: 'Hello',
					assistantMessage: 'Hi there',
				});
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.totalCount).toBe(1);
		expect(result.sessions[0].sessionId).toBe('session-valid');
	});

	it('should apply limit to results', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-1.jsonl' as unknown as fs.Dirent,
			'session-2.jsonl' as unknown as fs.Dirent,
			'session-3.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('.jsonl')) {
				return makeJsonlContent({ userMessage: 'Task', assistantMessage: 'Response' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath, { limit: 2 });

		expect(result.totalCount).toBe(3);
		expect(result.sessions).toHaveLength(2);
	});

	it('should skip sessions for pagination', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-a.jsonl' as unknown as fs.Dirent,
			'session-b.jsonl' as unknown as fs.Dirent,
			'session-c.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-a')) return { size: 500, mtimeMs: 3000 } as fs.Stats;
			if (pStr.includes('session-b')) return { size: 500, mtimeMs: 2000 } as fs.Stats;
			return { size: 500, mtimeMs: 1000 } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('.jsonl')) {
				return makeJsonlContent({ userMessage: 'Task', assistantMessage: 'Response' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		// Skip first 2, get the last one
		const result = listClaudeSessions(projectPath, { skip: 2, limit: 10 });

		expect(result.totalCount).toBe(3);
		expect(result.sessions).toHaveLength(1);
		// Sorted newest first: session-a (3000), session-b (2000), session-c (1000)
		// After skip 2, only session-c remains
		expect(result.sessions[0].sessionId).toBe('session-c');
	});

	it('should combine skip and limit for pagination', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-1.jsonl' as unknown as fs.Dirent,
			'session-2.jsonl' as unknown as fs.Dirent,
			'session-3.jsonl' as unknown as fs.Dirent,
			'session-4.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-1')) return { size: 500, mtimeMs: 4000 } as fs.Stats;
			if (pStr.includes('session-2')) return { size: 500, mtimeMs: 3000 } as fs.Stats;
			if (pStr.includes('session-3')) return { size: 500, mtimeMs: 2000 } as fs.Stats;
			return { size: 500, mtimeMs: 1000 } as fs.Stats;
		});

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('.jsonl')) {
				return makeJsonlContent({ userMessage: 'Task', assistantMessage: 'Response' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		// Skip 1, take 2 → sessions 2 and 3
		const result = listClaudeSessions(projectPath, { skip: 1, limit: 2 });

		expect(result.totalCount).toBe(4);
		expect(result.sessions).toHaveLength(2);
		expect(result.sessions[0].sessionId).toBe('session-2');
		expect(result.sessions[1].sessionId).toBe('session-3');
	});

	it('should filter sessions by search keyword in first message', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-auth.jsonl' as unknown as fs.Dirent,
			'session-tests.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-auth')) {
				return makeJsonlContent({
					userMessage: 'Fix the authentication flow',
					assistantMessage: 'I will help fix auth',
				});
			}
			if (pStr.includes('session-tests')) {
				return makeJsonlContent({
					userMessage: 'Write unit tests',
					assistantMessage: 'I will write tests',
				});
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath, { search: 'auth' });

		expect(result.totalCount).toBe(2);
		expect(result.filteredCount).toBe(1);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].sessionId).toBe('session-auth');
	});

	it('should attach session names from origins store', () => {
		vi.mocked(os.platform).mockReturnValue('darwin');

		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-named.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('claude-session-origins.json')) {
				return JSON.stringify({
					origins: {
						[projectPath]: {
							'session-named': {
								origin: 'user',
								sessionName: 'My Named Session',
								starred: true,
							},
						},
					},
				});
			}
			if (pStr.includes('session-named.jsonl')) {
				return makeJsonlContent({
					userMessage: 'Do something',
					assistantMessage: 'Done',
				});
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].sessionName).toBe('My Named Session');
		expect(result.sessions[0].starred).toBe(true);
		expect(result.sessions[0].origin).toBe('user');
	});

	it('should search in session names from origins store', () => {
		vi.mocked(os.platform).mockReturnValue('darwin');

		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-1.jsonl' as unknown as fs.Dirent,
			'session-2.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 500,
			mtimeMs: Date.now(),
		} as fs.Stats);

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('claude-session-origins.json')) {
				return JSON.stringify({
					origins: {
						[projectPath]: {
							'session-1': {
								origin: 'user',
								sessionName: 'Refactor auth module',
							},
							'session-2': {
								origin: 'user',
								sessionName: 'Database migration',
							},
						},
					},
				});
			}
			if (pStr.includes('session-1.jsonl')) {
				return makeJsonlContent({ userMessage: 'Start refactoring', assistantMessage: 'OK' });
			}
			if (pStr.includes('session-2.jsonl')) {
				return makeJsonlContent({ userMessage: 'Start migration', assistantMessage: 'OK' });
			}
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath, { search: 'migration' });

		expect(result.filteredCount).toBe(1);
		expect(result.sessions[0].sessionName).toBe('Database migration');
	});

	it('should extract token counts and calculate cost', () => {
		vi.mocked(fs.existsSync).mockImplementation((p) => {
			if (p === sessionsDir) return true;
			return false;
		});

		vi.mocked(fs.readdirSync).mockReturnValue([
			'session-tokens.jsonl' as unknown as fs.Dirent,
		]);

		vi.mocked(fs.statSync).mockReturnValue({
			size: 1000,
			mtimeMs: Date.now(),
		} as fs.Stats);

		const content = [
			JSON.stringify({
				type: 'user',
				timestamp: '2026-02-08T10:00:00.000Z',
				message: { role: 'user', content: 'Hello' },
			}),
			JSON.stringify({
				type: 'assistant',
				timestamp: '2026-02-08T10:00:05.000Z',
				message: { role: 'assistant', content: 'Hi there' },
			}),
			JSON.stringify({
				type: 'result',
				timestamp: '2026-02-08T10:00:05.000Z',
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_read_input_tokens: 200,
					cache_creation_input_tokens: 100,
				},
			}),
		].join('\n');

		vi.mocked(fs.readFileSync).mockImplementation((p) => {
			const pStr = p.toString();
			if (pStr.includes('session-tokens.jsonl')) return content;
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});

		const result = listClaudeSessions(projectPath);

		expect(result.sessions).toHaveLength(1);
		const session = result.sessions[0];
		expect(session.inputTokens).toBe(1000);
		expect(session.outputTokens).toBe(500);
		expect(session.cacheReadTokens).toBe(200);
		expect(session.cacheCreationTokens).toBe(100);
		expect(session.costUsd).toBeGreaterThan(0);
		expect(session.durationSeconds).toBe(5);
	});
});
