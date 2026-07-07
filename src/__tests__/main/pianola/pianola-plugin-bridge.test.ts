/**
 * Pianola through the generalized first-party bridge
 * (src/main/plugins/first-party-bridge.ts — the successor of the old
 * pianola-plugin-bridge). Kept at this path so Pianola's lifecycle contract
 * stays pinned: enable mints + reconciles, disable/revoke stop supervised
 * work, grants-gone forces the feature off.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { grantsFromRequests } from '../../../shared/plugins/permissions';
import {
	PIANOLA_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../shared/plugins/first-party';
import {
	FirstPartyPluginBridge,
	hasRequiredFirstPartyGrants,
} from '../../../main/plugins/first-party-bridge';

function grants(): PermissionGrant[] {
	return grantsFromRequests([...PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS], 1);
}

function makeStore(initial = false): {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
} {
	let encoreFeatures = { pianola: initial, plugins: true };
	return {
		get: (key: string) => (key === 'encoreFeatures' ? encoreFeatures : undefined),
		set: (key: string, value: unknown) => {
			if (key === 'encoreFeatures') encoreFeatures = value as typeof encoreFeatures;
		},
	};
}

describe('hasRequiredFirstPartyGrants', () => {
	it('requires every declared Pianola capability grant', () => {
		expect(hasRequiredFirstPartyGrants(PIANOLA_FIRST_PARTY_PLUGIN, grants())).toBe(true);
		expect(hasRequiredFirstPartyGrants(PIANOLA_FIRST_PARTY_PLUGIN, grants().slice(1))).toBe(false);
	});
});

describe('FirstPartyPluginBridge (Pianola)', () => {
	it('enable mints the declared grants host-side, then reconciles the background service', () => {
		let currentGrants: PermissionGrant[] = [];
		const settingsStore = makeStore(false);
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const mintFirstPartyGrants = vi.fn((definition: typeof PIANOLA_FIRST_PARTY_PLUGIN) => {
			currentGrants = grantsFromRequests([...definition.permissions], 2);
		});
		const bridge = new FirstPartyPluginBridge(PIANOLA_FIRST_PARTY_PLUGIN, {
			settingsStore,
			readGrants: (id) => (id === PIANOLA_FIRST_PARTY_PLUGIN_ID ? currentGrants : []),
			mintFirstPartyGrants,
			revokeGrants: vi.fn(),
			supervisor,
		});

		expect(bridge.state()).toEqual({ enabled: false, authorized: false });
		expect(bridge.setEnabled(true)).toEqual({ enabled: true, authorized: true });
		expect(mintFirstPartyGrants).toHaveBeenCalledWith(PIANOLA_FIRST_PARTY_PLUGIN);
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: true });
		expect(supervisor.reconcile).toHaveBeenCalledTimes(1);

		// Re-enable with live grants: no second mint (idempotent enable).
		bridge.setEnabled(true);
		expect(mintFirstPartyGrants).toHaveBeenCalledTimes(1);
	});

	it('fails closed (flag off, work stopped, error propagated) when the ledger rejects the mint', () => {
		const settingsStore = makeStore(false);
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new FirstPartyPluginBridge(PIANOLA_FIRST_PARTY_PLUGIN, {
			settingsStore,
			readGrants: () => [],
			mintFirstPartyGrants: () => {
				throw new Error('ledger rejected');
			},
			revokeGrants: vi.fn(),
			supervisor,
		});

		expect(() => bridge.setEnabled(true)).toThrow('ledger rejected');
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.stopAll).toHaveBeenCalledTimes(1);
		expect(supervisor.reconcile).not.toHaveBeenCalled();
	});

	it('fails closed without enabling when the minter silently under-delivers', () => {
		const settingsStore = makeStore(false);
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new FirstPartyPluginBridge(PIANOLA_FIRST_PARTY_PLUGIN, {
			settingsStore,
			readGrants: () => [], // minter "succeeds" but the ledger still has nothing
			mintFirstPartyGrants: vi.fn(),
			revokeGrants: vi.fn(),
			supervisor,
		});

		expect(bridge.setEnabled(true)).toEqual({ enabled: false, authorized: false });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.reconcile).not.toHaveBeenCalled();
	});

	it('disable and revoke both self-stop supervised Pianola work', () => {
		const settingsStore = makeStore(true);
		const revokeGrants = vi.fn();
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new FirstPartyPluginBridge(PIANOLA_FIRST_PARTY_PLUGIN, {
			settingsStore,
			readGrants: () => grants(),
			mintFirstPartyGrants: vi.fn(),
			revokeGrants,
			supervisor,
		});

		expect(bridge.setEnabled(false)).toEqual({ enabled: false, authorized: true });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.stopAll).toHaveBeenCalledTimes(1);

		bridge.setEnabled(true);
		bridge.revoke();
		expect(revokeGrants).toHaveBeenCalledWith(PIANOLA_FIRST_PARTY_PLUGIN_ID);
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.stopAll).toHaveBeenCalledTimes(2);
	});

	it('self-stops instead of reconciling when grants are revoked while the flag is on', () => {
		const settingsStore = makeStore(true);
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new FirstPartyPluginBridge(PIANOLA_FIRST_PARTY_PLUGIN, {
			settingsStore,
			readGrants: () => [],
			mintFirstPartyGrants: vi.fn(),
			revokeGrants: vi.fn(),
			supervisor,
		});

		expect(bridge.reconcileBackgroundService()).toEqual({ enabled: false, authorized: false });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.stopAll).toHaveBeenCalledTimes(1);
		expect(supervisor.reconcile).not.toHaveBeenCalled();
	});
});
