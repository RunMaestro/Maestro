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

	it('marks edges from non-selected pipeline as isActivePipeline=false', () => {
		const p1 = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const p2 = makePipeline('p2', {
			nodes: [makeTrigger('t2', 'file.changed'), makeAgent('a2', 'sess-2', 'Bob')],
			edges: [makeEdge('e2', 't2', 'a2')],
		});
		const edges = convertToReactFlowEdges([p1, p2], 'p2');
		const e1 = edges.find((e) => e.id === 'p1:e1')!;
		const e2 = edges.find((e) => e.id === 'p2:e2')!;
		expect((e1.data as { isActivePipeline: boolean }).isActivePipeline).toBe(false);
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
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, 'p1:e1');
		expect(edges[0].selected).toBe(true);
	});

	it('does not mark edge as selected when id does not match', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, 'p1:e2');
		expect(edges[0].selected).toBe(false);
	});

	it('marks edge data as isRunning when pipeline is in runningPipelineIds', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const running = new Set(['p1']);
		const edges = convertToReactFlowEdges([pipeline], 'p1', running);
		expect((edges[0].data as { isRunning: boolean }).isRunning).toBe(true);
	});

	it('does not mark edge as running when pipeline is not in runningPipelineIds', () => {
		const pipeline = makePipeline('p1', {
			nodes: [makeTrigger('t1', 'time.heartbeat'), makeAgent('a1', 'sess-1', 'Alice')],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const running = new Set(['p2']);
		const edges = convertToReactFlowEdges([pipeline], 'p1', running);
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
		const edges = convertToReactFlowEdges([pipeline], 'p1', undefined, 'p1:e1');
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
