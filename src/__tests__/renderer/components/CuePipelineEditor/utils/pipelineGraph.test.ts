/**
 * Tests for pipelineGraph utilities: getTriggerConfigSummary,
 * convertToReactFlowNodes, and convertToReactFlowEdges.
 *
 * These are pure functions — no React, no DOM.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	getTriggerConfigSummary,
	convertToReactFlowNodes,
	convertToReactFlowEdges,
	computePipelineYOffsets,
} from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph';
import type {
	CuePipeline,
	TriggerNodeData,
	AgentNodeData,
} from '../../../../../shared/cue-pipeline-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTrigger(
	id: string,
	eventType: TriggerNodeData['eventType'],
	config: TriggerNodeData['config'] = {},
	position = { x: 0, y: 0 }
) {
	return {
		id,
		type: 'trigger' as const,
		position,
		data: { eventType, label: eventType, config } satisfies TriggerNodeData,
	};
}

function makeAgent(
	id: string,
	sessionId: string,
	sessionName: string,
	overrides: Partial<AgentNodeData> = {},
	position = { x: 200, y: 0 }
) {
	return {
		id,
		type: 'agent' as const,
		position,
		data: {
			sessionId,
			sessionName,
			toolType: 'claude-code',
			...overrides,
		} satisfies AgentNodeData,
	};
}

function makeEdge(id: string, source: string, target: string, prompt?: string) {
	return { id, source, target, mode: 'pass' as const, prompt };
}

function makePipeline(id: string, overrides: Partial<Omit<CuePipeline, 'id'>> = {}): CuePipeline {
	return {
		id,
		name: `Pipeline ${id}`,
		color: '#06b6d4',
		nodes: [],
		edges: [],
		...overrides,
	};
}

// ─── getTriggerConfigSummary ──────────────────────────────────────────────────

describe('getTriggerConfigSummary', () => {
	it('heartbeat: returns interval when set', () => {
		const data: TriggerNodeData = {
			eventType: 'time.heartbeat',
			label: 'Heartbeat',
			config: { interval_minutes: 15 },
		};
		expect(getTriggerConfigSummary(data)).toBe('every 15min');
	});

	it('heartbeat: returns fallback when no interval', () => {
		const data: TriggerNodeData = {
			eventType: 'time.heartbeat',
			label: 'Heartbeat',
			config: {},
		};
		expect(getTriggerConfigSummary(data)).toBe('heartbeat');
	});

	it('scheduled: returns "scheduled" when no times set', () => {
		const data: TriggerNodeData = {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: {},
		};
		expect(getTriggerConfigSummary(data)).toBe('scheduled');
	});

	it('scheduled: shows up to 2 times inline', () => {
		const data: TriggerNodeData = {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: { schedule_times: ['09:00', '17:00'] },
		};
		expect(getTriggerConfigSummary(data)).toBe('09:00, 17:00');
	});

	it('scheduled: collapses 3+ times to count', () => {
		const data: TriggerNodeData = {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: { schedule_times: ['09:00', '12:00', '17:00'] },
		};
		expect(getTriggerConfigSummary(data)).toBe('3 times');
	});

	it('scheduled: appends day filter when days are a subset of 7', () => {
		const data: TriggerNodeData = {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: { schedule_times: ['09:00'], schedule_days: ['Mon', 'Fri'] },
		};
		expect(getTriggerConfigSummary(data)).toBe('09:00 (Mon, Fri)');
	});

	it('scheduled: omits day filter when all 7 days selected', () => {
		const data: TriggerNodeData = {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: {
				schedule_times: ['09:00'],
				schedule_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
			},
		};
		expect(getTriggerConfigSummary(data)).toBe('09:00');
	});

	it('file.changed: returns watch pattern when set', () => {
		const data: TriggerNodeData = {
			eventType: 'file.changed',
			label: 'File',
			config: { watch: 'src/**/*.ts' },
		};
		expect(getTriggerConfigSummary(data)).toBe('src/**/*.ts');
	});

	it('file.changed: returns default glob when no watch', () => {
		const data: TriggerNodeData = {
			eventType: 'file.changed',
			label: 'File',
			config: {},
		};
		expect(getTriggerConfigSummary(data)).toBe('**/*');
	});

	it('github.pull_request: returns repo name', () => {
		const data: TriggerNodeData = {
			eventType: 'github.pull_request',
			label: 'PR',
			config: { repo: 'org/repo' },
		};
		expect(getTriggerConfigSummary(data)).toBe('org/repo');
	});

	it('github.issue: returns repo name', () => {
		const data: TriggerNodeData = {
			eventType: 'github.issue',
			label: 'Issue',
			config: { repo: 'org/repo' },
		};
		expect(getTriggerConfigSummary(data)).toBe('org/repo');
	});

	it('github.pull_request: returns fallback when no repo', () => {
		const data: TriggerNodeData = {
			eventType: 'github.pull_request',
			label: 'PR',
			config: {},
		};
		expect(getTriggerConfigSummary(data)).toBe('repo');
	});

	it('task.pending: returns watch pattern', () => {
		const data: TriggerNodeData = {
			eventType: 'task.pending',
			label: 'Task',
			config: { watch: 'TODO.md' },
		};
		expect(getTriggerConfigSummary(data)).toBe('TODO.md');
	});

	it('task.pending: returns fallback when no watch', () => {
		const data: TriggerNodeData = {
			eventType: 'task.pending',
			label: 'Task',
			config: {},
		};
		expect(getTriggerConfigSummary(data)).toBe('tasks');
	});

	it('agent.completed: always returns fixed string', () => {
		const data: TriggerNodeData = {
			eventType: 'agent.completed',
			label: 'Agent Done',
			config: {},
		};
		expect(getTriggerConfigSummary(data)).toBe('agent done');
	});
});

// ─── convertToReactFlowNodes ──────────────────────────────────────────────────

