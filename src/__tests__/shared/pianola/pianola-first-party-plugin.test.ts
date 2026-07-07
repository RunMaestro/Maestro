import { describe, it, expect } from 'vitest';
import { parsePermissions } from '../../../shared/plugins/permissions';
import {
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	FIRST_PARTY_PLUGINS,
	PIANOLA_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../shared/plugins/first-party';

describe('Pianola first-party plugin definition', () => {
	it('declares Pianola as a first-party plugin-backed agents extension', () => {
		expect(PIANOLA_FIRST_PARTY_PLUGIN_ID).toBe('com.maestro.pianola');
		expect(PIANOLA_FIRST_PARTY_PLUGIN).toMatchObject({
			id: PIANOLA_FIRST_PARTY_PLUGIN_ID,
			name: 'Pianola',
			firstParty: true,
			category: 'agents',
			settingsNamespace: 'pianola',
			encoreFlag: 'pianola',
			backgroundServices: [{ id: 'pianola.supervisor', kind: 'supervised' }],
		});
		expect(FIRST_PARTY_PLUGINS.pianola).toBe(PIANOLA_FIRST_PARTY_PLUGIN);
	});

	it('requests only valid broker capabilities used by the supervised Pianola flow', () => {
		const parsed = parsePermissions(PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS);
		expect(parsed.errors).toEqual([]);
		// `agents:dispatch` is deliberately NOT declared: FC2 promoted it to an
		// allowlist scope naming exact targets, which a static manifest cannot
		// name for Pianola's dynamically-discovered sessions. Pianola dispatch
		// stays host-owned until the plugin lift designs a runtime grant seam
		// (see first-party.ts NOTE).
		expect(parsed.requests.map((p) => p.capability)).toEqual([
			'settings:read',
			'agents:read',
			'transcripts:read',
			'decisions:write',
			'notifications:toast',
			'background:service',
		]);
		expect(parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)).toBe(
			true
		);
	});
});

describe('first-party plugin registry', () => {
	it('registers every Encore feature under its plan-stable plugin id', () => {
		expect(FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => [def.encoreFlag, def.id])).toEqual([
			['usageStats', 'com.maestro.usage-stats'],
			['symphony', 'com.maestro.symphony'],
			['maestroCue', 'com.maestro.cue'],
			['directorNotes', 'com.maestro.director-notes'],
			['pianola', 'com.maestro.pianola'],
			['coworking', 'com.maestro.coworking'],
			['opencodeServer', 'com.maestro.opencode-server'],
		]);
	});

	it('keys the registry by Encore flag with no id or namespace collisions', () => {
		for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
			expect(FIRST_PARTY_PLUGINS[def.encoreFlag]).toBe(def);
		}
		const ids = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.id);
		expect(new Set(ids).size).toBe(ids.length);
		const namespaces = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.settingsNamespace);
		expect(new Set(namespaces).size).toBe(namespaces.length);
	});

	it('every definition declares first-party, valid permissions, and supervised-only services', () => {
		for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
			expect(def.firstParty).toBe(true);
			const parsed = parsePermissions(def.permissions);
			expect(parsed.errors).toEqual([]);
			expect(parsed.requests.length).toBeGreaterThan(0);
			// Every feature at least discloses reading its own Encore flag.
			expect(parsed.requests.map((p) => p.capability)).toContain('settings:read');
			// `agents:dispatch` can NEVER appear in static first-party metadata
			// (FC2 allowlist scopes require exact targets; see the Pianola NOTE).
			expect(parsed.requests.map((p) => p.capability)).not.toContain('agents:dispatch');
			for (const service of def.backgroundServices) {
				expect(service.kind).toBe('supervised');
				expect(service.id.length).toBeGreaterThan(0);
			}
		}
	});
});
