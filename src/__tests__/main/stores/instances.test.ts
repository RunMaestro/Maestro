import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mock state that's accessible in both mock factory and tests
// This ensures proper scoping and avoids potential test interference
const { mockStoreConstructorCalls, mockStoreInitialData } = vi.hoisted(() => ({
	mockStoreConstructorCalls: [] as Array<Record<string, unknown>>,
	mockStoreInitialData: new Map<string, Record<string, unknown>>(),
}));

// Mock electron
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/mock/user/data'),
	},
}));

// Mock electron-store with a class that tracks constructor calls
vi.mock('electron-store', () => {
	const deepClone = <T>(value: T): T => {
		if (value === undefined || value === null) {
			return value as T;
		}
		return JSON.parse(JSON.stringify(value));
	};

	return {
		default: class MockStore {
			options: Record<string, unknown>;
			store: Record<string, unknown>;
			defaults: Record<string, unknown>;
			name: string;
			private data: Record<string, unknown>;
			constructor(options: Record<string, unknown>) {
				this.options = options;
				this.name = String(options.name ?? `store-${mockStoreConstructorCalls.length}`);
				this.defaults = options.defaults ? deepClone(options.defaults) : {};
				this.data = mockStoreInitialData.has(this.name)
					? deepClone(mockStoreInitialData.get(this.name))
					: {};
				this.store = this.data;
				mockStoreConstructorCalls.push(options);
			}
			get(key?: string, defaultValue?: unknown) {
				if (typeof key === 'undefined') {
					return this.store;
				}
				if (Object.prototype.hasOwnProperty.call(this.data, key)) {
					return this.data[key as keyof typeof this.data];
				}
				if (Object.prototype.hasOwnProperty.call(this.defaults, key)) {
					return this.defaults[key as keyof typeof this.defaults];
				}
				return defaultValue;
			}
			set(key: string, value: unknown) {
				this.data[key] = value;
			}
		},
	};
});

// Mock utils
vi.mock('../../../main/stores/utils', () => ({
	getCustomSyncPath: vi.fn(),
}));

import {
	initializeStores,
	isInitialized,
	getStoreInstances,
	getCachedPaths,
} from '../../../main/stores/instances';
import { getCustomSyncPath } from '../../../main/stores/utils';

const mockedGetCustomSyncPath = vi.mocked(getCustomSyncPath);

describe('stores/instances', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStoreConstructorCalls.length = 0; // Clear tracked constructor calls
		mockedGetCustomSyncPath.mockReturnValue(undefined);
		mockStoreInitialData.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

		describe('initializeStores', () => {
		it('should initialize all stores', () => {
			const result = initializeStores({ productionDataPath: '/mock/production/path' });

			// Should create 8 stores
			expect(mockStoreConstructorCalls).toHaveLength(8);

			// Should return syncPath and bootstrapStore
			expect(result.syncPath).toBe('/mock/user/data');
			expect(result.bootstrapStore).toBeDefined();
		});

		it('should use custom sync path when available', () => {
			const customSyncPath = '/custom/sync/path';
			mockedGetCustomSyncPath.mockReturnValue(customSyncPath);

			const result = initializeStores({ productionDataPath: '/mock/production/path' });

			expect(result.syncPath).toBe(customSyncPath);
		});

		it('should create bootstrap store with userData path', () => {
			initializeStores({ productionDataPath: '/mock/production/path' });

			// First store created should be bootstrap
			expect(mockStoreConstructorCalls[0]).toEqual({
				name: 'maestro-bootstrap',
				cwd: '/mock/user/data',
				defaults: {},
			});
		});

		it('should create settings store with sync path', () => {
			initializeStores({ productionDataPath: '/mock/production/path' });

			// Second store created should be settings
			expect(mockStoreConstructorCalls[1]).toMatchObject({
				name: 'maestro-settings',
				cwd: '/mock/user/data',
			});
		});

		it('should create agent configs store with production path', () => {
			const productionPath = '/mock/production/path';
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
			initializeStores({ productionDataPath: '/mock/production/path' });

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
					multiWindowState: {
						primaryWindowId: 'primary',
						windows: [
							{
								id: 'primary',
								sessionIds: [],
								leftPanelCollapsed: false,
								rightPanelCollapsed: false,
							},
						],
					},
				},
			});
			// Window state should NOT have cwd
			expect(windowStateCall).not.toHaveProperty('cwd');
		});

		it('should log startup paths', () => {
			const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			initializeStores({ productionDataPath: '/mock/production/path' });

			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[STARTUP] userData path:'));
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[STARTUP] syncPath'));
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[STARTUP] productionDataPath')
			);
		});

		it('should migrate legacy window state and attach existing sessions', () => {
			const legacyWindowState = {
				width: 1800,
				height: 1000,
				isMaximized: true,
				isFullScreen: false,
				x: 120,
				y: 80,
			};
			mockStoreInitialData.set('maestro-window-state', legacyWindowState);

			const legacySessions = [
				{
					id: 'session-1',
					name: 'Session One',
					toolType: 'claude-code',
					cwd: '/tmp/project-one',
					projectRoot: '/tmp/project-one',
				},
				{
					id: 'session-2',
					name: 'Session Two',
					toolType: 'codex',
					cwd: '/tmp/project-two',
					projectRoot: '/tmp/project-two',
				},
			];
			mockStoreInitialData.set('maestro-sessions', { sessions: legacySessions });

			initializeStores({ productionDataPath: '/mock/production/path' });

			const { windowStateStore } = getStoreInstances();
			const multiWindowState = windowStateStore!.get('multiWindowState');

			expect(multiWindowState?.primaryWindowId).toBe('primary');
			expect(multiWindowState?.windows).toHaveLength(1);
			const [windowState] = multiWindowState!.windows;
			expect(windowState).toMatchObject({
				width: legacyWindowState.width,
				height: legacyWindowState.height,
				isMaximized: legacyWindowState.isMaximized,
				isFullScreen: legacyWindowState.isFullScreen,
				x: legacyWindowState.x,
				y: legacyWindowState.y,
				sessionIds: ['session-1', 'session-2'],
				activeSessionId: 'session-1',
			});
		});
	});

	describe('isInitialized', () => {
		it('should return true after initialization', () => {
			initializeStores({ productionDataPath: '/mock/production/path' });

			expect(isInitialized()).toBe(true);
		});
	});

	describe('getStoreInstances', () => {
		it('should return all store instances after initialization', () => {
			initializeStores({ productionDataPath: '/mock/production/path' });

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
			initializeStores({ productionDataPath: '/mock/production/path' });

			const paths = getCachedPaths();

			expect(paths.syncPath).toBe('/mock/user/data');
			expect(paths.productionDataPath).toBe('/mock/production/path');
		});

		it('should return custom sync path when configured', () => {
			mockedGetCustomSyncPath.mockReturnValue('/custom/sync');

			initializeStores({ productionDataPath: '/mock/production/path' });

			const paths = getCachedPaths();

			expect(paths.syncPath).toBe('/custom/sync');
		});
	});
});
