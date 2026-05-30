/**
 * Tests for per-edge upstream output control in pipelineToYaml.
 *
 * Verifies that `includeUpstreamOutput` and `forwardOutput` edge flags
 * correctly produce `include_output_from` and `forward_output_from`
 * arrays on the generated CueSubscription objects.
 */

import { describe, it, expect } from 'vitest';
import { pipelineToYamlSubscriptions } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml';
import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge,
} from '../../../../../shared/cue-pipeline-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePipeline(overrides: Partial<CuePipeline> = {}): CuePipeline {
	return {
		id: 'p1',
		name: 'test-pipeline',
		color: '#06b6d4',
		nodes: [],
		edges: [],
		...overrides,
	};
}

function triggerNode(id: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'time.heartbeat',
			label: 'Trigger',
			config: { interval_minutes: 5 },
		},
	};
}

function agentNode(
	id: string,
	sessionId: string,
	sessionName: string,
	inputPrompt = 'do work'
): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 300, y: 0 },
		data: {
			sessionId,
			sessionName,
			toolType: 'claude-code',
			inputPrompt,
		},
	};
}

function edge(
	id: string,
	source: string,
	target: string,
	overrides: Partial<PipelineEdge> = {}
): PipelineEdge {
	return { id, source, target, mode: 'pass', ...overrides };
}

// ─── Fan-in pipeline factory ────────────────────────────────────────────────
//
//   trigger → agentA ─┐
//   trigger → agentB ─┤→ agentC
//   trigger → agentD ─┘       (3-way fan-in when needed, 2-way otherwise)
//