describe('convertToReactFlowNodes', () => {
	// ── Basic rendering ──────────────────────────────────────────────────────

	it('returns empty array for empty pipeline list', () => {
		const result = convertToReactFlowNodes([], null);
		expect(result).toEqual([]);
	});

	it('returns empty array for pipelines with no nodes', () => {
		const pipelines = [makePipeline('p1'), makePipeline('p2')];
		expect(convertToReactFlowNodes(pipelines, null)).toEqual([]);
	});

	it('renders trigger node with correct composite id', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].id).toBe('p1:t1');
		expect(nodes[0].type).toBe('trigger');
	});

	it('renders agent node with correct composite id', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeAgent('a1', 'sess-1', 'Pedsidian')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].id).toBe('p1:a1');
		expect(nodes[0].type).toBe('agent');
	});

	it('passes customLabel over eventType label for triggers', () => {
		const trigger = makeTrigger('t1', 'time.heartbeat');
		(trigger.data as TriggerNodeData).customLabel = 'Morning Check';
		const pipeline = makePipeline('p1', { nodes: [trigger] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { label: string }).label).toBe('Morning Check');
	});

	it('uses eventType label when customLabel is absent', () => {
		const trigger = makeTrigger('t1', 'time.heartbeat');
		(trigger.data as TriggerNodeData).label = 'Heartbeat';
		const pipeline = makePipeline('p1', { nodes: [trigger] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { label: string }).label).toBe('Heartbeat');
	});

	it('threads subscriptionName from TriggerNodeData to TriggerNodeDataProps', () => {
		// Regression guard: if this thread-through breaks, the Play button
		// on chain triggers silently falls back to pipelineName and fires
		// the wrong subscription — that's the GitHub-trigger-unreachable bug.
		const trigger = makeTrigger('t1', 'github.pull_request');
		(trigger.data as TriggerNodeData).subscriptionName = 'Pipeline 1-chain-2';
		const pipeline = makePipeline('p1', { nodes: [trigger] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { subscriptionName?: string }).subscriptionName).toBe(
			'Pipeline 1-chain-2'
		);
	});

	it('leaves subscriptionName undefined when not stamped on the node data', () => {
		// Never-saved pipelines don't have a subscription yet — the TriggerNode
		// component's Play button is hidden (isSaved=false) in that case, and
		// the fallback to pipelineName handles any legacy data that slips through.
		const trigger = makeTrigger('t1', 'time.heartbeat');
		const pipeline = makePipeline('p1', { nodes: [trigger] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { subscriptionName?: string }).subscriptionName).toBeUndefined();
	});

	it('calls onConfigureNode callback and passes it to node data', () => {
		const callback = vi.fn();
		const pipeline = makePipeline('p1', { nodes: [makeTrigger('t1', 'file.changed')] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1', callback);
		expect((nodes[0].data as { onConfigure: typeof callback }).onConfigure).toBe(callback);
	});

	// ── hasPrompt ────────────────────────────────────────────────────────────

	it('hasPrompt is true when agent has inputPrompt', () => {
		const agent = makeAgent('a1', 'sess-1', 'Alice', { inputPrompt: 'Do something' });
		const pipeline = makePipeline('p1', { nodes: [agent] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { hasPrompt: boolean }).hasPrompt).toBe(true);
	});

	it('hasPrompt is true when agent has outputPrompt', () => {
		const agent = makeAgent('a1', 'sess-1', 'Alice', { outputPrompt: 'Summarise' });
		const pipeline = makePipeline('p1', { nodes: [agent] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { hasPrompt: boolean }).hasPrompt).toBe(true);
	});

	it('hasPrompt is true when an incoming edge has a prompt', () => {
		const trigger = makeTrigger('t1', 'time.heartbeat');
		const agent = makeAgent('a1', 'sess-1', 'Alice');
		const pipeline = makePipeline('p1', {
			nodes: [trigger, agent],
			edges: [{ ...makeEdge('e1', 't1', 'a1'), prompt: 'edge prompt' }],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const agentNode = nodes.find((n) => n.id === 'p1:a1')!;
		expect((agentNode.data as { hasPrompt: boolean }).hasPrompt).toBe(true);
	});

	it('hasPrompt is false when no prompt anywhere', () => {
		const agent = makeAgent('a1', 'sess-1', 'Alice');
		const pipeline = makePipeline('p1', { nodes: [agent] });
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		expect((nodes[0].data as { hasPrompt: boolean }).hasPrompt).toBe(false);
	});

	it('hasOutgoingEdge is true when agent has an outgoing edge', () => {
		const agent1 = makeAgent('a1', 'sess-1', 'Alice');
		const agent2 = makeAgent('a2', 'sess-2', 'Bob', {}, { x: 400, y: 0 });
		const pipeline = makePipeline('p1', {
			nodes: [agent1, agent2],
			edges: [makeEdge('e1', 'a1', 'a2')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const a1Node = nodes.find((n) => n.id === 'p1:a1')!;
		const a2Node = nodes.find((n) => n.id === 'p1:a2')!;
		expect((a1Node.data as { hasOutgoingEdge: boolean }).hasOutgoingEdge).toBe(true);
		expect((a2Node.data as { hasOutgoingEdge: boolean }).hasOutgoingEdge).toBe(false);
	});

	// ── Selected pipeline view ───────────────────────────────────────────────

	it('only renders nodes from the selected pipeline', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed'), makeAgent('a2', 'sess-2', 'Bob')],
		});
		const nodes = convertToReactFlowNodes([p1, p2], 'p1');
		const ids = nodes.map((n) => n.id);
		expect(ids).toContain('p1:t1');
		expect(ids).toContain('p1:a1');
		expect(ids).not.toContain('p2:t2');
		expect(ids).not.toContain('p2:a2');
	});

	it('BUG FIX: does NOT render a ghost copy of a shared agent from another pipeline when one is selected', () => {
		// This is the primary regression test for the "second one pops up" bug.
		// Pipeline 1 has Pedsidian. Pipeline 2 (selected) also has Pedsidian.
		// Before the fix, Pipeline 1's Pedsidian would appear at 40% opacity on the canvas.
		// After the fix, only the selected pipeline's copy is visible.
		const sharedSessionId = 'sess-pedsidian';
		const p1 = makePipeline('p1', {
			color: '#06b6d4',
			nodes: [makeAgent('a1', sharedSessionId, 'Pedsidian', {}, { x: 0, y: 0 })],
		});
		const p2 = makePipeline('p2', {
			color: '#8b5cf6',
			nodes: [makeAgent('a2', sharedSessionId, 'Pedsidian', {}, { x: 0, y: 0 })],
		});
		// p2 is selected — only p2's Pedsidian should appear
		const nodes = convertToReactFlowNodes([p1, p2], 'p2');
		const ids = nodes.map((n) => n.id);
		expect(ids).toHaveLength(1);
		expect(ids).toContain('p2:a2');
		expect(ids).not.toContain('p1:a1');
	});

	it('BUG FIX: no ghost agent appears even when the agent is unique to one pipeline and the other is selected', () => {
		// Simulates the exact user scenario: existing pipeline has Pedsidian,
		// user creates new pipeline (selected), drags Pedsidian in.
		const sharedSessionId = 'sess-pedsidian';
		const p1 = makePipeline('p1', {
			nodes: [makeAgent('a1', sharedSessionId, 'Pedsidian')],
		});
		// New pipeline just got Pedsidian dragged in
		const p2 = makePipeline('p2', {
			nodes: [makeAgent('a2', sharedSessionId, 'Pedsidian')],
		});
		const nodes = convertToReactFlowNodes([p1, p2], 'p2');
		// Should see exactly ONE Pedsidian node (from p2, not a dimmed copy from p1)
		const pedsidianNodes = nodes.filter(
			(n) => (n.data as { sessionId: string }).sessionId === sharedSessionId
		);
		expect(pedsidianNodes).toHaveLength(1);
		expect(pedsidianNodes[0].id).toBe('p2:a2');
		// No opacity dimming on any node
		expect(nodes.every((n) => n.style === undefined || n.style?.opacity === undefined)).toBe(true);
	});

	// ── All Pipelines view ───────────────────────────────────────────────────

	it('All Pipelines view renders nodes from all pipelines', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed'), makeAgent('a2', 'sess-2', 'Bob')],
		});
		const nodes = convertToReactFlowNodes([p1, p2], null);
		const ids = nodes.map((n) => n.id);
		expect(ids).toContain('p1:t1');
		expect(ids).toContain('p1:a1');
		expect(ids).toContain('p2:t2');
		expect(ids).toContain('p2:a2');
	});

	it('All Pipelines view: shared agent appears once per pipeline (both active, no dimming)', () => {
		const sharedSessionId = 'sess-shared';
		const p1 = makePipeline('p1', {
			nodes: [makeAgent('a1', sharedSessionId, 'Shared', {}, { x: 0, y: 0 })],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeAgent('a2', sharedSessionId, 'Shared', {}, { x: 0, y: 0 })],
		});
		const nodes = convertToReactFlowNodes([p1, p2], null);
		// Both copies are visible (one per pipeline) and neither is dimmed
		const ids = nodes.map((n) => n.id);
		expect(ids).toContain('p1:a1');
		expect(ids).toContain('p2:a2');
		expect(nodes.every((n) => n.style === undefined || n.style?.opacity === undefined)).toBe(true);
	});

	// ── Multi-pipeline color metadata ────────────────────────────────────────

	it('agent in a single pipeline has pipelineCount=1 and single color', () => {
		const pipeline = makePipeline('p1', {
			color: '#06b6d4',
			nodes: [makeAgent('a1', 'sess-1', 'Solo')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const data = nodes[0].data as { pipelineCount: number; pipelineColors: string[] };
		expect(data.pipelineCount).toBe(1);
		expect(data.pipelineColors).toEqual(['#06b6d4']);
	});

	it('shared agent in selected pipeline carries multi-pipeline color metadata', () => {
		// Even though we only render the active pipeline's node,
		// the pipelineCount and pipelineColors should reflect ALL pipelines it appears in.
		const p1 = makePipeline('p1', {
			color: '#06b6d4',
			nodes: [makeAgent('a1', 'sess-shared', 'Pedsidian')],
		});
		const p2 = makePipeline('p2', {
			color: '#8b5cf6',
			nodes: [makeAgent('a2', 'sess-shared', 'Pedsidian')],
		});
		const nodes = convertToReactFlowNodes([p1, p2], 'p2');
		const agentNode = nodes.find((n) => n.id === 'p2:a2')!;
		const data = agentNode.data as { pipelineCount: number; pipelineColors: string[] };
		// Count = 2 (appears in both p1 and p2)
		expect(data.pipelineCount).toBe(2);
		// Colors include both pipelines
		expect(data.pipelineColors).toContain('#06b6d4');
		expect(data.pipelineColors).toContain('#8b5cf6');
	});

	it('agent color indicator shows all pipeline colors even in selected view', () => {
		// Three pipelines share the same agent
		const p1 = makePipeline('p1', { color: '#06b6d4', nodes: [makeAgent('a1', 'sess-x', 'X')] });
		const p2 = makePipeline('p2', { color: '#8b5cf6', nodes: [makeAgent('a2', 'sess-x', 'X')] });
		const p3 = makePipeline('p3', { color: '#f59e0b', nodes: [makeAgent('a3', 'sess-x', 'X')] });
		// Viewing p3
		const nodes = convertToReactFlowNodes([p1, p2, p3], 'p3');
		expect(nodes).toHaveLength(1);
		const data = nodes[0].data as { pipelineCount: number; pipelineColors: string[] };
		expect(data.pipelineCount).toBe(3);
		expect(data.pipelineColors).toHaveLength(3);
	});

	// ── Y-offset stacking (All Pipelines view) ───────────────────────────────

	it('applies y-offsets in All Pipelines view to stack pipelines vertically', () => {
		// Both pipelines have their single node at y=50.
		// The algorithm normalises p1 to start at y=0 (offset = -minY = -50),
		// then places p2 after p1 ends (NODE_HEIGHT=100, PIPELINE_GAP=100).
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 0, y: 50 })],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed', {}, { x: 0, y: 50 })],
		});
		const nodes = convertToReactFlowNodes([p1, p2], null);
		const t1 = nodes.find((n) => n.id === 'p1:t1')!;
		const t2 = nodes.find((n) => n.id === 'p2:t2')!;
		// p1 is normalised: y = 50 + (-50) = 0
		expect(t1.position.y).toBe(0);
		// p2 comes after: y = 50 + offset, where offset > 50 → rendered y > 100
		expect(t2.position.y).toBeGreaterThan(t1.position.y);
	});

	it('does NOT apply y-offsets when only one pipeline', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 10, y: 30 })],
		});
		const nodes = convertToReactFlowNodes([pipeline], null);
		expect(nodes[0].position).toEqual({ x: 10, y: 30 });
	});

	it('does NOT apply y-offsets in selected pipeline view', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 0, y: 100 })],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed', {}, { x: 0, y: 100 })],
		});
		// Select p1 — no offsets should be computed
		const nodes = convertToReactFlowNodes([p1, p2], 'p1');
		const t1 = nodes.find((n) => n.id === 'p1:t1')!;
		expect(t1.position.y).toBe(100);
	});

	// ── Drag handle ──────────────────────────────────────────────────────────

	it('all rendered nodes have dragHandle set', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		for (const node of nodes) {
			expect(node.dragHandle).toBe('.drag-handle');
		}
	});
});

