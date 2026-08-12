/**
 * L4 lift: Symphony's first-party plugin definition. Pins the HONEST
 * permission disclosure (refined against the actual surface in
 * src/main/ipc/handlers/symphony.ts, src/main/services/symphony-runner.ts,
 * and src/renderer/hooks/symphony) and the extensionModel projection row.
 * Bridge/ledger round-trips for every definition (including this one) live in
 * src/__tests__/main/plugins/first-party-bridge.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
	SYMPHONY_FIRST_PARTY_PLUGIN,
	SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS,
	FIRST_PARTY_PLUGINS,
} from '../../../shared/plugins/first-party';
import {
	parsePermissions,
	grantsFromRequests,
	isPermitted,
	isHighRiskActCapability,
} from '../../../shared/plugins/permissions';
import {
	builtinExtension,
	BUILTIN_FEATURES,
} from '../../../renderer/components/Settings/Extensions/extensionModel';
import type { EncoreFeatureFlags } from '../../../renderer/types';

function flags(overrides: Partial<EncoreFeatureFlags> = {}): EncoreFeatureFlags {
	return {
		directorNotes: false,
		usageStats: false,
		symphony: false,
		maestroCue: false,
		pianola: false,
		plugins: false,
		...overrides,
	};
}

describe('SYMPHONY_FIRST_PARTY_PLUGIN definition', () => {
	it('is registered under the symphony Encore flag with stable identity', () => {
		expect(FIRST_PARTY_PLUGINS.symphony).toBe(SYMPHONY_FIRST_PARTY_PLUGIN);
		expect(SYMPHONY_FIRST_PARTY_PLUGIN).toMatchObject({
			id: 'com.maestro.symphony',
			firstParty: true,
			category: 'agents',
			settingsNamespace: 'symphony',
			encoreFlag: 'symphony',
		});
	});

	it('declares exactly the capabilities the surface touches, each justified', () => {
		expect(SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS.map((p) => p.capability)).toEqual([
			'settings:read', // symphonyRegistryUrls + Encore flag reads (getRegistry handler)
			'net:fetch', // registry fetch, GitHub stars/issues/PR status, doc downloads
			'sessions:read', // filterOrphanedContributions against the sessions store
			'sessions:create', // contribution start opens a new Maestro session
			'notifications:toast', // PR-ready / manual-finalize / start-failure toasts
			'storage:read', // symphony-state.json + symphony-cache.json reads
			'storage:write', // state/cache/doc persistence under the symphony data dir
		]);
		for (const request of SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS) {
			expect(request.reason, `${request.capability} needs a justification`).toBeTruthy();
		}
	});

	it('net:fetch is unscoped: custom registry URLs may point at any http(s) host', () => {
		const netFetch = SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS.find(
			(p) => p.capability === 'net:fetch'
		);
		expect(netFetch).toBeDefined();
		expect(netFetch!.scope).toBeUndefined();
	});

	it('never declares a high-risk act verb (git/gh spawn + dispatch stay host-owned)', () => {
		// The git/gh pipeline (clone, fork, push, PR) and the auto-started
		// batch run are host-owned supervised calls - act verbs must never
		// ride the bundled first-party mint.
		for (const request of SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS) {
			expect(isHighRiskActCapability(request.capability)).toBe(false);
		}
	});

	it('parses cleanly through the manifest permission validator', () => {
		const parsed = parsePermissions([...SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.requests.map((r) => r.capability)).toEqual(
			SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS.map((p) => p.capability)
		);
	});

	it('minted grants satisfy every declared request (the bridge enable invariant)', () => {
		const grants = grantsFromRequests([...SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS], 1000);
		for (const request of SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS) {
			expect(
				isPermitted(grants, request.capability, request.scope),
				`grant for ${request.capability} must cover its own request`
			).toBe(true);
		}
	});

	it('declares no background services: registry fetch is on-demand, PR sync is renderer polling', () => {
		expect(SYMPHONY_FIRST_PARTY_PLUGIN.backgroundServices).toEqual([]);
	});
});

describe('extensionModel projection (Symphony row)', () => {
	it('projects the refined definition onto the marketplace tile', () => {
		const def = BUILTIN_FEATURES.find((d) => d.flag === 'symphony');
		expect(def).toBeDefined();

		const enabled = builtinExtension(def!, flags({ symphony: true }));
		expect(enabled).toMatchObject({
			key: 'builtin:symphony',
			kind: 'builtin',
			id: 'symphony',
			name: 'Maestro Symphony',
			state: 'enabled',
			category: 'agents',
			pluginBacked: true,
			firstParty: true,
			pluginId: 'com.maestro.symphony',
			settingsNamespace: 'symphony',
			backgroundServiceId: undefined,
		});
		expect(enabled.permissions).toEqual(SYMPHONY_FIRST_PARTY_PLUGIN_PERMISSIONS);

		const disabled = builtinExtension(def!, flags());
		expect(disabled.state).toBe('not-installed');
	});
});
