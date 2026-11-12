/**
 * Director's Notes as a managed first-party plugin (encore-lifts L2).
 *
 * Pins two contracts:
 * 1. The definition discloses exactly the broker capabilities the feature's
 *    real code paths touch (director-notes IPC handlers, synopsis prompt
 *    builder, preload API, DirectorNotes renderer components) - and nothing
 *    host-owned (`agents:dispatch`, `process:spawn`) leaks into static
 *    first-party metadata.
 * 2. Lifecycle through the shared FirstPartyPluginBridge: DN is a
 *    SERVICE-LESS feature (all surfaces are on-demand; synopsis generation
 *    is a single awaited, timeout-bounded batch spawn), so the bridge must
 *    round-trip enable/disable/revoke with NO supervisor hooks.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { grantsFromRequests, parsePermissions } from '../../../shared/plugins/permissions';
import {
	DIRECTOR_NOTES_FIRST_PARTY_PLUGIN,
	FIRST_PARTY_PLUGINS,
} from '../../../shared/plugins/first-party';
import {
	FirstPartyPluginBridge,
	hasRequiredFirstPartyGrants,
} from '../../../main/plugins/first-party-bridge';

const DN = DIRECTOR_NOTES_FIRST_PARTY_PLUGIN;

function grants(grantedAt = 1): PermissionGrant[] {
	return grantsFromRequests([...DN.permissions], grantedAt);
}

function makeStore(initial = false): {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
} {
	let encoreFeatures: Record<string, unknown> = { directorNotes: initial };
	return {
		get: (key: string) => (key === 'encoreFeatures' ? encoreFeatures : undefined),
		set: (key: string, value: unknown) => {
			if (key === 'encoreFeatures') encoreFeatures = value as Record<string, unknown>;
		},
	};
}

describe("Director's Notes first-party plugin definition", () => {
	it('declares the plan-stable identity and registry slot', () => {
		expect(DN).toMatchObject({
			id: 'com.maestro.director-notes',
			name: "Director's Notes",
			firstParty: true,
			category: 'insights',
			settingsNamespace: 'directorNotes',
			encoreFlag: 'directorNotes',
		});
		expect(FIRST_PARTY_PLUGINS.directorNotes).toBe(DN);
	});

	it('requests exactly the broker capabilities the feature actually touches', () => {
		const parsed = parsePermissions(DN.permissions);
		expect(parsed.errors).toEqual([]);
		expect(parsed.requests.map((p) => p.capability)).toEqual([
			// Encore flag + synopsis provider settings + agent config overrides.
			'settings:read',
			// Unified list, graph buckets, Rich Overview stats, live entryAdded pushes.
			'history:read',
			// HistoryEntry.fullResponse in the unified view + the synopsis agent
			// reading raw history JSON files.
			'transcripts:read',
			// Session ID -> display-name resolution from the sessions store.
			'sessions:read',
			// Synopsis-ready toast when the modal is closed.
			'notifications:toast',
		]);
		expect(parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)).toBe(
			true
		);
	});

	it('keeps host-owned authority out of the static metadata', () => {
		const caps = DN.permissions.map((p) => p.capability);
		// The synopsis batch spawn (groomContext) is host-owned, like Pianola
		// dispatch: FC2 allowlist scopes need exact targets, and the provider
		// is a user setting resolved at request time (see first-party.ts NOTE).
		expect(caps).not.toContain('agents:dispatch');
		expect(caps).not.toContain('process:spawn');
	});

	it('declares NO background services (every surface is on-demand)', () => {
		// Unified history/graph/stats are computed per IPC call; synopsis is a
		// single awaited, timeout-bounded spawn cleaned up on quit. Nothing
		// recurring exists for a supervisor to stop.
		expect(DN.backgroundServices).toEqual([]);
		expect(DN.permissions.map((p) => p.capability)).not.toContain('background:service');
	});
});

describe("Director's Notes lifecycle through the shared bridge (service-less)", () => {
	it('requires every declared capability grant', () => {
		expect(hasRequiredFirstPartyGrants(DN, grants())).toBe(true);
		expect(hasRequiredFirstPartyGrants(DN, grants().slice(1))).toBe(false);
		expect(hasRequiredFirstPartyGrants(DN, [])).toBe(false);
	});

	it('enable mints the declared grants and flips the flag with NO supervisor hooks', () => {
		let currentGrants: PermissionGrant[] = [];
		const settingsStore = makeStore(false);
		const mintFirstPartyGrants = vi.fn((definition: typeof DN) => {
			currentGrants = grantsFromRequests([...definition.permissions], 2);
		});
		// DN passes no `supervisor` - the bridge must tolerate undefined hooks.
		const bridge = new FirstPartyPluginBridge(DN, {
			settingsStore,
			readGrants: (id) => (id === DN.id ? currentGrants : []),
			mintFirstPartyGrants,
			revokeGrants: vi.fn(),
		});

		expect(bridge.state()).toEqual({ enabled: false, authorized: false });
		expect(bridge.setEnabled(true)).toEqual({ enabled: true, authorized: true });
		expect(mintFirstPartyGrants).toHaveBeenCalledWith(DN);
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ directorNotes: true });
	});

	it('disable flips the flag off and keeps grants; revoke drops both', () => {
		let currentGrants: PermissionGrant[] = grants();
		const settingsStore = makeStore(true);
		const revokeGrants = vi.fn((id: string) => {
			if (id === DN.id) currentGrants = [];
		});
		const bridge = new FirstPartyPluginBridge(DN, {
			settingsStore,
			readGrants: (id) => (id === DN.id ? currentGrants : []),
			mintFirstPartyGrants: vi.fn(),
			revokeGrants,
		});

		expect(bridge.setEnabled(false)).toEqual({ enabled: false, authorized: true });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ directorNotes: false });
		expect(currentGrants.length).toBeGreaterThan(0);

		expect(bridge.revoke()).toEqual({ enabled: false, authorized: false });
		expect(revokeGrants).toHaveBeenCalledWith(DN.id);
		expect(bridge.state()).toEqual({ enabled: false, authorized: false });
	});

	it('reconcileBackgroundService forces the feature off when grants are gone', () => {
		const settingsStore = makeStore(true);
		const bridge = new FirstPartyPluginBridge(DN, {
			settingsStore,
			readGrants: () => [], // ledger lost/revoked the grants out-of-band
			mintFirstPartyGrants: vi.fn(),
			revokeGrants: vi.fn(),
		});

		expect(bridge.reconcileBackgroundService()).toEqual({ enabled: false, authorized: false });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ directorNotes: false });
	});

	it('reconcileBackgroundService is a no-op settle for an enabled, authorized DN', () => {
		const settingsStore = makeStore(true);
		const bridge = new FirstPartyPluginBridge(DN, {
			settingsStore,
			readGrants: (id) => (id === DN.id ? grants() : []),
			mintFirstPartyGrants: vi.fn(),
			revokeGrants: vi.fn(),
		});

		expect(bridge.reconcileBackgroundService()).toEqual({ enabled: true, authorized: true });
		expect(settingsStore.get('encoreFeatures')).toMatchObject({ directorNotes: true });
	});
});
