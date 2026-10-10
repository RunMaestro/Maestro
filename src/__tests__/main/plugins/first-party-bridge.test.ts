/**
 * Generalized first-party bridge: registry-wide lifecycle + the host-side
 * grant minter against the REAL sealed AuthorizationStore (the same ledger
 * path community consents write through). Pianola-specific lifecycle pinning
 * lives in src/__tests__/main/pianola/pianola-plugin-bridge.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	FIRST_PARTY_PLUGINS,
	MAESTRO_CUE_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN,
	type FirstPartyPluginDefinition,
} from '../../../shared/plugins/first-party';
import {
	AuthorizationStore,
	type Anchor,
	type AnchorStore,
	type SealProvider,
} from '../../../main/plugins/authorization-ledger';
import {
	FirstPartyPluginBridge,
	createFirstPartyGrantMinter,
	firstPartyAuthIdentity,
	getFirstPartyBridge,
	hasRequiredFirstPartyGrants,
	setFirstPartyBridges,
} from '../../../main/plugins/first-party-bridge';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-party-bridge-'));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	setFirstPartyBridges({});
});

/** Reversible "seal" with a marker so foreign/garbage bytes fail to unseal. */
function fakeSeal(): SealProvider {
	const MARK = 'SEALED\u0000';
	return {
		available: () => true,
		seal: (plaintext) => Buffer.from(MARK + plaintext, 'utf-8'),
		unseal: (blob) => {
			const s = blob.toString('utf-8');
			if (!s.startsWith(MARK)) throw new Error('not sealed by us');
			return s.slice(MARK.length);
		},
	};
}

function fakeAnchor(holder: { value: Anchor | null }): AnchorStore {
	return {
		available: () => true,
		read: () => holder.value,
		write: (a) => {
			holder.value = { ...a };
		},
		clear: () => {
			holder.value = null;
		},
	};
}

function makeLedger(): AuthorizationStore {
	return new AuthorizationStore({
		seal: fakeSeal(),
		anchor: fakeAnchor({ value: null }),
		ledgerPath: path.join(tmpDir, 'plugin-authorization.bin'),
		now: () => 1000,
	});
}

function makeSettings(initial: Record<string, boolean> = {}): {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
} {
	let encoreFeatures: Record<string, unknown> = { ...initial };
	return {
		get: (key: string) => (key === 'encoreFeatures' ? encoreFeatures : undefined),
		set: (key: string, value: unknown) => {
			if (key === 'encoreFeatures') encoreFeatures = value as Record<string, unknown>;
		},
	};
}

function makeBridge(
	definition: FirstPartyPluginDefinition,
	ledger: AuthorizationStore,
	settingsStore = makeSettings()
): FirstPartyPluginBridge {
	return new FirstPartyPluginBridge(definition, {
		settingsStore,
		readGrants: (id) => ledger.readGrants(id),
		mintFirstPartyGrants: createFirstPartyGrantMinter(ledger),
		revokeGrants: (id) => ledger.revoke(id),
	});
}

