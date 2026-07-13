import { describe, it, expect } from 'vitest';

// Vendored copies that ship in this standalone package.
import {
	PLUGIN_CAPABILITIES,
	PLUGIN_TIERS,
	PLUGIN_CATEGORIES,
	PLUGIN_EVENT_TOPICS,
	HOST_METHODS,
	HOST_API,
	HOST_METHOD_CAPABILITY,
	HOST_API_VERSION,
	PLUGIN_ID_PATTERN,
	UI_SURFACES,
	HOST_VIEW_SURFACES,
	MAX_HOST_VIEW_BLOCKS_BYTES,
	serializedJsonByteLength,
	capabilityRisk,
	isHostViewBlocks,
	describeCapability,
	isPluginCategory,
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
	PLUGIN_CATEGORIES as SRC_PLUGIN_CATEGORIES,
	PLUGIN_ID_PATTERN as SRC_PLUGIN_ID_PATTERN,
	isPluginCategory as srcIsPluginCategory,
	validatePluginManifest as srcValidatePluginManifest,
} from '../../../../src/shared/plugins/plugin-manifest';
import { PLUGIN_EVENT_TOPICS as SRC_PLUGIN_EVENT_TOPICS } from '../../../../src/shared/plugins/events';
import {
	HOST_API as SRC_HOST_API,
	HOST_METHODS as SRC_HOST_METHODS,
	HOST_METHOD_CAPABILITY as SRC_HOST_METHOD_CAPABILITY,
} from '../../../../src/shared/plugins/rpc-protocol';
import { HOST_API_VERSION as SRC_HOST_API_VERSION } from '../../../../src/shared/plugins/host-api';
import {
	HOST_VIEW_SURFACES as SRC_HOST_VIEW_SURFACES,
	MAX_HOST_VIEW_BLOCKS_BYTES as SRC_MAX_HOST_VIEW_BLOCKS_BYTES,
	serializedJsonByteLength as srcSerializedJsonByteLength,
	UI_SURFACES as SRC_UI_SURFACES,
	isHostViewBlocks as srcIsHostViewBlocks,
} from '../../../../src/shared/plugins/contributions';

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

	it('PLUGIN_CATEGORIES and category guard match the source', () => {
		expect(PLUGIN_CATEGORIES).toEqual(SRC_PLUGIN_CATEGORIES);
		for (const category of PLUGIN_CATEGORIES) {
			expect(isPluginCategory(category)).toBe(srcIsPluginCategory(category));
		}
		expect(isPluginCategory('not-a-category')).toBe(srcIsPluginCategory('not-a-category'));
	});

	it('PLUGIN_EVENT_TOPICS matches the source catalog', () => {
		expect(PLUGIN_EVENT_TOPICS).toEqual(SRC_PLUGIN_EVENT_TOPICS);
	});

	it('HOST_METHODS matches the source method set', () => {
		expect(HOST_METHODS).toEqual(SRC_HOST_METHODS);
	});

	it('HOST_API and HOST_METHOD_CAPABILITY match the source capability table', () => {
		expect(HOST_API).toEqual(SRC_HOST_API);
		expect(HOST_METHOD_CAPABILITY).toEqual(SRC_HOST_METHOD_CAPABILITY);
	});

	it('HOST_API_VERSION matches the source and is pinned to 1.12.0', () => {
		expect(HOST_API_VERSION).toBe(SRC_HOST_API_VERSION);
		expect(HOST_API_VERSION).toBe('1.12.0');
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

	it('host view surfaces and serialized-block cap match the source', () => {
		expect(HOST_VIEW_SURFACES).toEqual(SRC_HOST_VIEW_SURFACES);
		expect(MAX_HOST_VIEW_BLOCKS_BYTES).toBe(SRC_MAX_HOST_VIEW_BLOCKS_BYTES);
	});

	it('serialized JSON byte measurement matches the source contract', () => {
		for (const value of [[], { blocks: [{ kind: 'text', content: '🪄' }] }]) {
			expect(serializedJsonByteLength(value)).toBe(srcSerializedJsonByteLength(value));
		}
	});

	it('host view block-shape validation matches the source contract', () => {
		for (const value of [
			[],
			{ blocks: [] },
			{ blocks: [], extra: true },
			{ viewType: 'decision', blocks: [] },
		]) {
			expect(isHostViewBlocks(value)).toBe(srcIsHostViewBlocks(value));
		}
	});

	it('PLUGIN_ID_PATTERN source string matches', () => {
		expect(PLUGIN_ID_PATTERN.source).toBe(SRC_PLUGIN_ID_PATTERN.source);
	});

	it('validatePluginManifest agrees with the source on a malformed manifest', () => {
		const malformed = { id: '1nope', name: '', tier: 7, maestro: {} };
		expect(validatePluginManifest(malformed)).toEqual(srcValidatePluginManifest(malformed));
	});

	it('validatePluginManifest agrees with the source on a well-formed manifest with category', () => {
		const wellFormed = {
			id: 'com.example.transcript-reader',
			name: 'Transcript Reader',
			version: '0.1.0',
			tier: 1,
			maestro: { minHostApi: HOST_API_VERSION },
			entry: 'dist/entry.js',
			category: 'agents',
			permissions: [{ capability: 'transcripts:read', reason: 'Summarize the active session.' }],
		};

		expect(validatePluginManifest(wellFormed)).toEqual(srcValidatePluginManifest(wellFormed));
		expect(validatePluginManifest(wellFormed).manifest?.category).toBe('agents');
	});

	it('validatePluginManifest agrees with the source on an invalid category', () => {
		const invalidCategory = {
			id: 'com.example.transcript-reader',
			name: 'Transcript Reader',
			version: '0.1.0',
			tier: 1,
			maestro: { minHostApi: HOST_API_VERSION },
			entry: 'dist/entry.js',
			category: 'not-a-category',
			permissions: [{ capability: 'transcripts:read', reason: 'Summarize the active session.' }],
		};

		expect(validatePluginManifest(invalidCategory)).toEqual(
			srcValidatePluginManifest(invalidCategory)
		);
	});

	it('validatePluginManifest agrees with the source on allowlist-scoped act verbs (Phase-4 promotion)', () => {
		const base = {
			id: 'com.example.act-plugin',
			name: 'Act Plugin',
			version: '0.1.0',
			tier: 1,
			maestro: { minHostApi: HOST_API_VERSION },
			entry: 'dist/entry.js',
		};
		// Well-formed: both act verbs carry an exact-member allowlist scope.
		const scoped = {
			...base,
			permissions: [
				{ capability: 'agents:dispatch', scope: 'agent-a,agent-b' },
				{ capability: 'process:spawn', scope: 'echo-tool' },
			],
		};
		expect(validatePluginManifest(scoped)).toEqual(srcValidatePluginManifest(scoped));
		expect(validatePluginManifest(scoped).manifest?.permissions).toHaveLength(2);

		// An UNSCOPED act-verb request is a wildcard: both copies must reject it.
		const unscoped = { ...base, permissions: [{ capability: 'agents:dispatch' }] };
		expect(validatePluginManifest(unscoped)).toEqual(srcValidatePluginManifest(unscoped));
		expect(validatePluginManifest(unscoped).manifest).toBeNull();

		// A pattern-shaped member must also be rejected identically.
		const wildcard = { ...base, permissions: [{ capability: 'process:spawn', scope: '*' }] };
		expect(validatePluginManifest(wildcard)).toEqual(srcValidatePluginManifest(wildcard));
		expect(validatePluginManifest(wildcard).manifest).toBeNull();
	});
});
