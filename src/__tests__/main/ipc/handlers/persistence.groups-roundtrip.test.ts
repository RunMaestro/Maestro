/**
 * A group's `defaults` and `shortLabel` must survive the trip to disk and back.
 *
 * Group Settings stores both on the group row, and `groups:setAll` writes the
 * whole array, so neither field has a migration or a writer of its own. That
 * makes them easy to lose silently: a schema, a field allow-list or a mapper
 * added to the handler later would drop them and every other test would stay
 * green, because the suite beside this one (`persistence.test.ts`) hands the
 * handlers a mocked store and never reaches a file.
 *
 * This suite runs the real handlers over a real `electron-store`, built the way
 * `initializeStores()` builds the groups store, and reopens the file with a
 * second instance before it reads. The store is pointed at a temp directory
 * with an explicit `cwd`: `MAESTRO_USER_DATA` is set in a Maestro agent's
 * shell, and a store left to find its own directory would write into the
 * user's live data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import Store from 'electron-store';

const { mockCaptureException } = vi.hoisted(() => ({
	mockCaptureException: vi.fn(async () => {}),
}));

// `persistence.ts` registers through `ipcMain`. `electron-store` reads `app`
// and `ipcMain` only for a default directory and a version, and this suite
// gives it a `cwd`, so the extra members are there for the case where the
// mock reaches it too.
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
		on: vi.fn(),
	},
	app: {
		getPath: vi.fn().mockReturnValue('/mock/user/data'),
		getVersion: vi.fn().mockReturnValue('0.0.0-test'),
		on: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: vi.fn(() => []),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: mockCaptureException,
}));

vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));

import {
	registerPersistenceHandlers,
	type GroupsData,
	type MaestroSettings,
	type SessionsData,
} from '../../../../main/ipc/handlers/persistence';
import { createStoreDeserializer } from '../../../../main/stores/corrupt-store-recovery';
import { GROUPS_DEFAULTS } from '../../../../main/stores/defaults';
import { GROUPS_BACKUP_FILENAME } from '../../../../main/stores/groups-backup';
import { PUBLISHABLE_KEYS, UNPUBLISHABLE_KEYS } from '../../../../shared/groupAgentDefaults';
import type { Group, GroupAgentDefaults } from '../../../../shared/types';

const GROUPS_STORE_NAME = 'maestro-groups';

/**
 * Every default a group can hold, each with a value of its real shape. Typed
 * `Required` so a default added to `GroupAgentDefaults` is missing here until
 * somebody adds it, and the key-coverage test below fails for the same reason
 * at run time (test files are not type-checked).
 *
 * A real profile never holds `gatewayUrl` beside `tokenProxyMode`; the store
 * does not judge that, and this suite is about the store.
 */
const EVERY_DEFAULT: Required<GroupAgentDefaults> = {
	// General
	projectRoot: '/Users/dev/Projects/backend',
	additionalDirectories: [
		{ path: '/Users/dev/Projects/shared', read: true, write: false, description: 'Shared libs' },
	],
	newSessionMessage: 'Read CLAUDE.md first.',
	nudgeMessage: 'Keep it short.\nSecond line, with "quotes" and a \\ backslash.',
	// Provider
	toolType: 'claude-code',
	customPath: '/opt/homebrew/bin/claude',
	customArgs: '--verbose',
	customModel: 'opus',
	customEffort: 'high',
	customContextWindow: 1000000,
	enableMaestroP: false,
	maestroPMode: 'dynamic',
	maestroPPath: '/usr/local/bin/maestro-p',
	codexTransport: 'app-server',
	retryOnAvailabilityErrors: false,
	retryOnTokenExhaustion: false,
	codexAutoResetOnExhaustion: true,
	// Models
	runOn: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b', contextTokens: 32768 },
	tierTargets: {
		low: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b' },
		high: { type: 'provider-model', model: 'opus' },
	},
	backgroundRequests: { target: { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:4b' } },
	systemOneOptOut: true,
	gatewayUrl: 'http://127.0.0.1:4000',
	tokenProxyMode: 'compress',
	// Environment
	customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/dev/.claude-work', EMPTY_ON_PURPOSE: '' },
	customEnvVarsDisabled: { HTTP_PROXY: 'http://127.0.0.1:8080' },
	// Peers
	peerAgents: [{ sessionId: 'agent-docs', read: true, write: false, description: 'Docs owner' }],
	groupPeerAccess: { read: true, write: false },
	worktreePeerAccess: { read: false, write: false },
	// SSH
	sessionSshRemoteConfig: {
		enabled: true,
		remoteId: 'remote-1',
		workingDirOverride: '/srv/backend',
		syncHistory: true,
	},
};

const group = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Backend',
	emoji: '🛠️',
	collapsed: false,
	...overrides,
});

