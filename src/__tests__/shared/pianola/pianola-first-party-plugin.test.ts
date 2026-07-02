import { describe, it, expect } from 'vitest';
import { parsePermissions } from '../../../shared/plugins/permissions';
import {
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_METADATA,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../shared/pianola/first-party-plugin';

describe('Pianola first-party plugin metadata', () => {
	it('declares Pianola as a first-party plugin-backed agents extension', () => {
		expect(PIANOLA_FIRST_PARTY_PLUGIN_ID).toBe('com.maestro.pianola');
		expect(PIANOLA_FIRST_PARTY_PLUGIN_METADATA).toMatchObject({
			id: PIANOLA_FIRST_PARTY_PLUGIN_ID,
			name: 'Pianola',
			firstParty: true,
			category: 'agents',
			settings: { encoreFlag: 'pianola', namespace: 'pianola' },
			backgroundService: { id: 'pianola.supervisor', kind: 'supervised' },
		});
	});

	it('requests only valid broker capabilities used by the supervised Pianola flow', () => {
		const parsed = parsePermissions(PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS);
		expect(parsed.errors).toEqual([]);
		// `agents:dispatch` is deliberately NOT declared: FC2 promoted it to an
		// allowlist scope naming exact targets, which a static manifest cannot
		// name for Pianola's dynamically-discovered sessions. Pianola dispatch
		// stays host-owned until the plugin lift designs a runtime grant seam
		// (see first-party-plugin.ts NOTE).
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