describe('createFirstPartyGrantMinter (real sealed ledger)', () => {
	it('mints the declared grants through the ledger with first-party provenance', () => {
		const ledger = makeLedger();
		const mint = createFirstPartyGrantMinter(ledger);

		mint(PIANOLA_FIRST_PARTY_PLUGIN);

		const minted = ledger.readGrants(PIANOLA_FIRST_PARTY_PLUGIN.id);
		expect(minted.map((g) => g.capability)).toEqual(
			PIANOLA_FIRST_PARTY_PLUGIN.permissions.map((p) => p.capability)
		);
		expect(hasRequiredFirstPartyGrants(PIANOLA_FIRST_PARTY_PLUGIN, minted)).toBe(true);
		// Provenance is auditable in the ledger identity: an explicit
		// first-party marker, trusted-by-construction, honestly signer-less.
		expect(ledger.entryIdentity(PIANOLA_FIRST_PARTY_PLUGIN.id)).toEqual({
			contentHash: `first-party:${PIANOLA_FIRST_PARTY_PLUGIN.id}`,
			signatureStatus: 'trusted',
			signerKey: null,
		});
		expect(ledger.isEnabled(PIANOLA_FIRST_PARTY_PLUGIN.id)).toBe(true);
	});

	it('fails loudly when the ledger rejects (under-delivers) the write', () => {
		const rejecting = {
			mint: vi.fn(),
			readGrants: () => [],
		};
		const mint = createFirstPartyGrantMinter(rejecting);
		expect(() => mint(MAESTRO_CUE_FIRST_PARTY_PLUGIN)).toThrow(
			/Authorization ledger rejected first-party grants for "com\.maestro\.cue"/
		);
		expect(rejecting.mint).toHaveBeenCalledTimes(1);
	});

	it('re-minting after revoke works (a fresh mint clears the tombstone)', () => {
		const ledger = makeLedger();
		const mint = createFirstPartyGrantMinter(ledger);

		mint(PIANOLA_FIRST_PARTY_PLUGIN);
		ledger.revoke(PIANOLA_FIRST_PARTY_PLUGIN.id);
		expect(ledger.readGrants(PIANOLA_FIRST_PARTY_PLUGIN.id)).toEqual([]);
		expect(ledger.isTombstoned(PIANOLA_FIRST_PARTY_PLUGIN.id)).toBe(true);

		mint(PIANOLA_FIRST_PARTY_PLUGIN);
		expect(ledger.isTombstoned(PIANOLA_FIRST_PARTY_PLUGIN.id)).toBe(false);
		expect(
			hasRequiredFirstPartyGrants(
				PIANOLA_FIRST_PARTY_PLUGIN,
				ledger.readGrants(PIANOLA_FIRST_PARTY_PLUGIN.id)
			)
		).toBe(true);
	});
});

describe('FirstPartyPluginBridge over the real ledger (every definition)', () => {
	it('enable→disable→revoke round-trips the flag and grants for all five features', () => {
		for (const definition of FIRST_PARTY_PLUGIN_DEFINITIONS) {
			const ledger = makeLedger();
			const settingsStore = makeSettings();
			const bridge = makeBridge(definition, ledger, settingsStore);

			expect(bridge.state()).toEqual({ enabled: false, authorized: false });

			expect(bridge.setEnabled(true)).toEqual({ enabled: true, authorized: true });
			expect(settingsStore.get('encoreFeatures')).toMatchObject({
				[definition.encoreFlag]: true,
			});
			expect(ledger.isEnabled(definition.id)).toBe(true);

			expect(bridge.setEnabled(false)).toEqual({ enabled: false, authorized: true });
			expect(settingsStore.get('encoreFeatures')).toMatchObject({
				[definition.encoreFlag]: false,
			});
			// Disable keeps the grants (cheap re-enable) …
			expect(ledger.isEnabled(definition.id)).toBe(true);

			// … revoke drops them and forces the flag off.
			expect(bridge.revoke()).toEqual({ enabled: false, authorized: false });
			expect(ledger.readGrants(definition.id)).toEqual([]);
			expect(bridge.state()).toEqual({ enabled: false, authorized: false });
		}
	});

	it('service-less definitions enable without supervisor hooks (no throw on undefined)', () => {
		const ledger = makeLedger();
		const bridge = makeBridge(MAESTRO_CUE_FIRST_PARTY_PLUGIN, ledger);
		expect(bridge.setEnabled(true)).toEqual({ enabled: true, authorized: true });
		expect(bridge.reconcileBackgroundService()).toEqual({ enabled: true, authorized: true });
		expect(bridge.revoke()).toEqual({ enabled: false, authorized: false });
	});

	it('firstPartyAuthIdentity marks provenance per definition id', () => {
		expect(firstPartyAuthIdentity(MAESTRO_CUE_FIRST_PARTY_PLUGIN)).toEqual({
			contentHash: 'first-party:com.maestro.cue',
			signatureStatus: 'trusted',
			signerKey: null,
		});
	});
});

describe('active bridge registry', () => {
	it('exposes constructed bridges to the IPC togglers by Encore flag', () => {
		const ledger = makeLedger();
		const bridge = makeBridge(FIRST_PARTY_PLUGINS.pianola, ledger);
		expect(getFirstPartyBridge('pianola')).toBeNull();
		setFirstPartyBridges({ pianola: bridge });
		expect(getFirstPartyBridge('pianola')).toBe(bridge);
		expect(getFirstPartyBridge('symphony')).toBeNull();
		setFirstPartyBridges({});
		expect(getFirstPartyBridge('pianola')).toBeNull();
	});
});
