import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useCueDirtyStore } from '../../../../renderer/stores/cueDirtyStore';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	usePipelineState,
	validatePipelines,
	DEFAULT_TRIGGER_LABELS,
} from '../../../../renderer/hooks/cue/usePipelineState';
import type { UsePipelineStateParams } from '../../../../renderer/hooks/cue/usePipelineState';
import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge,
} from '../../../../shared/cue-pipeline-types';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const mockPersistLayout = vi.fn();
const mockPendingSavedViewportRef = {
	current: null as null | { x: number; y: number; zoom: number },
};
vi.mock('../../../../renderer/hooks/cue/usePipelineLayout', () => ({
	usePipelineLayout: vi.fn(() => ({
		persistLayout: mockPersistLayout,
		pendingSavedViewportRef: mockPendingSavedViewportRef,
		pipelinesLoaded: true,
	})),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineToYaml', () => ({
	pipelinesToYaml: vi.fn(() => ({ yaml: 'test', promptFiles: new Map() })),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline', () => ({
	graphSessionsToPipelines: vi.fn(() => []),
}));

vi.mock('../../../../renderer/components/CuePipelineEditor/pipelineColors', () => ({
	getNextPipelineColor: vi.fn(() => '#06b6d4'),
}));

const mockShowConfirmation = vi.fn((message: string, onConfirm: () => void) => {
	// By default, immediately invoke onConfirm (simulates user clicking "Confirm")
	onConfirm();
});
vi.mock('../../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({
		showConfirmation: mockShowConfirmation,
	}),
}));

const mockGetSettings = vi.fn().mockResolvedValue({
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 10,
});
const mockWriteYaml = vi.fn().mockResolvedValue(undefined);
const mockRefreshSession = vi.fn().mockResolvedValue(undefined);
const mockGetGraphData = vi.fn().mockResolvedValue([]);
// readYaml returns the same content pipelinesToYaml is mocked to produce, so
// handleSave's write-back verification passes.
const mockReadYaml = vi.fn().mockResolvedValue('test');

afterEach(() => {
	useCueDirtyStore.setState({ pipelineDirty: false, yamlDirty: false });
});

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		cue: {
			getSettings: mockGetSettings,
			writeYaml: mockWriteYaml,
			readYaml: mockReadYaml,
			refreshSession: mockRefreshSession,
			getGraphData: mockGetGraphData,
		},
	};
	vi.spyOn(window, 'confirm').mockReturnValue(true);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createDefaultParams(overrides?: Partial<UsePipelineStateParams>): UsePipelineStateParams {
	return {
		sessions: [],
		graphSessions: [],
		activeRuns: [],
		reactFlowInstance: { getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) } as any,
		selectedNodePipelineId: null,
		selectedEdgePipelineId: null,
		setSelectedNodeId: vi.fn(),
		setSelectedEdgeId: vi.fn(),
		setTriggerDrawerOpen: vi.fn(),
		setAgentDrawerOpen: vi.fn(),
		...overrides,
	};
}

function makeTriggerNode(id: string, eventType = 'file.changed' as const): PipelineNode {
	// Provide event-appropriate defaults so the per-event trigger config
	// validation (introduced to prevent broken YAML being saved) doesn't
	// fail tests that aren't asserting on trigger config specifics.
	const defaults: Record<string, Record<string, unknown>> = {
		'file.changed': { watch: '**/*' },
		'task.pending': { watch: '**/*.md' },
		'time.heartbeat': { interval_minutes: 5 },
		'time.scheduled': { schedule_times: ['09:00'] },
	};
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType,
			label: eventType,
			config: defaults[eventType] ?? {},
		},
	};
}

function makeAgentNode(
	id: string,
	sessionName: string,
	opts?: { inputPrompt?: string; outputPrompt?: string; includeUpstreamOutput?: boolean }
): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 100, y: 0 },
		data: {
			sessionId: `session-${id}`,
			sessionName,
			toolType: 'claude-code',
			inputPrompt: opts?.inputPrompt,
			outputPrompt: opts?.outputPrompt,
			includeUpstreamOutput: opts?.includeUpstreamOutput,
		},
	};
}

