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
	untanglePipelineNodes,
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

	it('keeps independent chains on their own row bands instead of merging columns', () => {
		// Two independent trigger→agent chains. The old single-rank Tidy stacked
		// BOTH triggers into one column and BOTH agents into the next — collapsing
		// the chains on top of each other ("rearranging the graph"). Per-component
		// Tidy keeps each chain on its own horizontal band.
		const p = pipeline({
			nodes: [
				triggerNode('t1', 0, 0),
				agentNode('a1', 0, 0),
				triggerNode('t2', 0, 300),
				agentNode('a2', 0, 300),
			],
			edges: [
				{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 't2', target: 'a2', mode: 'pass' },
			],
		});
		const byId = new Map(arrangePipelineNodes(p).map((n) => [n.id, n.position]));
		// Triggers share the left column; agents share the next column.
		expect(byId.get('t1')!.x).toBe(byId.get('t2')!.x);
		expect(byId.get('a1')!.x).toBe(byId.get('a2')!.x);
		// Each chain sits on its own band: chain 1 entirely above chain 2.
		const chain1MaxY = Math.max(byId.get('t1')!.y, byId.get('a1')!.y);
		const chain2MinY = Math.min(byId.get('t2')!.y, byId.get('a2')!.y);
		expect(chain1MaxY).toBeLessThan(chain2MinY);
		// Within a chain the trigger and its agent are level → straight edge.
		expect(byId.get('t1')!.y).toBe(byId.get('a1')!.y);
		expect(byId.get('t2')!.y).toBe(byId.get('a2')!.y);
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

describe('untanglePipelineNodes', () => {
	// True segment-intersection crossing count over laid-out positions, so the
	// assertion is independent of the layout's internal ordering logic. Edges
	// sharing an endpoint can't "cross" in the layout sense and are skipped.
	function countCrossings(
		edges: Array<{ source: string; target: string }>,
		pos: Map<string, { x: number; y: number }>
	): number {
		const ccw = (
			a: { x: number; y: number },
			b: { x: number; y: number },
			c: { x: number; y: number }
		) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
		const intersect = (
			p1: { x: number; y: number },
			p2: { x: number; y: number },
			p3: { x: number; y: number },
			p4: { x: number; y: number }
		) => {
			const d1 = ccw(p3, p4, p1);
			const d2 = ccw(p3, p4, p2);
			const d3 = ccw(p1, p2, p3);
			const d4 = ccw(p1, p2, p4);
			return (
				((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
			);
		};
		let crossings = 0;
		for (let i = 0; i < edges.length; i++) {
			for (let j = i + 1; j < edges.length; j++) {
				const a = edges[i];
				const b = edges[j];
				if (
					a.source === b.source ||
					a.target === b.target ||
					a.source === b.target ||
					a.target === b.source
				)
					continue;
				if (
					intersect(pos.get(a.source)!, pos.get(a.target)!, pos.get(b.source)!, pos.get(b.target)!)
				)
					crossings++;
			}
		}
		return crossings;
	}

	it('removes crossings within a connected component (shuffled middle layer)', () => {
		// One trigger T fans out to A0..A5; each Ai then feeds B_perm[i]. Because
		// everything is wired through T it is a SINGLE connected component, so both
		// buttons lay it out in the same band. Tidy keeps the A/B columns in
		// current Y order (the a→b edges cross); Arrange reorders the B column to
		// remove the crossings. (Independent t→a pairs would land in separate
		// bands and could never cross — that's the per-component behavior covered
		// by the Tidy banding test above.)
		const perm = [2, 0, 3, 1, 5, 4];
		const nodes: PipelineNode[] = [triggerNode('t', 0, 0)];
		const edges: CuePipeline['edges'] = [];
		for (let i = 0; i < perm.length; i++) {
			nodes.push(agentNode(`a${i}`, 0, i * 100));
			edges.push({ id: `ta${i}`, source: 't', target: `a${i}`, mode: 'pass' });
		}
		for (let i = 0; i < perm.length; i++) {
			nodes.push(agentNode(`b${i}`, 0, i * 100));
			edges.push({ id: `ab${i}`, source: `a${i}`, target: `b${perm[i]}`, mode: 'pass' });
		}
		const p = pipeline({ nodes, edges });

		const tidied = new Map(arrangePipelineNodes(p).map((n) => [n.id, n.position]));
		const arranged = new Map(untanglePipelineNodes(p).map((n) => [n.id, n.position]));

		// countCrossings skips edges sharing an endpoint, so the t→a fan-out edges
		// drop out automatically and only the a→b permutation edges are counted.
		expect(countCrossings(edges, tidied)).toBeGreaterThan(0);
		expect(countCrossings(edges, arranged)).toBe(0);
	});

	it('does not scramble an already-clean fan-out (current order preserved)', () => {
		const p = pipeline({
			nodes: [
				triggerNode('t', 0, 0),
				agentNode('a', 0, 100),
				agentNode('b', 0, 200),
				agentNode('c', 0, 300),
			],
			edges: [
				{ id: 'e1', source: 't', target: 'a', mode: 'pass' },
				{ id: 'e2', source: 't', target: 'b', mode: 'pass' },
				{ id: 'e3', source: 't', target: 'c', mode: 'pass' },
			],
		});
		const byId = new Map(untanglePipelineNodes(p).map((n) => [n.id, n.position]));
		// Same column, current top-to-bottom order (a,b,c) intact.
		expect(byId.get('a')!.y).toBeLessThan(byId.get('b')!.y);
		expect(byId.get('b')!.y).toBeLessThan(byId.get('c')!.y);
	});

	it('does not mutate the input nodes', () => {
		const p = pipeline({
			nodes: [triggerNode('t', 7, 7), agentNode('a', 7, 7)],
			edges: [{ id: 'e1', source: 't', target: 'a', mode: 'pass' }],
		});
		untanglePipelineNodes(p);
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
		expect(() => untanglePipelineNodes(p)).not.toThrow();
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
