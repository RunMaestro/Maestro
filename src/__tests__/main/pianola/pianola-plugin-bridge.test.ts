import { describe, it, expect, vi } from 'vitest';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import {
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../shared/pianola/first-party-plugin';
import {
	PianolaFirstPartyPluginBridge,
	pianolaHasRequiredPluginGrants,
} from '../../../main/pianola/pianola-plugin-bridge';

function grants(): PermissionGrant[] {
	return PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS.map((request) => ({
		capability: request.capability,
		...(request.scope ? { scope: request.scope } : {}),
		grantedAt: 1,
	}));
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

describe('pianolaHasRequiredPluginGrants', () => {
	it('requires every declared Pianola capability grant', () => {
		expect(pianolaHasRequiredPluginGrants(grants())).toBe(true);
		expect(pianolaHasRequiredPluginGrants(grants().slice(1))).toBe(false);
	});
});

describe('PianolaFirstPartyPluginBridge', () => {
	it('enables and reconciles the background service only after grants exist', () => {
		let currentGrants: PermissionGrant[] = [];
		const settingsStore = makeStore(false);
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new PianolaFirstPartyPluginBridge({
			settingsStore,
			readGrants: (id) => (id === PIANOLA_FIRST_PARTY_PLUGIN_ID ? currentGrants : []),
			revokeGrants: vi.fn(),
			supervisor,
		});

		expect(bridge.setEnabled(true)).toEqual({ enabled: false, authorized: false });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.reconcile).not.toHaveBeenCalled();

		currentGrants = grants();
		expect(bridge.setEnabled(true)).toEqual({ enabled: true, authorized: true });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: true });
		expect(supervisor.reconcile).toHaveBeenCalledTimes(1);
	});

	it('disable and revoke both self-stop supervised Pianola work', () => {
		const settingsStore = makeStore(true);
		const revokeGrants = vi.fn();
		const supervisor = { reconcile: vi.fn(), stopAll: vi.fn() };
		const bridge = new PianolaFirstPartyPluginBridge({
			settingsStore,
			readGrants: () => grants(),
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
		const bridge = new PianolaFirstPartyPluginBridge({
			settingsStore,
			readGrants: () => [],
			revokeGrants: vi.fn(),
			supervisor,
		});

		expect(bridge.reconcileBackgroundService()).toEqual({ enabled: false, authorized: false });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ pianola: false });
		expect(supervisor.stopAll).toHaveBeenCalledTimes(1);
		expect(supervisor.reconcile).not.toHaveBeenCalled();
	});
});
