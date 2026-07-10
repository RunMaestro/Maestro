import { describe, expect, it, vi } from 'vitest';
import {
	PluginGroupingRegistry,
	validatePublishedGrouping,
} from '../../../main/plugins/plugin-grouping-registry';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'by-agent-type',
		groups: [
			{ id: 'agents', label: 'Agents' },
			{ id: 'claude', label: 'Claude', parentId: 'agents' },
		],
		assignments: { 'session-1': 'claude', unknown: 'claude' },
		...overrides,
	};
}

describe('validatePublishedGrouping', () => {
	it('preserves a fake session id in snapshot readback without checking host sessions', () => {
		const registry = new PluginGroupingRegistry();
		registry.publish(
			validatePublishedGrouping(
				'com.acme',
				'by-agent-type',
				payload({ assignments: { 'fake-session-id': 'claude' } })
			)
		);

		expect(registry.snapshot()).toEqual([
			expect.objectContaining({
				assignments: { 'fake-session-id': 'claude' },
			}),
		]);
	});

	it('rejects nested schema extras, cycles, and hierarchies deeper than two levels', () => {
		expect(() =>
			validatePublishedGrouping(
				'com.acme',
				'by-agent-type',
				payload({ groups: [{ id: 'root', label: 'Root', unexpected: true }] })
			)
		).toThrow(/invalid group/);
		expect(() =>
			validatePublishedGrouping(
				'com.acme',
				'by-agent-type',
				payload({
					groups: [
						{ id: 'a', label: 'A', parentId: 'b' },
						{ id: 'b', label: 'B', parentId: 'a' },
					],
				})
			)
		).toThrow(/cycle/);
		expect(() =>
			validatePublishedGrouping(
				'com.acme',
				'by-agent-type',
				payload({
					groups: [
						{ id: 'root', label: 'Root' },
						{ id: 'child', label: 'Child', parentId: 'root' },
						{ id: 'grandchild', label: 'Grandchild', parentId: 'child' },
					],
				})
			)
		).toThrow(/depth/);
	});
});

describe('PluginGroupingRegistry', () => {
	it('purges every snapshot for a stopped or disabled plugin and never leaks mutable state', () => {
		const onChanged = vi.fn();
		const registry = new PluginGroupingRegistry(onChanged);
		registry.publish(validatePublishedGrouping('com.acme', 'by-agent-type', payload()));
		registry.publish(
			validatePublishedGrouping('com.other', 'by-agent-type', payload({ id: 'by-agent-type' }))
		);

		const snapshot = registry.snapshot();
		snapshot[0].assignments['session-2'] = 'claude';
		expect(registry.snapshot()[0].assignments).not.toHaveProperty('session-2');

		registry.removePlugin('com.acme');
		expect(registry.snapshot()).toHaveLength(1);
		expect(registry.snapshot()[0].pluginId).toBe('com.other');
		expect(onChanged).toHaveBeenCalledTimes(3);
	});

	it('clears all snapshots when the plugins feature is switched off', () => {
		const registry = new PluginGroupingRegistry();
		registry.publish(validatePublishedGrouping('com.acme', 'by-agent-type', payload()));

		registry.clearAll();

		expect(registry.snapshot()).toEqual([]);
	});
});
