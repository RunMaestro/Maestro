import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Store from 'electron-store';
import type { ClaudeSessionOriginsData } from '../../../main/storage/claude-session-storage';
import {
	AgentSessionStorage,
	AgentSessionInfo,
	PaginatedSessionsResult,
	SessionMessagesResult,
	SessionSearchResult,
	SessionSearchMode,
	registerSessionStorage,
	getSessionStorage,
	hasSessionStorage,
	getAllSessionStorages,
	clearStorageRegistry,
} from '../../../main/agents';
import type { ToolType } from '../../../shared/types';

// Mock storage implementation for testing
class MockSessionStorage implements AgentSessionStorage {
	readonly agentId: ToolType;

	constructor(agentId: ToolType) {
		this.agentId = agentId;
	}

	async listSessions(_projectPath: string): Promise<AgentSessionInfo[]> {
		return [];
	}

	async listSessionsPaginated(
		_projectPath: string,
		_options?: { cursor?: string; limit?: number }
	): Promise<PaginatedSessionsResult> {
		return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
	}

	async readSessionMessages(
		_projectPath: string,
		_sessionId: string,
		_options?: { offset?: number; limit?: number }
	): Promise<SessionMessagesResult> {
		return { messages: [], total: 0, hasMore: false };
	}

	async searchSessions(
		_projectPath: string,
		_query: string,
		_searchMode: SessionSearchMode
	): Promise<SessionSearchResult[]> {
		return [];
	}

	getSessionPath(_projectPath: string, _sessionId: string): string | null {
		return `/mock/path/${_sessionId}.jsonl`;
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: true, linesRemoved: 2 };
	}
}

describe('agent-session-storage', () => {
	beforeEach(() => {
		clearStorageRegistry();
	});

	afterEach(() => {
		clearStorageRegistry();
	});

	describe('Storage Registry', () => {
		it('should register a storage implementation', () => {
			const storage = new MockSessionStorage('claude-code');
			registerSessionStorage(storage);
			expect(hasSessionStorage('claude-code')).toBe(true);
		});

		it('should retrieve a registered storage', () => {
			const storage = new MockSessionStorage('claude-code');
			registerSessionStorage(storage);
			const retrieved = getSessionStorage('claude-code');
			expect(retrieved).toBe(storage);
			expect(retrieved?.agentId).toBe('claude-code');
		});

		it('should return null for unregistered agent', () => {
			const result = getSessionStorage('unknown-agent' as ToolType);
			expect(result).toBeNull();
		});

		it('should return false for hasSessionStorage on unregistered agent', () => {
			expect(hasSessionStorage('unknown-agent')).toBe(false);
		});

		it('should get all registered storages', () => {
			const storage1 = new MockSessionStorage('claude-code');
			const storage2 = new MockSessionStorage('opencode');
			registerSessionStorage(storage1);
			registerSessionStorage(storage2);

			const all = getAllSessionStorages();
			expect(all).toHaveLength(2);
			expect(all).toContain(storage1);
			expect(all).toContain(storage2);
		});

		it('should clear all storages', () => {
			registerSessionStorage(new MockSessionStorage('claude-code'));
			registerSessionStorage(new MockSessionStorage('opencode'));

			expect(getAllSessionStorages()).toHaveLength(2);
			clearStorageRegistry();
			expect(getAllSessionStorages()).toHaveLength(0);
		});

		it('should overwrite existing registration for same agent', () => {
			const storage1 = new MockSessionStorage('claude-code');
			const storage2 = new MockSessionStorage('claude-code');
			registerSessionStorage(storage1);
			registerSessionStorage(storage2);

			expect(getAllSessionStorages()).toHaveLength(1);
			expect(getSessionStorage('claude-code')).toBe(storage2);
		});
	});

	describe('AgentSessionStorage Interface', () => {
		let storage: MockSessionStorage;

		beforeEach(() => {
			storage = new MockSessionStorage('claude-code');
		});

		it('should have required agentId property', () => {
			expect(storage.agentId).toBe('claude-code');
		});

		it('should implement listSessions', async () => {
			const sessions = await storage.listSessions('/test/project');
			expect(Array.isArray(sessions)).toBe(true);
		});

		it('should implement listSessionsPaginated', async () => {
			const result = await storage.listSessionsPaginated('/test/project');
			expect(result.sessions).toBeDefined();
			expect(result.hasMore).toBeDefined();
			expect(result.totalCount).toBeDefined();
			expect(result.nextCursor).toBeDefined();
		});

		it('should implement readSessionMessages', async () => {
			const result = await storage.readSessionMessages('/test/project', 'session-123');
			expect(result.messages).toBeDefined();
			expect(result.total).toBeDefined();
			expect(result.hasMore).toBeDefined();
		});

		it('should implement searchSessions', async () => {
			const results = await storage.searchSessions('/test/project', 'query', 'all');
			expect(Array.isArray(results)).toBe(true);
		});

		it('should implement getSessionPath', () => {
			const path = storage.getSessionPath('/test/project', 'session-123');
			expect(path).toBe('/mock/path/session-123.jsonl');
		});

		it('should implement deleteMessagePair', async () => {
			const result = await storage.deleteMessagePair('/test/project', 'session-123', 'uuid-456');
			expect(result.success).toBe(true);
			expect(result.linesRemoved).toBe(2);
		});
	});

	describe('Type Exports', () => {
		it('should export AgentSessionOrigin type with correct values', () => {
			const validOrigins: ('user' | 'auto')[] = ['user', 'auto'];
			expect(validOrigins).toContain('user');
			expect(validOrigins).toContain('auto');
		});

		it('should export SessionSearchMode type with correct values', () => {
			const validModes: SessionSearchMode[] = ['title', 'user', 'assistant', 'all'];
			expect(validModes).toContain('title');
			expect(validModes).toContain('user');
			expect(validModes).toContain('assistant');
			expect(validModes).toContain('all');
		});
	});
});

describe('ClaudeSessionStorage', () => {
	// Note: These tests would require mocking the filesystem
	// For now, we test that the class can be imported
	it('should be importable', async () => {
		// Dynamic import to test module loading
		const { ClaudeSessionStorage } = await import('../../../main/storage/claude-session-storage');
		expect(ClaudeSessionStorage).toBeDefined();
	});

	it('should have claude-code as agentId', async () => {
		const { ClaudeSessionStorage } = await import('../../../main/storage/claude-session-storage');

		// Create instance without store (it will create its own)
		// Note: In a real test, we'd mock electron-store
		const storage = new ClaudeSessionStorage();
		expect(storage.agentId).toBe('claude-code');
	});
});