// ─── convertToReactFlowEdges ──────────────────────────────────────────────────

describe('convertToReactFlowEdges', () => {
	it('returns empty array for pipelines with no edges', () => {
		const pipelines = [makePipeline('p1'), makePipeline('p2')];
		expect(convertToReactFlowEdges(pipelines, null)).toEqual([]);
	});

	it('creates edge with composite source/target ids', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1');
		expect(edges).toHaveLength(1);
		expect(edges[0].id).toBe('p1:e1');
		expect(edges[0].source).toBe('p1:t1');
		expect(edges[0].target).toBe('p1:a1');
		expect(edges[0].type).toBe('pipeline');
	});

	it('marks edges from selected pipeline as isActivePipeline=true', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1');
		expect((edges[0].data as { isActivePipeline: boolean }).isActivePipeline).toBe(true);
	});

	it('excludes edges from non-selected pipeline', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed'), makeAgent('a2', 'sess-2', 'Bob')],
			edges: [makeEdge('e2', 't2', 'a2')],
		});
		const edges = convertToReactFlowEdges([p1, p2], 'p2');
		// Non-active pipeline edges are excluded to prevent orphaned edges
		// (their source/target nodes are not rendered by convertToReactFlowNodes)
		expect(edges.find((e) => e.id === 'p1:e1')).toBeUndefined();
		const e2 = edges.find((e) => e.id === 'p2:e2')!;
		expect((e2.data as { isActivePipeline: boolean }).isActivePipeline).toBe(true);
	});

	it('marks all edges as active in All Pipelines view', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed'), makeAgent('a2', 'sess-2', 'Bob')],
			edges: [makeEdge('e2', 't2', 'a2')],
		});
		const edges = convertToReactFlowEdges([p1, p2], null);
		for (const edge of edges) {
			expect((edge.data as { isActivePipeline: boolean }).isActivePipeline).toBe(true);
		}
	});

	it('marks edge as selected when its id matches selectedEdgeId', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1', 'p1:e1');
		expect(edges[0].selected).toBe(true);
	});

	it('does not mark edge as selected when id does not match', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1', 'p1:e2');
		expect(edges[0].selected).toBe(false);
	});

	it('marks edge as isRunning when its TARGET agent is currently executing', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const runningByPipeline = new Map<string, Set<string>>([['p1', new Set(['Alice'])]]);
		const edges = convertToReactFlowEdges(
			[pipeline],
			'p1',
			undefined,
			undefined,
			runningByPipeline
		);
		expect((edges[0].data as { isRunning: boolean }).isRunning).toBe(true);
	});

	it('does not mark edge as running when no agents are running in this pipeline', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const runningByPipeline = new Map<string, Set<string>>([['p2', new Set(['Alice'])]]);
		const edges = convertToReactFlowEdges(
			[pipeline],
			'p1',
			undefined,
			undefined,
			runningByPipeline
		);
		expect((edges[0].data as { isRunning: boolean }).isRunning).toBe(false);
	});

	it('carries pipeline color on edge data', () => {
		const pipeline = makePipeline('p1', {
			color: '#ef4444',
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1');
		expect((edges[0].data as { pipelineColor: string }).pipelineColor).toBe('#ef4444');
	});

	it('selected edge gets larger marker than unselected', () => {
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a1', 'sess-1', 'Alice'),
				makeAgent('a2', 'sess-2', 'Bob'),
			],
			edges: [makeEdge('e1', 't1', 'a1'), makeEdge('e2', 'a1', 'a2')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1', 'p1:e1');
		const e1 = edges.find((e) => e.id === 'p1:e1')!;
		const e2 = edges.find((e) => e.id === 'p1:e2')!;
		const e1Marker = e1.markerEnd as { width: number; height: number };
		const e2Marker = e2.markerEnd as { width: number; height: number };
		expect(e1Marker.width).toBeGreaterThan(e2Marker.width);
		expect(e1Marker.height).toBeGreaterThan(e2Marker.height);
	});

	it('renders edges from multiple pipelines in All Pipelines view', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed'), makeAgent('a2', 'sess-2', 'Bob')],
			edges: [makeEdge('e2', 't2', 'a2')],
		});
		const edges = convertToReactFlowEdges([p1, p2], null);
		expect(edges).toHaveLength(2);
		expect(edges.map((e) => e.id)).toContain('p1:e1');
		expect(edges.map((e) => e.id)).toContain('p2:e2');
	});
});

