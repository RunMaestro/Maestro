import { describe, it, expect, expectTypeOf } from 'vitest';
import {
	defineManifest,
	definePlugin,
	validatePluginManifest,
	PLUGIN_CAPABILITIES,
	PLUGIN_ID_PATTERN,
	PLUGIN_TIERS,
	HOST_API_VERSION,
	type MaestroSdk,
	type PluginManifest,
	type PluginModule,
} from '../index';

describe('@maestro/plugin-sdk authoring surface', () => {
	// A well-formed tier-1 manifest authored through defineManifest. The id
	// matches PLUGIN_ID_PATTERN, the version is valid semver, and minHostApi is
	// pinned to the host contract this SDK build tracks.
	const sample: PluginManifest = defineManifest({
		id: 'com.example.transcript-reader',
		name: 'Transcript Reader',
		version: '0.1.0',
		tier: 1,
		maestro: { minHostApi: HOST_API_VERSION },
		entry: 'dist/entry.js',
		permissions: [{ capability: 'transcripts:read', reason: 'Summarize the active session.' }],
	});

	it('defineManifest is an identity that preserves the manifest', () => {
		expect(sample.id).toBe('com.example.transcript-reader');
		expect(PLUGIN_ID_PATTERN.test(sample.id)).toBe(true);
		expect(PLUGIN_TIERS).toContain(sample.tier);
	});

	it('validatePluginManifest accepts the well-formed tier-1 manifest', () => {
		const result = validatePluginManifest(sample);
		expect(result.errors).toEqual([]);
		expect(result.manifest).not.toBeNull();
		expect(result.manifest?.id).toBe(sample.id);
		expect(result.manifest?.tier).toBe(1);
		expect(result.manifest?.maestro.minHostApi).toBe(HOST_API_VERSION);
		expect(result.manifest?.permissions).toEqual([
			{ capability: 'transcripts:read', reason: 'Summarize the active session.' },
		]);
	});

	it('rejects a manifest whose id breaks PLUGIN_ID_PATTERN', () => {
		const bad = validatePluginManifest({ ...sample, id: '1nope' });
		expect(bad.manifest).toBeNull();
		expect(bad.errors.some((e) => e.includes('id'))).toBe(true);
	});

	it('exposes the transcripts:read capability in PLUGIN_CAPABILITIES', () => {
		expect(PLUGIN_CAPABILITIES).toContain('transcripts:read');
	});

	it('definePlugin is an identity over a PluginModule', () => {
		const calls: string[] = [];
		const mod: PluginModule = definePlugin({
			activate() {
				calls.push('activate');
			},
		});
		mod.activate?.(undefined as unknown as MaestroSdk);
		expect(calls).toEqual(['activate']);
		expect(mod.deactivate).toBeUndefined();
	});

	it('types transcripts.read on the MaestroSdk runtime surface', () => {
		expectTypeOf<MaestroSdk>().toHaveProperty('transcripts');
		expectTypeOf<MaestroSdk['transcripts']>().toHaveProperty('read');
		expectTypeOf<MaestroSdk['transcripts']['read']>().toBeFunction();
		expectTypeOf<MaestroSdk['transcripts']['read']>().parameter(0).toMatchObjectType<{
			sessionId: string;
			fields: string[];
			projectPath?: string;
			limit?: number;
			since?: number;
		}>();
		expectTypeOf<MaestroSdk['transcripts']['read']>().returns.resolves.toEqualTypeOf<
			Array<Record<string, unknown>>
		>();
	});
});