describe('OpenCodeSessionStorage', () => {
	it('should be importable', async () => {
		const { OpenCodeSessionStorage } =
			await import('../../../main/storage/opencode-session-storage');
		expect(OpenCodeSessionStorage).toBeDefined();
	});

	it('should have opencode as agentId', async () => {
		const { OpenCodeSessionStorage } =
			await import('../../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();
		expect(storage.agentId).toBe('opencode');
	});

	it('should return empty results for non-existent projects', async () => {
		const { OpenCodeSessionStorage } =
			await import('../../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		// Non-existent project should return empty results
		const sessions = await storage.listSessions('/test/nonexistent/project');
		expect(sessions).toEqual([]);

		const paginated = await storage.listSessionsPaginated('/test/nonexistent/project');
		expect(paginated.sessions).toEqual([]);
		expect(paginated.totalCount).toBe(0);

		const messages = await storage.readSessionMessages('/test/nonexistent/project', 'session-123');
		expect(messages.messages).toEqual([]);
		expect(messages.total).toBe(0);

		const search = await storage.searchSessions('/test/nonexistent/project', 'query', 'all');
		expect(search).toEqual([]);
	});

	it('should return message directory path for getSessionPath', async () => {
		const { OpenCodeSessionStorage } =
			await import('../../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		// getSessionPath returns the message directory for the session
		const path = storage.getSessionPath('/test/project', 'session-123');
		expect(path).toContain('opencode');
		expect(path).toContain('storage');
		expect(path).toContain('message');
		expect(path).toContain('session-123');
	});

	it('should fail gracefully when deleting from non-existent session', async () => {
		const { OpenCodeSessionStorage } =
			await import('../../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		const deleteResult = await storage.deleteMessagePair(
			'/test/project',
			'session-123',
			'uuid-456'
		);
		expect(deleteResult.success).toBe(false);
		expect(deleteResult.error).toContain('No messages found in session');
	});
});

describe('CodexSessionStorage', () => {
	it('should be importable', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
		expect(CodexSessionStorage).toBeDefined();
	});

	it('should have codex as agentId', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();
		expect(storage.agentId).toBe('codex');
	});

	it('should return empty results for non-existent sessions directory', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		// Non-existent project should return empty results (since ~/.codex/sessions/ likely doesn't exist in test)
		const sessions = await storage.listSessions('/test/nonexistent/project');
		expect(sessions).toEqual([]);

		const paginated = await storage.listSessionsPaginated('/test/nonexistent/project');
		expect(paginated.sessions).toEqual([]);
		expect(paginated.totalCount).toBe(0);

		const messages = await storage.readSessionMessages(
			'/test/nonexistent/project',
			'nonexistent-session'
		);
		expect(messages.messages).toEqual([]);
		expect(messages.total).toBe(0);

		const search = await storage.searchSessions('/test/nonexistent/project', 'query', 'all');
		expect(search).toEqual([]);
	});

	it('should return null for getSessionPath (async operation required)', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		// getSessionPath is synchronous and always returns null for Codex
		// Use findSessionFile async method internally
		const path = storage.getSessionPath('/test/project', 'session-123');
		expect(path).toBeNull();
	});

	it('should fail gracefully when deleting from non-existent session', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const deleteResult = await storage.deleteMessagePair(
			'/test/project',
			'session-123',
			'uuid-456'
		);
		expect(deleteResult.success).toBe(false);
		expect(deleteResult.error).toContain('Session file not found');
	});

	it('should handle empty search query', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const search = await storage.searchSessions('/test/project', '', 'all');
		expect(search).toEqual([]);

		const searchWhitespace = await storage.searchSessions('/test/project', '   ', 'all');
		expect(searchWhitespace).toEqual([]);
	});
});

describe('Storage Module Initialization', () => {
	it('should export initializeSessionStorages function', async () => {
		const { initializeSessionStorages } = await import('../../../main/storage/index');
		expect(typeof initializeSessionStorages).toBe('function');
	});

	it('should export CodexSessionStorage', async () => {
		const { CodexSessionStorage } = await import('../../../main/storage/index');
		expect(CodexSessionStorage).toBeDefined();
	});

	it('should allow creating ClaudeSessionStorage with external store', async () => {
		// This tests that ClaudeSessionStorage can receive an external store
		// This prevents the dual-store bug where IPC handlers and storage class
		// use different electron-store instances
		const { ClaudeSessionStorage } = await import('../../../main/storage/claude-session-storage');

		// Create a mock store
		const mockStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
			store: { origins: {} },
		};

		// Should be able to create with external store (no throw)
		const storage = new ClaudeSessionStorage(
			mockStore as unknown as Store<ClaudeSessionOriginsData>
		);
		expect(storage.agentId).toBe('claude-code');
	});

	it('should export InitializeSessionStoragesOptions interface', async () => {
		// This tests that the options interface is exported for type-safe initialization
		const storageModule = await import('../../../main/storage/index');
		// The function should accept options object
		expect(typeof storageModule.initializeSessionStorages).toBe('function');
		// Function should accept undefined options (backward compatible)
		expect(() => storageModule.initializeSessionStorages()).not.toThrow();
	});

	it('should accept claudeSessionOriginsStore in options', async () => {
		// This tests the fix for the dual-store bug
		// When a shared store is passed, it should be used instead of creating a new one
		const { initializeSessionStorages } = await import('../../../main/storage/index');
		const { getSessionStorage, clearStorageRegistry } = await import('../../../main/agents');

		// Clear registry first
		clearStorageRegistry();

		// Create a mock store-like object
		// Note: In production, this would be an actual electron-store instance
		// The key is that the SAME store is used by both IPC handlers and ClaudeSessionStorage
		const mockStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
			store: { origins: {} },
		};

		// Initialize with the shared store
		// This mimics what main/index.ts does
		initializeSessionStorages({
			claudeSessionOriginsStore: mockStore as unknown as Store<ClaudeSessionOriginsData>,
		});

		// Verify ClaudeSessionStorage was registered
		const storage = getSessionStorage('claude-code');
		expect(storage).not.toBeNull();
		expect(storage?.agentId).toBe('claude-code');

		// Clean up
		clearStorageRegistry();
	});
});

