import { describe, it, expect } from 'vitest';
import {
	validatePluginManifest,
	isManifestHostCompatible,
	PLUGIN_ID_PATTERN,
} from '../../../shared/plugins/plugin-manifest';

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'com.acme.hello',
		name: 'Hello',
		version: '1.0.0',
		tier: 0,
		maestro: { minHostApi: '1.0.0' },
		...overrides,
	};
}

function workspaceContributes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		workspaces: [
			{
				localId: 'omp-workspace',
				title: 'OMP',
				icon: 'sparkles',
				interactivePanelLocalId: 'omp-panel',
			},
		],
		interactivePanels: [
			{
				localId: 'omp-panel',
				title: 'OMP panel',
				entry: 'dist/panel.html',
				workspaceLocalId: 'omp-workspace',
			},
		],
		...overrides,
	};
}

describe('validatePluginManifest', () => {
	it('accepts a well-formed manifest and trims strings', () => {
		const { manifest, errors } = validatePluginManifest(validManifest({ name: '  Hello  ' }));
		expect(errors).toEqual([]);
		expect(manifest).not.toBeNull();
		expect(manifest?.id).toBe('com.acme.hello');
		expect(manifest?.name).toBe('Hello');
		expect(manifest?.tier).toBe(0);
		expect(manifest?.maestro.minHostApi).toBe('1.0.0');
	});

	it('rejects non-object input', () => {
		expect(validatePluginManifest(null).manifest).toBeNull();
		expect(validatePluginManifest('x').manifest).toBeNull();
		expect(validatePluginManifest([]).manifest).toBeNull();
	});

	it('requires id, name, version, tier, and maestro block', () => {
		const { manifest, errors } = validatePluginManifest({});
		expect(manifest).toBeNull();
		expect(errors.some((e) => e.includes('id'))).toBe(true);
		expect(errors.some((e) => e.includes('name'))).toBe(true);
		expect(errors.some((e) => e.includes('version'))).toBe(true);
		expect(errors.some((e) => e.includes('tier'))).toBe(true);
		expect(errors.some((e) => e.includes('maestro'))).toBe(true);
	});

	it('rejects an invalid id shape', () => {
		expect(validatePluginManifest(validManifest({ id: 'Bad Id!' })).manifest).toBeNull();
		expect(validatePluginManifest(validManifest({ id: '9starts-with-digit' })).manifest).toBeNull();
		expect(validatePluginManifest(validManifest({ id: '../escape' })).manifest).toBeNull();
	});

	it('rejects an invalid version and minHostApi', () => {
		expect(validatePluginManifest(validManifest({ version: 'v1' })).manifest).toBeNull();
		expect(
			validatePluginManifest(validManifest({ maestro: { minHostApi: 'latest' } })).manifest
		).toBeNull();
	});

	it('rejects an out-of-range tier', () => {
		expect(validatePluginManifest(validManifest({ tier: 3 })).manifest).toBeNull();
		expect(validatePluginManifest(validManifest({ tier: '0' })).manifest).toBeNull();
	});

	it('preserves contributes verbatim when present and an object', () => {
		const contributes = { themes: [{ id: 'midnight' }], unknownFuture: [1, 2] };
		const { manifest } = validatePluginManifest(validManifest({ contributes }));
		expect(manifest?.contributes).toEqual(contributes);
	});

	it('rejects a non-object contributes', () => {
		expect(validatePluginManifest(validManifest({ contributes: [] })).manifest).toBeNull();
	});

	it('keeps optional metadata only when a non-empty string', () => {
		const { manifest } = validatePluginManifest(
			validManifest({ description: 'desc', author: '', homepage: 'https://x' })
		);
		expect(manifest?.description).toBe('desc');
		expect(manifest?.author).toBeUndefined();
		expect(manifest?.homepage).toBe('https://x');
	});

	it('accepts a known category, omits it when absent, and rejects an unknown one', () => {
		const withCategory = validatePluginManifest(validManifest({ category: 'devtools' }));
		expect(withCategory.errors).toEqual([]);
		expect(withCategory.manifest?.category).toBe('devtools');

		const withoutCategory = validatePluginManifest(validManifest());
		expect(withoutCategory.manifest?.category).toBeUndefined();

		const badCategory = validatePluginManifest(validManifest({ category: 'nope' }));
		expect(badCategory.manifest).toBeNull();
		expect(badCategory.errors.some((e) => e.includes('category'))).toBe(true);
	});

	it('does not treat host incompatibility as a validation error', () => {
		const { manifest, errors } = validatePluginManifest(
			validManifest({ maestro: { minHostApi: '2.0.0' } })
		);
		expect(errors).toEqual([]);
		expect(manifest).not.toBeNull();
		expect(isManifestHostCompatible(manifest!, '1.0.0')).toBe(false);
	});
	it('validates a paired workspace and closed interactive panel into canonical owner-bound records', () => {
		const result = validatePluginManifest(
			validManifest({
				id: 'com.maestro.omp',
				tier: 2,
				entry: 'dist/worker.js',
				permissions: [{ capability: 'ui:workspace' }, { capability: 'ui:interactivePanel' }],
				contributes: workspaceContributes(),
			})
		);

		expect(result.errors).toEqual([]);
		expect(result.manifest?.workspaceFoundation).toEqual({
			ownerPluginId: 'com.maestro.omp',
			workspace: {
				localId: 'omp-workspace',
				canonicalContributionId: 'com.maestro.omp/omp-workspace',
				title: 'OMP',
				icon: 'sparkles',
				panelLocalId: 'omp-panel',
				order: 0,
			},
			panel: {
				localId: 'omp-panel',
				canonicalContributionId: 'com.maestro.omp/omp-panel',
				title: 'OMP panel',
				entry: 'dist/panel.html',
			},
		});
	});

	it('rejects workspace declarations missing either paired capability, a paired contribution, or a bounded field', () => {
		const base = {
			id: 'com.maestro.omp',
			tier: 2,
			entry: 'dist/worker.js',
			permissions: [{ capability: 'ui:workspace' }, { capability: 'ui:interactivePanel' }],
		};
		const missingPanelPermission = validatePluginManifest({
			...validManifest(base),
			permissions: [{ capability: 'ui:workspace' }],
			contributes: workspaceContributes(),
		});
		const orphanWorkspace = validatePluginManifest({
			...validManifest(base),
			contributes: workspaceContributes({ interactivePanels: [] }),
		});
		const overlongTitle = validatePluginManifest({
			...validManifest(base),
			contributes: workspaceContributes({
				workspaces: [
					{
						localId: 'omp-workspace',
						title: 'x'.repeat(161),
						icon: 'sparkles',
						interactivePanelLocalId: 'omp-panel',
					},
				],
			}),
		});

		expect(missingPanelPermission.manifest).toBeNull();
		expect(missingPanelPermission.errors.join(' ')).toContain('ui:interactivePanel');
		expect(orphanWorkspace.manifest).toBeNull();
		expect(orphanWorkspace.errors.join(' ')).toContain(
			'interactivePanels must contain exactly one item'
		);
		expect(overlongTitle.manifest).toBeNull();
		expect(overlongTitle.errors.join(' ')).toContain('at most 160 Unicode scalars');
	});

	it('rejects process:interactive unless its manifest permission is scoped exactly to omp', () => {
		const base = {
			tier: 2,
			entry: 'dist/worker.js',
			permissions: [{ capability: 'process:interactive', scope: 'omp' }],
		};
		expect(validatePluginManifest(validManifest(base)).errors).toEqual([]);
		const invalid = validatePluginManifest(
			validManifest({
				...base,
				permissions: [{ capability: 'process:interactive', scope: 'other' }],
			})
		);
		expect(invalid.manifest).toBeNull();
		expect(invalid.errors.join(' ')).toContain('scope exactly "omp"');
	});

	it('preserves legacy panels that do not opt into the closed workspace contract', () => {
		const result = validatePluginManifest(
			validManifest({
				tier: 1,
				entry: 'dist/worker.js',
				contributes: { panels: [{ id: 'legacy-panel', title: 'Legacy', entry: 'panel.html' }] },
			})
		);

		expect(result.errors).toEqual([]);
		expect(result.manifest?.contributes).toEqual({
			panels: [{ id: 'legacy-panel', title: 'Legacy', entry: 'panel.html' }],
		});
		expect(result.manifest?.workspaceFoundation).toBeUndefined();
	});
});

describe('PLUGIN_ID_PATTERN', () => {
	it('accepts reverse-DNS and kebab ids', () => {
		expect(PLUGIN_ID_PATTERN.test('com.acme.tool')).toBe(true);
		expect(PLUGIN_ID_PATTERN.test('my-plugin')).toBe(true);
		expect(PLUGIN_ID_PATTERN.test('a1.b2-c3_d4')).toBe(true);
	});
	it('rejects spaces, uppercase, leading digit, and traversal', () => {
		expect(PLUGIN_ID_PATTERN.test('Has Space')).toBe(false);
		expect(PLUGIN_ID_PATTERN.test('UPPER')).toBe(false);
		expect(PLUGIN_ID_PATTERN.test('1abc')).toBe(false);
		expect(PLUGIN_ID_PATTERN.test('..')).toBe(false);
	});
});
