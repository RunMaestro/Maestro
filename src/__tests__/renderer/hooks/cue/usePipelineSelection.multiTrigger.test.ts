/**
 * Regression tests for the multi-trigger prompt-leakage bug.
 *
 * Before the fix, `usePipelineSelection` computed per-edge prompts as:
 *   edge.prompt ?? node.data.inputPrompt ?? ''
 *
 * The `inputPrompt` fallback meant that when an agent had multiple incoming
 * trigger edges and only the first had `edge.prompt` set, every other
 * trigger's UI row would render the agent's `inputPrompt` (which was
 * auto-populated from the first trigger's connection). This leaked the first
 * trigger's prompt into every subsequent trigger's textarea.
 *
 * After the fix, the fallback is `defaultPromptFor(eventType)` — each
 * trigger gets its own barebones template for its event type and the
 * agent-level `inputPrompt` is never consulted at per-edge resolution time.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePipelineSelection } from '../../../../renderer/hooks/cue/usePipelineSelection';
import type { CuePipelineState } from '../../../../shared/cue-pipeline-types';

function makeTriggerNode(id: string, eventType: string, label = 'Trigger') {
	return {
		id,
		type: 'trigger' as const,
		position: { x: 0, y: 0 },
		data: { eventType, label, config: {} },
	};
}

function makeAgentNode(id: string, extras: Record<string, unknown> = {}) {
	return {
		id,
		type: 'agent' as const,
		position: { x: 100, y: 0 },
		data: {
			sessionId: `sess-${id}`,
			sessionName: `Agent ${id}`,
			toolType: 'claude-code',
			...extras,
		},
	};
}

function makeEdge(
	id: string,
	source: string,
	target: string,
	extras: Record<string, unknown> = {}
) {
	return { id, source, target, mode: 'pass' as const, ...extras };
}

function makePipeline(id: string, nodes: any[], edges: any[]) {
	return { id, name: `Pipeline ${id}`, color: '#06b6d4', nodes, edges };
}

function mouseEvent() {
	return { stopPropagation: () => {} } as unknown as React.MouseEvent;
}

describe('usePipelineSelection — multi-trigger prompt isolation', () => {
	it('returns distinct prompts for two triggers when both have edge.prompt set', () => {
		const triggerA = makeTriggerNode('tA', 'github.issue');
		const triggerB = makeTriggerNode('tB', 'github.pull_request');
		const agent = makeAgentNode('a1');
		const edgeA = makeEdge('eA', 'tA', 'a1', { prompt: 'handle issue' });
		const edgeB = makeEdge('eB', 'tB', 'a1', { prompt: 'handle PR' });
		const pipeline = makePipeline('p1', [triggerA, triggerB, agent], [edgeA, edgeB]);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		const triggers = result.current.incomingTriggerEdges;
		expect(triggers).toHaveLength(2);
		const promptByEdge = Object.fromEntries(triggers.map((t) => [t.edgeId, t.prompt]));
		expect(promptByEdge.eA).toBe('handle issue');
		expect(promptByEdge.eB).toBe('handle PR');
	});

	it("second trigger without edge.prompt falls back to its own event-type default, not the first trigger's prompt or agent inputPrompt", () => {
		const triggerA = makeTriggerNode('tA', 'github.issue');
		const triggerB = makeTriggerNode('tB', 'file.changed');
		// Simulate the legacy auto-populate that used to set inputPrompt from the first trigger.
		const agent = makeAgentNode('a1', { inputPrompt: 'ISSUE PROMPT TEMPLATE' });
		const edgeA = makeEdge('eA', 'tA', 'a1', { prompt: 'user-edited issue prompt' });
		const edgeB = makeEdge('eB', 'tB', 'a1'); // no prompt — this is the leakage vector
		const pipeline = makePipeline('p1', [triggerA, triggerB, agent], [edgeA, edgeB]);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		const promptByEdge = Object.fromEntries(
			result.current.incomingTriggerEdges.map((t) => [t.edgeId, t.prompt])
		);
		expect(promptByEdge.eA).toBe('user-edited issue prompt');
		// eB must NOT receive the agent inputPrompt (the bug) and must NOT
		// receive eA's prompt (another shape of leak). It must receive the
		// file.changed template.
		expect(promptByEdge.eB).toContain('{{CUE_FILE_PATH}}');
		expect(promptByEdge.eB).not.toBe('ISSUE PROMPT TEMPLATE');
		expect(promptByEdge.eB).not.toBe('user-edited issue prompt');
	});

	it('two triggers, neither with edge.prompt, each gets its own event-type default', () => {
		const triggerA = makeTriggerNode('tA', 'task.pending');
		const triggerB = makeTriggerNode('tB', 'cli.trigger');
		const agent = makeAgentNode('a1');
		const edgeA = makeEdge('eA', 'tA', 'a1');
		const edgeB = makeEdge('eB', 'tB', 'a1');
		const pipeline = makePipeline('p1', [triggerA, triggerB, agent], [edgeA, edgeB]);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		const promptByEdge = Object.fromEntries(
			result.current.incomingTriggerEdges.map((t) => [t.edgeId, t.prompt])
		);
		expect(promptByEdge.eA).toContain('{{CUE_TASK_LIST}}');
		expect(promptByEdge.eB).toContain('{{CUE_CLI_PROMPT}}');
	});

	it('agent inputPrompt is never used as the fallback, even when the edge is present and unset', () => {
		const trigger = makeTriggerNode('t1', 'time.heartbeat');
		const agent = makeAgentNode('a1', { inputPrompt: 'do not leak this' });
		const edge = makeEdge('e1', 't1', 'a1');
		const pipeline = makePipeline('p1', [trigger, agent], [edge]);
		const state: CuePipelineState = { pipelines: [pipeline as any], selectedPipelineId: 'p1' };

		const { result } = renderHook(() => usePipelineSelection({ pipelineState: state }));
		act(() => {
			result.current.onNodeClick(mouseEvent(), { id: 'p1:a1' } as any);
		});

		expect(result.current.incomingTriggerEdges[0].prompt).toBe(''); // time.heartbeat default
		expect(result.current.incomingTriggerEdges[0].prompt).not.toContain('do not leak this');
	});
});
