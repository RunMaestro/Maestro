import { describe, it, expect } from 'vitest';
import { groupByPlugin, mergePluginContributions } from '../pluginContributionMerge';

interface Item {
	id: string;
	pluginId: string;
}

describe('groupByPlugin', () => {
	it('buckets flat items by plugin, preserving first-seen plugin order', () => {
		const entries = groupByPlugin<Item>([
			{ id: 'a', pluginId: 'p1' },
			{ id: 'b', pluginId: 'p2' },
			{ id: 'c', pluginId: 'p1' },
		]);
		expect(entries.map((e) => e.pluginId)).toEqual(['p1', 'p2']);
		expect(entries[0].items.map((i) => i.id)).toEqual(['a', 'c']);
		expect(entries[1].items.map((i) => i.id)).toEqual(['b']);
	});

	it('returns no entries for an empty input', () => {
		expect(groupByPlugin<Item>([])).toEqual([]);
	});
});

describe('mergePluginContributions', () => {
	it('lets a built-in win a colliding id and drops the plugin entry with an error', () => {
		const result = mergePluginContributions<{ id: string }>(
			[{ id: 'themes' }],
			[{ id: 'themes', pluginId: 'acme' }]
		);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].provenance).toEqual({ source: 'builtin' });
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('collides with a built-in');
	});

	it('keeps the earlier plugin and drops a later duplicate id', () => {
		const result = mergePluginContributions<{ id: string }>(
			[],
			[
				{ id: 'dup', pluginId: 'first' },
				{ id: 'dup', pluginId: 'second' },
			]
		);
		expect(result.items).toHaveLength(1);
		expect(result.items[0].provenance).toEqual({ source: 'plugin', pluginId: 'first' });
		expect(result.errors[0]).toContain('duplicates another contribution');
	});

	it('retains provenance and orders built-ins before surviving plugin entries', () => {
		const result = mergePluginContributions<{ id: string }>(
			[{ id: 'b1' }],
			[
				{ id: 'p1', pluginId: 'acme' },
				{ id: 'p2', pluginId: 'beta' },
			]
		);
		expect(result.items.map((r) => r.item.id)).toEqual(['b1', 'p1', 'p2']);
		expect(result.items.map((r) => r.provenance.source)).toEqual(['builtin', 'plugin', 'plugin']);
		expect(result.errors).toEqual([]);
	});
});
