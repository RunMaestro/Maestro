/**
 * Tests for pipeline layout merge/restore utilities.
 *
 * Verifies that saved layout state is correctly merged with live pipeline
 * data, including the critical case where selectedPipelineId is null
 * ("All Pipelines" mode).
 */

import { describe, it, expect } from 'vitest';
import { mergePipelinesWithSavedLayout } from '../../../../../renderer/components/CuePipelineEditor/utils/pipelineLayout';
import type { CuePipeline, PipelineLayoutState } from '../../../../../shared/cue-pipeline-types';

function makePipeline(overrides: Partial<CuePipeline> = {}): CuePipeline {
	return {
		id: 'p1',
		name: 'test-pipeline',
		color: '#06b6d4',
		nodes: [
			{
				id: 'trigger-1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: {
					eventType: 'time.heartbeat',
					label: 'Timer',
					config: { interval_minutes: 5 },
				},
			},
			{
				id: 'agent-1',
				type: 'agent',
				position: { x: 300, y: 0 },
				data: {
					sessionId: 's1',
					sessionName: 'worker',
					toolType: 'claude-code',
					inputPrompt: 'Do work',
				},
			},
		],
		edges: [{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' }],
		...overrides,
	};
}

describe('mergePipelinesWithSavedLayout', () => {
	it('preserves null selectedPipelineId (All Pipelines mode)', () => {
		const livePipelines = [makePipeline()];
		const savedLayout: PipelineLayoutState = {
			pipelines: [makePipeline()],
			selectedPipelineId: null,
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
		expect(result.selectedPipelineId).toBeNull();
	});

	it('preserves a specific selectedPipelineId from saved layout', () => {
		const livePipelines = [makePipeline(), makePipeline({ id: 'p2', name: 'second' })];
		const savedLayout: PipelineLayoutState = {
			pipelines: livePipelines,
			selectedPipelineId: 'p2',
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
		expect(result.selectedPipelineId).toBe('p2');
	});

	it('defaults to first pipeline id when selectedPipelineId is missing from layout', () => {
		const livePipelines = [makePipeline()];
		// Simulate a legacy saved layout that doesn't have selectedPipelineId at all
		const savedLayout = {
			pipelines: [makePipeline()],
		} as PipelineLayoutState;

		// Delete the property so `in` check fails
		delete (savedLayout as unknown as Record<string, unknown>).selectedPipelineId;

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
		expect(result.selectedPipelineId).toBe('p1');
	});

	it('falls back to first pipeline when saved selectedPipelineId no longer exists', () => {
		// Repro for the "pipeline vanished after save" bug: createPipeline assigned
		// a timestamp-based id (`pipeline-1700000000000`) that the next YAML reload
		// regenerates as `pipeline-MyPipeline`. The saved layout still references
		// the old timestamp id; without this fallback the canvas renders empty
		// because convertToReactFlowNodes skips every pipeline whose id != selected.
		const livePipelines = [makePipeline({ id: 'pipeline-MyPipeline' })];
		const savedLayout: PipelineLayoutState = {
			pipelines: [makePipeline({ id: 'pipeline-1700000000000' })],
			selectedPipelineId: 'pipeline-1700000000000',
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
		expect(result.selectedPipelineId).toBe('pipeline-MyPipeline');
	});

	it('merges saved node positions with live pipeline data', () => {
		const livePipelines = [makePipeline()];
		const savedLayout: PipelineLayoutState = {
			pipelines: [
				makePipeline({
					nodes: [
						{
							id: 'trigger-1',
							type: 'trigger',
							position: { x: 100, y: 200 },
							data: {
								eventType: 'time.heartbeat',
								label: 'Timer',
								config: { interval_minutes: 5 },
							},
						},
						{
							id: 'agent-1',
							type: 'agent',
							position: { x: 500, y: 300 },
							data: {
								sessionId: 's1',
								sessionName: 'worker',
								toolType: 'claude-code',
								inputPrompt: 'Do work',
							},
						},
					],
				}),
			],
			selectedPipelineId: 'p1',
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);

		// Positions from saved layout should override live defaults
		const triggerNode = result.pipelines[0].nodes.find((n) => n.id === 'trigger-1');
		const agentNode = result.pipelines[0].nodes.find((n) => n.id === 'agent-1');
		expect(triggerNode?.position).toEqual({ x: 100, y: 200 });
		expect(agentNode?.position).toEqual({ x: 500, y: 300 });
	});

	it('keeps live node positions when saved layout has no matching nodes', () => {
		const livePipelines = [makePipeline()];
		const savedLayout: PipelineLayoutState = {
			pipelines: [makePipeline({ nodes: [] })],
			selectedPipelineId: 'p1',
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);

		// Original positions preserved
		const triggerNode = result.pipelines[0].nodes.find((n) => n.id === 'trigger-1');
		expect(triggerNode?.position).toEqual({ x: 0, y: 0 });
	});

	it('restores saved name but keeps YAML-authoritative live color', () => {
		// YAML now carries `pipeline_color`, so live pipeline color is
		// authoritative. Layout JSON color is stale metadata and must not
		// override a valid live color (otherwise YAML edits get clobbered
		// on reload, and Commit 3's color persistence is defeated).
		const livePipelines = [
			makePipeline({ id: 'p1', name: 'Pipeline 1', color: '#06b6d4' }),
			makePipeline({ id: 'p2', name: 'Pipeline 2', color: '#8b5cf6' }),
		];
		const savedLayout: PipelineLayoutState = {
			pipelines: [
				makePipeline({ id: 'p1', name: 'My Custom Name', color: '#ef4444' }),
				makePipeline({ id: 'p2', name: 'Another Name', color: '#22c55e' }),
			],
			selectedPipelineId: null,
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);

		// Name still flows from layout JSON (user rename without YAML re-save).
		expect(result.pipelines[0].name).toBe('My Custom Name');
		expect(result.pipelines[1].name).toBe('Another Name');
		// Color is YAML-authoritative — live values win.
		expect(result.pipelines[0].color).toBe('#06b6d4');
		expect(result.pipelines[1].color).toBe('#8b5cf6');
	});

	it('keeps live color and name when no saved layout match exists', () => {
		const livePipelines = [makePipeline({ id: 'p-new', name: 'Brand New', color: '#3b82f6' })];
		const savedLayout: PipelineLayoutState = {
			pipelines: [makePipeline({ id: 'p-old', name: 'Old One', color: '#ef4444' })],
			selectedPipelineId: null,
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);

		// No matching ID in saved layout — live values preserved
		expect(result.pipelines[0].name).toBe('Brand New');
		expect(result.pipelines[0].color).toBe('#3b82f6');
	});

	it('returns all live pipelines even when saved layout has fewer', () => {
		const livePipelines = [
			makePipeline({ id: 'p1', name: 'first' }),
			makePipeline({ id: 'p2', name: 'second' }),
		];
		const savedLayout: PipelineLayoutState = {
			pipelines: [makePipeline({ id: 'p1', name: 'first' })],
			selectedPipelineId: null,
		};

		const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
		expect(result.pipelines).toHaveLength(2);
		expect(result.selectedPipelineId).toBeNull();
	});

	describe('semantic position keying (survives id regeneration)', () => {
		// Regression guard for the "snap-back to grid on first save+reopen"
		// bug. UI-created nodes use timestamp ids (`trigger-1741234567890`,
		// `agent-s1-1741234567900`); `yamlToPipeline` regenerates ids as
		// `trigger-0`, `agent-<sessionName>-<size>` on reload. Before the
		// semantic-key lookup, positions persisted under UI timestamp ids
		// missed every lookup on next open and every node snapped back to
		// the auto-layout default. These tests pin down the semantic
		// matching so future refactors don't regress this fix.

		it('restores positions after node IDs are regenerated by yamlToPipeline', () => {
			// Saved layout uses UI timestamp ids (first-save case).
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					{
						id: 'pipeline-Pipeline 1',
						name: 'Pipeline 1',
						color: '#06b6d4',
						nodes: [
							{
								id: 'trigger-1741234567890', // UI-created timestamp id
								type: 'trigger',
								position: { x: 150, y: 250 },
								data: {
									eventType: 'time.heartbeat',
									label: 'Timer',
									config: { interval_minutes: 5 },
								},
							},
							{
								id: 'agent-s1-1741234568001', // UI-created timestamp id
								type: 'agent',
								position: { x: 550, y: 350 },
								data: {
									sessionId: 's1',
									sessionName: 'worker',
									toolType: 'claude-code',
								},
							},
						],
						edges: [],
					},
				],
				selectedPipelineId: 'pipeline-Pipeline 1',
			};

			// Live pipeline (post-reload) has yamlToPipeline-generated ids —
			// completely different from the timestamp ids on disk.
			const livePipelines: CuePipeline[] = [
				{
					id: 'pipeline-Pipeline 1',
					name: 'Pipeline 1',
					color: '#06b6d4',
					nodes: [
						{
							id: 'trigger-0',
							type: 'trigger',
							position: { x: 100, y: 200 }, // auto-layout default
							data: {
								eventType: 'time.heartbeat',
								label: 'Timer',
								config: { interval_minutes: 5 },
								subscriptionName: 'Pipeline 1',
							},
						},
						{
							id: 'agent-worker-1',
							type: 'agent',
							position: { x: 400, y: 200 }, // auto-layout default
							data: {
								sessionId: 's1',
								sessionName: 'worker',
								toolType: 'claude-code',
							},
						},
					],
					edges: [],
				},
			];

			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			const trigger = result.pipelines[0].nodes.find((n) => n.type === 'trigger');
			const agent = result.pipelines[0].nodes.find((n) => n.type === 'agent');
			// Semantic match lets saved positions override auto-layout defaults
			// even though node ids changed entirely.
			expect(trigger?.position).toEqual({ x: 150, y: 250 });
			expect(agent?.position).toEqual({ x: 550, y: 350 });
		});

		it('matches agent position by sessionId even after name change', () => {
			// User renamed the agent between save and reload. sessionId is the
			// authoritative identity; sessionName is mutable. Position must
			// still be preserved.
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					{
						id: 'pipeline-p1',
						name: 'p1',
						color: '#06b6d4',
						nodes: [
							{
								id: 'agent-old-name-1',
								type: 'agent',
								position: { x: 777, y: 888 },
								data: {
									sessionId: 'sess-stable-uuid',
									sessionName: 'OldName',
									toolType: 'claude-code',
								},
							},
						],
						edges: [],
					},
				],
				selectedPipelineId: 'pipeline-p1',
			};
			const livePipelines: CuePipeline[] = [
				{
					id: 'pipeline-p1',
					name: 'p1',
					color: '#06b6d4',
					nodes: [
						{
							id: 'agent-NewName-0',
							type: 'agent',
							position: { x: 0, y: 0 },
							data: {
								sessionId: 'sess-stable-uuid',
								sessionName: 'NewName',
								toolType: 'claude-code',
							},
						},
					],
					edges: [],
				},
			];
			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			expect(result.pipelines[0].nodes[0].position).toEqual({ x: 777, y: 888 });
		});

		it('matches command node position by subscription name even after id regeneration', () => {
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					{
						id: 'pipeline-p1',
						name: 'p1',
						color: '#06b6d4',
						nodes: [
							{
								id: 'command-ui-id',
								type: 'command',
								position: { x: 900, y: 100 },
								data: {
									name: 'forward-to-reviewer',
									mode: 'cli',
									cliCommand: 'send',
									cliTarget: 'reviewer',
									owningSessionId: 'sess-1',
									owningSessionName: 'owner',
								},
							},
						],
						edges: [],
					},
				],
				selectedPipelineId: 'pipeline-p1',
			};
			const livePipelines: CuePipeline[] = [
				{
					id: 'pipeline-p1',
					name: 'p1',
					color: '#06b6d4',
					nodes: [
						{
							id: 'command-0', // yamlToPipeline-generated
							type: 'command',
							position: { x: 0, y: 0 },
							data: {
								name: 'forward-to-reviewer',
								mode: 'cli',
								cliCommand: 'send',
								cliTarget: 'reviewer',
								owningSessionId: 'sess-1',
								owningSessionName: 'owner',
							},
						},
					],
					edges: [],
				},
			];
			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			expect(result.pipelines[0].nodes[0].position).toEqual({ x: 900, y: 100 });
		});

		it('does NOT apply a semantic match across different pipelines', () => {
			// Two pipelines each with their own trigger-0. Saved layout has
			// pipeline "A" with a timer trigger at {100,100}. Live pipeline
			// "B" also has a timer trigger. The merge must NOT steal pipeline
			// A's position for pipeline B's trigger — the pipeline NAME gates
			// the lookup.
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					{
						id: 'pipeline-A',
						name: 'A',
						color: '#06b6d4',
						nodes: [
							{
								id: 'trigger-1',
								type: 'trigger',
								position: { x: 100, y: 100 },
								data: {
									eventType: 'time.heartbeat',
									label: 'Timer',
									config: { interval_minutes: 5 },
								},
							},
						],
						edges: [],
					},
				],
				selectedPipelineId: 'pipeline-A',
			};
			const livePipelines: CuePipeline[] = [
				{
					id: 'pipeline-B',
					name: 'B',
					color: '#06b6d4',
					nodes: [
						{
							id: 'trigger-0',
							type: 'trigger',
							position: { x: 50, y: 50 },
							data: {
								eventType: 'time.heartbeat',
								label: 'Timer',
								config: { interval_minutes: 5 },
							},
						},
					],
					edges: [],
				},
			];
			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			// Pipeline B's trigger keeps its own position; pipeline A's
			// saved position is NOT applied across the name boundary.
			expect(result.pipelines[0].nodes[0].position).toEqual({ x: 50, y: 50 });
		});

		it('matches multiple triggers of the same event type by index order', () => {
			// Pipeline with two heartbeat triggers. Semantic key uses
			// (eventType, triggerIndex) so positions map correctly even when
			// ids change.
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					{
						id: 'pipeline-multi',
						name: 'multi',
						color: '#06b6d4',
						nodes: [
							{
								id: 'trigger-ui-first',
								type: 'trigger',
								position: { x: 10, y: 10 },
								data: {
									eventType: 'time.heartbeat',
									label: 'T1',
									config: { interval_minutes: 1 },
								},
							},
							{
								id: 'trigger-ui-second',
								type: 'trigger',
								position: { x: 20, y: 20 },
								data: {
									eventType: 'time.heartbeat',
									label: 'T2',
									config: { interval_minutes: 2 },
								},
							},
						],
						edges: [],
					},
				],
				selectedPipelineId: 'pipeline-multi',
			};
			const livePipelines: CuePipeline[] = [
				{
					id: 'pipeline-multi',
					name: 'multi',
					color: '#06b6d4',
					nodes: [
						{
							id: 'trigger-0',
							type: 'trigger',
							position: { x: 0, y: 0 },
							data: {
								eventType: 'time.heartbeat',
								label: 'T1',
								config: { interval_minutes: 1 },
								subscriptionName: 'multi',
							},
						},
						{
							id: 'trigger-1',
							type: 'trigger',
							position: { x: 0, y: 0 },
							data: {
								eventType: 'time.heartbeat',
								label: 'T2',
								config: { interval_minutes: 2 },
								subscriptionName: 'multi-chain-1',
							},
						},
					],
					edges: [],
				},
			];
			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			// First trigger gets first saved position; second gets second.
			expect(result.pipelines[0].nodes[0].position).toEqual({ x: 10, y: 10 });
			expect(result.pipelines[0].nodes[1].position).toEqual({ x: 20, y: 20 });
		});

		it('preserves positions AND name across an unsaved-rename + close/reopen cycle', () => {
			// User renamed "Pipeline 1" to "MyPipe" without saving the YAML,
			// then closed and reopened the modal. persistLayout ran on the
			// rename; YAML still has the old name. On reopen:
			//   live pipeline (from YAML): id=pipeline-Pipeline 1, name=Pipeline 1
			//   saved layout: id=pipeline-Pipeline 1, name=MyPipe (unsaved rename)
			// Live id matches saved id → savedMatch found → name wins from
			// saved (rename preserved) AND positions resolve within savedMatch.
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					{
						id: 'pipeline-Pipeline 1',
						name: 'MyPipe', // user's unsaved rename
						color: '#06b6d4',
						nodes: [
							{
								id: 'trigger-ui-id',
								type: 'trigger',
								position: { x: 700, y: 800 },
								data: {
									eventType: 'time.heartbeat',
									label: 'Timer',
									config: { interval_minutes: 5 },
								},
							},
						],
						edges: [],
					},
				],
				selectedPipelineId: 'pipeline-Pipeline 1',
			};
			const livePipelines: CuePipeline[] = [
				{
					id: 'pipeline-Pipeline 1',
					name: 'Pipeline 1', // from YAML — rename was never saved
					color: '#06b6d4',
					nodes: [
						{
							id: 'trigger-0',
							type: 'trigger',
							position: { x: 0, y: 0 },
							data: {
								eventType: 'time.heartbeat',
								label: 'Timer',
								config: { interval_minutes: 5 },
								subscriptionName: 'Pipeline 1',
							},
						},
					],
					edges: [],
				},
			];
			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			// Unsaved rename wins (existing feature preserved).
			expect(result.pipelines[0].name).toBe('MyPipe');
			// Position from the saved layout still applied via semantic key.
			expect(result.pipelines[0].nodes[0].position).toEqual({ x: 700, y: 800 });
		});

		it('falls back to id-based lookup for legacy layouts where ids still match', () => {
			// Pre-semantic-key layouts: both saved and live pipelines share
			// node ids (e.g. they were both emitted by yamlToPipeline on
			// consecutive save-reload cycles). The id-based fallback keeps
			// those layouts working.
			const livePipelines = [makePipeline()];
			const savedLayout: PipelineLayoutState = {
				pipelines: [
					makePipeline({
						nodes: [
							{
								id: 'trigger-1',
								type: 'trigger',
								position: { x: 123, y: 456 },
								data: {
									eventType: 'time.heartbeat',
									label: 'Timer',
									config: { interval_minutes: 5 },
								},
							},
							{
								id: 'agent-1',
								type: 'agent',
								position: { x: 789, y: 321 },
								data: {
									sessionId: 's1',
									sessionName: 'worker',
									toolType: 'claude-code',
									inputPrompt: 'Do work',
								},
							},
						],
					}),
				],
				selectedPipelineId: 'p1',
			};
			const result = mergePipelinesWithSavedLayout(livePipelines, savedLayout);
			const trigger = result.pipelines[0].nodes.find((n) => n.id === 'trigger-1');
			const agent = result.pipelines[0].nodes.find((n) => n.id === 'agent-1');
			expect(trigger?.position).toEqual({ x: 123, y: 456 });
			expect(agent?.position).toEqual({ x: 789, y: 321 });
		});
	});
});
