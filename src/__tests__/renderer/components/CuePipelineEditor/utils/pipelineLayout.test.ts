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
});
