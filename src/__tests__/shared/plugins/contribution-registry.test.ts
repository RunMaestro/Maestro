/**
 * @file contribution-registry.test.ts
 * @description The shared merge contract every plugin-extensible surface uses:
 * built-in-always-wins, earlier-plugin-wins, dropped-with-error, provenance.
 */

import { describe, it, expect } from 'vitest';
import {
	mergeContributions,
	type RegistryEntry,
} from '../../../shared/plugins/contribution-registry';

interface Item extends RegistryEntry {
	label: string;
}
const mk = (id: string, label = id): Item => ({ id, label });

describe('mergeContributions', () => {
	it('keeps built-ins, appends plugin entries, and tags provenance', () => {
		const r = mergeContributions([mk('builtin.a')], [{ pluginId: 'p1', items: [mk('p1/x')] }]);
		expect(r.errors).toEqual([]);
		expect(r.items.map((i) => i.item.id)).toEqual(['builtin.a', 'p1/x']);
		expect(r.items[0].provenance).toEqual({ source: 'builtin' });
		expect(r.items[1].provenance).toEqual({ source: 'plugin', pluginId: 'p1' });
	});

	it('built-in ALWAYS wins a collision; the plugin entry is dropped with an error', () => {
		const r = mergeContributions(
			[mk('shared')],
			[{ pluginId: 'evil', items: [mk('shared', 'spoof')] }]
		);
		expect(r.items).toHaveLength(1);
		expect(r.items[0].provenance).toEqual({ source: 'builtin' });
		expect(r.items[0].item.label).toBe('shared');
		expect(r.errors[0]).toContain('collides with a built-in');
	});

	it('earlier plugin wins over a later duplicate id', () => {
		const r = mergeContributions(
			[],
			[
				{ pluginId: 'p1', items: [mk('p1/x')] },
				{ pluginId: 'p2', items: [mk('p1/x', 'dup')] },
			]
		);
		expect(r.items).toHaveLength(1);
		expect(r.items[0].provenance).toEqual({ source: 'plugin', pluginId: 'p1' });
		expect(r.errors[0]).toContain('duplicates another contribution');
	});

	it('returns surviving items in order with their provenance', () => {
		const result = mergeContributions([mk('a')], [{ pluginId: 'p', items: [mk('p/b')] }]);

		expect(result.items.map((entry) => entry.item.id)).toEqual(['a', 'p/b']);
		expect(result.items.map((entry) => entry.provenance)).toEqual([
			{ source: 'builtin' },
			{ source: 'plugin', pluginId: 'p' },
		]);
	});
});