// ─── Edge-animation edge cases (per-agent, not pipeline-wide) ────────────────

describe('convertToReactFlowEdges — per-agent edge animation', () => {
	// Regression guard for the "all edges animate when ANY run is active" bug.
	// Rule: an edge animates iff its target is an agent whose sessionName
	// appears in the pipeline's active-agents set.

	it('linear chain: only the edge feeding the running agent animates', () => {
		// Pipeline: trigger → A → B → C. Only B is running.
		// Expected: edge A→B animates, trigger→A and B→C are static.
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a', 'sess-a', 'A'),
				makeAgent('b', 'sess-b', 'B'),
				makeAgent('c', 'sess-c', 'C'),
			],
			edges: [makeEdge('e1', 't1', 'a'), makeEdge('e2', 'a', 'b'), makeEdge('e3', 'b', 'c')],
		});
		const running = new Map<string, Set<string>>([['p1', new Set(['B'])]]);
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, running);

		const running01 = (edges.find((e) => e.id === 'p1:e1')!.data as { isRunning: boolean })
			.isRunning;
		const running02 = (edges.find((e) => e.id === 'p1:e2')!.data as { isRunning: boolean })
			.isRunning;
		const running03 = (edges.find((e) => e.id === 'p1:e3')!.data as { isRunning: boolean })
			.isRunning;
		expect(running01).toBe(false);
		expect(running02).toBe(true);
		expect(running03).toBe(false);
	});

	it('linear chain: animation moves forward as the running agent advances', () => {
		// Simulate two ticks: first A running, then B running, then C running.
		// At each tick the animating edge shifts one step down the chain.
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a', 'sess-a', 'A'),
				makeAgent('b', 'sess-b', 'B'),
				makeAgent('c', 'sess-c', 'C'),
			],
			edges: [makeEdge('e1', 't1', 'a'), makeEdge('e2', 'a', 'b'), makeEdge('e3', 'b', 'c')],
		});

		const ranges = [
			{ running: 'A', expect: { 'p1:e1': true, 'p1:e2': false, 'p1:e3': false } },
			{ running: 'B', expect: { 'p1:e1': false, 'p1:e2': true, 'p1:e3': false } },
			{ running: 'C', expect: { 'p1:e1': false, 'p1:e2': false, 'p1:e3': true } },
		];
		for (const { running: runName, expect: expected } of ranges) {
			const runningMap = new Map<string, Set<string>>([['p1', new Set([runName])]]);
			const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, runningMap);
			for (const [edgeId, expectedRunning] of Object.entries(expected)) {
				const d = edges.find((e) => e.id === edgeId)!.data as { isRunning: boolean };
				expect(d.isRunning).toBe(expectedRunning);
			}
		}
	});

	it('fan-out: every edge feeding a running target animates concurrently', () => {
		// trigger → [A, B, C] and all three are running in parallel → all three edges animate.
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a', 'sess-a', 'A'),
				makeAgent('b', 'sess-b', 'B'),
				makeAgent('c', 'sess-c', 'C'),
			],
			edges: [makeEdge('e1', 't1', 'a'), makeEdge('e2', 't1', 'b'), makeEdge('e3', 't1', 'c')],
		});
		const running = new Map<string, Set<string>>([['p1', new Set(['A', 'B', 'C'])]]);
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, running);
		for (const e of edges) {
			expect((e.data as { isRunning: boolean }).isRunning).toBe(true);
		}
	});

	it('fan-out: only edges to running targets animate when some are still queued', () => {
		// trigger → [A, B, C]. A is running, B and C are still queued.
		// Expected: only trigger→A animates.
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a', 'sess-a', 'A'),
				makeAgent('b', 'sess-b', 'B'),
				makeAgent('c', 'sess-c', 'C'),
			],
			edges: [makeEdge('e1', 't1', 'a'), makeEdge('e2', 't1', 'b'), makeEdge('e3', 't1', 'c')],
		});
		const running = new Map<string, Set<string>>([['p1', new Set(['A'])]]);
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, running);
		expect((edges.find((e) => e.id === 'p1:e1')!.data as { isRunning: boolean }).isRunning).toBe(
			true
		);
		expect((edges.find((e) => e.id === 'p1:e2')!.data as { isRunning: boolean }).isRunning).toBe(
			false
		);
		expect((edges.find((e) => e.id === 'p1:e3')!.data as { isRunning: boolean }).isRunning).toBe(
			false
		);
	});

	it('fan-in: all incoming edges to the running target animate simultaneously', () => {
		// [A, B] → C (fan-in). When C is running, both A→C and B→C animate.
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a', 'sess-a', 'A'),
				makeAgent('b', 'sess-b', 'B'),
				makeAgent('c', 'sess-c', 'C'),
			],
			edges: [
				makeEdge('e1', 't1', 'a'),
				makeEdge('e2', 't1', 'b'),
				makeEdge('e3', 'a', 'c'),
				makeEdge('e4', 'b', 'c'),
			],
		});
		const running = new Map<string, Set<string>>([['p1', new Set(['C'])]]);
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, running);
		expect((edges.find((e) => e.id === 'p1:e3')!.data as { isRunning: boolean }).isRunning).toBe(
			true
		);
		expect((edges.find((e) => e.id === 'p1:e4')!.data as { isRunning: boolean }).isRunning).toBe(
			true
		);
		// Feeds into A/B (not running) stay static.
		expect((edges.find((e) => e.id === 'p1:e1')!.data as { isRunning: boolean }).isRunning).toBe(
			false
		);
		expect((edges.find((e) => e.id === 'p1:e2')!.data as { isRunning: boolean }).isRunning).toBe(
			false
		);
	});

	it('no animation when no agent is running in the pipeline', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a', 'sess-a', 'A')],
			edges: [makeEdge('e1', 't1', 'a')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, new Map());
		expect((edges[0].data as { isRunning: boolean }).isRunning).toBe(false);
	});

	it('edges whose target is NOT an agent (cli_output, error) never animate', () => {
		// Edges pointing at non-agent nodes can't correspond to an active run —
		// don't animate them even if an agent with a matching name is running.
		const pipeline = makePipeline('p1', {
			nodes: [
				makeTrigger('t1', 'time.heartbeat'),
				makeAgent('a', 'sess-a', 'A'),
				{
					id: 'cli',
					type: 'cli_output',
					position: { x: 0, y: 0 },
					data: { target: 'some-target' } as { target: string },
				},
			],
			edges: [makeEdge('e1', 't1', 'a'), makeEdge('e2', 'a', 'cli')],
		});
		const running = new Map<string, Set<string>>([['p1', new Set(['A'])]]);
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, running);
		// Edge to A (agent) animates; edge to cli (non-agent) does not.
		expect((edges.find((e) => e.id === 'p1:e1')!.data as { isRunning: boolean }).isRunning).toBe(
			true
		);
		expect((edges.find((e) => e.id === 'p1:e2')!.data as { isRunning: boolean }).isRunning).toBe(
			false
		);
	});

	it('multi-pipeline: a run in pipeline A does not animate edges in pipeline B', () => {
		// Pipeline A and B both contain an agent named "Worker". Only pipeline A
		// has an active run. Pipeline B's identically-named agent must NOT
		// have its incoming edge animated — the map is keyed by pipeline id.
		const pA = makePipeline('pA', {
			nodes: [makeTrigger('tA', 'time.heartbeat'), makeAgent('a', 'sess-shared', 'Worker')],
			edges: [makeEdge('eA', 'tA', 'a')],
		});
		const pB = makePipeline('pB', {
			nodes: [makeTrigger('tB', 'time.heartbeat'), makeAgent('b', 'sess-shared', 'Worker')],
			edges: [makeEdge('eB', 'tB', 'b')],
		});
		const running = new Map<string, Set<string>>([['pA', new Set(['Worker'])]]);
		const edges = convertToReactFlowEdges([pA, pB], null, undefined, undefined, running);
		expect((edges.find((e) => e.id === 'pA:eA')!.data as { isRunning: boolean }).isRunning).toBe(
			true
		);
		expect((edges.find((e) => e.id === 'pB:eB')!.data as { isRunning: boolean }).isRunning).toBe(
			false
		);
	});

	it('omitted runningAgentsByPipeline means no edges animate (no accidental global fallback)', () => {
		// Defensive: passing `undefined` must not re-activate a pipeline-wide
		// animation path. Absence of the argument = "no known running agents".
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a', 'sess-a', 'A')],
			edges: [makeEdge('e1', 't1', 'a')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1');
		expect((edges[0].data as { isRunning: boolean }).isRunning).toBe(false);
	});

	it('running agent with no incoming edges (hypothetical orphan) does not crash', () => {
		// Defensive guard: an orphan agent isn't in `pipeline.edges`, so there's
		// nothing to animate anyway. No edge-level crash.
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a', 'sess-a', 'A')],
			edges: [], // no edges
		});
		const running = new Map<string, Set<string>>([['p1', new Set(['A'])]]);
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, undefined, running);
		expect(edges).toEqual([]);
	});
});

