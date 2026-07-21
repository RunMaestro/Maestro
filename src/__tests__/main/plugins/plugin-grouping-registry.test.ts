import { describe, expect, it, vi } from 'vitest';
import {
	MAX_GROUPING_PAYLOAD_BYTES,
	PluginGroupingRegistry,
	validatePublishedGrouping,
} from '../../../main/plugins/plugin-grouping-registry';
import { serializedJsonByteLength } from '../../../shared/plugins/contributions';

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

function payloadAtByteLength(byteLength: number): Record<string, unknown> {
	const base = payload({ groups: [], assignments: { 'session-1': '' } });
	const baseBytes = serializedJsonByteLength(base);
	if (baseBytes === null) throw new Error('test payload must be serializable');
	return payload({
		groups: [],
		assignments: { 'session-1': 'x'.repeat(byteLength - baseBytes) },
	});
}

describe('validatePublishedGrouping', () => {
	it('measures multibyte payloads by their serialized UTF-8 byte length', () => {
		const input = payload({
			groups: [],
			assignments: { 'session-1': '😀'.repeat(Math.ceil(MAX_GROUPING_PAYLOAD_BYTES / 4)) },
		});

		expect(serializedJsonByteLength(input)).toBeGreaterThan(MAX_GROUPING_PAYLOAD_BYTES);
		expect(() => validatePublishedGrouping('com.acme', 'by-agent-type', input)).toThrow(
			'grouping payload exceeds size cap'
		);
	});

	it('accepts a payload at the exact serialized byte limit', () => {
		const input = payloadAtByteLength(MAX_GROUPING_PAYLOAD_BYTES);

		expect(serializedJsonByteLength(input)).toBe(MAX_GROUPING_PAYLOAD_BYTES);
		expect(validatePublishedGrouping('com.acme', 'by-agent-type', input)).toMatchObject({
			id: 'com.acme/by-agent-type',
		});
	});

	it('preserves the grouping-specific error for unserializable payloads', () => {
		const input = payload();
		(input.assignments as Record<string, unknown>).loop = input;

		expect(() => validatePublishedGrouping('com.acme', 'by-agent-type', input)).toThrow(
			'grouping payload must be JSON serializable'
		);
	});

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
