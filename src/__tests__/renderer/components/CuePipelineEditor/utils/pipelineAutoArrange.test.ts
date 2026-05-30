/**
 * Tests for the auto-arrange layout helpers.
 *
 * arrangePipelineNodes: flow-depth columns, current-order preservation, grid
 * fallback for edge-less pipelines.
 * arrangePipelineGroups: balanced grid packing of group cards via viewOffset,
 * preserving current reading order.
 */

import { describe, it, expect } from 'vitest';
import {
	arrangePipelineNodes,
	arrangePipelineGroups,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineAutoArrange';
import type { CuePipeline, PipelineNode } from '../../../../../shared/cue-pipeline-types';

function agentNode(id: string, x: number, y: number): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x, y },
		data: { sessionId: id, sessionName: id, toolType: 'claude-code' },
	};
}

function triggerNode(id: string, x: number, y: number): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x, y },
		data: { eventType: 'time.heartbeat', label: 'Timer', config: {} },
	};
}

function pipeline(overrides: Partial<CuePipeline> = {}): CuePipeline {
	return {
		id: 'p1',
		name: 'pipeline',
		color: '#06b6d4',
		nodes: [],
		edges: [],
		...overrides,
	};
}

describe('arrangePipelineNodes', () => {
	it('returns nodes unchanged when there is 0 or 1 node', () => {
		const empty = pipeline();
		expect(arrangePipelineNodes(empty)).toBe(empty.nodes);
		const single = pipeline({ nodes: [agentNode('a', 50, 50)] });
		expect(arrangePipelineNodes(single)).toBe(single.nodes);
	});

	it('lays a trigger→agent→agent chain out in left-to-right columns', () => {
		const p = pipeline({
			nodes: [triggerNode('t', 0, 0), agentNode('a1', 0, 0), agentNode('a2', 0, 0)],
			edges: [
				{ id: 'e1', source: 't', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});
		const arranged = arrangePipelineNodes(p);
		const byId = new Map(arranged.map((n) => [n.id, n.position]));
		// Three ranks ⇒ three distinct, strictly increasing x columns.
		expect(byId.get('t')!.x).toBeLessThan(byId.get('a1')!.x);
		expect(byId.get('a1')!.x).toBeLessThan(byId.get('a2')!.x);
	});

	it('places fan-out targets in the same column, ordered by current Y', () => {
		const p = pipeline({
			nodes: [
				triggerNode('t', 0, 0),
				agentNode('low', 0, 500), // currently lower on screen
				agentNode('high', 0, 100), // currently higher on screen
			],
			edges: [
				{ id: 'e1', source: 't', target: 'low', mode: 'pass' },
				{ id: 'e2', source: 't', target: 'high', mode: 'pass' },
			],
		});
		const arranged = arrangePipelineNodes(p);
		const byId = new Map(arranged.map((n) => [n.id, n.position]));
		// Both targets share rank 1 ⇒ same column.
		expect(byId.get('low')!.x).toBe(byId.get('high')!.x);
		// Current vertical order preserved: 'high' (y=100) stays above 'low' (y=500).
		expect(byId.get('high')!.y).toBeLessThan(byId.get('low')!.y);
	});

	it('grids edge-less nodes into multiple columns instead of one tall stack', () => {
		const nodes = Array.from({ length: 4 }, (_, i) => agentNode(`a${i}`, 0, i * 10));
		const arranged = arrangePipelineNodes(pipeline({ nodes }));
		const xs = new Set(arranged.map((n) => n.position.x));
		// 4 nodes ⇒ ceil(sqrt(4)) = 2 columns.
		expect(xs.size).toBeGreaterThan(1);
	});

	it('does not mutate the input nodes', () => {
		const p = pipeline({
			nodes: [triggerNode('t', 7, 7), agentNode('a', 7, 7)],
			edges: [{ id: 'e1', source: 't', target: 'a', mode: 'pass' }],
		});
		arrangePipelineNodes(p);
		expect(p.nodes[0].position).toEqual({ x: 7, y: 7 });
	});

	it('tolerates a cycle without throwing', () => {
		const p = pipeline({
			nodes: [agentNode('a', 0, 0), agentNode('b', 0, 0)],
			edges: [
				{ id: 'e1', source: 'a', target: 'b', mode: 'pass' },
				{ id: 'e2', source: 'b', target: 'a', mode: 'pass' },
			],
		});
		expect(() => arrangePipelineNodes(p)).not.toThrow();
	});
});

describe('arrangePipelineGroups', () => {
	function group(id: string, offsetY: number): CuePipeline {
		return pipeline({
			id,
			name: id,
			nodes: [triggerNode(`${id}-t`, 0, 0), agentNode(`${id}-a`, 300, 0)],
			viewOffset: { x: 0, y: offsetY },
		});
	}

	it('returns one viewOffset per non-empty pipeline', () => {
		const pipelines = [group('p1', 0), group('p2', 200), group('p3', 400)];
		const result = arrangePipelineGroups(pipelines, new Map());
		expect(result.size).toBe(3);
		expect(result.has('p1')).toBe(true);
	});

	it('packs into multiple columns (not a single vertical stack)', () => {
		const pipelines = Array.from({ length: 4 }, (_, i) => group(`p${i}`, i * 200));
		const result = arrangePipelineGroups(pipelines, new Map());
		const xs = new Set([...result.values()].map((o) => Math.round(o.x)));
		// 4 cards ⇒ round(sqrt(4)) = 2 columns.
		expect(xs.size).toBe(2);
	});

	it('preserves current reading order (top pipeline stays first)', () => {
		// p_top is currently highest (y=0), p_bottom lowest (y=900).
		const pipelines = [group('p_bottom', 900), group('p_top', 0)];
		const result = arrangePipelineGroups(pipelines, new Map());
		// With 2 items ⇒ round(sqrt(2)) = 1 column, so order shows up as Y.
		expect(result.get('p_top')!.y).toBeLessThan(result.get('p_bottom')!.y);
	});

	it('ignores empty pipelines', () => {
		const pipelines = [group('p1', 0), pipeline({ id: 'empty', nodes: [] })];
		const result = arrangePipelineGroups(pipelines, new Map());
		expect(result.has('empty')).toBe(false);
		expect(result.size).toBe(1);
	});

	it('returns an empty map when there is nothing to arrange', () => {
		expect(arrangePipelineGroups([], new Map()).size).toBe(0);
	});
});