describe('convertToReactFlowNodes triggerOptions', () => {
	it('passes trigger options to trigger node data', () => {
		const onTriggerPipeline = vi.fn();
		const runningPipelineIds = new Set(['p1']);
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat')],
		});

		const nodes = convertToReactFlowNodes([pipeline], 'p1', undefined, {
			onTriggerPipeline,
			isSaved: true,
			runningPipelineIds,
		});

		expect(nodes).toHaveLength(1);
		const triggerData = nodes[0].data as any;
		expect(triggerData.onTriggerPipeline).toBe(onTriggerPipeline);
		expect(triggerData.pipelineName).toBe('Pipeline p1');
		expect(triggerData.isSaved).toBe(true);
		expect(triggerData.isRunning).toBe(true);
	});

	it('sets isRunning to false when pipeline is not in runningPipelineIds', () => {
		const pipeline = makePipeline('p2', {
			nodes: [makeTrigger('t1', 'time.heartbeat')],
		});

		const nodes = convertToReactFlowNodes([pipeline], 'p2', undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: true,
			runningPipelineIds: new Set(['other']),
		});

		const triggerData = nodes[0].data as any;
		expect(triggerData.isRunning).toBe(false);
	});

	it('does not include trigger options when not provided', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat')],
		});

		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const triggerData = nodes[0].data as any;
		expect(triggerData.onTriggerPipeline).toBeUndefined();
		expect(triggerData.pipelineName).toBe('Pipeline p1');
		expect(triggerData.isSaved).toBeUndefined();
		// `isRunning` is now always a boolean (false when no running info
		// is supplied) so the Play button renders a stable initial state.
		// Falsy matches the old `undefined` semantics for the Play button.
		expect(triggerData.isRunning).toBe(false);
	});
});