function makeFanInPipeline(
	edgeOverrides: {
		aToC?: Partial<PipelineEdge>;
		bToC?: Partial<PipelineEdge>;
		dToC?: Partial<PipelineEdge>;
	} = {}
): CuePipeline {
	const nodes: PipelineNode[] = [
		triggerNode('t1'),
		agentNode('a1', 's1', 'Agent A', 'task A'),
		agentNode('a2', 's2', 'Agent B', 'task B'),
		agentNode('a3', 's3', 'Agent C', 'combine'),
	];

	const edges: PipelineEdge[] = [
		edge('e-t-a', 't1', 'a1'),
		edge('e-t-b', 't1', 'a2'),
		edge('e-a-c', 'a1', 'a3', edgeOverrides.aToC),
		edge('e-b-c', 'a2', 'a3', edgeOverrides.bToC),
	];

	if (edgeOverrides.dToC) {
		nodes.push(agentNode('a4', 's4', 'Agent D', 'task D'));
		edges.push(edge('e-t-d', 't1', 'a4'));
		edges.push(edge('e-d-c', 'a4', 'a3', edgeOverrides.dToC));
	}

	return makePipeline({ nodes, edges });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('pipelineToYamlSubscriptions — per-edge upstream output', () => {
	describe('include_output_from', () => {
		it('does not emit include_output_from when all edges are included (default)', () => {
			const pipeline = makeFanInPipeline();
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 2
			);
			expect(fanInSub).toBeDefined();
			expect(fanInSub!.include_output_from).toBeUndefined();
			expect(fanInSub!.forward_output_from).toBeUndefined();
		});

		it('emits include_output_from listing only included sources when one edge is excluded', () => {
			const pipeline = makeFanInPipeline({
				bToC: { includeUpstreamOutput: false },
			});
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 2
			);
			expect(fanInSub).toBeDefined();
			// source_session lists all sources (both still trigger fan-in)
			expect(fanInSub!.source_session).toEqual(['Agent A', 'Agent B']);
			// include_output_from only lists the included one
			expect(fanInSub!.include_output_from).toEqual(['Agent A']);
		});

		it('does not emit include_output_from when all edges explicitly set includeUpstreamOutput: true', () => {
			const pipeline = makeFanInPipeline({
				aToC: { includeUpstreamOutput: true },
				bToC: { includeUpstreamOutput: true },
			});
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 2
			);
			expect(fanInSub).toBeDefined();
			expect(fanInSub!.include_output_from).toBeUndefined();
		});
	});

	describe('forward_output_from', () => {
		it('emits forward_output_from when one edge has forwardOutput: true', () => {
			const pipeline = makeFanInPipeline({
				aToC: { forwardOutput: true },
			});
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 2
			);
			expect(fanInSub).toBeDefined();
			expect(fanInSub!.forward_output_from).toEqual(['Agent A']);
		});

		it('does not emit forward_output_from when no edges have forwardOutput', () => {
			const pipeline = makeFanInPipeline();
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 2
			);
			expect(fanInSub).toBeDefined();
			expect(fanInSub!.forward_output_from).toBeUndefined();
		});
	});

	describe('mixed include + forward', () => {
		it('emits both arrays when 2 included, 1 excluded+forwarded (3-way fan-in)', () => {
			// Agent A → included (default)
			// Agent B → included (default)
			// Agent D → excluded + forwarded
			const pipeline = makeFanInPipeline({
				dToC: { includeUpstreamOutput: false, forwardOutput: true },
			});
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 3
			);
			expect(fanInSub).toBeDefined();
			// All three sources participate in the fan-in
			expect(fanInSub!.source_session).toEqual(['Agent A', 'Agent B', 'Agent D']);
			// Only A and B contribute output
			expect(fanInSub!.include_output_from).toEqual(['Agent A', 'Agent B']);
			// Only D is forwarded
			expect(fanInSub!.forward_output_from).toEqual(['Agent D']);
		});

		it('emits forward_output_from alongside include_output_from when an edge is both excluded and forwarded', () => {
			// Agent A → included + forwarded
			// Agent B → excluded + forwarded
			const pipeline = makeFanInPipeline({
				aToC: { forwardOutput: true },
				bToC: { includeUpstreamOutput: false, forwardOutput: true },
			});
			const subs = pipelineToYamlSubscriptions(pipeline);

			const fanInSub = subs.find(
				(s) => Array.isArray(s.source_session) && s.source_session.length === 2
			);
			expect(fanInSub).toBeDefined();
			// Only A is included for output injection
			expect(fanInSub!.include_output_from).toEqual(['Agent A']);
			// Both A and B are forwarded
			expect(fanInSub!.forward_output_from).toEqual(['Agent A', 'Agent B']);
		});
	});

	describe('single chain with includeUpstreamOutput: false', () => {
		it('does not inject {{CUE_SOURCE_OUTPUT}} when edge excludes upstream output', () => {
			const pipeline = makePipeline({
				nodes: [
					triggerNode('t1'),
					agentNode('a1', 's1', 'Agent A', 'build'),
					agentNode('a2', 's2', 'Agent B', 'test'),
				],
				edges: [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2', { includeUpstreamOutput: false })],
			});

			const subs = pipelineToYamlSubscriptions(pipeline);
			expect(subs).toHaveLength(2);

			const chainSub = subs.find((s) => s.event === 'agent.completed');
			expect(chainSub).toBeDefined();
			// Prompt should NOT contain the CUE_SOURCE_OUTPUT variable
			expect(chainSub!.prompt).not.toContain('{{CUE_SOURCE_OUTPUT}}');
			// Original prompt preserved
			expect(chainSub!.prompt).toBe('test');
		});

		it('injects {{CUE_SOURCE_OUTPUT}} when edge includeUpstreamOutput is true (default)', () => {
			const pipeline = makePipeline({
				nodes: [
					triggerNode('t1'),
					agentNode('a1', 's1', 'Agent A', 'build'),
					agentNode('a2', 's2', 'Agent B', 'test'),
				],
				edges: [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2')],
			});

			const subs = pipelineToYamlSubscriptions(pipeline);
			const chainSub = subs.find((s) => s.event === 'agent.completed');
			expect(chainSub).toBeDefined();
			expect(chainSub!.prompt).toContain('{{CUE_SOURCE_OUTPUT}}');
		});
	});

	// Regression gate: the authored prompt stored on AgentNodeData must never
	// accumulate injected tokens when emitting YAML. If this breaks, every
	// save would duplicate the prepended prefix.
	describe('prompt accumulation regression', () => {
		it('does not mutate the pipeline node inputPrompt on emit', () => {
			const pipeline = makePipeline({
				nodes: [
					triggerNode('t1'),
					agentNode('a1', 's1', 'Agent A', 'build'),
					agentNode('a2', 's2', 'Agent B', 'author'),
				],
				edges: [edge('e1', 't1', 'a1'), edge('e2', 'a1', 'a2')],
			});
			const before = (pipeline.nodes[2].data as { inputPrompt?: string }).inputPrompt;
			pipelineToYamlSubscriptions(pipeline);
			const after = (pipeline.nodes[2].data as { inputPrompt?: string }).inputPrompt;
			expect(after).toBe(before);
		});
	});
});
