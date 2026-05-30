import { describe, it, expect } from 'vitest';

import {
	PIPELINE_COLORS as SHARED_PIPELINE_COLORS,
	getNextPipelineColor as sharedGetNextPipelineColor,
} from '../../../../shared/cue-pipeline-types';
import {
	PIPELINE_COLORS as RENDERER_PIPELINE_COLORS,
	getNextPipelineColor as rendererGetNextPipelineColor,
} from '../../../../renderer/components/CuePipelineEditor/pipelineColors';

describe('pipeline color palette consolidation', () => {
	it('exports a single canonical 12-entry palette', () => {
		expect(SHARED_PIPELINE_COLORS).toHaveLength(12);
		expect(SHARED_PIPELINE_COLORS.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))).toBe(true);
	});

	it('renderer re-exports the same palette reference as shared', () => {
		expect(RENDERER_PIPELINE_COLORS).toBe(SHARED_PIPELINE_COLORS);
	});

	it('renderer re-exports the same getNextPipelineColor as shared', () => {
		expect(rendererGetNextPipelineColor).toBe(sharedGetNextPipelineColor);
	});

	it('matches the documented canonical color order', () => {
		expect(SHARED_PIPELINE_COLORS).toEqual([
			'#06b6d4',
			'#8b5cf6',
			'#f59e0b',
			'#ef4444',
			'#22c55e',
			'#ec4899',
			'#3b82f6',
			'#f97316',
			'#14b8a6',
			'#a855f7',
			'#eab308',
			'#6366f1',
		]);
	});

	it('getNextPipelineColor returns first color when no pipelines exist', () => {
		expect(rendererGetNextPipelineColor([])).toBe('#06b6d4');
	});

	it('getNextPipelineColor skips used colors', () => {
		const used = [
			{ id: 'p1', name: 'A', color: '#06b6d4', nodes: [], edges: [] },
			{ id: 'p2', name: 'B', color: '#8b5cf6', nodes: [], edges: [] },
		];
		expect(rendererGetNextPipelineColor(used)).toBe('#f59e0b');
	});

	it('getNextPipelineColor cycles when all colors used', () => {
		const allUsed = SHARED_PIPELINE_COLORS.map((color, i) => ({
			id: `p${i}`,
			name: `P${i}`,
			color,
			nodes: [],
			edges: [],
		}));
		expect(rendererGetNextPipelineColor(allUsed)).toBe(SHARED_PIPELINE_COLORS[0]);
	});
});