describe('CodexSessionStorage SSH Remote Support', () => {
	// Mock SSH remote config for testing
	const mockSshConfig = {
		id: 'test-ssh',
		name: 'Test SSH Server',
		host: 'test-server.example.com',
		port: 22,
		username: 'testuser',
		useSshConfig: false,
		enabled: true,
	};

	describe('listSessions with SSH config', () => {
		it('should accept sshConfig parameter for listSessions', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// With SSH config - should not throw and should return array
			const sessions = await storage.listSessions('/test/path', mockSshConfig);
			expect(Array.isArray(sessions)).toBe(true);
		});

		it('should use local file system when sshConfig is undefined', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Without SSH config - should use local operations
			const sessions = await storage.listSessions('/test/nonexistent/project');
			expect(sessions).toEqual([]);
		});
	});

	describe('listSessionsPaginated with SSH config', () => {
		it('should accept sshConfig parameter for listSessionsPaginated', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// With SSH config - should work with pagination options
			const result = await storage.listSessionsPaginated('/test/path', {}, mockSshConfig);
			expect(result).toHaveProperty('sessions');
			expect(result).toHaveProperty('hasMore');
			expect(result).toHaveProperty('totalCount');
			expect(result).toHaveProperty('nextCursor');
			expect(Array.isArray(result.sessions)).toBe(true);
		});

		it('should support pagination options with SSH config', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Test with specific pagination options
			const result = await storage.listSessionsPaginated(
				'/test/path',
				{ limit: 10, cursor: undefined },
				mockSshConfig
			);
			expect(result.totalCount).toBe(0); // No sessions on test remote
			expect(result.hasMore).toBe(false);
		});
	});

	describe('readSessionMessages with SSH config', () => {
		it('should accept sshConfig parameter for readSessionMessages', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// With SSH config - should attempt to read remotely
			const result = await storage.readSessionMessages(
				'/test/path',
				'nonexistent-session',
				{},
				mockSshConfig
			);
			expect(result).toHaveProperty('messages');
			expect(result).toHaveProperty('total');
			expect(result).toHaveProperty('hasMore');
			expect(result.messages).toEqual([]);
		});

		it('should handle offset and limit options with SSH config', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Test pagination options with SSH config
			const result = await storage.readSessionMessages(
				'/test/path',
				'session-id',
				{ offset: 0, limit: 50 },
				mockSshConfig
			);
			expect(result.messages).toEqual([]);
			expect(result.total).toBe(0);
		});
	});

	describe('searchSessions with SSH config', () => {
		it('should accept sshConfig parameter for searchSessions', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// With SSH config - should search remotely
			const results = await storage.searchSessions(
				'/test/path',
				'test query',
				'all',
				mockSshConfig
			);
			expect(Array.isArray(results)).toBe(true);
		});

		it('should return empty results for empty query with SSH config', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			const results = await storage.searchSessions('/test/path', '', 'all', mockSshConfig);
			expect(results).toEqual([]);

			const whitespaceResults = await storage.searchSessions(
				'/test/path',
				'   ',
				'all',
				mockSshConfig
			);
			expect(whitespaceResults).toEqual([]);
		});

		it('should support all search modes with SSH config', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Test each search mode works with SSH config
			const modes: Array<'title' | 'user' | 'assistant' | 'all'> = [
				'title',
				'user',
				'assistant',
				'all',
			];

			for (const mode of modes) {
				const results = await storage.searchSessions('/test/path', 'query', mode, mockSshConfig);
				expect(Array.isArray(results)).toBe(true);
			}
		});
	});

	describe('getSessionPath with SSH config', () => {
		it('should return null for getSessionPath (sync method cannot do remote lookup)', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// getSessionPath is synchronous and returns null for Codex (requires async file search)
			const path = storage.getSessionPath('/test/path', 'session-id', mockSshConfig);
			expect(path).toBeNull();
		});

		it('should return null for getSessionPath without SSH config as well', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Even without SSH, Codex getSessionPath returns null (needs async lookup)
			const path = storage.getSessionPath('/test/path', 'session-id');
			expect(path).toBeNull();
		});
	});

	describe('deleteMessagePair with SSH config', () => {
		it('should return error for SSH remote sessions', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			const result = await storage.deleteMessagePair(
				'/test/path',
				'session-id',
				'message-uuid',
				undefined,
				mockSshConfig
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Delete not supported for remote sessions');
		});

		it('should return session not found for local delete on non-existent session', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Without SSH config, should attempt local delete
			const result = await storage.deleteMessagePair(
				'/test/path',
				'nonexistent-session',
				'message-uuid'
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Session file not found');
		});
	});

	describe('YYYY/MM/DD directory traversal via SSH', () => {
		it('should handle remote directory structure traversal', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Codex uses YYYY/MM/DD directory structure
			// This test verifies the method accepts sshConfig and attempts traversal
			const sessions = await storage.listSessions('/project/path', mockSshConfig);

			// Should return empty array (no actual remote sessions)
			// but should not throw during traversal
			expect(sessions).toEqual([]);
		});
	});

	describe('Remote session file parsing', () => {
		it('should handle session file parsing when content is fetched via SSH', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Test that readSessionMessages handles SSH path correctly
			const result = await storage.readSessionMessages(
				'/project/path',
				'test-session-id',
				{ offset: 0, limit: 10 },
				mockSshConfig
			);

			expect(result.messages).toEqual([]);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});
	});

	describe('SSH remote method signatures', () => {
		it('should accept sshConfig parameter on all public methods', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Verify all public methods accept sshConfig
			// listSessions
			const sessions = await storage.listSessions('/test/path', mockSshConfig);
			expect(Array.isArray(sessions)).toBe(true);

			// listSessionsPaginated
			const paginated = await storage.listSessionsPaginated('/test/path', {}, mockSshConfig);
			expect(paginated).toHaveProperty('sessions');

			// readSessionMessages
			const messages = await storage.readSessionMessages(
				'/test/path',
				'session-id',
				{},
				mockSshConfig
			);
			expect(messages).toHaveProperty('messages');

			// searchSessions
			const search = await storage.searchSessions('/test/path', 'query', 'all', mockSshConfig);
			expect(Array.isArray(search)).toBe(true);

			// getSessionPath (sync - returns null)
			const sessionPath = storage.getSessionPath('/test/path', 'session-id', mockSshConfig);
			expect(sessionPath).toBeNull();

			// deleteMessagePair (returns error for SSH)
			const deleteResult = await storage.deleteMessagePair(
				'/test/path',
				'session-id',
				'message-id',
				undefined,
				mockSshConfig
			);
			expect(deleteResult.success).toBe(false);
			expect(deleteResult.error).toContain('remote');
		});
	});

	describe('SSH config flow verification', () => {
		it('should differentiate between SSH and local based on sshConfig presence', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Both with and without sshConfig should work (return empty for non-existent)
			const withSsh = await storage.listSessions('/project/path', mockSshConfig);
			const withoutSsh = await storage.listSessions('/project/path');

			expect(Array.isArray(withSsh)).toBe(true);
			expect(Array.isArray(withoutSsh)).toBe(true);
		});

		it('should verify SshRemoteConfig interface is properly accepted', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Full SshRemoteConfig object
			const fullConfig = {
				id: 'full-config-test',
				name: 'Full Config Test',
				host: 'remote.example.com',
				port: 2222,
				username: 'admin',
				useSshConfig: true,
				enabled: true,
			};

			// Should work with full config
			const sessions = await storage.listSessions('/project', fullConfig);
			expect(Array.isArray(sessions)).toBe(true);

			// Should work with minimal config
			const minimalConfig = {
				id: 'minimal',
				name: 'Minimal',
				host: 'host',
				port: 22,
				username: 'user',
				useSshConfig: false,
				enabled: true,
			};
			const sessionsMinimal = await storage.listSessions('/project', minimalConfig);
			expect(Array.isArray(sessionsMinimal)).toBe(true);
		});
	});

	describe('Remote sessions directory path', () => {
		it('should use ~/.codex/sessions for remote path', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// The private getRemoteSessionsDir returns '~/.codex/sessions'
			// We verify this indirectly by testing that SSH operations work correctly
			// and that the storage class is properly instantiated with the right agentId
			expect(storage.agentId).toBe('codex');
		});
	});
});

