/**
 * Unit tests for the pure graph traversal that surfaces direct + transitive
 * upstream sources for a given pipeline node.
 */

import { describe, it, expect } from 'vitest';
import { computeTransitiveUpstream } from '../../../../../renderer/components/CuePipelineEditor/utils/transitiveUpstream';
import type {
	AgentNodeData,
	CuePipeline,
	PipelineEdge,
	PipelineNode,
} from '../../../../../shared/cue-pipeline-types';

function agent(id: string, sessionName: string): PipelineNode {
	const data: AgentNodeData = {
		sessionId: `session-${id}`,
		sessionName,
		toolType: 'claude-code',
	};
	return { id, type: 'agent', position: { x: 0, y: 0 }, data };
}

function edge(
	id: string,
	source: string,
	target: string,
	overrides: Partial<PipelineEdge> = {}
): PipelineEdge {
	return {
		id,
		source,
		target,
		mode: 'pass',
		...overrides,
	};
}

function pipeline(nodes: PipelineNode[], edges: PipelineEdge[]): CuePipeline {
	return {
		id: 'p1',
		name: 'Test Pipeline',
		color: '#000',
		nodes,
		edges,
	};
}

describe('computeTransitiveUpstream', () => {
	describe('direct sources', () => {
		it('returns a single direct source for a trivial B -> C pipeline', () => {
			const p = pipeline([agent('b', 'B'), agent('c', 'C')], [edge('e1', 'b', 'c')]);
			const result = computeTransitiveUpstream(p, 'c');
			expect(result).toEqual([{ source: 'B', sourceNodeId: 'b', isDirect: true, path: ['B'] }]);
		});

		it('lists multiple direct sources in edge order', () => {
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B'), agent('c', 'C')],
				[edge('e1', 'a', 'c'), edge('e2', 'b', 'c')]
			);
			const result = computeTransitiveUpstream(p, 'c');
			expect(result.map((r) => r.source)).toEqual(['A', 'B']);
			expect(result.every((r) => r.isDirect)).toBe(true);
		});
	});

	describe('transitive sources', () => {
		it('returns A as transitive via B in A -> B -> C when A->B has forwardOutput=true', () => {
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B'), agent('c', 'C')],
				[edge('e1', 'a', 'b', { forwardOutput: true }), edge('e2', 'b', 'c')]
			);
			const result = computeTransitiveUpstream(p, 'c');
			expect(result).toHaveLength(2);
			const bSrc = result.find((r) => r.source === 'B')!;
			const aSrc = result.find((r) => r.source === 'A')!;
			expect(bSrc.isDirect).toBe(true);
			expect(aSrc.isDirect).toBe(false);
			expect(aSrc.path).toEqual(['A', 'B']);
			expect(aSrc.relayEdgeId).toBe('e1');
		});

		it('omits A when the A->B edge does NOT have forwardOutput=true', () => {
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B'), agent('c', 'C')],
				[edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]
			);
			const result = computeTransitiveUpstream(p, 'c');
			expect(result.map((r) => r.source)).toEqual(['B']);
		});

		it('walks transitively through multiple forwarding hops', () => {
			// A -> B -> C -> D, with A->B and B->C forwarding.
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B'), agent('c', 'C'), agent('d', 'D')],
				[
					edge('e1', 'a', 'b', { forwardOutput: true }),
					edge('e2', 'b', 'c', { forwardOutput: true }),
					edge('e3', 'c', 'd'),
				]
			);
			const result = computeTransitiveUpstream(p, 'd');
			expect(result.map((r) => r.source).sort()).toEqual(['A', 'B', 'C']);
			const a = result.find((r) => r.source === 'A')!;
			expect(a.isDirect).toBe(false);
			expect(a.path).toEqual(['A', 'B', 'C']);
		});

		it('stops walking when the forwarding chain breaks', () => {
			// A -> B -> C -> D, with A->B forwarding but B->C NOT forwarding.
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B'), agent('c', 'C'), agent('d', 'D')],
				[edge('e1', 'a', 'b', { forwardOutput: true }), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')]
			);
			const result = computeTransitiveUpstream(p, 'd');
			// C is direct. B is NOT forwarded to C (e2.forwardOutput falsy), so
			// A never reaches D even though A is forwarded through B.
			expect(result.map((r) => r.source)).toEqual(['C']);
		});
	});

	describe('dedup & cycles', () => {
		it('dedupes when the same source reaches the target via multiple paths', () => {
			// Diamond: A -> B -> D, A -> C -> D, both forwarding. A should
			// appear once as transitive.
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B'), agent('c', 'C'), agent('d', 'D')],
				[
					edge('e1', 'a', 'b', { forwardOutput: true }),
					edge('e2', 'a', 'c', { forwardOutput: true }),
					edge('e3', 'b', 'd'),
					edge('e4', 'c', 'd'),
				]
			);
			const result = computeTransitiveUpstream(p, 'd');
			const aRows = result.filter((r) => r.source === 'A');
			expect(aRows).toHaveLength(1);
			expect(aRows[0].isDirect).toBe(false);
		});

		it('terminates on cycles', () => {
			// A -> B -> A (cycle), computing upstream from B.
			const p = pipeline(
				[agent('a', 'A'), agent('b', 'B')],
				[
					edge('e1', 'a', 'b', { forwardOutput: true }),
					edge('e2', 'b', 'a', { forwardOutput: true }),
				]
			);
			const result = computeTransitiveUpstream(p, 'b');
			expect(result.map((r) => r.source)).toEqual(['A']);
		});
	});

	describe('edge cases', () => {
		it('returns empty for a target with no incoming edges', () => {
			const p = pipeline([agent('a', 'A')], []);
			expect(computeTransitiveUpstream(p, 'a')).toEqual([]);
		});

		it('returns empty when the target node id does not exist', () => {
			const p = pipeline([agent('a', 'A')], []);
			expect(computeTransitiveUpstream(p, 'nonexistent')).toEqual([]);
		});

		it('ignores non-agent nodes (e.g. triggers) as sources', () => {
			// Trigger node wired into an agent should NOT appear as an upstream.
			const trigger: PipelineNode = {
				id: 't',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { eventType: 'agent.completed', label: 'Trigger', config: {} },
			};
			const p = pipeline([trigger, agent('a', 'A')], [edge('e1', 't', 'a')]);
			expect(computeTransitiveUpstream(p, 'a')).toEqual([]);
		});
	});
});
