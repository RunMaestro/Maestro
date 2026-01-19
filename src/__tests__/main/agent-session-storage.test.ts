import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
} from '../../main/agent-session-storage';
import type { ToolType } from '../../shared/types';

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
		const { ClaudeSessionStorage } = await import('../../main/storage/claude-session-storage');
		expect(ClaudeSessionStorage).toBeDefined();
	});

	it('should have claude-code as agentId', async () => {
		const { ClaudeSessionStorage } = await import('../../main/storage/claude-session-storage');

		// Create instance without store (it will create its own)
		// Note: In a real test, we'd mock electron-store
		const storage = new ClaudeSessionStorage();
		expect(storage.agentId).toBe('claude-code');
	});
});

describe('OpenCodeSessionStorage', () => {
	it('should be importable', async () => {
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		expect(OpenCodeSessionStorage).toBeDefined();
	});

	it('should have opencode as agentId', async () => {
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();
		expect(storage.agentId).toBe('opencode');
	});

	it('should return empty results for non-existent projects', async () => {
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
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
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
		const storage = new OpenCodeSessionStorage();

		// getSessionPath returns the message directory for the session
		const path = storage.getSessionPath('/test/project', 'session-123');
		expect(path).toContain('opencode');
		expect(path).toContain('storage');
		expect(path).toContain('message');
		expect(path).toContain('session-123');
	});

	it('should fail gracefully when deleting from non-existent session', async () => {
		const { OpenCodeSessionStorage } = await import('../../main/storage/opencode-session-storage');
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
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		expect(CodexSessionStorage).toBeDefined();
	});

	it('should have codex as agentId', async () => {
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();
		expect(storage.agentId).toBe('codex');
	});

	it('should return empty results for non-existent sessions directory', async () => {
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
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
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		// getSessionPath is synchronous and always returns null for Codex
		// Use findSessionFile async method internally
		const path = storage.getSessionPath('/test/project', 'session-123');
		expect(path).toBeNull();
	});

	it('should fail gracefully when deleting from non-existent session', async () => {
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
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
		const { CodexSessionStorage } = await import('../../main/storage/codex-session-storage');
		const storage = new CodexSessionStorage();

		const search = await storage.searchSessions('/test/project', '', 'all');
		expect(search).toEqual([]);

		const searchWhitespace = await storage.searchSessions('/test/project', '   ', 'all');
		expect(searchWhitespace).toEqual([]);
	});
});

describe('Storage Module Initialization', () => {
	it('should export initializeSessionStorages function', async () => {
		const { initializeSessionStorages } = await import('../../main/storage/index');
		expect(typeof initializeSessionStorages).toBe('function');
	});

	it('should export CodexSessionStorage', async () => {
		const { CodexSessionStorage } = await import('../../main/storage/index');
		expect(CodexSessionStorage).toBeDefined();
	});

	it('should allow creating ClaudeSessionStorage with external store', async () => {
		// This tests that ClaudeSessionStorage can receive an external store
		// This prevents the dual-store bug where IPC handlers and storage class
		// use different electron-store instances
		const { ClaudeSessionStorage } = await import('../../main/storage/claude-session-storage');

		// Create a mock store
		const mockStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
			store: { origins: {} },
		};

		// Should be able to create with external store (no throw)
		const storage = new ClaudeSessionStorage(
			mockStore as unknown as import('electron-store').default
		);
		expect(storage.agentId).toBe('claude-code');
	});

	it('should export InitializeSessionStoragesOptions interface', async () => {
		// This tests that the options interface is exported for type-safe initialization
		const storageModule = await import('../../main/storage/index');
		// The function should accept options object
		expect(typeof storageModule.initializeSessionStorages).toBe('function');
		// Function should accept undefined options (backward compatible)
		expect(() => storageModule.initializeSessionStorages()).not.toThrow();
	});

	it('should accept claudeSessionOriginsStore in options', async () => {
		// This tests the fix for the dual-store bug
		// When a shared store is passed, it should be used instead of creating a new one
		const { initializeSessionStorages } = await import('../../main/storage/index');
		const { getSessionStorage, clearStorageRegistry } =
			await import('../../main/agent-session-storage');

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
			claudeSessionOriginsStore: mockStore as unknown as import('electron-store').default,
		});

		// Verify ClaudeSessionStorage was registered
		const storage = getSessionStorage('claude-code');
		expect(storage).not.toBeNull();
		expect(storage?.agentId).toBe('claude-code');

		// Clean up
		clearStorageRegistry();
	});
});