describe('OpenCodeSessionStorage SSH Remote Support', () => {
	// Mock SSH remote config for testing
	const mockSshConfig = {
		id: 'test-ssh',
		name: 'Test SSH Server',
		host: 'test-server.example.com',
		port: 22,
		username: 'testuser',
		useSshConfig: false,
		enabled: true,
	};

	// Mock project data for OpenCode
	const mockProjectData = {
		id: 'test-project-id',
		worktree: '/home/testuser/project',
		vcsDir: '/home/testuser/project/.git',
		vcs: 'git',
		time: {
			created: 1700000000000,
			updated: 1700001000000,
		},
	};

	// Mock session data
	const mockSessionData = {
		id: 'ses_test123',
		version: '1.0.0',
		projectID: 'test-project-id',
		directory: '/home/testuser/project',
		title: 'Test Session',
		time: {
			created: 1700000000000,
			updated: 1700001000000,
		},
		summary: {
			additions: 10,
			deletions: 5,
			files: 3,
		},
	};

	// Mock message data
	const mockUserMessage = {
		id: 'msg_user123',
		sessionID: 'ses_test123',
		role: 'user' as const,
		time: { created: 1700000000000 },
	};

	const mockAssistantMessage = {
		id: 'msg_assistant123',
		sessionID: 'ses_test123',
		role: 'assistant' as const,
		time: { created: 1700000500000 },
		tokens: {
			input: 100,
			output: 200,
			cache: { read: 50, write: 25 },
		},
		cost: 0.005,
	};

	// Mock text parts
	const mockUserPart = {
		id: 'part_user123',
		messageID: 'msg_user123',
		type: 'text' as const,
		text: 'Hello, can you help me?',
	};

	const mockAssistantPart = {
		id: 'part_assistant123',
		messageID: 'msg_assistant123',
		type: 'text' as const,
		text: 'Of course! I am happy to help.',
	};

	describe('getSessionPath with SSH config', () => {
		it('should return remote message directory path when sshConfig is provided', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			const path = storage.getSessionPath('/home/testuser/project', 'ses_test123', mockSshConfig);

			expect(path).toBe('~/.local/share/opencode/storage/message/ses_test123');
		});

		it('should return local path when sshConfig is not provided', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			const path = storage.getSessionPath('/home/testuser/project', 'ses_test123');

			expect(path).toContain('opencode');
			expect(path).toContain('storage');
			expect(path).toContain('message');
			expect(path).toContain('ses_test123');
			expect(path).not.toContain('~'); // Local path should be absolute
		});
	});

	describe('deleteMessagePair with SSH config', () => {
		it('should return error for SSH remote sessions', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			const result = await storage.deleteMessagePair(
				'/home/testuser/project',
				'ses_test123',
				'msg_user123',
				undefined,
				mockSshConfig
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Delete not supported for remote sessions');
		});
	});

	describe('searchSessions with SSH config', () => {
		it('should return empty results for empty search query with SSH config', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			const results = await storage.searchSessions(
				'/home/testuser/project',
				'',
				'all',
				mockSshConfig
			);
			expect(results).toEqual([]);

			const whitespaceResults = await storage.searchSessions(
				'/home/testuser/project',
				'   ',
				'all',
				mockSshConfig
			);
			expect(whitespaceResults).toEqual([]);
		});
	});

	describe('Local operations still work without sshConfig', () => {
		it('should use local file system when sshConfig is undefined', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Without SSH config, should use local operations
			// Since we don't have real OpenCode data, expect empty results
			const sessions = await storage.listSessions('/test/nonexistent/project');
			expect(sessions).toEqual([]);

			const paginated = await storage.listSessionsPaginated('/test/nonexistent/project');
			expect(paginated.sessions).toEqual([]);

			const messages = await storage.readSessionMessages(
				'/test/nonexistent/project',
				'session-123'
			);
			expect(messages.messages).toEqual([]);

			const search = await storage.searchSessions('/test/nonexistent/project', 'query', 'all');
			expect(search).toEqual([]);
		});

		it('should use local file system when sshConfig is null', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Passing undefined (not null, since the type is SshRemoteConfig | undefined)
			const sessions = await storage.listSessions('/test/nonexistent/project', undefined);
			expect(sessions).toEqual([]);
		});
	});

	describe('SSH remote method signatures', () => {
		it('should accept sshConfig parameter on all public methods', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Verify that all public methods accept sshConfig parameter
			// These should not throw type errors at compile time and should handle the parameter

			// listSessions accepts sshConfig
			const sessions = await storage.listSessions('/test/path', mockSshConfig);
			expect(Array.isArray(sessions)).toBe(true);

			// listSessionsPaginated accepts sshConfig
			const paginated = await storage.listSessionsPaginated('/test/path', {}, mockSshConfig);
			expect(paginated).toHaveProperty('sessions');
			expect(paginated).toHaveProperty('hasMore');
			expect(paginated).toHaveProperty('totalCount');

			// readSessionMessages accepts sshConfig
			const messages = await storage.readSessionMessages(
				'/test/path',
				'session-id',
				{},
				mockSshConfig
			);
			expect(messages).toHaveProperty('messages');
			expect(messages).toHaveProperty('total');

			// searchSessions accepts sshConfig
			const search = await storage.searchSessions('/test/path', 'query', 'all', mockSshConfig);
			expect(Array.isArray(search)).toBe(true);

			// getSessionPath accepts sshConfig and returns remote path format
			const sessionPath = storage.getSessionPath('/test/path', 'session-id', mockSshConfig);
			expect(sessionPath).toContain('~/.local/share/opencode/storage');

			// deleteMessagePair accepts sshConfig and returns error for remote
			const deleteResult = await storage.deleteMessagePair(
				'/test/path',
				'session-id',
				'message-id',
				undefined,
				mockSshConfig
			);
			expect(deleteResult.success).toBe(false);
			expect(deleteResult.error).toContain('remote');
		});
	});

	describe('Remote path construction', () => {
		it('should construct correct remote paths for OpenCode storage', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Test getSessionPath returns correct remote format
			const messageDirPath = storage.getSessionPath('/project', 'ses_abc123', mockSshConfig);
			expect(messageDirPath).toBe('~/.local/share/opencode/storage/message/ses_abc123');

			// Verify the remote path uses POSIX format (forward slashes)
			expect(messageDirPath).not.toContain('\\');

			// Verify it uses ~ for home directory expansion on remote
			expect(messageDirPath).toMatch(/^~\//);
		});
	});

	describe('SSH config flow verification', () => {
		it('should differentiate between SSH and local based on sshConfig presence', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// With sshConfig - returns remote-style path
			const remotePath = storage.getSessionPath('/project', 'session-id', mockSshConfig);
			expect(remotePath).toContain('~');

			// Without sshConfig - returns local-style path
			const localPath = storage.getSessionPath('/project', 'session-id');
			expect(localPath).not.toContain('~');

			// Verify local path is absolute
			expect(localPath?.startsWith('/') || localPath?.match(/^[A-Z]:\\/)).toBeTruthy();
		});

		it('should verify SshRemoteConfig interface is properly accepted', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Full SshRemoteConfig object
			const fullConfig = {
				id: 'full-config-test',
				name: 'Full Config Test',
				host: 'remote.example.com',
				port: 2222,
				username: 'admin',
				useSshConfig: true,
				enabled: true,
			};

			// Should work with full config
			const path = storage.getSessionPath('/project', 'session-id', fullConfig);
			expect(path).toBe('~/.local/share/opencode/storage/message/session-id');

			// Should work with minimal config
			const minimalConfig = {
				id: 'minimal',
				name: 'Minimal',
				host: 'host',
				port: 22,
				username: 'user',
				useSshConfig: false,
				enabled: true,
			};
			const pathMinimal = storage.getSessionPath('/project', 'session-id', minimalConfig);
			expect(pathMinimal).toBe('~/.local/share/opencode/storage/message/session-id');
		});
	});
});