// ─── Per-trigger isRunning (one sub → one trigger spinner) ───────────────────

describe('convertToReactFlowNodes — per-trigger isRunning', () => {
	// Regression guard for the "all trigger icons spin when any sub runs" bug.
	// A multi-trigger pipeline (startup + scheduled + GitHub PR) generates
	// three trigger nodes sharing one pipeline. Only the trigger whose own
	// subscription has an active run should animate.

	function triggerWithSub(id: string, eventType: TriggerNodeData['eventType'], subName: string) {
		const t = makeTrigger(id, eventType);
		(t.data as TriggerNodeData).subscriptionName = subName;
		return t;
	}

	it('in a multi-trigger pipeline, only the trigger whose sub is running animates', () => {
		// Pipeline 1 has three triggers: the startup sub ("Pipeline 1"),
		// the scheduled chain-1 sub, and the GitHub chain-2 sub. Only the
		// scheduled chain-1 sub is actively running in this tick.
		const t1 = triggerWithSub('t1', 'app.startup', 'Pipeline 1');
		const t2 = triggerWithSub('t2', 'time.scheduled', 'Pipeline 1-chain-1');
		const t3 = triggerWithSub('t3', 'github.pull_request', 'Pipeline 1-chain-2');
		const pipeline: CuePipeline = {
			id: 'p1',
			name: 'Pipeline 1',
			color: '#06b6d4',
			nodes: [t1, t2, t3],
			edges: [],
		};

		const runningByPipeline = new Map<string, Set<string>>([
			['p1', new Set(['Pipeline 1-chain-1'])],
		]);
		const nodes = convertToReactFlowNodes([pipeline], 'p1', undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: true,
			runningPipelineIds: new Set(['p1']),
			runningSubscriptionsByPipeline: runningByPipeline,
		});

		const byId = Object.fromEntries(
			nodes.map((n) => [n.id, (n.data as { isRunning: boolean }).isRunning])
		);
		expect(byId['p1:t1']).toBe(false);
		expect(byId['p1:t2']).toBe(true);
		expect(byId['p1:t3']).toBe(false);
	});

	it('single-trigger pipeline: the only trigger animates when its sub runs', () => {
		const t = triggerWithSub('t1', 'time.heartbeat', 'solo');
		const pipeline: CuePipeline = {
			id: 'p1',
			name: 'solo',
			color: '#06b6d4',
			nodes: [t],
			edges: [],
		};
		const runningByPipeline = new Map<string, Set<string>>([['p1', new Set(['solo'])]]);
		const nodes = convertToReactFlowNodes([pipeline], 'p1', undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: true,
			runningPipelineIds: new Set(['p1']),
			runningSubscriptionsByPipeline: runningByPipeline,
		});
		expect((nodes[0].data as { isRunning: boolean }).isRunning).toBe(true);
	});

	it('concurrent: two trigger subs running together → both triggers animate, third stays static', () => {
		// Startup and GitHub both have live runs; scheduled does not.
		const t1 = triggerWithSub('t1', 'app.startup', 'Pipeline 1');
		const t2 = triggerWithSub('t2', 'time.scheduled', 'Pipeline 1-chain-1');
		const t3 = triggerWithSub('t3', 'github.pull_request', 'Pipeline 1-chain-2');
		const pipeline: CuePipeline = {
			id: 'p1',
			name: 'Pipeline 1',
			color: '#06b6d4',
			nodes: [t1, t2, t3],
			edges: [],
		};
		const runningByPipeline = new Map<string, Set<string>>([
			['p1', new Set(['Pipeline 1', 'Pipeline 1-chain-2'])],
		]);
		const nodes = convertToReactFlowNodes([pipeline], 'p1', undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: true,
			runningPipelineIds: new Set(['p1']),
			runningSubscriptionsByPipeline: runningByPipeline,
		});
		const byId = Object.fromEntries(
			nodes.map((n) => [n.id, (n.data as { isRunning: boolean }).isRunning])
		);
		expect(byId['p1:t1']).toBe(true);
		expect(byId['p1:t2']).toBe(false);
		expect(byId['p1:t3']).toBe(true);
	});

	it('no active runs → no trigger animates even when the pipeline was in runningPipelineIds', () => {
		// Defensive: runningPipelineIds is a broader signal that may linger
		// momentarily. When the per-sub map is empty, no trigger should spin.
		const t = triggerWithSub('t1', 'time.heartbeat', 'solo');
		const pipeline: CuePipeline = {
			id: 'p1',
			name: 'solo',
			color: '#06b6d4',
			nodes: [t],
			edges: [],
		};
		const nodes = convertToReactFlowNodes([pipeline], 'p1', undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: true,
			runningPipelineIds: new Set(['p1']),
			runningSubscriptionsByPipeline: new Map(),
		});
		expect((nodes[0].data as { isRunning: boolean }).isRunning).toBe(false);
	});

	it('legacy trigger without subscriptionName falls back to pipeline-wide running flag', () => {
		// Never-saved pipelines won't have `subscriptionName` stamped on the
		// trigger. The Play button is hidden in that case anyway, but the
		// `isRunning` state should still reflect pipeline-wide activity for
		// any consumer that reads it (e.g. legacy config-panel bindings).
		const t = makeTrigger('t1', 'time.heartbeat'); // no subscriptionName
		const pipeline: CuePipeline = {
			id: 'p1',
			name: 'legacy',
			color: '#06b6d4',
			nodes: [t],
			edges: [],
		};
		const nodes = convertToReactFlowNodes([pipeline], 'p1', undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: false, // unsaved — Play button hidden, but isRunning still resolves
			runningPipelineIds: new Set(['p1']),
			runningSubscriptionsByPipeline: new Map(),
		});
		expect((nodes[0].data as { isRunning: boolean }).isRunning).toBe(true);
	});

	it('multi-pipeline: trigger animation is scoped to its own pipeline', () => {
		// Pipeline A has a sub "shared-sub". Pipeline B also has a sub
		// "shared-sub" (impossible in practice, but tests isolation by pipeline id).
		const tA = triggerWithSub('tA', 'app.startup', 'A');
		const tB = triggerWithSub('tB', 'app.startup', 'B');
		const pA: CuePipeline = {
			id: 'pA',
			name: 'A',
			color: '#ef4444',
			nodes: [tA],
			edges: [],
		};
		const pB: CuePipeline = {
			id: 'pB',
			name: 'B',
			color: '#06b6d4',
			nodes: [tB],
			edges: [],
		};
		const runningByPipeline = new Map<string, Set<string>>([['pA', new Set(['A'])]]);
		const nodes = convertToReactFlowNodes([pA, pB], null, undefined, {
			onTriggerPipeline: vi.fn(),
			isSaved: true,
			runningPipelineIds: new Set(['pA']),
			runningSubscriptionsByPipeline: runningByPipeline,
		});
		const byId = Object.fromEntries(
			nodes.map((n) => [n.id, (n.data as { isRunning: boolean }).isRunning])
		);
		expect(byId['pA:tA']).toBe(true);
		expect(byId['pB:tB']).toBe(false);
	});
});