function makeEdge(id: string, source: string, target: string, prompt?: string): PipelineEdge {
	return {
		id,
		source,
		target,
		mode: 'pass',
		prompt,
	};
}

function makePipeline(overrides?: Partial<CuePipeline>): CuePipeline {
	return {
		id: 'p1',
		name: 'Test Pipeline',
		color: '#06b6d4',
		nodes: [],
		edges: [],
		...overrides,
	};
}

// ─── DEFAULT_TRIGGER_LABELS ──────────────────────────────────────────────────

describe('DEFAULT_TRIGGER_LABELS', () => {
	it('has entries for all nine event types', () => {
		const keys = Object.keys(DEFAULT_TRIGGER_LABELS);
		expect(keys).toHaveLength(9);
		expect(keys).toContain('app.startup');
		expect(keys).toContain('time.heartbeat');
		expect(keys).toContain('time.scheduled');
		expect(keys).toContain('file.changed');
		expect(keys).toContain('agent.completed');
		expect(keys).toContain('github.pull_request');
		expect(keys).toContain('github.issue');
		expect(keys).toContain('task.pending');
		expect(keys).toContain('cli.trigger');
	});
});

// ─── validatePipelines (pure function) ───────────────────────────────────────

describe('validatePipelines', () => {
	it('flags an empty pipeline (no nodes) so the save surfaces feedback', () => {
		// Previously this returned [] and save silently succeeded without
		// persisting anything — the "didn't save" class of user-reported bugs.
		const errors = validatePipelines([makePipeline({ name: 'Empty' })]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/Empty.*add a trigger and an agent/);
	});

	it('returns empty array for empty pipelines array', () => {
		const errors = validatePipelines([]);
		expect(errors).toEqual([]);
	});

	it('errors on pipeline with agents but no triggers', () => {
		const pipeline = makePipeline({
			nodes: [makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' })],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('needs at least one trigger'));
	});

	it('errors on pipeline with triggers but no agents', () => {
		const pipeline = makePipeline({
			nodes: [makeTriggerNode('t1')],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('needs at least one agent'));
	});

	it('errors on disconnected agent (no incoming edge)', () => {
		const pipeline = makePipeline({
			nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' })],
			edges: [], // no edges connecting trigger to agent
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('has no incoming connection'));
	});

	it('errors on agent missing prompt (no node-level, no edge-level)', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1'), // no inputPrompt
			],
			edges: [makeEdge('e1', 't1', 'a1')], // no prompt on edge either
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('missing a prompt'));
	});

	it('passes when agent has node-level prompt', () => {
		const pipeline = makePipeline({
			nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' })],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toEqual([]);
	});

	it('passes when all trigger edges have prompts', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1'), // no node-level prompt
			],
			edges: [makeEdge('e1', 't1', 'a1', 'edge prompt')],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toEqual([]);
	});

	it('detects cycles', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' }),
				makeAgentNode('a2', 'Agent 2', { inputPrompt: 'do stuff' }),
			],
			edges: [
				makeEdge('e1', 't1', 'a1'),
				makeEdge('e2', 'a1', 'a2'),
				makeEdge('e3', 'a2', 'a1'), // creates cycle
			],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('contains a cycle'));
	});

	it('allows chain agent without prompt when includeUpstreamOutput is not disabled', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'first' }),
				makeAgentNode('a2', 'Agent 2'), // chain agent, no prompt, includeUpstreamOutput defaults to undefined (=true)
			],
			edges: [
				makeEdge('e1', 't1', 'a1'),
				makeEdge('e2', 'a1', 'a2'), // agent-to-agent chain
			],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toEqual([]);
	});

	it('allows chain agent without prompt when includeUpstreamOutput is true', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'first' }),
				makeAgentNode('a2', 'Agent 2', { includeUpstreamOutput: true }),
			],
			edges: [makeEdge('e1', 't1', 'a1'), makeEdge('e2', 'a1', 'a2')],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toEqual([]);
	});

	it('errors on chain agent without prompt when includeUpstreamOutput is false', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'first' }),
				makeAgentNode('a2', 'Agent 2', { includeUpstreamOutput: false }),
			],
			edges: [makeEdge('e1', 't1', 'a1'), makeEdge('e2', 'a1', 'a2')],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('Agent 2'));
		expect(errors).toContainEqual(expect.stringContaining('missing a prompt'));
	});

	it('passes for chain agent with prompt regardless of includeUpstreamOutput', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'first' }),
				makeAgentNode('a2', 'Agent 2', { inputPrompt: 'analyze', includeUpstreamOutput: false }),
			],
			edges: [makeEdge('e1', 't1', 'a1'), makeEdge('e2', 'a1', 'a2')],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toEqual([]);
	});

	it('allows fan-in agent without prompt when includeUpstreamOutput is not disabled', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'work 1' }),
				makeAgentNode('a2', 'Agent 2', { inputPrompt: 'work 2' }),
				makeAgentNode('a3', 'Agent 3'), // fan-in target, no prompt
			],
			edges: [
				makeEdge('e1', 't1', 'a1'),
				makeEdge('e2', 't1', 'a2'),
				makeEdge('e3', 'a1', 'a3'),
				makeEdge('e4', 'a2', 'a3'),
			],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toEqual([]);
	});

	it('errors on fan-in agent without prompt when includeUpstreamOutput is false', () => {
		const pipeline = makePipeline({
			nodes: [
				makeTriggerNode('t1'),
				makeAgentNode('a1', 'Agent 1', { inputPrompt: 'work 1' }),
				makeAgentNode('a2', 'Agent 2', { inputPrompt: 'work 2' }),
				makeAgentNode('a3', 'Agent 3', { includeUpstreamOutput: false }),
			],
			edges: [
				makeEdge('e1', 't1', 'a1'),
				makeEdge('e2', 't1', 'a2'),
				makeEdge('e3', 'a1', 'a3'),
				makeEdge('e4', 'a2', 'a3'),
			],
		});
		const errors = validatePipelines([pipeline]);
		expect(errors).toContainEqual(expect.stringContaining('Agent 3'));
		expect(errors).toContainEqual(expect.stringContaining('missing a prompt'));
	});

	it('validates multiple pipelines independently', () => {
		const valid = makePipeline({
			id: 'valid',
			name: 'Valid',
			nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1', { inputPrompt: 'ok' })],
			edges: [makeEdge('e1', 't1', 'a1')],
		});
		const invalid = makePipeline({
			id: 'invalid',
			name: 'Invalid',
			nodes: [makeAgentNode('a2', 'Agent 2')],
		});
		const errors = validatePipelines([valid, invalid]);
		expect(errors.some((e) => e.includes('Invalid'))).toBe(true);
		expect(errors.some((e) => e.includes('Valid'))).toBe(false);
	});
});