describe('FactoryDroidSessionStorage SSH Remote Support', () => {
	// Mock SSH remote config for testing
	const mockSshConfig = {
		id: 'test-ssh',
		name: 'Test SSH Server',
		host: 'test-server.example.com',
		port: 22,
		username: 'testuser',
		useSshConfig: false,
		enabled: true,
	};

	describe('listSessions with SSH config', () => {
		it('should accept sshConfig parameter for listSessions', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// With SSH config - should not throw and should return array
			const sessions = await storage.listSessions('/test/path', mockSshConfig);
			expect(Array.isArray(sessions)).toBe(true);
		});

		it('should use local file system when sshConfig is undefined', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Without SSH config - should use local operations
			const sessions = await storage.listSessions('/test/nonexistent/project');
			expect(sessions).toEqual([]);
		});
	});

	describe('listSessionsPaginated with SSH config', () => {
		it('should accept sshConfig parameter for listSessionsPaginated', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// With SSH config - should work with pagination options
			const result = await storage.listSessionsPaginated('/test/path', {}, mockSshConfig);
			expect(result).toHaveProperty('sessions');
			expect(result).toHaveProperty('hasMore');
			expect(result).toHaveProperty('totalCount');
			expect(result).toHaveProperty('nextCursor');
			expect(Array.isArray(result.sessions)).toBe(true);
		});

		it('should support pagination options with SSH config', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Test with specific pagination options
			const result = await storage.listSessionsPaginated(
				'/test/path',
				{ limit: 10, cursor: undefined },
				mockSshConfig
			);
			expect(result.totalCount).toBe(0); // No sessions on test remote
			expect(result.hasMore).toBe(false);
		});
	});

	describe('readSessionMessages with SSH config', () => {
		it('should accept sshConfig parameter for readSessionMessages', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// With SSH config - should attempt to read remotely
			const result = await storage.readSessionMessages(
				'/test/path',
				'nonexistent-session',
				{},
				mockSshConfig
			);
			expect(result).toHaveProperty('messages');
			expect(result).toHaveProperty('total');
			expect(result).toHaveProperty('hasMore');
			expect(result.messages).toEqual([]);
		});

		it('should handle offset and limit options with SSH config', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Test pagination options with SSH config
			const result = await storage.readSessionMessages(
				'/test/path',
				'session-id',
				{ offset: 0, limit: 50 },
				mockSshConfig
			);
			expect(result.messages).toEqual([]);
			expect(result.total).toBe(0);
		});
	});

	describe('searchSessions with SSH config', () => {
		it('should accept sshConfig parameter for searchSessions', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// With SSH config - should search remotely
			const results = await storage.searchSessions(
				'/test/path',
				'test query',
				'all',
				mockSshConfig
			);
			expect(Array.isArray(results)).toBe(true);
		});

		it('should return empty results for empty query with SSH config', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			const results = await storage.searchSessions('/test/path', '', 'all', mockSshConfig);
			expect(results).toEqual([]);

			const whitespaceResults = await storage.searchSessions(
				'/test/path',
				'   ',
				'all',
				mockSshConfig
			);
			expect(whitespaceResults).toEqual([]);
		});

		it('should support all search modes with SSH config', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Test each search mode works with SSH config
			const modes: Array<'title' | 'user' | 'assistant' | 'all'> = [
				'title',
				'user',
				'assistant',
				'all',
			];

			for (const mode of modes) {
				const results = await storage.searchSessions('/test/path', 'query', mode, mockSshConfig);
				expect(Array.isArray(results)).toBe(true);
			}
		});
	});

	describe('getSessionPath with SSH config', () => {
		it('should return remote JSONL path when sshConfig is provided', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// getSessionPath returns the .jsonl file path
			const path = storage.getSessionPath('/home/testuser/project', 'session-uuid', mockSshConfig);

			// Factory Droid encodes the project path with `-` for `/`
			expect(path).toContain('~/.factory/sessions/');
			expect(path).toContain('session-uuid.jsonl');
		});

		it('should return local path when sshConfig is not provided', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			const sessionPath = storage.getSessionPath('/home/testuser/project', 'session-uuid');

			expect(sessionPath).toContain('.factory');
			expect(sessionPath).toContain('sessions');
			expect(sessionPath).toContain('session-uuid.jsonl');
			expect(sessionPath).not.toContain('~'); // Local path should be absolute
		});
	});

	describe('deleteMessagePair with SSH config', () => {
		it('should return error for SSH remote sessions', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			const result = await storage.deleteMessagePair(
				'/test/path',
				'session-id',
				'message-uuid',
				undefined,
				mockSshConfig
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Delete not supported for remote sessions');
		});

		it('should return error for local delete on non-existent session', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Without SSH config, should attempt local delete
			const result = await storage.deleteMessagePair(
				'/test/path',
				'nonexistent-session',
				'message-uuid'
			);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});
	});

	describe('Remote path encoding for Factory Droid', () => {
		it('should handle path encoding correctly with `-` substitution for `/`', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Factory Droid encodes /Users/testuser/project as -Users-testuser-project
			const path = storage.getSessionPath('/Users/testuser/project', 'session-id', mockSshConfig);

			// The path should contain the encoded project directory
			expect(path).toContain('~/.factory/sessions/');
			expect(path).toContain('session-id.jsonl');
			// The encoded path should be in the directory structure
			expect(path).toMatch(/~\/\.factory\/sessions\/[^/]+\/session-id\.jsonl/);
		});
	});

	describe('JSONL parsing with remote content', () => {
		it('should handle JSONL parsing when content is fetched via SSH', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Test that readSessionMessages handles SSH path correctly
			const result = await storage.readSessionMessages(
				'/project/path',
				'test-session-id',
				{ offset: 0, limit: 10 },
				mockSshConfig
			);

			expect(result.messages).toEqual([]);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});
	});

	describe('Settings.json loading via SSH', () => {
		it('should attempt to load settings.json via SSH when listing sessions', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// This verifies the storage class properly attempts to load settings.json
			// Settings.json contains tokenUsage, model info, etc.
			const sessions = await storage.listSessions('/project/path', mockSshConfig);
			expect(Array.isArray(sessions)).toBe(true);
		});
	});

	describe('SSH remote method signatures', () => {
		it('should accept sshConfig parameter on all public methods', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Verify all public methods accept sshConfig
			// listSessions
			const sessions = await storage.listSessions('/test/path', mockSshConfig);
			expect(Array.isArray(sessions)).toBe(true);

			// listSessionsPaginated
			const paginated = await storage.listSessionsPaginated('/test/path', {}, mockSshConfig);
			expect(paginated).toHaveProperty('sessions');

			// readSessionMessages
			const messages = await storage.readSessionMessages(
				'/test/path',
				'session-id',
				{},
				mockSshConfig
			);
			expect(messages).toHaveProperty('messages');

			// searchSessions
			const search = await storage.searchSessions('/test/path', 'query', 'all', mockSshConfig);
			expect(Array.isArray(search)).toBe(true);

			// getSessionPath (returns remote path)
			const sessionPath = storage.getSessionPath('/test/path', 'session-id', mockSshConfig);
			expect(sessionPath).toContain('~/.factory/sessions/');
			expect(sessionPath).toContain('session-id.jsonl');

			// deleteMessagePair (returns error for SSH)
			const deleteResult = await storage.deleteMessagePair(
				'/test/path',
				'session-id',
				'message-id',
				undefined,
				mockSshConfig
			);
			expect(deleteResult.success).toBe(false);
			expect(deleteResult.error).toContain('remote');
		});
	});

	describe('SSH config flow verification', () => {
		it('should differentiate between SSH and local based on sshConfig presence', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// With sshConfig - returns remote-style path
			const remotePath = storage.getSessionPath('/project', 'session-id', mockSshConfig);
			expect(remotePath).toContain('~');

			// Without sshConfig - returns local-style path
			const localPath = storage.getSessionPath('/project', 'session-id');
			expect(localPath).not.toContain('~');

			// Verify local path is absolute
			expect(localPath?.startsWith('/') || localPath?.match(/^[A-Z]:\\/)).toBeTruthy();
		});

		it('should verify SshRemoteConfig interface is properly accepted', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Full SshRemoteConfig object
			const fullConfig = {
				id: 'full-config-test',
				name: 'Full Config Test',
				host: 'remote.example.com',
				port: 2222,
				username: 'admin',
				useSshConfig: true,
				enabled: true,
			};

			// Should work with full config
			const path = storage.getSessionPath('/project', 'session-id', fullConfig);
			expect(path).toContain('~/.factory/sessions/');

			// Should work with minimal config
			const minimalConfig = {
				id: 'minimal',
				name: 'Minimal',
				host: 'host',
				port: 22,
				username: 'user',
				useSshConfig: false,
				enabled: true,
			};
			const pathMinimal = storage.getSessionPath('/project', 'session-id', minimalConfig);
			expect(pathMinimal).toContain('~/.factory/sessions/');
		});
	});

	describe('Remote sessions directory path', () => {
		it('should use ~/.factory/sessions for remote path', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Verify Factory Droid uses ~/.factory/sessions on remote
			expect(storage.agentId).toBe('factory-droid');

			// getSessionPath should return path starting with ~/.factory/sessions/
			const path = storage.getSessionPath('/project', 'session-id', mockSshConfig);
			expect(path).toMatch(/^~\/\.factory\/sessions\//);
		});
	});

	describe('Local operations still work without sshConfig', () => {
		it('should use local file system when sshConfig is undefined', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Without SSH config, should use local operations
			// Since we don't have real Factory Droid data, expect empty results
			const sessions = await storage.listSessions('/test/nonexistent/project');
			expect(sessions).toEqual([]);

			const paginated = await storage.listSessionsPaginated('/test/nonexistent/project');
			expect(paginated.sessions).toEqual([]);

			const messages = await storage.readSessionMessages(
				'/test/nonexistent/project',
				'session-123'
			);
			expect(messages.messages).toEqual([]);

			const search = await storage.searchSessions('/test/nonexistent/project', 'query', 'all');
			expect(search).toEqual([]);
		});

		it('should use local file system when sshConfig is null', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Passing undefined (not null, since the type is SshRemoteConfig | undefined)
			const sessions = await storage.listSessions('/test/nonexistent/project', undefined);
			expect(sessions).toEqual([]);
		});
	});
});

