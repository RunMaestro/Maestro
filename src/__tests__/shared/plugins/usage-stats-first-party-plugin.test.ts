/**
 * Usage & Stats first-party plugin definition (encore-lifts L5).
 *
 * Pins the HONEST permission disclosure grepped from the feature's actual
 * surfaces (stats IPC handlers, host stats DB, quota samplers, WakaTime
 * manager, Usage Dashboard) and the `stats.sampler` supervised background
 * service. Registry-wide invariants live in
 * src/__tests__/shared/pianola/pianola-first-party-plugin.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
	parsePermissions,
	grantsFromRequests,
	isPermitted,
} from '../../../shared/plugins/permissions';
import {
	FIRST_PARTY_PLUGINS,
	USAGE_STATS_FIRST_PARTY_PLUGIN,
} from '../../../shared/plugins/first-party';
import { hasRequiredFirstPartyGrants } from '../../../main/plugins/first-party-bridge';

describe('Usage & Stats first-party plugin definition', () => {
	it('declares Usage & Stats as a first-party plugin-backed insights extension', () => {
		expect(USAGE_STATS_FIRST_PARTY_PLUGIN).toMatchObject({
			id: 'com.maestro.usage-stats',
			name: 'Usage & Stats',
			firstParty: true,
			category: 'insights',
			settingsNamespace: 'usageStats',
			encoreFlag: 'usageStats',
		});
		expect(FIRST_PARTY_PLUGINS.usageStats).toBe(USAGE_STATS_FIRST_PARTY_PLUGIN);
	});

	it('requests only valid broker capabilities the feature actually touches', () => {
		const parsed = parsePermissions(USAGE_STATS_FIRST_PARTY_PLUGIN.permissions);
		expect(parsed.errors).toEqual([]);
		expect(parsed.requests.map((p) => [p.capability, p.scope ?? null])).toEqual([
			['settings:read', null],
			['sessions:read', null],
			['agents:read', null],
			// WakaTime CLI auto-install: release lookup on github.com, asset
			// download redirected to the githubusercontent.com CDN.
			['net:fetch', 'github.com'],
			['net:fetch', 'githubusercontent.com'],
			// Cue telemetry batches (dual-gated on usageStats AND maestroCue).
			['net:fetch', 'runmaestro.ai'],
			['background:service', null],
		]);
		expect(parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)).toBe(
			true
		);
	});

	it('never claims host-owned surfaces as broker capabilities', () => {
		const caps = USAGE_STATS_FIRST_PARTY_PLUGIN.permissions.map((p) => p.capability);
		// The stats DB is HOST-OWNED SQLite, not the plugin's own brokered
		// store - claiming storage:* would be dishonest (see first-party.ts NOTE).
		expect(caps).not.toContain('storage:sql');
		expect(caps).not.toContain('storage:read');
		expect(caps).not.toContain('storage:write');
		// The feature never reads the history store; it records into its own DB.
		expect(caps).not.toContain('history:read');
		// Sampler/WakaTime spawns are host-owned; act verbs never ride the
		// bundled first-party mint.
		expect(caps).not.toContain('process:spawn');
		expect(caps).not.toContain('agents:dispatch');
		// CSV export goes through the user-driven OS save dialog only.
		expect(caps).not.toContain('fs:write');
	});

	it('registers the stats.sampler supervised background service', () => {
		expect(USAGE_STATS_FIRST_PARTY_PLUGIN.backgroundServices).toEqual([
			{
				id: 'stats.sampler',
				kind: 'supervised',
				description: expect.stringContaining('sampling loop'),
			},
		]);
		// The service declaration is backed by the matching broker capability.
		expect(USAGE_STATS_FIRST_PARTY_PLUGIN.permissions.map((p) => p.capability)).toContain(
			'background:service'
		);
	});

	it('scoped net:fetch grants minted from the declaration satisfy it (bridge round-trip)', () => {
		// The bridge minter turns requests into grants verbatim; a scoped
		// request must be satisfied by its own scoped grant, or enable()
		// would fail closed forever.
		const grants = grantsFromRequests([...USAGE_STATS_FIRST_PARTY_PLUGIN.permissions], 1000);
		expect(hasRequiredFirstPartyGrants(USAGE_STATS_FIRST_PARTY_PLUGIN, grants)).toBe(true);
		// And the scoped grants stay scoped: a foreign host is NOT permitted.
		expect(isPermitted(grants, 'net:fetch', 'api.github.com')).toBe(true); // subdomain of github.com
		expect(isPermitted(grants, 'net:fetch', 'evil.example.com')).toBe(false);
	});
});
