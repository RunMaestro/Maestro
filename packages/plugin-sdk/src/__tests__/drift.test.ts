import { describe, it, expect } from 'vitest';

// Vendored copies that ship in this standalone package.
import {
	PLUGIN_CAPABILITIES,
	PLUGIN_TIERS,
	PLUGIN_EVENT_TOPICS,
	HOST_METHODS,
	HOST_API_VERSION,
	PLUGIN_ID_PATTERN,
	UI_SURFACES,
	capabilityRisk,
	describeCapability,
	validatePluginManifest,
} from '../index';

// The real host contracts (single source of truth). The relative depth from
// packages/plugin-sdk/src/__tests__/ to the worktree src/ is four levels up.
import {
	PLUGIN_CAPABILITIES as SRC_PLUGIN_CAPABILITIES,
	capabilityRisk as srcCapabilityRisk,
	describeCapability as srcDescribeCapability,
} from '../../../../src/shared/plugins/permissions';
import {
	PLUGIN_TIERS as SRC_PLUGIN_TIERS,
	PLUGIN_ID_PATTERN as SRC_PLUGIN_ID_PATTERN,
	validatePluginManifest as srcValidatePluginManifest,
} from '../../../../src/shared/plugins/plugin-manifest';
import { PLUGIN_EVENT_TOPICS as SRC_PLUGIN_EVENT_TOPICS } from '../../../../src/shared/plugins/events';
import { HOST_METHODS as SRC_HOST_METHODS } from '../../../../src/shared/plugins/rpc-protocol';
import { HOST_API_VERSION as SRC_HOST_API_VERSION } from '../../../../src/shared/plugins/host-api';
import { UI_SURFACES as SRC_UI_SURFACES } from '../../../../src/shared/plugins/contributions';

// This package VENDORS the frozen plugin contracts so it can publish standalone
// (no imports outside the package). That copy must never silently fall behind
// the host. This guard imports BOTH the vendored copies and the real sources and
// asserts parity; it fails the moment the host contract changes without this
// package being updated in lockstep.
describe('@maestro/plugin-sdk vendored-contract drift guard', () => {
	it('PLUGIN_CAPABILITIES matches the source vocabulary', () => {
		expect(PLUGIN_CAPABILITIES).toEqual(SRC_PLUGIN_CAPABILITIES);
	});

	it('PLUGIN_TIERS matches the source', () => {
		expect(PLUGIN_TIERS).toEqual(SRC_PLUGIN_TIERS);
	});

	it('PLUGIN_EVENT_TOPICS matches the source catalog', () => {
		expect(PLUGIN_EVENT_TOPICS).toEqual(SRC_PLUGIN_EVENT_TOPICS);
	});

	it('HOST_METHODS matches the source method set', () => {
		expect(HOST_METHODS).toEqual(SRC_HOST_METHODS);
	});

	it('HOST_API_VERSION matches the source and is pinned to 1.7.0', () => {
		expect(HOST_API_VERSION).toBe(SRC_HOST_API_VERSION);
		expect(HOST_API_VERSION).toBe('1.7.0');
	});

	it('capability risk and descriptions match the source', () => {
		for (const capability of PLUGIN_CAPABILITIES) {
			expect(capabilityRisk(capability)).toBe(srcCapabilityRisk(capability));
			expect(describeCapability(capability)).toBe(srcDescribeCapability(capability));
		}
	});

	it('UI_SURFACES matches the source render-surface catalog', () => {
		expect(UI_SURFACES).toEqual(SRC_UI_SURFACES);
	});

	it('PLUGIN_ID_PATTERN source string matches', () => {
		expect(PLUGIN_ID_PATTERN.source).toBe(SRC_PLUGIN_ID_PATTERN.source);
	});

	it('validatePluginManifest agrees with the source on a malformed manifest', () => {
		const malformed = { id: '1nope', name: '', tier: 7, maestro: {} };
		expect(validatePluginManifest(malformed)).toEqual(srcValidatePluginManifest(malformed));
	});

	it('validatePluginManifest agrees with the source on a well-formed manifest', () => {
		const wellFormed = {
			id: 'com.example.transcript-reader',
			name: 'Transcript Reader',
			version: '0.1.0',
			tier: 1,
			maestro: { minHostApi: HOST_API_VERSION },
			entry: 'dist/entry.js',
			permissions: [{ capability: 'transcripts:read', reason: 'Summarize the active session.' }],
		};
		expect(validatePluginManifest(wellFormed)).toEqual(srcValidatePluginManifest(wellFormed));
	});
});
