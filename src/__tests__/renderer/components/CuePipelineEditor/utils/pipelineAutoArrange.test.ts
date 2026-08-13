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
import {
	NODE_BG_WIDTH,
	NODE_BG_HEIGHT,
	PIPELINE_GROUP_PADDING,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph';
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

// Real rendered node heights the layout centers on (mirror pipelineAutoArrange).
// A node's connection handle sits at its vertical center, so a straight edge
// requires equal CENTER y, not equal top-left y.
const TRIGGER_H = 60;
const AGENT_H = 80;
const ROW_H = AGENT_H; // tallest node drives the uniform row pitch
function centerY(pos: { y: number }, type: 'trigger' | 'agent'): number {
	return pos.y + (type === 'trigger' ? TRIGGER_H : AGENT_H) / 2;
}

// Horizontal gap between columns (mirror pipelineAutoArrange): NODE_GAP plus an
// arrowhead allowance so >=25px of straight line shows before the target arrow.
const NODE_GAP = 25;
const ARROWHEAD_ALLOWANCE = 20;
const COLUMN_GAP = NODE_GAP + ARROWHEAD_ALLOWANCE;

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

	it('snaps a chain onto a grid: COLUMN_GAP of clear space between columns', () => {
		// Every column pitch = node footprint + COLUMN_GAP, leaving room for the
		// arrowhead plus >=25px of visible straight line, and the chain reads as
		// one grid.
		const p = pipeline({
			nodes: [triggerNode('t', 0, 0), agentNode('a1', 0, 0), agentNode('a2', 0, 0)],
			edges: [
				{ id: 'e1', source: 't', target: 'a1', mode: 'pass' },
				{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
			],
		});
		const byId = new Map(arrangePipelineNodes(p).map((n) => [n.id, n.position]));
		// Gap between a node's right edge and the next node's left edge is COLUMN_GAP.
		// (No measured widths passed → every node falls back to NODE_BG_WIDTH.)
		expect(byId.get('a1')!.x - (byId.get('t')!.x + NODE_BG_WIDTH)).toBe(COLUMN_GAP);
		expect(byId.get('a2')!.x - (byId.get('a1')!.x + NODE_BG_WIDTH)).toBe(COLUMN_GAP);
		// A linear chain stays on one row. Edges are dead-straight when the node
		// CENTERS (where the handles are) share a y - the trigger is shorter than
		// the agents, so its top-left sits lower to bring the centers level.
		expect(centerY(byId.get('t')!, 'trigger')).toBe(centerY(byId.get('a1')!, 'agent'));
		expect(centerY(byId.get('a1')!, 'agent')).toBe(centerY(byId.get('a2')!, 'agent'));
	});

	it('spaces columns from MEASURED widths so a wide node never overruns the next column', () => {
		// Repro of the cramped 3-node chain: a wide command/agent node at rank 1
		// would, under a fixed column pitch, overlap the rank-2 node. With measured
		// widths the rank-2 column starts COLUMN_GAP past the rank-1 node's real
		// right edge, guaranteeing the gap and producing a real third column.
		const p = pipeline({
			nodes: [triggerNode('t', 0, 0), agentNode('mid', 0, 0), agentNode('end', 0, 0)],
			edges: [
				{ id: 'e1', source: 't', target: 'mid', mode: 'pass' },
				{ id: 'e2', source: 'mid', target: 'end', mode: 'pass' },
			],
		});
		// Trigger 200px wide, the middle node a fat 560px (long path/name), end 300px.
		const widths = new Map<string, number>([
			['t', 200],
			['mid', 560],
			['end', 300],
		]);
		const byId = new Map(arrangePipelineNodes(p, widths).map((n) => [n.id, n.position]));
		// Three distinct, strictly increasing columns.
		expect(byId.get('t')!.x).toBeLessThan(byId.get('mid')!.x);
		expect(byId.get('mid')!.x).toBeLessThan(byId.get('end')!.x);
		// Column 1 (mid) starts COLUMN_GAP past the trigger's real 200px right edge.
		expect(byId.get('mid')!.x - (byId.get('t')!.x + 200)).toBe(COLUMN_GAP);
		// Column 2 (end) starts COLUMN_GAP past the WIDE mid node's real 560px right
		// edge - this is the guarantee that was violated with a fixed pitch.
		expect(byId.get('end')!.x - (byId.get('mid')!.x + 560)).toBe(COLUMN_GAP);
	});

	it('aligns every component on ONE column grid sized by the widest node per rank', () => {
		// Two independent chains. The rank-1 column must clear the WIDEST rank-0
		// node across BOTH chains, so both chains' rank-1 nodes share an x and no
		// trigger (however wide) overruns its target.
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
		// t2 is the widest rank-0 node; the shared rank-1 column must clear IT.
		const widths = new Map<string, number>([
			['t1', 180],
			['a1', 300],
			['t2', 420],
			['a2', 300],
		]);
		const byId = new Map(arrangePipelineNodes(p, widths).map((n) => [n.id, n.position]));
		// Both chains' agents share the same column x (one global grid).
		expect(byId.get('a1')!.x).toBe(byId.get('a2')!.x);
		// That column clears the widest rank-0 node (t2 @ 420) by COLUMN_GAP.
		expect(byId.get('a1')!.x - (0 + 420)).toBe(COLUMN_GAP);
	});

	it('centers a fan-out source against its targets and stacks them 25px apart', () => {
		// Fan-out: t → a, b, c. The three targets share a column and stack
		// real-height + 25px apart so rows align on a single grid. The single
		// trigger is CENTERED against the group, so its center is level with the
		// MIDDLE target (b) and sits between the top (a) and bottom (c) targets.
		const GAP = 25;
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
		const byId = new Map(arrangePipelineNodes(p).map((n) => [n.id, n.position]));
		// Trigger center is level with the MIDDLE target (centered fan), and falls
		// strictly between the first and last targets.
		expect(centerY(byId.get('t')!, 'trigger')).toBe(centerY(byId.get('b')!, 'agent'));
		expect(centerY(byId.get('t')!, 'trigger')).toBeGreaterThan(centerY(byId.get('a')!, 'agent'));
		expect(centerY(byId.get('t')!, 'trigger')).toBeLessThan(centerY(byId.get('c')!, 'agent'));
		// Stacked same-height nodes are exactly 25px apart edge-to-edge (real height).
		expect(byId.get('b')!.y - (byId.get('a')!.y + ROW_H)).toBe(GAP);
		expect(byId.get('c')!.y - (byId.get('b')!.y + ROW_H)).toBe(GAP);
	});

	it('centers a fan-in sink against its sources', () => {
		// Fan-in: a, b, c → t. The mirror of the fan-out case. The three sources
		// stack in the first column; the single sink is centered against them, so
		// its center is level with the middle source (b).
		const p = pipeline({
			nodes: [
				agentNode('a', 0, 100),
				agentNode('b', 0, 200),
				agentNode('c', 0, 300),
				agentNode('t', 0, 200),
			],
			edges: [
				{ id: 'e1', source: 'a', target: 't', mode: 'pass' },
				{ id: 'e2', source: 'b', target: 't', mode: 'pass' },
				{ id: 'e3', source: 'c', target: 't', mode: 'pass' },
			],
		});
		const byId = new Map(arrangePipelineNodes(p).map((n) => [n.id, n.position]));
		// Sink in its own (later) column, centered on the middle source.
		expect(byId.get('t')!.x).toBeGreaterThan(byId.get('a')!.x);
		expect(centerY(byId.get('t')!, 'agent')).toBe(centerY(byId.get('b')!, 'agent'));
		expect(centerY(byId.get('t')!, 'agent')).toBeGreaterThan(centerY(byId.get('a')!, 'agent'));
		expect(centerY(byId.get('t')!, 'agent')).toBeLessThan(centerY(byId.get('c')!, 'agent'));
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
		// BOTH triggers into one column and BOTH agents into the next - collapsing
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
		// Within a chain the trigger and its agent centers are level → straight edge.
		expect(centerY(byId.get('t1')!, 'trigger')).toBe(centerY(byId.get('a1')!, 'agent'));
		expect(centerY(byId.get('t2')!, 'trigger')).toBe(centerY(byId.get('a2')!, 'agent'));
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

	it('preserves a two-column arrangement instead of collapsing to one tall stack', () => {
		// Four trigger→agent pairs the user placed in TWO columns: pairs 0,1 on the
		// left (x≈0), pairs 2,3 on the right (x≈600). Tidy must keep two columns
		// where they are, not stack all four bands into one column.
		const nodes: PipelineNode[] = [];
		const edges: CuePipeline['edges'] = [];
		for (let i = 0; i < 4; i++) {
			const colX = i < 2 ? 0 : 600;
			const rowY = (i % 2) * 200;
			nodes.push(triggerNode(`t${i}`, colX, rowY));
			nodes.push(agentNode(`a${i}`, colX + 200, rowY));
			edges.push({ id: `e${i}`, source: `t${i}`, target: `a${i}`, mode: 'pass' });
		}
		const byId = new Map(
			arrangePipelineNodes(pipeline({ nodes, edges })).map((n) => [n.id, n.position])
		);
		// Exactly two distinct trigger columns survive.
		const triggerXs = new Set([0, 1, 2, 3].map((i) => byId.get(`t${i}`)!.x));
		expect(triggerXs.size).toBe(2);
		// Left pairs share the leftmost trigger x; right pairs share a larger x.
		expect(byId.get('t0')!.x).toBe(byId.get('t1')!.x);
		expect(byId.get('t2')!.x).toBe(byId.get('t3')!.x);
		expect(byId.get('t2')!.x).toBeGreaterThan(byId.get('t0')!.x);
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
		// bands and could never cross - that's the per-component behavior covered
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

	// Ten independent trigger→agent pairs, all stacked in one tall column.
	function tenPairs(): CuePipeline {
		const nodes: PipelineNode[] = [];
		const edges: CuePipeline['edges'] = [];
		for (let i = 0; i < 10; i++) {
			nodes.push(triggerNode(`t${i}`, 0, i * 200));
			nodes.push(agentNode(`a${i}`, 200, i * 200));
			edges.push({ id: `e${i}`, source: `t${i}`, target: `a${i}`, mode: 'pass' });
		}
		return pipeline({ nodes, edges });
	}

	it('packs independent sub-circuits into multiple columns to fit a wide viewport', () => {
		// A wide editor canvas: one tall 10-pair column wastes it, so Arrange should
		// spread the pairs across 2+ side-by-side columns.
		const arranged = untanglePipelineNodes(tenPairs(), undefined, { width: 1600, height: 600 });
		const byId = new Map(arranged.map((n) => [n.id, n.position]));
		const triggerXs = new Set(Array.from({ length: 10 }, (_, i) => byId.get(`t${i}`)!.x));
		expect(triggerXs.size).toBeGreaterThan(1);
		// Fitting a wide viewport must be shorter than the one-column stack would be.
		const maxY = Math.max(...arranged.map((n) => n.position.y));
		const singleColumnMaxY = Math.max(
			...untanglePipelineNodes(tenPairs()).map((n) => n.position.y)
		);
		expect(maxY).toBeLessThan(singleColumnMaxY);
	});

	it('keeps a single tall column when no viewport is provided (legacy behavior)', () => {
		const byId = new Map(untanglePipelineNodes(tenPairs()).map((n) => [n.id, n.position]));
		// Every trigger stays in the one shared left column.
		const triggerXs = new Set(Array.from({ length: 10 }, (_, i) => byId.get(`t${i}`)!.x));
		expect(triggerXs.size).toBe(1);
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

	// ── Masonry packing (tight, no whitespace blow-out) ──────────────────────
	// Reconstruct each card's on-screen rect from the returned viewOffset using
	// the SAME footprint math as groupInfo, so we can assert geometric packing
	// properties the old uniform-grid layout violated.
	function cardRect(p: CuePipeline, offset: { x: number; y: number }) {
		const minX = Math.min(...p.nodes.map((n) => n.position.x));
		const minY = Math.min(...p.nodes.map((n) => n.position.y));
		const maxX = Math.max(...p.nodes.map((n) => n.position.x + NODE_BG_WIDTH));
		const maxY = Math.max(...p.nodes.map((n) => n.position.y + NODE_BG_HEIGHT));
		const width = maxX - minX + 2 * PIPELINE_GROUP_PADDING;
		const height = maxY - minY + 2 * PIPELINE_GROUP_PADDING;
		// Card renders at (minX + offset - PADDING); offset is what arrange returns.
		const left = minX + offset.x - PIPELINE_GROUP_PADDING;
		const top = minY + offset.y - PIPELINE_GROUP_PADDING;
		return { left, top, right: left + width, bottom: top + height };
	}

	function rectsOverlap(a: ReturnType<typeof cardRect>, b: ReturnType<typeof cardRect>): boolean {
		return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
	}

	/** A tall pipeline (stacked nodes) and N single-node pipelines. */
	function tallPipeline(id: string, rows: number): CuePipeline {
		return pipeline({
			id,
			name: id,
			nodes: Array.from({ length: rows }, (_, i) => agentNode(`${id}-a${i}`, 0, i * 200)),
		});
	}
	function smallPipeline(id: string, currentY: number): CuePipeline {
		return pipeline({
			id,
			name: id,
			nodes: [agentNode(`${id}-a`, 0, 0)],
			viewOffset: { x: 0, y: currentY },
		});
	}

	it('packs cards without overlap (varied sizes)', () => {
		const pipelines = [
			tallPipeline('giant', 10),
			smallPipeline('s1', 100),
			smallPipeline('s2', 200),
			smallPipeline('s3', 300),
			smallPipeline('s4', 400),
			smallPipeline('s5', 500),
		];
		const result = arrangePipelineGroups(pipelines, new Map());
		const rects = pipelines.map((p) => cardRect(p, result.get(p.id)!));
		for (let i = 0; i < rects.length; i++) {
			for (let j = i + 1; j < rects.length; j++) {
				expect(rectsOverlap(rects[i], rects[j])).toBe(false);
			}
		}
	});

	it('a tall pipeline does not strand short ones in dead space below it', () => {
		// Old uniform grid forced every card in the giant's ROW to inherit its
		// height, stacking later rows far below and leaving big gaps. Masonry
		// drops short cards into other columns beside the giant, so the total
		// vertical extent stays close to the giant's own height rather than
		// growing by every short card's row.
		const giant = tallPipeline('giant', 12);
		const smalls = Array.from({ length: 5 }, (_, i) => smallPipeline(`s${i}`, (i + 1) * 100));
		const pipelines = [giant, ...smalls];
		const result = arrangePipelineGroups(pipelines, new Map());

		const giantRect = cardRect(giant, result.get('giant')!);
		const giantHeight = giantRect.bottom - giantRect.top;
		const totalHeight =
			Math.max(...pipelines.map((p) => cardRect(p, result.get(p.id)!).bottom)) -
			Math.min(...pipelines.map((p) => cardRect(p, result.get(p.id)!).top));

		// Masonry keeps the layout no taller than the giant (the short cards fit
		// beside it in other columns). The old uniform grid stacked the short
		// cards into extra ROWS below the giant, making the layout giant + several
		// short rows tall - this asserts that dead space is gone.
		const smallHeight = (() => {
			const r = cardRect(smalls[0], result.get('s0')!);
			return r.bottom - r.top;
		})();
		expect(totalHeight).toBeLessThanOrEqual(giantHeight + smallHeight);

		// And at least one short card sits beside the giant (its top is above the
		// giant's bottom while occupying a different column).
		const beside = smalls.some((p) => {
			const r = cardRect(p, result.get(p.id)!);
			return r.top < giantRect.bottom && (r.right <= giantRect.left || r.left >= giantRect.right);
		});
		expect(beside).toBe(true);
	});
});
