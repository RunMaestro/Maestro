import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { app } from 'electron';

// Use vi.hoisted to create mock state that's accessible in both mock factory and tests
// This ensures proper scoping and avoids potential test interference
const { mockStoreConstructorCalls } = vi.hoisted(() => ({
	mockStoreConstructorCalls: [] as Array<Record<string, unknown>>,
}));

// Mock electron
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(),
	},
}));

// Mock electron-store with a class that tracks constructor calls
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			options: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.options = options;
				mockStoreConstructorCalls.push(options);
			}
			get() {
				return undefined;
			}
			set() {}
		},
	};
});

// Mock utils
vi.mock('../../../main/stores/utils', () => ({
	getCustomSyncPath: vi.fn(),
}));

import {
	initializeStores,
	selectStoreSyncPath,
	isInitialized,
	getStoreInstances,
	getCachedPaths,
} from '../../../main/stores/instances';
import { getCustomSyncPath } from '../../../main/stores/utils';
import {
	hadRecentInternalWrite,
	resetInternalWriteTracking,
} from '../../../main/stores/write-tracker';

const mockedGetCustomSyncPath = vi.mocked(getCustomSyncPath);

describe('stores/instances', () => {
	const fixture = createBoardIsolationFixture();
	const { userData, sync } = fixture.contract;

	beforeAll(() => {
		fixture.install();
		vi.mocked(app.getPath).mockReturnValue(userData);
	});
	afterAll(async () => {
		await fixture.cleanup();
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mockStoreConstructorCalls.length = 0; // Clear tracked constructor calls
		mockedGetCustomSyncPath.mockReturnValue(undefined);
		resetInternalWriteTracking();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('initializeStores', () => {
		it('should initialize all stores', () => {
			const result = initializeStores({ productionDataPath: userData });

			// Should create 9 stores (added agentCapabilitiesStore for snapshot persistence)
			expect(mockStoreConstructorCalls).toHaveLength(9);

			// Should return syncPath and bootstrapStore
			expect(result.syncPath).toBe(sync);
			expect(result.bootstrapStore).toBeDefined();
		});

		it('selects default, custom and admitted sync paths', () => {
			const custom = vi.fn(() => '/custom/sync/path');
			expect(selectStoreSyncPath('/user/data', () => undefined)).toBe('/user/data');
			expect(selectStoreSyncPath('/user/data', custom)).toBe('/custom/sync/path');
			custom.mockClear();
			expect(selectStoreSyncPath('/user/data', custom, sync)).toBe(sync);
			expect(custom).not.toHaveBeenCalled();
		});

		it('rejects mismatched paths before constructing any store', () => {
			expect(() => initializeStores({ productionDataPath: sync })).toThrow(
				'Board isolation store paths differ'
			);
			expect(mockStoreConstructorCalls).toHaveLength(0);
			vi.mocked(app.getPath).mockReturnValueOnce(sync);
			expect(() => initializeStores({ productionDataPath: userData })).toThrow(
				'Board isolation store paths differ'
			);
			expect(mockStoreConstructorCalls).toHaveLength(0);
		});

		it('should create bootstrap store with userData path', () => {
			initializeStores({ productionDataPath: userData });

			// First store created should be bootstrap
			expect(mockStoreConstructorCalls[0]).toEqual({
				name: 'maestro-bootstrap',
				cwd: userData,
				defaults: {},
				deserialize: expect.any(Function),
			});
		});

		it('configures stores with BOM-safe JSON deserialization', () => {
			initializeStores({ productionDataPath: userData });

			for (const call of mockStoreConstructorCalls) {
				expect(call.deserialize).toEqual(expect.any(Function));
				expect((call.deserialize as (value: string) => unknown)('\uFEFF{"ok":true}')).toEqual({
					ok: true,
				});
			}
		});

		it('should create settings store with sync path', () => {
			initializeStores({ productionDataPath: userData });

			// Second store created should be settings
			expect(mockStoreConstructorCalls[1]).toMatchObject({
				name: 'maestro-settings',
				cwd: sync,
			});
		});

		it('should create agent configs store with production path', () => {
			const productionPath = userData;
			initializeStores({ productionDataPath: productionPath });

			// Agent configs store should use production path
			const agentConfigsCall = mockStoreConstructorCalls.find(
				(call) => call.name === 'maestro-agent-configs'
			);
			expect(agentConfigsCall).toMatchObject({
				name: 'maestro-agent-configs',
				cwd: productionPath,
			});
		});

		it('should create window state store without cwd (local only)', () => {
			initializeStores({ productionDataPath: userData });

			// Window state store should not have cwd
			const windowStateCall = mockStoreConstructorCalls.find(
				(call) => call.name === 'maestro-window-state'
			);
			expect(windowStateCall).toMatchObject({
				name: 'maestro-window-state',
				defaults: {
					width: 1400,
					height: 900,
					isMaximized: false,
					isFullScreen: false,
				},
			});
			// Window state should NOT have cwd
			expect(windowStateCall).not.toHaveProperty('cwd');
		});

		// Without this wiring the settings file watcher can't tell our own writes
		// from an external edit, and every settings:set bounces back to the
		// renderer as an "external change" that reloads over live typing.
		it('instruments the watched stores so their writes are stamped', () => {
			initializeStores({ productionDataPath: userData });
			const { settingsStore, agentConfigsStore } = getStoreInstances();

			settingsStore!.set('fontSize', 16);

			expect(hadRecentInternalWrite('maestro-settings.json')).toBe(true);
			expect(hadRecentInternalWrite('maestro-agent-configs.json')).toBe(false);

			agentConfigsStore!.set('configs', {});

			expect(hadRecentInternalWrite('maestro-agent-configs.json')).toBe(true);
		});

		it('should log startup paths', () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			initializeStores({ productionDataPath: userData });

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[STARTUP] userData path:'));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[STARTUP] syncPath'));
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[STARTUP] productionDataPath')
			);
		});
	});

	describe('isInitialized', () => {
		it('should return true after initialization', () => {
			initializeStores({ productionDataPath: userData });

			expect(isInitialized()).toBe(true);
		});
	});

	describe('getStoreInstances', () => {
		it('should return all store instances after initialization', () => {
			initializeStores({ productionDataPath: userData });

			const instances = getStoreInstances();

			expect(instances.bootstrapStore).toBeDefined();
			expect(instances.settingsStore).toBeDefined();
			expect(instances.sessionsStore).toBeDefined();
			expect(instances.groupsStore).toBeDefined();
			expect(instances.agentConfigsStore).toBeDefined();
			expect(instances.windowStateStore).toBeDefined();
			expect(instances.claudeSessionOriginsStore).toBeDefined();
			expect(instances.agentSessionOriginsStore).toBeDefined();
		});
	});

	describe('getCachedPaths', () => {
		it('should return cached paths after initialization', () => {
			initializeStores({ productionDataPath: userData });

			const paths = getCachedPaths();

			expect(paths.syncPath).toBe(sync);
			expect(paths.productionDataPath).toBe(userData);
		});
	});
});