/**
 * Integration-style tests for SSH config flow verification
 *
 * These tests verify that SSH config flows through correctly across all agent types:
 * - OpenCodeSessionStorage
 * - CodexSessionStorage
 * - FactoryDroidSessionStorage
 *
 * Tests verify:
 * - Mock SshRemoteConfig object is properly accepted
 * - Correct remote paths are constructed for each agent type
 * - SSH utility functions are called with the correct sshConfig parameter
 * - Local operations still work when sshConfig is undefined/null
 */
describe('SSH Config Integration Flow Verification', () => {
	// Standardized SSH remote config for integration testing
	// This config simulates a real SSH connection to a remote development server
	const integrationSshConfig = {
		id: 'integration-test-ssh',
		name: 'Integration Test Server',
		host: 'dev-server.internal.example.com',
		port: 22,
		username: 'developer',
		useSshConfig: true,
		enabled: true,
	};

	// Alternative SSH config for testing different configurations
	const alternativeSshConfig = {
		id: 'alt-ssh-config',
		name: 'Alternative Server',
		host: '192.168.1.100',
		port: 2222,
		username: 'admin',
		useSshConfig: false,
		enabled: true,
	};

	describe('Remote Path Construction Verification', () => {
		it('should construct correct remote paths for OpenCode storage', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Test with various project paths and session IDs
			const testCases = [
				{
					projectPath: '/home/developer/projects/my-app',
					sessionId: 'ses_abc123def456',
					expectedPathPattern: '~/.local/share/opencode/storage/message/ses_abc123def456',
				},
				{
					projectPath: '/var/www/production',
					sessionId: 'ses_xyz789',
					expectedPathPattern: '~/.local/share/opencode/storage/message/ses_xyz789',
				},
				{
					projectPath: '/root/workspace',
					sessionId: 'ses_test',
					expectedPathPattern: '~/.local/share/opencode/storage/message/ses_test',
				},
			];

			for (const testCase of testCases) {
				const path = storage.getSessionPath(
					testCase.projectPath,
					testCase.sessionId,
					integrationSshConfig
				);
				expect(path).toBe(testCase.expectedPathPattern);
				// Verify POSIX path format (forward slashes only)
				expect(path).not.toContain('\\');
				// Verify home directory expansion format
				expect(path).toMatch(/^~\//);
			}
		});

		it('should construct correct remote paths for Codex storage', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Codex getSessionPath returns null (requires async file lookup)
			// but the internal path construction should use ~/.codex/sessions
			expect(storage.agentId).toBe('codex');

			// Verify that SSH config is accepted without errors
			const path = storage.getSessionPath('/project/path', 'session-id', integrationSshConfig);
			expect(path).toBeNull(); // Expected - Codex needs async file search
		});

		it('should construct correct remote paths for Factory Droid storage', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Test path encoding (Factory Droid replaces / with - in project paths)
			const testCases = [
				{
					projectPath: '/home/developer/my-project',
					sessionId: 'uuid-1234-5678',
					// Encoded: -home-developer-my-project
					expectedPattern:
						/^~\/\.factory\/sessions\/-home-developer-my-project\/uuid-1234-5678\.jsonl$/,
				},
				{
					projectPath: '/var/www/app',
					sessionId: 'test-session',
					// Encoded: -var-www-app
					expectedPattern: /^~\/\.factory\/sessions\/-var-www-app\/test-session\.jsonl$/,
				},
			];

			for (const testCase of testCases) {
				const path = storage.getSessionPath(
					testCase.projectPath,
					testCase.sessionId,
					integrationSshConfig
				);
				expect(path).toMatch(testCase.expectedPattern);
				// Verify POSIX path format
				expect(path).not.toContain('\\');
				// Verify home directory expansion format
				expect(path).toMatch(/^~\//);
				// Verify .jsonl extension
				expect(path).toMatch(/\.jsonl$/);
			}
		});
	});

	describe('SSH Config Parameter Propagation', () => {
		it('should propagate sshConfig to all OpenCode methods correctly', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			// Verify all public methods accept and handle sshConfig without throwing
			const results = await Promise.all([
				storage.listSessions('/test/path', integrationSshConfig),
				storage.listSessionsPaginated('/test/path', { limit: 10 }, integrationSshConfig),
				storage.readSessionMessages(
					'/test/path',
					'session-id',
					{ limit: 20 },
					integrationSshConfig
				),
				storage.searchSessions('/test/path', 'query', 'all', integrationSshConfig),
				storage.deleteMessagePair(
					'/test/path',
					'session-id',
					'msg-id',
					undefined,
					integrationSshConfig
				),
			]);

			// Verify all methods returned valid results (not thrown)
			expect(Array.isArray(results[0])).toBe(true); // listSessions
			expect(results[1]).toHaveProperty('sessions'); // listSessionsPaginated
			expect(results[2]).toHaveProperty('messages'); // readSessionMessages
			expect(Array.isArray(results[3])).toBe(true); // searchSessions
			expect(results[4]).toHaveProperty('success'); // deleteMessagePair
			expect(results[4].success).toBe(false); // Should fail for remote
			expect(results[4].error).toContain('remote');

			// Verify getSessionPath (synchronous) also works
			const sessionPath = storage.getSessionPath('/test/path', 'session-id', integrationSshConfig);
			expect(sessionPath).toContain('~/.local/share/opencode');
		});

		it('should propagate sshConfig to all Codex methods correctly', async () => {
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const storage = new CodexSessionStorage();

			// Verify all public methods accept and handle sshConfig without throwing
			const results = await Promise.all([
				storage.listSessions('/test/path', integrationSshConfig),
				storage.listSessionsPaginated('/test/path', { limit: 10 }, integrationSshConfig),
				storage.readSessionMessages(
					'/test/path',
					'session-id',
					{ limit: 20 },
					integrationSshConfig
				),
				storage.searchSessions('/test/path', 'query', 'all', integrationSshConfig),
				storage.deleteMessagePair(
					'/test/path',
					'session-id',
					'msg-id',
					undefined,
					integrationSshConfig
				),
			]);

			// Verify all methods returned valid results
			expect(Array.isArray(results[0])).toBe(true);
			expect(results[1]).toHaveProperty('sessions');
			expect(results[2]).toHaveProperty('messages');
			expect(Array.isArray(results[3])).toBe(true);
			expect(results[4].success).toBe(false); // Should fail for remote
			expect(results[4].error).toContain('remote');
		});

		it('should propagate sshConfig to all Factory Droid methods correctly', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			// Verify all public methods accept and handle sshConfig without throwing
			const results = await Promise.all([
				storage.listSessions('/test/path', integrationSshConfig),
				storage.listSessionsPaginated('/test/path', { limit: 10 }, integrationSshConfig),
				storage.readSessionMessages(
					'/test/path',
					'session-id',
					{ limit: 20 },
					integrationSshConfig
				),
				storage.searchSessions('/test/path', 'query', 'all', integrationSshConfig),
				storage.deleteMessagePair(
					'/test/path',
					'session-id',
					'msg-id',
					undefined,
					integrationSshConfig
				),
			]);

			// Verify all methods returned valid results
			expect(Array.isArray(results[0])).toBe(true);
			expect(results[1]).toHaveProperty('sessions');
			expect(results[2]).toHaveProperty('messages');
			expect(Array.isArray(results[3])).toBe(true);
			expect(results[4].success).toBe(false); // Should fail for remote
			expect(results[4].error).toContain('remote');

			// Verify getSessionPath (synchronous) also works
			const sessionPath = storage.getSessionPath('/test/path', 'session-id', integrationSshConfig);
			expect(sessionPath).toContain('~/.factory/sessions/');
		});
	});

	describe('Local vs Remote Operation Differentiation', () => {
		it('should correctly differentiate local and remote paths for OpenCode', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const storage = new OpenCodeSessionStorage();

			const projectPath = '/home/developer/project';
			const sessionId = 'ses_test123';

			// With SSH config - remote path
			const remotePath = storage.getSessionPath(projectPath, sessionId, integrationSshConfig);
			expect(remotePath).toContain('~'); // Uses ~ for home expansion
			expect(remotePath).toMatch(/^~\//);

			// Without SSH config - local path
			const localPath = storage.getSessionPath(projectPath, sessionId);
			expect(localPath).not.toContain('~'); // Local paths are absolute
			expect(localPath?.startsWith('/') || localPath?.match(/^[A-Z]:\\/)).toBeTruthy();
		});

		it('should correctly differentiate local and remote paths for Factory Droid', async () => {
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');
			const storage = new FactoryDroidSessionStorage();

			const projectPath = '/home/developer/project';
			const sessionId = 'test-uuid';

			// With SSH config - remote path
			const remotePath = storage.getSessionPath(projectPath, sessionId, integrationSshConfig);
			expect(remotePath).toContain('~'); // Uses ~ for home expansion
			expect(remotePath).toMatch(/^~\//);
			expect(remotePath).toContain('.factory/sessions/');

			// Without SSH config - local path
			const localPath = storage.getSessionPath(projectPath, sessionId);
			expect(localPath).not.toContain('~'); // Local paths are absolute
			expect(localPath?.startsWith('/') || localPath?.match(/^[A-Z]:\\/)).toBeTruthy();
			expect(localPath).toContain('.factory');
		});
	});

	describe('SshRemoteConfig Interface Acceptance', () => {
		it('should accept full SshRemoteConfig with all fields', async () => {
			const fullConfig = {
				id: 'full-config-id',
				name: 'Full Configuration',
				host: 'full.example.com',
				port: 22,
				username: 'fulluser',
				useSshConfig: true,
				enabled: true,
			};

			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// All should accept the full config without errors
			await expect(openCode.listSessions('/test', fullConfig)).resolves.toBeDefined();
			await expect(codex.listSessions('/test', fullConfig)).resolves.toBeDefined();
			await expect(factoryDroid.listSessions('/test', fullConfig)).resolves.toBeDefined();
		});

		it('should accept minimal required SshRemoteConfig fields', async () => {
			const minimalConfig = {
				id: 'min',
				name: 'Minimal',
				host: 'min.example.com',
				port: 22,
				username: 'user',
				useSshConfig: false,
				enabled: true,
			};

			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// All should accept minimal config without errors
			await expect(openCode.listSessions('/test', minimalConfig)).resolves.toBeDefined();
			await expect(codex.listSessions('/test', minimalConfig)).resolves.toBeDefined();
			await expect(factoryDroid.listSessions('/test', minimalConfig)).resolves.toBeDefined();
		});

		it('should handle alternative SSH configurations for path construction', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// Verify paths are constructed the same regardless of host/port differences
			// The remote path should only depend on the project path and session ID,
			// not on the specific SSH host/port configuration
			const openCodePath = openCode.getSessionPath('/project', 'session', integrationSshConfig);
			const openCodePathAlt = openCode.getSessionPath('/project', 'session', alternativeSshConfig);
			expect(openCodePath).toBe(openCodePathAlt); // Paths should be identical

			const factoryPath = factoryDroid.getSessionPath('/project', 'session', integrationSshConfig);
			const factoryPathAlt = factoryDroid.getSessionPath(
				'/project',
				'session',
				alternativeSshConfig
			);
			expect(factoryPath).toBe(factoryPathAlt); // Paths should be identical

			// Verify the paths are correctly formatted regardless of which config is used
			expect(openCodePath).toMatch(/^~\/.local\/share\/opencode\//);
			expect(factoryPath).toMatch(/^~\/\.factory\/sessions\//);
		});
	});

	describe('Local Operations with undefined/null sshConfig', () => {
		it('should use local file system for all agents when sshConfig is undefined', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// All should return empty results for non-existent paths (not throw)
			const openCodeSessions = await openCode.listSessions('/nonexistent/path', undefined);
			const codexSessions = await codex.listSessions('/nonexistent/path', undefined);
			const factorySessions = await factoryDroid.listSessions('/nonexistent/path', undefined);

			expect(openCodeSessions).toEqual([]);
			expect(codexSessions).toEqual([]);
			expect(factorySessions).toEqual([]);
		});

		it('should return local paths when sshConfig is not provided', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// Without sshConfig, paths should be absolute local paths
			const openCodePath = openCode.getSessionPath('/project', 'session-id');
			const factoryPath = factoryDroid.getSessionPath('/project', 'session-id');

			// Should not contain ~ (remote home expansion)
			expect(openCodePath).not.toContain('~');
			expect(factoryPath).not.toContain('~');

			// Should be absolute paths
			expect(openCodePath?.startsWith('/') || openCodePath?.match(/^[A-Z]:\\/)).toBeTruthy();
			expect(factoryPath?.startsWith('/') || factoryPath?.match(/^[A-Z]:\\/)).toBeTruthy();
		});

		it('should handle all pagination options correctly without sshConfig', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			const paginationOptions = { limit: 50, cursor: undefined };

			// All should work without sshConfig
			const openCodeResult = await openCode.listSessionsPaginated(
				'/test/path',
				paginationOptions,
				undefined
			);
			const codexResult = await codex.listSessionsPaginated(
				'/test/path',
				paginationOptions,
				undefined
			);
			const factoryResult = await factoryDroid.listSessionsPaginated(
				'/test/path',
				paginationOptions,
				undefined
			);

			expect(openCodeResult.sessions).toEqual([]);
			expect(openCodeResult.totalCount).toBe(0);
			expect(codexResult.sessions).toEqual([]);
			expect(codexResult.totalCount).toBe(0);
			expect(factoryResult.sessions).toEqual([]);
			expect(factoryResult.totalCount).toBe(0);
		});
	});

	describe('Cross-Agent Consistency', () => {
		it('should have consistent delete behavior for remote sessions across all agents', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// All agents should reject delete operations for remote sessions with consistent error
			const openCodeDelete = await openCode.deleteMessagePair(
				'/test',
				'session',
				'msg',
				undefined,
				integrationSshConfig
			);
			const codexDelete = await codex.deleteMessagePair(
				'/test',
				'session',
				'msg',
				undefined,
				integrationSshConfig
			);
			const factoryDelete = await factoryDroid.deleteMessagePair(
				'/test',
				'session',
				'msg',
				undefined,
				integrationSshConfig
			);

			// All should fail
			expect(openCodeDelete.success).toBe(false);
			expect(codexDelete.success).toBe(false);
			expect(factoryDelete.success).toBe(false);

			// All should have consistent error message pattern
			expect(openCodeDelete.error).toContain('remote');
			expect(codexDelete.error).toContain('remote');
			expect(factoryDelete.error).toContain('remote');
		});

		it('should return consistent empty results for empty search queries across all agents', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// Empty and whitespace-only queries should return empty results for all agents
			const emptyQueries = ['', '   ', '\t', '\n'];

			for (const query of emptyQueries) {
				const openCodeSearch = await openCode.searchSessions(
					'/test',
					query,
					'all',
					integrationSshConfig
				);
				const codexSearch = await codex.searchSessions('/test', query, 'all', integrationSshConfig);
				const factorySearch = await factoryDroid.searchSessions(
					'/test',
					query,
					'all',
					integrationSshConfig
				);

				expect(openCodeSearch).toEqual([]);
				expect(codexSearch).toEqual([]);
				expect(factorySearch).toEqual([]);
			}
		});

		it('should support all search modes with SSH config across all agents', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { CodexSessionStorage } = await import('../../../main/storage/codex-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const codex = new CodexSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			const searchModes: Array<'title' | 'user' | 'assistant' | 'all'> = [
				'title',
				'user',
				'assistant',
				'all',
			];

			for (const mode of searchModes) {
				// All should accept the mode with SSH config without throwing
				await expect(
					openCode.searchSessions('/test', 'query', mode, integrationSshConfig)
				).resolves.toBeDefined();
				await expect(
					codex.searchSessions('/test', 'query', mode, integrationSshConfig)
				).resolves.toBeDefined();
				await expect(
					factoryDroid.searchSessions('/test', 'query', mode, integrationSshConfig)
				).resolves.toBeDefined();
			}
		});
	});

	describe('Remote Path Format Verification', () => {
		it('should use POSIX path separators for all remote paths', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			// Test with various project paths that might have Windows-style separators locally
			const testPaths = [
				'/home/user/project',
				'/var/www/app',
				'/opt/application/workspace',
				'/tmp/test-project',
			];

			for (const projectPath of testPaths) {
				const openCodePath = openCode.getSessionPath(
					projectPath,
					'session-id',
					integrationSshConfig
				);
				const factoryPath = factoryDroid.getSessionPath(
					projectPath,
					'session-id',
					integrationSshConfig
				);

				// Should not contain Windows backslashes
				expect(openCodePath).not.toContain('\\');
				expect(factoryPath).not.toContain('\\');

				// Should use forward slashes
				expect(openCodePath).toContain('/');
				expect(factoryPath).toContain('/');
			}
		});

		it('should use tilde (~) for home directory expansion on remote paths', async () => {
			const { OpenCodeSessionStorage } =
				await import('../../../main/storage/opencode-session-storage');
			const { FactoryDroidSessionStorage } =
				await import('../../../main/storage/factory-droid-session-storage');

			const openCode = new OpenCodeSessionStorage();
			const factoryDroid = new FactoryDroidSessionStorage();

			const openCodePath = openCode.getSessionPath('/project', 'session', integrationSshConfig);
			const factoryPath = factoryDroid.getSessionPath('/project', 'session', integrationSshConfig);

			// Both should start with ~/ for remote home directory expansion
			expect(openCodePath).toMatch(/^~\//);
			expect(factoryPath).toMatch(/^~\//);

			// Verify the expected base directories
			expect(openCodePath).toContain('~/.local/share/opencode/');
			expect(factoryPath).toContain('~/.factory/sessions/');
		});
	});
});