// ─── computePipelineYOffsets ────────────────────────────────────────────────

describe('computePipelineYOffsets', () => {
	it('returns empty map when a pipeline is selected', () => {
		const pipelines: CuePipeline[] = [
			{
				id: 'p1',
				name: 'P1',
				color: '#ef4444',
				nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 0, y: 50 })],
				edges: [],
			},
			{
				id: 'p2',
				name: 'P2',
				color: '#3b82f6',
				nodes: [makeTrigger('t2', 'file.changed', {}, { x: 0, y: 100 })],
				edges: [],
			},
		];
		const offsets = computePipelineYOffsets(pipelines, 'p1');
		expect(offsets.size).toBe(0);
	});

	it('returns empty map when there is only one pipeline', () => {
		const pipelines: CuePipeline[] = [
			{
				id: 'p1',
				name: 'P1',
				color: '#ef4444',
				nodes: [makeTrigger('t1', 'time.heartbeat')],
				edges: [],
			},
		];
		const offsets = computePipelineYOffsets(pipelines, null);
		expect(offsets.size).toBe(0);
	});

	it('computes offsets so pipelines stack without overlap', () => {
		const pipelines: CuePipeline[] = [
			{
				id: 'p1',
				name: 'P1',
				color: '#ef4444',
				nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 0, y: 0 })],
				edges: [],
			},
			{
				id: 'p2',
				name: 'P2',
				color: '#3b82f6',
				nodes: [makeTrigger('t2', 'file.changed', {}, { x: 0, y: 0 })],
				edges: [],
			},
		];
		const offsets = computePipelineYOffsets(pipelines, null);
		expect(offsets.get('p1')).toBe(0); // first pipeline starts at y=0
		expect(offsets.get('p2')).toBeGreaterThan(0); // second pipeline is pushed down
	});

	it('skips empty pipelines', () => {
		const pipelines: CuePipeline[] = [
			{
				id: 'p1',
				name: 'P1',
				color: '#ef4444',
				nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 0, y: 0 })],
				edges: [],
			},
			{ id: 'p2', name: 'P2', color: '#3b82f6', nodes: [], edges: [] },
			{
				id: 'p3',
				name: 'P3',
				color: '#22c55e',
				nodes: [makeTrigger('t3', 'file.changed', {}, { x: 0, y: 0 })],
				edges: [],
			},
		];
		const offsets = computePipelineYOffsets(pipelines, null);
		expect(offsets.has('p2')).toBe(false);
		expect(offsets.has('p1')).toBe(true);
		expect(offsets.has('p3')).toBe(true);
	});

	it('produces offsets consistent with convertToReactFlowNodes', () => {
		const pipelines: CuePipeline[] = [
			{
				id: 'p1',
				name: 'P1',
				color: '#ef4444',
				nodes: [makeTrigger('t1', 'time.heartbeat', {}, { x: 0, y: 10 })],
				edges: [],
			},
			{
				id: 'p2',
				name: 'P2',
				color: '#3b82f6',
				nodes: [makeTrigger('t2', 'file.changed', {}, { x: 0, y: 20 })],
				edges: [],
			},
		];
		const offsets = computePipelineYOffsets(pipelines, null);
		const nodes = convertToReactFlowNodes(pipelines, null);

		// The ReactFlow node position should equal canonical position + offset
		const p1Node = nodes.find((n) => n.id === 'p1:t1')!;
		const p2Node = nodes.find((n) => n.id === 'p2:t2')!;
		expect(p1Node.position.y).toBe(10 + (offsets.get('p1') ?? 0));
		expect(p2Node.position.y).toBe(20 + (offsets.get('p2') ?? 0));
	});
});