// ─── usePipelineState hook ───────────────────────────────────────────────────

describe('usePipelineState', () => {
	it('returns initial state with empty pipelines and not dirty', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		expect(result.current.pipelineState.pipelines).toEqual([]);
		expect(result.current.pipelineState.selectedPipelineId).toBeNull();
		expect(result.current.isDirty).toBe(false);
		expect(result.current.saveStatus).toBe('idle');
		expect(result.current.validationErrors).toEqual([]);
	});

	it('isAllPipelinesView is true when selectedPipelineId is null', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		expect(result.current.isAllPipelinesView).toBe(true);
	});

	it('createPipeline adds a pipeline and selects it', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});

		expect(result.current.pipelineState.pipelines).toHaveLength(1);
		expect(result.current.pipelineState.pipelines[0].name).toBe('Pipeline 1');
		expect(result.current.pipelineState.pipelines[0].color).toBe('#06b6d4');
		expect(result.current.pipelineState.selectedPipelineId).toBe(
			result.current.pipelineState.pipelines[0].id
		);
		expect(result.current.isAllPipelinesView).toBe(false);
	});

	it('createPipeline increments pipeline name number', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});
		act(() => {
			result.current.createPipeline();
		});

		expect(result.current.pipelineState.pipelines).toHaveLength(2);
		expect(result.current.pipelineState.pipelines[1].name).toBe('Pipeline 2');
	});

	it('createPipeline avoids duplicate names after deletion', () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		// Create Pipeline 1, Pipeline 2, and Pipeline 3 with distinct timestamps
		act(() => result.current.createPipeline());
		vi.advanceTimersByTime(1);
		act(() => result.current.createPipeline());
		vi.advanceTimersByTime(1);
		act(() => result.current.createPipeline());
		expect(result.current.pipelineState.pipelines).toHaveLength(3);

		// Delete Pipeline 2 (middle one, no nodes → no confirm dialog)
		const secondId = result.current.pipelineState.pipelines[1].id;
		act(() => result.current.deletePipeline(secondId));
		expect(result.current.pipelineState.pipelines).toHaveLength(2);

		// Remaining: Pipeline 1 and Pipeline 3. maxNum=3, so next should be Pipeline 4 (not Pipeline 3 again)
		vi.advanceTimersByTime(1);
		act(() => result.current.createPipeline());

		expect(result.current.pipelineState.pipelines).toHaveLength(3);
		expect(result.current.pipelineState.pipelines[0].name).toBe('Pipeline 1');
		expect(result.current.pipelineState.pipelines[1].name).toBe('Pipeline 3');
		expect(result.current.pipelineState.pipelines[2].name).toBe('Pipeline 4');

		vi.useRealTimers();
	});

	it('deletePipeline removes the pipeline when confirm returns true', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});

		// Add a node so confirm is required
		const pipelineId = result.current.pipelineState.pipelines[0].id;
		act(() => {
			result.current.setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) =>
					p.id === pipelineId ? { ...p, nodes: [makeTriggerNode('t1')] } : p
				),
			}));
		});

		act(() => {
			result.current.deletePipeline(pipelineId);
		});

		expect(result.current.pipelineState.pipelines).toHaveLength(0);
	});

	it('deletePipeline does not remove when confirm is not accepted', () => {
		// Don't invoke onConfirm — simulates user clicking "Cancel"
		mockShowConfirmation.mockImplementationOnce(() => {});
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});

		const pipelineId = result.current.pipelineState.pipelines[0].id;
		// Add a node so confirm is triggered
		act(() => {
			result.current.setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) =>
					p.id === pipelineId ? { ...p, nodes: [makeTriggerNode('t1')] } : p
				),
			}));
		});

		act(() => {
			result.current.deletePipeline(pipelineId);
		});

		expect(result.current.pipelineState.pipelines).toHaveLength(1);
	});

	it('deletePipeline on empty-node pipeline removes without confirm', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});

		const pipelineId = result.current.pipelineState.pipelines[0].id;
		act(() => {
			result.current.deletePipeline(pipelineId);
		});

		expect(mockShowConfirmation).not.toHaveBeenCalled();
		expect(result.current.pipelineState.pipelines).toHaveLength(0);
	});

	it('renamePipeline updates the pipeline name', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});

		const pipelineId = result.current.pipelineState.pipelines[0].id;
		act(() => {
			result.current.renamePipeline(pipelineId, 'My New Name');
		});

		expect(result.current.pipelineState.pipelines[0].name).toBe('My New Name');
	});

	it('changePipelineColor updates color', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		act(() => {
			result.current.createPipeline();
		});

		const pipelineId = result.current.pipelineState.pipelines[0].id;
		act(() => {
			result.current.changePipelineColor(pipelineId, '#ff0000');
		});

		expect(result.current.pipelineState.pipelines[0].color).toBe('#ff0000');
	});

	it('selectPipeline(null) closes both drawers', () => {
		const setTriggerDrawerOpen = vi.fn();
		const setAgentDrawerOpen = vi.fn();
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ setTriggerDrawerOpen, setAgentDrawerOpen }))
		);

		act(() => {
			result.current.selectPipeline(null);
		});

		expect(setTriggerDrawerOpen).toHaveBeenCalledWith(false);
		expect(setAgentDrawerOpen).toHaveBeenCalledWith(false);
		expect(mockPersistLayout).toHaveBeenCalled();
	});

	it('selectPipeline with id does not close drawers', () => {
		const setTriggerDrawerOpen = vi.fn();
		const setAgentDrawerOpen = vi.fn();
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ setTriggerDrawerOpen, setAgentDrawerOpen }))
		);

		act(() => {
			result.current.selectPipeline('some-id');
		});

		expect(setTriggerDrawerOpen).not.toHaveBeenCalled();
		expect(setAgentDrawerOpen).not.toHaveBeenCalled();
		expect(result.current.pipelineState.selectedPipelineId).toBe('some-id');
	});

	it('onUpdateNode mutates correct node in correct pipeline', () => {
		const pipelineId = 'p1';
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ selectedNodePipelineId: pipelineId }))
		);

		// Seed state with a pipeline containing a node
		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						id: pipelineId,
						nodes: [makeAgentNode('a1', 'Agent 1', { inputPrompt: 'old' })],
					}),
				],
				selectedPipelineId: pipelineId,
			});
		});

		act(() => {
			result.current.onUpdateNode('a1', { inputPrompt: 'new prompt' });
		});

		const node = result.current.pipelineState.pipelines[0].nodes[0];
		expect((node.data as any).inputPrompt).toBe('new prompt');
		// Other fields preserved
		expect((node.data as any).sessionName).toBe('Agent 1');
	});

	it('onUpdateNode is a no-op when selectedNodePipelineId is null', () => {
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ selectedNodePipelineId: null }))
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						nodes: [makeAgentNode('a1', 'Agent 1', { inputPrompt: 'original' })],
					}),
				],
				selectedPipelineId: 'p1',
			});
		});

		act(() => {
			result.current.onUpdateNode('a1', { inputPrompt: 'changed' });
		});

		expect((result.current.pipelineState.pipelines[0].nodes[0].data as any).inputPrompt).toBe(
			'original'
		);
	});

	it('onDeleteNode removes node and connected edges, calls setSelectedNodeId(null)', () => {
		const pipelineId = 'p1';
		const setSelectedNodeId = vi.fn();
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					selectedNodePipelineId: pipelineId,
					setSelectedNodeId,
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						id: pipelineId,
						nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1', { inputPrompt: 'ok' })],
						edges: [makeEdge('e1', 't1', 'a1')],
					}),
				],
				selectedPipelineId: pipelineId,
			});
		});

		act(() => {
			result.current.onDeleteNode('a1');
		});

		const pipeline = result.current.pipelineState.pipelines[0];
		expect(pipeline.nodes).toHaveLength(1);
		expect(pipeline.nodes[0].id).toBe('t1');
		expect(pipeline.edges).toHaveLength(0);
		expect(setSelectedNodeId).toHaveBeenCalledWith(null);
	});

	it('onUpdateEdgePrompt updates edge prompt', () => {
		const pipelineId = 'p1';
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ selectedNodePipelineId: pipelineId }))
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						id: pipelineId,
						nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1')],
						edges: [makeEdge('e1', 't1', 'a1', 'old prompt')],
					}),
				],
				selectedPipelineId: pipelineId,
			});
		});

		act(() => {
			result.current.onUpdateEdgePrompt('e1', 'new prompt');
		});

		expect(result.current.pipelineState.pipelines[0].edges[0].prompt).toBe('new prompt');
	});

	it('onUpdateEdge updates edge fields', () => {
		const pipelineId = 'p1';
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ selectedEdgePipelineId: pipelineId }))
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						id: pipelineId,
						nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1')],
						edges: [makeEdge('e1', 't1', 'a1')],
					}),
				],
				selectedPipelineId: pipelineId,
			});
		});

		act(() => {
			result.current.onUpdateEdge('e1', {
				mode: 'debate',
				debateConfig: { maxRounds: 5, timeoutPerRound: 120 },
			});
		});

		const edge = result.current.pipelineState.pipelines[0].edges[0];
		expect(edge.mode).toBe('debate');
		expect(edge.debateConfig).toEqual({ maxRounds: 5, timeoutPerRound: 120 });
	});

	it('onUpdateEdge is a no-op when selectedEdgePipelineId is null', () => {
		const { result } = renderHook(() =>
			usePipelineState(createDefaultParams({ selectedEdgePipelineId: null }))
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1')],
						edges: [makeEdge('e1', 't1', 'a1')],
					}),
				],
				selectedPipelineId: 'p1',
			});
		});

		act(() => {
			result.current.onUpdateEdge('e1', { mode: 'debate' });
		});

		expect(result.current.pipelineState.pipelines[0].edges[0].mode).toBe('pass');
	});

	it('onDeleteEdge removes edge and calls setSelectedEdgeId(null)', () => {
		const pipelineId = 'p1';
		const setSelectedEdgeId = vi.fn();
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					selectedEdgePipelineId: pipelineId,
					setSelectedEdgeId,
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						id: pipelineId,
						nodes: [makeTriggerNode('t1'), makeAgentNode('a1', 'Agent 1')],
						edges: [makeEdge('e1', 't1', 'a1'), makeEdge('e2', 't1', 'a1')],
					}),
				],
				selectedPipelineId: pipelineId,
			});
		});

		act(() => {
			result.current.onDeleteEdge('e1');
		});

		expect(result.current.pipelineState.pipelines[0].edges).toHaveLength(1);
		expect(result.current.pipelineState.pipelines[0].edges[0].id).toBe('e2');
		expect(setSelectedEdgeId).toHaveBeenCalledWith(null);
	});

	it('runningPipelineIds matches active runs to pipelines by name', () => {
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [{ subscriptionName: 'My Pipeline', sessionName: 'Agent 1' }],
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({ id: 'p1', name: 'My Pipeline' }),
					makePipeline({ id: 'p2', name: 'Other Pipeline' }),
				],
				selectedPipelineId: null,
			});
		});

		expect(result.current.runningPipelineIds.has('p1')).toBe(true);
		expect(result.current.runningPipelineIds.has('p2')).toBe(false);
	});

	it('runningPipelineIds strips -chain-N and -fanin suffixes', () => {
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [
						{ subscriptionName: 'My Pipeline-chain-2', sessionName: 'Agent 1' },
						{ subscriptionName: 'My Pipeline-fanin', sessionName: 'Agent 2' },
					],
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [makePipeline({ id: 'p1', name: 'My Pipeline' })],
				selectedPipelineId: null,
			});
		});

		expect(result.current.runningPipelineIds.has('p1')).toBe(true);
	});

	it('runningPipelineIds is empty when no activeRuns', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams({ activeRuns: [] })));

		expect(result.current.runningPipelineIds.size).toBe(0);
	});

	it('runningAgentsByPipeline groups running session names under the owning pipeline id', () => {
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [
						{ subscriptionName: 'My Pipeline', sessionName: 'Alice' },
						{ subscriptionName: 'My Pipeline-chain-1', sessionName: 'Bob' },
						{ subscriptionName: 'Other Pipeline', sessionName: 'Carol' },
					],
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({ id: 'p1', name: 'My Pipeline' }),
					makePipeline({ id: 'p2', name: 'Other Pipeline' }),
				],
				selectedPipelineId: null,
			});
		});

		const p1Agents = result.current.runningAgentsByPipeline.get('p1');
		const p2Agents = result.current.runningAgentsByPipeline.get('p2');
		expect(p1Agents).toBeDefined();
		expect([...p1Agents!].sort()).toEqual(['Alice', 'Bob']);
		expect(p2Agents).toBeDefined();
		expect([...p2Agents!]).toEqual(['Carol']);
	});

	it('runningAgentsByPipeline strips -chain-N and -fanin suffixes when matching to pipelines', () => {
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [
						{ subscriptionName: 'Pipeline-chain-3', sessionName: 'DeepAgent' },
						{ subscriptionName: 'Pipeline-fanin', sessionName: 'Aggregator' },
					],
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [makePipeline({ id: 'p1', name: 'Pipeline' })],
				selectedPipelineId: null,
			});
		});

		const agents = result.current.runningAgentsByPipeline.get('p1');
		expect(agents).toBeDefined();
		expect([...agents!].sort()).toEqual(['Aggregator', 'DeepAgent']);
	});

	it('runningAgentsByPipeline is an empty map when no activeRuns', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams({ activeRuns: [] })));
		expect(result.current.runningAgentsByPipeline.size).toBe(0);
	});

	it('runningSubscriptionsByPipeline carries exact subscription names (no suffix stripping)', () => {
		// Used by trigger-node animation: each trigger node knows its exact
		// subscription name (e.g. "Pipeline 1-chain-2") and compares against
		// the pipeline's running-subs set. Stripping the suffix would collapse
		// chain triggers with the initial trigger — making every trigger icon
		// spin when any sub in the pipeline runs (the pre-fix bug).
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [
						{ subscriptionName: 'Pipeline 1', sessionName: 'Alice' },
						{ subscriptionName: 'Pipeline 1-chain-2', sessionName: 'Bob' },
					],
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [makePipeline({ id: 'p1', name: 'Pipeline 1' })],
				selectedPipelineId: null,
			});
		});

		const subs = result.current.runningSubscriptionsByPipeline.get('p1');
		expect(subs).toBeDefined();
		expect([...subs!].sort()).toEqual(['Pipeline 1', 'Pipeline 1-chain-2']);
	});

	it('runningSubscriptionsByPipeline is empty when no activeRuns', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams({ activeRuns: [] })));
		expect(result.current.runningSubscriptionsByPipeline.size).toBe(0);
	});

	it('runningSubscriptionsByPipeline does not include pipelines with no matching runs', () => {
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [{ subscriptionName: 'Alpha', sessionName: 'A' }],
				})
			)
		);
		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({ id: 'pAlpha', name: 'Alpha' }),
					makePipeline({ id: 'pBravo', name: 'Bravo' }),
				],
				selectedPipelineId: null,
			});
		});
		expect(result.current.runningSubscriptionsByPipeline.has('pAlpha')).toBe(true);
		expect(result.current.runningSubscriptionsByPipeline.has('pBravo')).toBe(false);
	});

	it('runningAgentsByPipeline does not include pipelines with no matching active runs', () => {
		const { result } = renderHook(() =>
			usePipelineState(
				createDefaultParams({
					activeRuns: [{ subscriptionName: 'Alpha', sessionName: 'A1' }],
				})
			)
		);

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({ id: 'pAlpha', name: 'Alpha' }),
					makePipeline({ id: 'pBravo', name: 'Bravo' }),
				],
				selectedPipelineId: null,
			});
		});

		expect(result.current.runningAgentsByPipeline.has('pAlpha')).toBe(true);
		expect(result.current.runningAgentsByPipeline.has('pBravo')).toBe(false);
	});

	it('handleSave with no project root adds validation error', async () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams({ sessions: [] })));

		// Wait for settingsLoaded flip (Fix #1 gate) before calling handleSave
		await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());

		// Create a valid pipeline so it doesn't fail on other validations
		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						nodes: [
							makeTriggerNode('t1'),
							makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' }),
						],
						edges: [makeEdge('e1', 't1', 'a1')],
					}),
				],
				selectedPipelineId: 'p1',
			});
		});

		await act(async () => {
			await result.current.handleSave();
		});

		expect(result.current.validationErrors).toContainEqual(
			expect.stringContaining('No project root found')
		);
		expect(mockWriteYaml).not.toHaveBeenCalled();
	});

	it('validation errors persist across subsequent re-renders (regression: dirty-tracking wipe)', async () => {
		// Previously the dirty-tracking effect depended on the `persistence` object
		// identity, which changes every render. When handleSave set validationErrors
		// and React re-rendered, the effect fired and immediately cleared them —
		// the banner flashed for one frame. Guard: errors survive a post-save
		// re-render so the user can actually read them.
		const { result, rerender } = renderHook(() =>
			usePipelineState(createDefaultParams({ sessions: [] }))
		);

		await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						nodes: [
							makeTriggerNode('t1'),
							makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' }),
						],
						edges: [makeEdge('e1', 't1', 'a1')],
					}),
				],
				selectedPipelineId: 'p1',
			});
		});

		await act(async () => {
			await result.current.handleSave();
		});

		expect(result.current.validationErrors.length).toBeGreaterThan(0);

		// Force extra renders the way a parent re-render would. Without the fix
		// the dirty-tracking effect would fire and wipe validationErrors.
		rerender();
		rerender();
		rerender();

		expect(result.current.validationErrors.length).toBeGreaterThan(0);
	});

	it('handleSave succeeds with valid pipeline and project root', async () => {
		const sessions = [
			{ id: 's1', name: 'Agent 1', toolType: 'claude-code', projectRoot: '/test/project' },
		];
		const { result } = renderHook(() => usePipelineState(createDefaultParams({ sessions })));

		// Wait for settingsLoaded flip (Fix #1 gate) before calling handleSave
		await waitFor(() => expect(mockGetSettings).toHaveBeenCalled());

		act(() => {
			result.current.setPipelineState({
				pipelines: [
					makePipeline({
						nodes: [
							makeTriggerNode('t1'),
							makeAgentNode('a1', 'Agent 1', { inputPrompt: 'do stuff' }),
						],
						edges: [makeEdge('e1', 't1', 'a1')],
					}),
				],
				selectedPipelineId: 'p1',
			});
		});

		await act(async () => {
			await result.current.handleSave();
		});

		expect(result.current.validationErrors).toEqual([]);
		expect(mockWriteYaml).toHaveBeenCalledWith('/test/project', 'test', {});
		expect(result.current.saveStatus).toBe('success');
		expect(result.current.isDirty).toBe(false);
	});

	it('handleDiscard resets dirty state', async () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		// Mark dirty
		act(() => {
			result.current.setIsDirty(true);
		});
		expect(result.current.isDirty).toBe(true);

		await act(async () => {
			await result.current.handleDiscard();
		});

		expect(result.current.isDirty).toBe(false);
		expect(result.current.validationErrors).toEqual([]);
	});

	it('handleDiscard restores from getGraphData when data exists', async () => {
		const { graphSessionsToPipelines } =
			await import('../../../../renderer/components/CuePipelineEditor/utils/yamlToPipeline');
		const restoredPipeline = makePipeline({ id: 'restored', name: 'Restored' });
		(graphSessionsToPipelines as ReturnType<typeof vi.fn>).mockReturnValueOnce([restoredPipeline]);
		mockGetGraphData.mockResolvedValueOnce([{ sessionId: 's1', subscriptions: [] }]);

		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		await act(async () => {
			await result.current.handleDiscard();
		});

		expect(result.current.pipelineState.pipelines).toEqual([restoredPipeline]);
		expect(result.current.pipelineState.selectedPipelineId).toBe('restored');
	});

	it('showSettings defaults to false and can be toggled', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		expect(result.current.showSettings).toBe(false);

		act(() => {
			result.current.setShowSettings(true);
		});

		expect(result.current.showSettings).toBe(true);
	});

	it('pushes isDirty into cueDirtyStore.pipelineDirty when isDirty changes', () => {
		const { result } = renderHook(() => usePipelineState(createDefaultParams()));

		// Initially not dirty
		expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);

		act(() => {
			result.current.setIsDirty(true);
		});

		expect(useCueDirtyStore.getState().pipelineDirty).toBe(true);

		act(() => {
			result.current.setIsDirty(false);
		});

		expect(useCueDirtyStore.getState().pipelineDirty).toBe(false);
	});
});
