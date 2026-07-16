/**
 * Tests for ClaudeSessionStorage
 *
 * Verifies:
 * - Session origin registration and retrieval
 * - Session naming and starring
 * - Context usage tracking
 * - Origin info attachment to sessions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import { ClaudeSessionStorage } from '../../../main/storage/claude-session-storage';
import type { SshRemoteConfig } from '../../../shared/types';
import type Store from 'electron-store';
import type { AgentSessionOriginsData } from '../../../main/stores/types';

// Mock electron-store
const mockStoreData: Record<string, unknown> = {};
vi.mock('electron-store', () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			get: vi.fn((key: string, defaultValue?: unknown) => {
				return mockStoreData[key] ?? defaultValue;
			}),
			set: vi.fn((key: string, value: unknown) => {
				mockStoreData[key] = value;
			}),
			store: mockStoreData,
		})),
	};
});

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		access: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
	},
}));

// Mock remote-fs utilities
vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	listDirWithStatsRemote: vi.fn(),
}));

// Mock statsCache
vi.mock('../../../main/utils/statsCache', () => ({
	encodeClaudeProjectPath: vi.fn((projectPath: string) => {
		// Match Claude Code's encoding: replace all non-alphanumeric with -
		return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
	}),
}));

// Mock pricing
vi.mock('../../../main/utils/pricing', () => ({
	calculateClaudeCost: vi.fn(() => 0.05),
}));

describe('ClaudeSessionStorage', () => {
	let storage: ClaudeSessionStorage;
	let mockStore: {
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		store: Record<string, unknown>;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Reset mock store data
		Object.keys(mockStoreData).forEach((key) => delete mockStoreData[key]);
		mockStoreData['origins'] = {};

		mockStore = {
			get: vi.fn((key: string, defaultValue?: unknown) => {
				return mockStoreData[key] ?? defaultValue;
			}),
			set: vi.fn((key: string, value: unknown) => {
				mockStoreData[key] = value;
			}),
			store: mockStoreData,
		};

		// Create storage with mock store
		storage = new ClaudeSessionStorage(mockStore as unknown as Store<AgentSessionOriginsData>);
	});

	describe('Origin Management', () => {
		describe('registerSessionOrigin', () => {
			it('should register a user session origin', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123']).toEqual({ origin: 'user' });
			});

			it('should register an auto session origin', () => {
				storage.registerSessionOrigin('/project/path', 'session-456', 'auto');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-456']).toEqual({ origin: 'auto' });
			});

			it('should register origin with session name', () => {
				storage.registerSessionOrigin('/project/path', 'session-789', 'user', 'My Session');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-789']).toEqual({
					origin: 'user',
					sessionName: 'My Session',
				});
			});

			it('should handle multiple sessions for same project', () => {
				storage.registerSessionOrigin('/project/path', 'session-1', 'user');
				storage.registerSessionOrigin('/project/path', 'session-2', 'auto');
				storage.registerSessionOrigin('/project/path', 'session-3', 'user', 'Named');

				const origins = storage.getSessionOrigins('/project/path');
				expect(Object.keys(origins)).toHaveLength(3);
			});

			it('should handle multiple projects', () => {
				storage.registerSessionOrigin('/project/a', 'session-a', 'user');
				storage.registerSessionOrigin('/project/b', 'session-b', 'auto');

				expect(storage.getSessionOrigins('/project/a')['session-a']).toBeDefined();
				expect(storage.getSessionOrigins('/project/b')['session-b']).toBeDefined();
				expect(storage.getSessionOrigins('/project/a')['session-b']).toBeUndefined();
			});

			it('should persist to store', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');

				expect(mockStore.set).toHaveBeenCalledWith(
					'origins',
					expect.objectContaining({
						'claude-code': expect.objectContaining({
							'/project/path': expect.objectContaining({
								'session-123': { origin: 'user' },
							}),
						}),
					})
				);
			});
		});

		describe('updateSessionName', () => {
			it('should update name for existing session with string origin', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');
				storage.updateSessionName('/project/path', 'session-123', 'New Name');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123']).toEqual({
					origin: 'user',
					sessionName: 'New Name',
				});
			});

			it('should update name for existing session with object origin', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user', 'Old Name');
				storage.updateSessionName('/project/path', 'session-123', 'New Name');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].sessionName).toBe('New Name');
			});

			it('should create origin entry if session not registered', () => {
				storage.updateSessionName('/project/path', 'new-session', 'Session Name');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['new-session']).toEqual({
					origin: 'user',
					sessionName: 'Session Name',
				});
			});

			it('should preserve existing starred status', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');
				storage.updateSessionStarred('/project/path', 'session-123', true);
				storage.updateSessionName('/project/path', 'session-123', 'Named');

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].starred).toBe(true);
				expect(origins['session-123'].sessionName).toBe('Named');
			});
		});

		describe('updateSessionStarred', () => {
			it('should star a session', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');
				storage.updateSessionStarred('/project/path', 'session-123', true);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].starred).toBe(true);
			});

			it('should unstar a session', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');
				storage.updateSessionStarred('/project/path', 'session-123', true);
				storage.updateSessionStarred('/project/path', 'session-123', false);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].starred).toBe(false);
			});

			it('should create origin entry if session not registered', () => {
				storage.updateSessionStarred('/project/path', 'new-session', true);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['new-session']).toEqual({
					origin: 'user',
					starred: true,
				});
			});

			it('should preserve existing session name', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user', 'My Session');
				storage.updateSessionStarred('/project/path', 'session-123', true);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].sessionName).toBe('My Session');
				expect(origins['session-123'].starred).toBe(true);
			});
		});

		describe('updateSessionContextUsage', () => {
			it('should store context usage percentage', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');
				storage.updateSessionContextUsage('/project/path', 'session-123', 75);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].contextUsage).toBe(75);
			});

			it('should create origin entry if session not registered', () => {
				storage.updateSessionContextUsage('/project/path', 'new-session', 50);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['new-session']).toEqual({
					origin: 'user',
					contextUsage: 50,
				});
			});

			it('should preserve existing origin data', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'auto', 'Named');
				storage.updateSessionStarred('/project/path', 'session-123', true);
				storage.updateSessionContextUsage('/project/path', 'session-123', 80);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123']).toEqual({
					origin: 'auto',
					sessionName: 'Named',
					starred: true,
					contextUsage: 80,
				});
			});

			it('should update context usage on subsequent calls', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user');
				storage.updateSessionContextUsage('/project/path', 'session-123', 25);
				storage.updateSessionContextUsage('/project/path', 'session-123', 50);
				storage.updateSessionContextUsage('/project/path', 'session-123', 75);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123'].contextUsage).toBe(75);
			});
		});

		describe('getSessionOrigins', () => {
			it('should return empty object for project with no sessions', () => {
				const origins = storage.getSessionOrigins('/nonexistent/project');
				expect(origins).toEqual({});
			});

			it('reads canonical agent-keyed origin records', () => {
				mockStoreData['origins'] = {
					'claude-code': {
						'/project/path': {
							'session-123': { origin: 'user' },
						},
					},
				};

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123']).toEqual({ origin: 'user' });
			});

			it('should return full SessionOriginInfo for object origins', () => {
				storage.registerSessionOrigin('/project/path', 'session-123', 'user', 'Named');
				storage.updateSessionStarred('/project/path', 'session-123', true);
				storage.updateSessionContextUsage('/project/path', 'session-123', 60);

				const origins = storage.getSessionOrigins('/project/path');
				expect(origins['session-123']).toEqual({
					origin: 'user',
					sessionName: 'Named',
					starred: true,
					contextUsage: 60,
				});
			});
		});
	});

	describe('Session Path', () => {
		describe('getSessionPath', () => {
			it('should return correct local path', () => {
				const sessionPath = storage.getSessionPath('/project/path', 'session-123');

				expect(sessionPath).toBeDefined();
				expect(sessionPath).toContain('session-123.jsonl');
				expect(sessionPath).toContain('.claude');
				expect(sessionPath).toContain('projects');
			});

			it('should return remote path when sshConfig provided', () => {
				const sshConfig: SshRemoteConfig = {
					id: 'test-remote',
					name: 'Test Remote',
					host: 'remote.example.com',
					port: 22,
					username: 'testuser',
					privateKeyPath: '~/.ssh/id_rsa',
					enabled: true,
					useSshConfig: false,
				};
				const sessionPath = storage.getSessionPath('/project/path', 'session-123', sshConfig);

				expect(sessionPath).toBeDefined();
				expect(sessionPath).toContain('session-123.jsonl');
				expect(sessionPath).toContain('~/.claude/projects');
			});
		});
	});

	describe('Agent ID', () => {
		it('should have correct agent ID', () => {
			expect(storage.agentId).toBe('claude-code');
		});
	});

	describe('Edge Cases', () => {
		it('should handle special characters in project path', () => {
			storage.registerSessionOrigin('/path/with spaces/and-dashes', 'session-1', 'user');

			const origins = storage.getSessionOrigins('/path/with spaces/and-dashes');
			expect(origins['session-1']).toBeDefined();
		});

		it('should handle special characters in session ID', () => {
			storage.registerSessionOrigin('/project', 'session-with-dashes-123', 'user');
			storage.registerSessionOrigin('/project', 'session_with_underscores', 'auto');

			const origins = storage.getSessionOrigins('/project');
			expect(origins['session-with-dashes-123']).toBeDefined();
			expect(origins['session_with_underscores']).toBeDefined();
		});

		it('should handle empty session name', () => {
			storage.registerSessionOrigin('/project', 'session-123', 'user', '');

			const origins = storage.getSessionOrigins('/project');
			// Empty string is falsy, so sessionName is not stored when empty
			expect(origins['session-123']).toEqual({ origin: 'user' });
		});

		it('should handle zero context usage', () => {
			storage.updateSessionContextUsage('/project', 'session-123', 0);

			const origins = storage.getSessionOrigins('/project');
			expect(origins['session-123'].contextUsage).toBe(0);
		});

		it('should handle 100% context usage', () => {
			storage.updateSessionContextUsage('/project', 'session-123', 100);

			const origins = storage.getSessionOrigins('/project');
			expect(origins['session-123'].contextUsage).toBe(100);
		});
	});

	describe('Storage Persistence', () => {
		it('should call store.set on every origin update', () => {
			storage.registerSessionOrigin('/project', 'session-1', 'user');
			expect(mockStore.set).toHaveBeenCalledTimes(1);

			storage.updateSessionName('/project', 'session-1', 'Name');
			expect(mockStore.set).toHaveBeenCalledTimes(2);

			storage.updateSessionStarred('/project', 'session-1', true);
			expect(mockStore.set).toHaveBeenCalledTimes(3);

			storage.updateSessionContextUsage('/project', 'session-1', 50);
			expect(mockStore.set).toHaveBeenCalledTimes(4);
		});

		it('should always call store.set with origins key', () => {
			storage.registerSessionOrigin('/project', 'session-1', 'user');

			expect(mockStore.set).toHaveBeenCalledWith('origins', expect.any(Object));
		});
	});

	describe('readSessionMessages - image reconstruction', () => {
		const jsonl = (entries: unknown[]): string => entries.map((e) => JSON.stringify(e)).join('\n');

		it('reconstructs base64 data URLs from image content blocks', async () => {
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'u1',
					message: {
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
							{ type: 'text', text: 'look at this' },
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].images).toEqual(['data:image/png;base64,AAAA']);
			expect(result.messages[0].content).toBe('look at this');
		});

		it('drops the synthetic [Image: ...] placeholder text when images are recovered', async () => {
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'u1',
					message: {
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
							{
								type: 'text',
								text: '[Image: original 2808x1566, displayed at 2000x1115. Multiply coordinates by 1.40 to map to original image.]',
							},
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].images).toEqual(['data:image/jpeg;base64,BBBB']);
			expect(result.messages[0].content).toBe('');
		});

		it('drops a standalone placeholder-only message that has no image block', async () => {
			// The harness sometimes emits the [Image: ...] description as its own
			// follow-up message (an echo of an image shown in a prior turn). With no
			// real image to render, the whole message collapses to nothing.
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'real',
					message: {
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
							{ type: 'text', text: 'Getting better but...' },
						],
					},
				},
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:01.000Z',
					uuid: 'echo',
					message: {
						role: 'user',
						content: [
							{
								type: 'text',
								text: '[Image: original 2808x1566, displayed at 2000x1115. Multiply coordinates by 1.40 to map to original image.]\n[Image: original 2828x1906, displayed at 2000x1348. Multiply coordinates by 1.41 to map to original image.]',
							},
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].uuid).toBe('real');
			expect(result.messages[0].images).toEqual(['data:image/png;base64,AAAA']);
			expect(result.messages[0].content).toBe('Getting better but...');
		});

		it('keeps real text while stripping a placeholder line in the same block', async () => {
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'u1',
					message: {
						role: 'user',
						content: [
							{
								type: 'text',
								text: 'before\n[Image: original 100x100, displayed at 50x50. Multiply coordinates by 2.00 to map to original image.]\nafter',
							},
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].content).toBe('before\nafter');
		});

		it('keeps a message that has only images and no text', async () => {
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'u1',
					message: {
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } },
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0].images).toEqual(['data:image/png;base64,CCCC']);
		});

		it('preserves multiple images in order', async () => {
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'u1',
					message: {
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'one' } },
							{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'two' } },
							{ type: 'text', text: 'two shots' },
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages[0].images).toEqual([
				'data:image/png;base64,one',
				'data:image/png;base64,two',
			]);
		});

		it('does not set images for text-only messages', async () => {
			const transcript = jsonl([
				{
					type: 'assistant',
					timestamp: '2026-06-02T02:42:00.000Z',
					uuid: 'a1',
					message: { role: 'assistant', content: [{ type: 'text', text: 'plain reply' }] },
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages[0].images).toBeUndefined();
			expect(result.messages[0].content).toBe('plain reply');
		});

		it('ignores malformed image blocks lacking base64 data', async () => {
			const transcript = jsonl([
				{
					type: 'user',
					timestamp: '2026-06-02T02:41:00.000Z',
					uuid: 'u1',
					message: {
						role: 'user',
						content: [
							{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
							{ type: 'text', text: 'with a url image' },
						],
					},
				},
			]);
			vi.mocked(fs.readFile).mockResolvedValue(transcript as never);

			const result = await storage.readSessionMessages('/project', 'session-1');

			expect(result.messages[0].images).toBeUndefined();
			expect(result.messages[0].content).toBe('with a url image');
		});
	});
});
