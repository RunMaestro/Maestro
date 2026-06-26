import { describe, it, expect } from 'vitest';
import {
	collectContributions,
	aggregateContributions,
} from '../../../shared/plugins/contributions';
import type { PluginManifest } from '../../../shared/plugins/plugin-manifest';

function manifest(id: string, contributes: Record<string, unknown> | undefined): PluginManifest {
	return {
		id,
		name: id,
		version: '1.0.0',
		tier: 0,
		maestro: { minHostApi: '1.0.0' },
		...(contributes ? { contributes } : {}),
	};
}

describe('collectContributions', () => {
	it('returns empty buckets when there is no contributes block', () => {
		const c = collectContributions(manifest('com.a', undefined));
		expect(c.themes).toEqual([]);
		expect(c.prompts).toEqual([]);
		expect(c.settings).toEqual([]);
		expect(c.commandMacros).toEqual([]);
		expect(c.errors).toEqual([]);
	});

	it('namespaces ids by plugin id', () => {
		const c = collectContributions(
			manifest('com.acme', {
				themes: [{ id: 'midnight', name: 'Midnight', mode: 'dark', colors: { bg: '#000' } }],
			})
		);
		expect(c.themes[0].id).toBe('com.acme/midnight');
		expect(c.themes[0].localId).toBe('midnight');
		expect(c.themes[0].pluginId).toBe('com.acme');
	});

	it('validates each contribution type and drops bad ones with an error', () => {
		const c = collectContributions(
			manifest('com.acme', {
				themes: [
					{ id: 'good', name: 'Good', mode: 'dark', colors: { bg: '#000' } },
					{ id: 'nomode', name: 'Bad', colors: { bg: '#000' } },
				],
				prompts: [
					{ id: 'p1', title: 'P1', content: 'hi' },
					{ id: 'p2', title: 'no content' },
				],
				settings: [
					{ id: 's1', key: 'k', type: 'boolean', default: true },
					{ id: 's2', key: 'k2', type: 'number', default: 'x' },
				],
				commandMacros: [
					{ id: 'm1', title: 'M1', prompt: 'do it' },
					{ id: 'm2', title: 'M2' },
				],
			})
		);
		expect(c.themes.map((t) => t.localId)).toEqual(['good']);
		expect(c.prompts.map((p) => p.localId)).toEqual(['p1']);
		expect(c.settings.map((s) => s.localId)).toEqual(['s1']);
		expect(c.commandMacros.map((m) => m.localId)).toEqual(['m1']);
		expect(c.errors.length).toBe(4);
	});

	it('rejects an invalid local id', () => {
		const c = collectContributions(
			manifest('com.acme', {
				prompts: [{ id: 'Bad Id', title: 'x', content: 'y' }],
			})
		);
		expect(c.prompts).toEqual([]);
		expect(c.errors[0]).toMatch(/not a valid id/);
	});

	it('keeps only string colors and rejects an empty color map', () => {
		const c = collectContributions(
			manifest('com.acme', {
				themes: [
					{ id: 't1', name: 'T1', mode: 'light', colors: { bg: '#fff', n: 5 } },
					{ id: 't2', name: 'T2', mode: 'light', colors: { n: 5 } },
				],
			})
		);
		expect(c.themes[0].colors).toEqual({ bg: '#fff' });
		expect(c.themes.map((t) => t.localId)).toEqual(['t1']);
	});
});

describe('aggregateContributions', () => {
	it('merges across plugins and collects per-plugin errors', () => {
		const agg = aggregateContributions([
			manifest('com.a', {
				themes: [{ id: 'x', name: 'X', mode: 'dark', colors: { bg: '#000' } }],
			}),
			manifest('com.b', {
				prompts: [
					{ id: 'p', title: 'P', content: 'c' },
					{ id: 'bad', title: 'no content' },
				],
			}),
		]);
		expect(agg.themes).toHaveLength(1);
		expect(agg.prompts).toHaveLength(1);
		expect(agg.errorsByPlugin['com.b']).toBeDefined();
		expect(agg.errorsByPlugin['com.a']).toBeUndefined();
	});

	it('does not collide same-localId contributions from different plugins', () => {
		const agg = aggregateContributions([
			manifest('com.a', {
				themes: [{ id: 'midnight', name: 'A', mode: 'dark', colors: { bg: '#000' } }],
			}),
			manifest('com.b', {
				themes: [{ id: 'midnight', name: 'B', mode: 'dark', colors: { bg: '#111' } }],
			}),
		]);
		expect(agg.themes.map((t) => t.id).sort()).toEqual(['com.a/midnight', 'com.b/midnight']);
	});
});