// ─── Fan-out count ────────────────────────────────────────────────────────────

describe('convertToReactFlowNodes fanOutCount', () => {
	it('trigger node has fanOutCount when it fans out to multiple agents', () => {
		const trigger = makeTrigger('t1', 'time.heartbeat');
		const a1 = makeAgent('a1', 'sess-1', 'Alice');
		const a2 = makeAgent('a2', 'sess-2', 'Bob');
		const a3 = makeAgent('a3', 'sess-3', 'Carol');
		const pipeline = makePipeline('p1', {
			nodes: [trigger, a1, a2, a3],
			edges: [makeEdge('e1', 't1', 'a1'), makeEdge('e2', 't1', 'a2'), makeEdge('e3', 't1', 'a3')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const triggerNode = nodes.find((n) => n.id === 'p1:t1')!;
		expect((triggerNode.data as any).fanOutCount).toBe(3);
	});

	it('trigger node has no fanOutCount when it targets a single agent', () => {
		const trigger = makeTrigger('t1', 'time.heartbeat');
		const agent = makeAgent('a1', 'sess-1', 'Alice');
		const pipeline = makePipeline('p1', {
			nodes: [trigger, agent],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const triggerNode = nodes.find((n) => n.id === 'p1:t1')!;
		expect((triggerNode.data as any).fanOutCount).toBeUndefined();
	});
});

// ─── Instance labels ──────────────────────────────────────────────────────────

describe('convertToReactFlowNodes instanceLabel', () => {
	it('assigns instance labels when the same sessionId appears multiple times', () => {
		const a1 = makeAgent('a1', 'sess-shared', 'Worker');
		const a2 = makeAgent('a2', 'sess-shared', 'Worker', {}, { x: 400, y: 0 });
		const pipeline = makePipeline('p1', {
			nodes: [a1, a2],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const node1 = nodes.find((n) => n.id === 'p1:a1')!;
		const node2 = nodes.find((n) => n.id === 'p1:a2')!;
		expect((node1.data as any).instanceLabel).toBe(1);
		expect((node2.data as any).instanceLabel).toBe(2);
	});

	it('does not assign instance labels when all agents have unique sessionIds', () => {
		const a1 = makeAgent('a1', 'sess-1', 'Alice');
		const a2 = makeAgent('a2', 'sess-2', 'Bob');
		const pipeline = makePipeline('p1', {
			nodes: [a1, a2],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const node1 = nodes.find((n) => n.id === 'p1:a1')!;
		const node2 = nodes.find((n) => n.id === 'p1:a2')!;
		expect((node1.data as any).instanceLabel).toBeUndefined();
		expect((node2.data as any).instanceLabel).toBeUndefined();
	});
});

describe('convertToReactFlowNodes fanInCount', () => {
	it('sets fanInCount for agent with multiple incoming agent edges', () => {
		const a = makeAgent('a', 'sa', 'Alice');
		const b = makeAgent('b', 'sb', 'Bob');
		const c = makeAgent('c', 'sc', 'Carol');
		const d = makeAgent('d', 'sd', 'Dave');
		const pipeline = makePipeline('p1', {
			nodes: [a, b, c, d],
			edges: [makeEdge('e1', 'a', 'd'), makeEdge('e2', 'b', 'd'), makeEdge('e3', 'c', 'd')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const nodeD = nodes.find((n) => n.id === 'p1:d')!;
		expect((nodeD.data as any).fanInCount).toBe(3);
	});

	it('does not set fanInCount for agent with single incoming agent edge', () => {
		const a = makeAgent('a', 'sa', 'Alice');
		const d = makeAgent('d', 'sd', 'Dave');
		const pipeline = makePipeline('p1', {
			nodes: [a, d],
			edges: [makeEdge('e1', 'a', 'd')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const nodeD = nodes.find((n) => n.id === 'p1:d')!;
		expect((nodeD.data as any).fanInCount).toBeUndefined();
	});

	it('does not count trigger edges as fan-in', () => {
		const t = makeTrigger('t1', 'time.heartbeat', { interval_minutes: 5 });
		const a = makeAgent('a', 'sa', 'Alice');
		const d = makeAgent('d', 'sd', 'Dave');
		const pipeline = makePipeline('p1', {
			nodes: [t, a, d],
			edges: [makeEdge('e1', 't1', 'd'), makeEdge('e2', 'a', 'd')],
		});
		const nodes = convertToReactFlowNodes([pipeline], 'p1');
		const nodeD = nodes.find((n) => n.id === 'p1:d')!;
		expect((nodeD.data as any).fanInCount).toBeUndefined();
	});
});