describe('groups persistence round trip (Group Settings)', () => {
	let dir: string;
	let storeFile: string;

	/** The groups store, as `initializeStores()` in `stores/instances.ts` builds it. */
	function openGroupsStore(): Store<GroupsData> {
		return new Store<GroupsData>({
			name: GROUPS_STORE_NAME,
			cwd: dir,
			defaults: GROUPS_DEFAULTS,
			deserialize: createStoreDeserializer<GroupsData>(storeFile),
		});
	}

	/**
	 * Register the real handlers over a store opened fresh from the file. Every
	 * call is a new process as far as the registry is concerned: nothing a
	 * previous instance held in memory can answer a read.
	 */
	function openHandlers(): {
		setAll: (groups: Group[]) => Promise<boolean>;
		getAll: () => Promise<Group[]>;
	} {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as (...args: unknown[]) => unknown);
		});
		// The settings and sessions handlers are registered and never called here.
		const settingsStore = { get: vi.fn(), set: vi.fn(), store: {} };
		const sessionsStore = { get: vi.fn().mockReturnValue([]), set: vi.fn(), path: '' };
		registerPersistenceHandlers({
			settingsStore: settingsStore as unknown as Store<MaestroSettings>,
			sessionsStore: sessionsStore as unknown as Store<SessionsData>,
			groupsStore: openGroupsStore(),
			getWebServer: () => null,
			flushSessionWrites: vi.fn().mockResolvedValue(undefined),
		});
		return {
			setAll: (groups) => handlers.get('groups:setAll')!({}, groups) as Promise<boolean>,
			getAll: () => handlers.get('groups:getAll')!({}) as Promise<Group[]>,
		};
	}

	const readStoreFile = (): GroupsData => JSON.parse(fs.readFileSync(storeFile, 'utf-8'));

	beforeEach(() => {
		vi.clearAllMocks();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-groups-roundtrip-'));
		storeFile = path.join(dir, `${GROUPS_STORE_NAME}.json`);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('holds a value for every default a group can store', () => {
		// A default added to GROUP_DEFAULT_FIELDS and not to EVERY_DEFAULT would
		// leave the round trip below silent about it.
		expect(Object.keys(EVERY_DEFAULT).sort()).toEqual(
			[...PUBLISHABLE_KEYS, ...UNPUBLISHABLE_KEYS].sort()
		);
	});

	it('writes to the temp directory it was given, and nowhere else', async () => {
		const store = openGroupsStore();
		expect(store.path).toBe(storeFile);

		expect(await openHandlers().setAll([group({ defaults: { customModel: 'opus' } })])).toBe(true);

		expect(fs.readdirSync(dir)).toEqual([`${GROUPS_STORE_NAME}.json`]);
	});

	it('reads back every default and the pill label after the store is reopened', async () => {
		const groups: Group[] = [
			group({ shortLabel: 'BE', defaults: EVERY_DEFAULT }),
			// The motivating case: one env var pinned, and nothing else.
			group({
				id: 'group-2',
				name: 'Amini & Conant',
				emoji: '🎼',
				defaults: { customEnvVars: { CLAUDE_CONFIG_DIR: '/Users/dev/.claude-banaco' } },
			}),
			// A child group with a label and no defaults.
			group({ id: 'group-3', name: 'Docs', parentGroupId: 'group-1', shortLabel: 'D' }),
			// A group that has never been through Group Settings.
			group({ id: 'group-4', name: 'Plain', collapsed: true }),
		];

		expect(await openHandlers().setAll(groups)).toBe(true);
		const readBack = await openHandlers().getAll();

		expect(readBack).toEqual(groups);
		expect(readBack[0].defaults).toEqual(EVERY_DEFAULT);
		expect(readBack[0].shortLabel).toBe('BE');
		expect(readStoreFile()).toEqual({ groups });
		// The file parsed as written: it was not quarantined as corrupt.
		expect(mockCaptureException).not.toHaveBeenCalled();
	});

	it('keeps the values a naive serializer would drop or change', async () => {
		const defaults: GroupAgentDefaults = {
			// An explicit `false` is a choice (the TUI is off over SSH); absent is not.
			enableMaestroP: false,
			retryOnAvailabilityErrors: false,
			// An empty value is a variable set to nothing, not a missing one.
			customEnvVars: { EMPTY_ON_PURPOSE: '' },
			// Neither square lit is an exclusion, and it is stored.
			peerAgents: [{ sessionId: 'agent-x', read: false, write: false }],
			// The mirror flag alone, with no remote chosen.
			sessionSshRemoteConfig: { enabled: false, remoteId: null, syncHistory: true },
		};

		await openHandlers().setAll([group({ defaults })]);
		const [readBack] = await openHandlers().getAll();

		expect(readBack.defaults).toEqual(defaults);
		expect(readBack.defaults?.enableMaestroP).toBe(false);
		expect(readBack.defaults?.customEnvVars).toEqual({ EMPTY_ON_PURPOSE: '' });
		expect(readBack.defaults?.sessionSshRemoteConfig?.remoteId).toBeNull();
	});

	it('stores no key for a group with no defaults and no label', async () => {
		await openHandlers().setAll([group()]);

		const [stored] = readStoreFile().groups;
		expect(stored).not.toHaveProperty('defaults');
		expect(stored).not.toHaveProperty('shortLabel');
	});

	it('removes cleared defaults and a cleared label from disk: a write replaces, it does not merge', async () => {
		await openHandlers().setAll([group({ shortLabel: 'BE', defaults: EVERY_DEFAULT })]);

		// What Clear defaults and an emptied pill label field write: the row without the keys.
		await openHandlers().setAll([group()]);
		const [readBack] = await openHandlers().getAll();

		expect(readBack).toEqual(group());
		expect(readBack).not.toHaveProperty('defaults');
		expect(readBack).not.toHaveProperty('shortLabel');
		expect(fs.readFileSync(storeFile, 'utf-8')).not.toContain('CLAUDE_CONFIG_DIR');
	});

	it('replaces one default and leaves the rest of the profile as written', async () => {
		await openHandlers().setAll([group({ shortLabel: 'BE', defaults: EVERY_DEFAULT })]);

		const next = group({ shortLabel: 'BE', defaults: { ...EVERY_DEFAULT, customModel: 'sonnet' } });
		await openHandlers().setAll([next]);
		const [readBack] = await openHandlers().getAll();

		expect(readBack.defaults).toEqual({ ...EVERY_DEFAULT, customModel: 'sonnet' });
		expect(readBack.shortLabel).toBe('BE');
	});

	it('keeps the defaults in the backup taken before an empty registry replaces them', async () => {
		const groups = [group({ shortLabel: 'BE', defaults: EVERY_DEFAULT })];
		await openHandlers().setAll(groups);

		expect(await openHandlers().setAll([])).toBe(true);

		expect(await openHandlers().getAll()).toEqual([]);
		const backup = JSON.parse(fs.readFileSync(path.join(dir, GROUPS_BACKUP_FILENAME), 'utf-8'));
		expect(backup.entries).toEqual(groups);
	});
});
