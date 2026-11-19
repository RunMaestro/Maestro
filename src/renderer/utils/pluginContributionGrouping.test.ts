// Source: src/renderer/utils/__tests__/pluginContributionMerge.test.ts
// Source: src/renderer/utils/pluginGroupings.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { groupByPlugin } from './pluginContributionMerge';
import { mergePluginContributions } from './pluginContributionMerge';
import { buildVirtualGrouping } from './pluginGroupings';
describe('pluginContributionMerge', () => {
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
});
describe('pluginGroupings', () => {
	describe('buildVirtualGrouping', () => {
		it('uses first matching rule and places unmatched sessions in Other without mutating session metadata', () => {
			const sessions = [
				{ id: 'a', name: 'API task', toolType: 'claude', cwd: 'C:/work/api' },
				{ id: 'b', name: 'Other', toolType: 'codex', cwd: 'C:/elsewhere' },
			];
			const model = buildVirtualGrouping(
				{
					id: 'com.test/by-type',
					pluginId: 'com.test',
					localId: 'by-type',
					label: 'By type',
					rules: [
						{ match: { toolType: 'claude' }, group: 'Claude' },
						{ match: { cwdGlob: 'C:/work/*', namePattern: 'API *' }, group: 'API' },
					],
				},
				sessions
			);
			expect(model.assignments).toEqual({
				a: 'virtual:com.test/by-type:Claude',
				b: 'virtual:com.test/by-type:Other',
			});
			expect(sessions[0]).toEqual({
				id: 'a',
				name: 'API task',
				toolType: 'claude',
				cwd: 'C:/work/api',
			});
		});

		it('places sessions omitted from a computed snapshot in Other', () => {
			const model = buildVirtualGrouping(
				{
					id: 'com.test/by-agent',
					pluginId: 'com.test',
					localId: 'by-agent',
					groups: [{ id: 'claude', label: 'Claude' }],
					assignments: { claude: 'claude' },
				},
				[
					{ id: 'claude', name: 'Claude task' },
					{ id: 'unassigned', name: 'Unassigned task' },
				]
			);

			expect(model.groups).toEqual([
				{ id: 'virtual:com.test/by-agent:claude', name: 'Claude' },
				{ id: 'virtual:com.test/by-agent:Other', name: 'Other' },
			]);
			expect(model.assignments).toEqual({
				claude: 'virtual:com.test/by-agent:claude',
				unassigned: 'virtual:com.test/by-agent:Other',
			});
		});
	});
});
