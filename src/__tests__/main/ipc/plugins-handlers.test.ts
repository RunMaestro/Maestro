/**
 * @file plugins-handlers.test.ts
 * @description Locks the invariant that the plugin READ channels
 * (plugins:contributions, plugins:list) never call manager.refresh(). refresh()
 * reconciles sandboxes and fires onChange -> 'plugins:changed' -> renderer
 * re-fetch -> read again, an infinite IPC loop that froze the whole app. Reads
 * must be pure; discovery happens at startup and on mutations. electron's
 * ipcMain is mocked to capture handlers; the store is mocked so no fs runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AggregatedContributions } from '../../../shared/plugins/contributions';
import type { PluginRegistry } from '../../../shared/plugins/plugin-registry';
import type { PluginManager } from '../../../main/plugins/plugin-manager';
import type {
	PluginActivityMap,
	PluginsHandlerDependencies,
} from '../../../main/ipc/handlers/plugins';
import {
	FirstPartyPluginBridge,
	setFirstPartyBridges,
} from '../../../main/plugins/first-party-bridge';
import {
	FIRST_PARTY_PLUGINS,
	PIANOLA_FIRST_PARTY_PLUGIN,
} from '../../../shared/plugins/first-party';
import { grantsFromRequests, type PermissionGrant } from '../../../shared/plugins/permissions';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
	},
}));

vi.mock('../../../main/plugins/plugin-store-main', () => ({
	readGrants: vi.fn(() => []),
	setGrants: vi.fn(),
	forgetGrants: vi.fn(),
}));

import { registerPluginsHandlers } from '../../../main/ipc/handlers/plugins';

const EMPTY: AggregatedContributions = {
	themes: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	agents: [],
	errorsByPlugin: {},
};

const emptyRegistry = { records: [] } as unknown as PluginRegistry;

function fakeManager() {
	return {
		refresh: vi.fn(() => emptyRegistry),
		getRegistry: vi.fn(() => emptyRegistry),
		getContributions: vi.fn(() => EMPTY),
		setEnabled: vi.fn(() => emptyRegistry),
	};
}

function settingsStore(plugins: boolean): { get: (key: string) => unknown } {
	return { get: (key: string) => (key === 'encoreFeatures' ? { plugins } : undefined) };
}

function register(plugins: boolean, sandboxHost?: PluginsHandlerDependencies['sandboxHost']) {
	const manager = fakeManager();
	registerPluginsHandlers({
		settingsStore: settingsStore(plugins),
		manager: manager as unknown as PluginManager,
		sandboxHost,
		authStore: {
			readGrants: vi.fn(() => []),
			revoke: vi.fn(),
			uninstall: vi.fn(),
			isEnabled: vi.fn(() => false),
		},
	});
	return manager;
}

const event = {} as unknown;

beforeEach(() => {
	handlers.clear();
	vi.clearAllMocks();
});

describe('plugins IPC read channels are pure (no refresh -> no feedback loop)', () => {
	it('plugins:contributions returns getContributions() and never calls refresh()', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:contributions');
		expect(handler).toBeDefined();

		// Call it repeatedly — the old bug looped because each read refreshed.
		await handler!(event);
		await handler!(event);
		await handler!(event);

		expect(manager.getContributions).toHaveBeenCalledTimes(3);
		expect(manager.refresh).not.toHaveBeenCalled();
	});

	it('plugins:list returns getRegistry() and never calls refresh()', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:list');
		expect(handler).toBeDefined();

		await handler!(event);
		await handler!(event);

		expect(manager.getRegistry).toHaveBeenCalledTimes(2);
		expect(manager.refresh).not.toHaveBeenCalled();
	});

	it('plugins:set-enabled (a mutation) still drives manager.setEnabled', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:set-enabled');
		expect(handler).toBeDefined();

		await handler!(event, 'some-plugin', true);

		expect(manager.setEnabled).toHaveBeenCalledWith('some-plugin', true);
	});

	it('mutation channels reject a path-traversal plugin id (InvalidPluginId) and never reach the manager', async () => {
		const manager = register(true);
		const handler = handlers.get('plugins:set-enabled');
		expect(handler).toBeDefined();

		await expect(handler!(event, '../../etc', true)).rejects.toThrow('InvalidPluginId');
		expect(manager.setEnabled).not.toHaveBeenCalled();
	});

	it('reads reject with PluginsDisabled when the Encore flag is off, without touching the manager', async () => {
		const manager = register(false);
		const handler = handlers.get('plugins:contributions');
		expect(handler).toBeDefined();

		await expect(handler!(event)).rejects.toThrow('PluginsDisabled');
		expect(manager.getContributions).not.toHaveBeenCalled();
		expect(manager.refresh).not.toHaveBeenCalled();
	});
});

describe('plugins:get-activity (gated read-only observability)', () => {
	const sample: PluginActivityMap = {
		demo: {
			totalCalls: 3,
			inFlight: 1,
			peakInFlight: 2,
			lastActivity: 1_700_000_000_000,
			crashCount: 0,
			recentLogs: [{ level: 'info', message: 'hi', at: 1_700_000_000_000 }],
		},
	};

	it('returns the sandbox host snapshot when the flag is on', async () => {
		const getActivity = vi.fn(() => sample);
		register(true, { getActivity });
		const handler = handlers.get('plugins:get-activity');
		expect(handler).toBeDefined();
		await expect(handler!(event)).resolves.toEqual(sample);
		expect(getActivity).toHaveBeenCalledTimes(1);
	});

	it('returns {} when no sandbox host is wired', async () => {
		register(true);
		const handler = handlers.get('plugins:get-activity');
		expect(handler).toBeDefined();
		await expect(handler!(event)).resolves.toEqual({});
	});

	it('throws PluginsDisabled when the flag is off and never reads the sandbox host', async () => {
		const getActivity = vi.fn(() => sample);
		register(false, { getActivity });
		const handler = handlers.get('plugins:get-activity');
		expect(handler).toBeDefined();
		await expect(handler!(event)).rejects.toThrow('PluginsDisabled');
		expect(getActivity).not.toHaveBeenCalled();
	});
});

describe('plugins:set-enabled gates code-tier activation on ledger authorization', () => {
	function setup(opts: { tier: 0 | 1; authorized: boolean }) {
		const setEnabledMock = vi.fn(() => emptyRegistry);
		const manager = {
			refresh: vi.fn(() => emptyRegistry),
			getContributions: vi.fn(() => EMPTY),
			getRegistry: vi.fn(() => ({ records: [{ id: 'com.p', manifest: { tier: opts.tier } }] })),
			setEnabled: setEnabledMock,
		};
		registerPluginsHandlers({
			settingsStore: settingsStore(true),
			manager: manager as unknown as PluginManager,
			authStore: {
				readGrants: vi.fn(() => []),
				revoke: vi.fn(),
				uninstall: vi.fn(),
				isEnabled: vi.fn(() => opts.authorized),
			},
		});
		return { setEnabledMock };
	}

	it('rejects enabling a code-tier plugin that holds no ledger grant', async () => {
		const { setEnabledMock } = setup({ tier: 1, authorized: false });
		const handler = handlers.get('plugins:set-enabled');
		await expect(handler!(event, 'com.p', true)).rejects.toThrow(/PluginNotAuthorized/);
		expect(setEnabledMock).not.toHaveBeenCalled();
	});

	it('allows enabling a code-tier plugin once it is authorized in the ledger', async () => {
		const { setEnabledMock } = setup({ tier: 1, authorized: true });
		const handler = handlers.get('plugins:set-enabled');
		await expect(handler!(event, 'com.p', true)).resolves.toBeDefined();
		expect(setEnabledMock).toHaveBeenCalledWith('com.p', true);
	});

	it('does not gate disabling a code-tier plugin', async () => {
		const { setEnabledMock } = setup({ tier: 1, authorized: false });
		const handler = handlers.get('plugins:set-enabled');
		await expect(handler!(event, 'com.p', false)).resolves.toBeDefined();
		expect(setEnabledMock).toHaveBeenCalledWith('com.p', false);
	});

	it('does not gate enabling a tier-0 data plugin', async () => {
		const { setEnabledMock } = setup({ tier: 0, authorized: false });
		const handler = handlers.get('plugins:set-enabled');
		await expect(handler!(event, 'com.p', true)).resolves.toBeDefined();
		expect(setEnabledMock).toHaveBeenCalledWith('com.p', true);
	});
});

describe('plugins:first-party-set-enabled routes the marketplace toggle through the bridge', () => {
	// A REAL bridge over fake deps: the round-trip exercises handler validation
	// + bridge lifecycle (flag write, grant mint, supervisor hooks) end to end.
	function bridgeSetup() {
		let ledger: PermissionGrant[] = [];
		const encore: Record<string, unknown> = { pianola: false };
		const store = {
			get: vi.fn((key: string) => (key === 'encoreFeatures' ? { ...encore } : undefined)),
			set: vi.fn((key: string, value: unknown) => {
				if (key === 'encoreFeatures' && value && typeof value === 'object') {
					Object.assign(encore, value);
				}
			}),
		};
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new FirstPartyPluginBridge(PIANOLA_FIRST_PARTY_PLUGIN, {
			settingsStore: store,
			readGrants: () => ledger,
			mintFirstPartyGrants: vi.fn((definition) => {
				ledger = grantsFromRequests([...definition.permissions], Date.now());
			}),
			revokeGrants: vi.fn(() => {
				ledger = [];
			}),
			supervisor,
		});
		setFirstPartyBridges({ pianola: bridge });
		return { encore, supervisor };
	}

	afterEach(() => {
		setFirstPartyBridges({});
	});

	it('enable flips the flag through the bridge and reconciles the supervisor', async () => {
		register(true);
		const { encore, supervisor } = bridgeSetup();
		const handler = handlers.get('plugins:first-party-set-enabled');
		expect(handler).toBeDefined();

		await expect(handler!(event, 'pianola', true)).resolves.toEqual({
			enabled: true,
			authorized: true,
		});
		expect(encore.pianola).toBe(true);
		expect(supervisor.reconcile).toHaveBeenCalledTimes(1);
		expect(supervisor.stopAll).not.toHaveBeenCalled();
	});

	it('disable flips the flag off and stops supervised work', async () => {
		register(true);
		const { encore, supervisor } = bridgeSetup();
		const handler = handlers.get('plugins:first-party-set-enabled');

		await handler!(event, 'pianola', true);
		const state = await handler!(event, 'pianola', false);

		expect(state).toMatchObject({ enabled: false });
		expect(encore.pianola).toBe(false);
		expect(supervisor.stopAll).toHaveBeenCalledTimes(1);
	});

	it('is NOT gated on the community-plugin subsystem flag', async () => {
		register(false); // encoreFeatures.plugins === false
		const { encore } = bridgeSetup();
		const handler = handlers.get('plugins:first-party-set-enabled');

		await expect(handler!(event, 'pianola', true)).resolves.toMatchObject({ enabled: true });
		expect(encore.pianola).toBe(true);
	});

	it('rejects a flag that is not a first-party Encore flag', async () => {
		register(true);
		bridgeSetup();
		const handler = handlers.get('plugins:first-party-set-enabled');

		await expect(handler!(event, 'plugins', true)).rejects.toThrow('InvalidFirstPartyFlag');
		await expect(handler!(event, '../evil', true)).rejects.toThrow('InvalidFirstPartyFlag');
		await expect(handler!(event, 42, true)).rejects.toThrow('InvalidFirstPartyFlag');
	});

	it('rejects a non-boolean enabled value', async () => {
		register(true);
		bridgeSetup();
		const handler = handlers.get('plugins:first-party-set-enabled');

		await expect(handler!(event, 'pianola', 'yes')).rejects.toThrow('InvalidEnabledFlag');
	});

	it('rejects when no bridge is registered for the flag', async () => {
		register(true);
		bridgeSetup(); // registers pianola only
		const handler = handlers.get('plugins:first-party-set-enabled');

		await expect(handler!(event, 'symphony', true)).rejects.toThrow('FirstPartyBridgeUnavailable');
	});

	it('accepts every first-party flag when its bridge exists', async () => {
		register(true);
		// One real bridge per flag over an isolated settings map.
		const encore: Record<string, unknown> = {};
		const store = {
			get: (key: string) => (key === 'encoreFeatures' ? { ...encore } : undefined),
			set: (_key: string, value: unknown) => {
				if (value && typeof value === 'object') Object.assign(encore, value);
			},
		};
		const ledgers: Record<string, PermissionGrant[]> = {};
		const bridges = Object.fromEntries(
			Object.values(FIRST_PARTY_PLUGINS).map((definition) => [
				definition.encoreFlag,
				new FirstPartyPluginBridge(definition, {
					settingsStore: store,
					readGrants: (id) => ledgers[id] ?? [],
					mintFirstPartyGrants: (def) => {
						ledgers[def.id] = grantsFromRequests([...def.permissions], Date.now());
					},
					revokeGrants: (id) => {
						ledgers[id] = [];
					},
				}),
			])
		);
		setFirstPartyBridges(bridges);
		const handler = handlers.get('plugins:first-party-set-enabled');

		for (const flag of Object.keys(FIRST_PARTY_PLUGINS)) {
			await expect(handler!(event, flag, true)).resolves.toMatchObject({ enabled: true });
			expect(encore[flag]).toBe(true);
		}
	});
});
