import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the instances module
vi.mock('../../main/stores/instances', () => ({
	isInitialized: vi.fn(),
	getStoreInstances: vi.fn(),
	getCachedPaths: vi.fn(),
}));

import {
	getBootstrapStore,
	getSettingsStore,
	getSessionsStore,
	getGroupsStore,
	getAgentConfigsStore,
	getWindowStateStore,
	getClaudeSessionOriginsStore,
	getAgentSessionOriginsStore,
	getSyncPath,
	getProductionDataPath,
	getSshRemoteById,
} from '../../main/stores/getters';

import { isInitialized, getStoreInstances, getCachedPaths } from '../../main/stores/instances';

const mockedIsInitialized = vi.mocked(isInitialized);
const mockedGetStoreInstances = vi.mocked(getStoreInstances);
const mockedGetCachedPaths = vi.mocked(getCachedPaths);

describe('stores/getters', () => {
	const mockStores = {
		bootstrapStore: { get: vi.fn(), set: vi.fn() },
		settingsStore: { get: vi.fn(), set: vi.fn() },
		sessionsStore: { get: vi.fn(), set: vi.fn() },
		groupsStore: { get: vi.fn(), set: vi.fn() },
		agentConfigsStore: { get: vi.fn(), set: vi.fn() },
		windowStateStore: { get: vi.fn(), set: vi.fn() },
		claudeSessionOriginsStore: { get: vi.fn(), set: vi.fn() },
		agentSessionOriginsStore: { get: vi.fn(), set: vi.fn() },
	};

	const mockPaths = {
		syncPath: '/test/sync/path',
		productionDataPath: '/test/production/path',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockedIsInitialized.mockReturnValue(true);
		mockedGetStoreInstances.mockReturnValue(mockStores as any);
		mockedGetCachedPaths.mockReturnValue(mockPaths);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('error handling when not initialized', () => {
		beforeEach(() => {
			mockedIsInitialized.mockReturnValue(false);
			mockedGetStoreInstances.mockReturnValue({
				bootstrapStore: null,
				settingsStore: null,
				sessionsStore: null,
				groupsStore: null,
				agentConfigsStore: null,
				windowStateStore: null,
				claudeSessionOriginsStore: null,
				agentSessionOriginsStore: null,
			} as any);
			mockedGetCachedPaths.mockReturnValue({
				syncPath: null,
				productionDataPath: null,
			});
		});

		it('getBootstrapStore should throw when not initialized', () => {
			expect(() => getBootstrapStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getSettingsStore should throw when not initialized', () => {
			expect(() => getSettingsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getSessionsStore should throw when not initialized', () => {
			expect(() => getSessionsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getGroupsStore should throw when not initialized', () => {
			expect(() => getGroupsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getAgentConfigsStore should throw when not initialized', () => {
			expect(() => getAgentConfigsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getWindowStateStore should throw when not initialized', () => {
			expect(() => getWindowStateStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getClaudeSessionOriginsStore should throw when not initialized', () => {
			expect(() => getClaudeSessionOriginsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getAgentSessionOriginsStore should throw when not initialized', () => {
			expect(() => getAgentSessionOriginsStore()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});

		it('getSyncPath should throw when not initialized', () => {
			expect(() => getSyncPath()).toThrow('Stores not initialized. Call initializeStores() first.');
		});

		it('getProductionDataPath should throw when not initialized', () => {
			expect(() => getProductionDataPath()).toThrow(
				'Stores not initialized. Call initializeStores() first.'
			);
		});
	});

	describe('successful getters when initialized', () => {
		it('getBootstrapStore should return bootstrap store', () => {
			const result = getBootstrapStore();
			expect(result).toBe(mockStores.bootstrapStore);
		});

		it('getSettingsStore should return settings store', () => {
			const result = getSettingsStore();
			expect(result).toBe(mockStores.settingsStore);
		});

		it('getSessionsStore should return sessions store', () => {
			const result = getSessionsStore();
			expect(result).toBe(mockStores.sessionsStore);
		});

		it('getGroupsStore should return groups store', () => {
			const result = getGroupsStore();
			expect(result).toBe(mockStores.groupsStore);
		});

		it('getAgentConfigsStore should return agent configs store', () => {
			const result = getAgentConfigsStore();
			expect(result).toBe(mockStores.agentConfigsStore);
		});

		it('getWindowStateStore should return window state store', () => {
			const result = getWindowStateStore();
			expect(result).toBe(mockStores.windowStateStore);
		});

		it('getClaudeSessionOriginsStore should return claude session origins store', () => {
			const result = getClaudeSessionOriginsStore();
			expect(result).toBe(mockStores.claudeSessionOriginsStore);
		});

		it('getAgentSessionOriginsStore should return agent session origins store', () => {
			const result = getAgentSessionOriginsStore();
			expect(result).toBe(mockStores.agentSessionOriginsStore);
		});

		it('getSyncPath should return sync path', () => {
			const result = getSyncPath();
			expect(result).toBe('/test/sync/path');
		});

		it('getProductionDataPath should return production data path', () => {
			const result = getProductionDataPath();
			expect(result).toBe('/test/production/path');
		});
	});

	describe('getSshRemoteById', () => {
		it('should find SSH remote by ID', () => {
			const mockSshRemotes = [
				{ id: 'remote-1', name: 'Server 1', host: 'server1.com', username: 'user1' },
				{ id: 'remote-2', name: 'Server 2', host: 'server2.com', username: 'user2' },
			];

			mockStores.settingsStore.get.mockReturnValue(mockSshRemotes);

			const result = getSshRemoteById('remote-2');

			expect(result).toEqual(mockSshRemotes[1]);
			expect(mockStores.settingsStore.get).toHaveBeenCalledWith('sshRemotes', []);
		});

		it('should return undefined for non-existent ID', () => {
			mockStores.settingsStore.get.mockReturnValue([
				{ id: 'remote-1', name: 'Server 1', host: 'server1.com', username: 'user1' },
			]);

			const result = getSshRemoteById('non-existent');

			expect(result).toBeUndefined();
		});

		it('should return undefined when no remotes configured', () => {
			mockStores.settingsStore.get.mockReturnValue([]);

			const result = getSshRemoteById('remote-1');

			expect(result).toBeUndefined();
		});
	});
});
