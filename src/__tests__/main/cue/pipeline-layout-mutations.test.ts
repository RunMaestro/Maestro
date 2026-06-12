/**
 * Unit tests for the in-memory pipeline-layout mutation primitives. The
 * disk-bound wrappers (`setPipelineOnDisk` etc.) are covered indirectly:
 * they delegate to the same primitives plus `loadPipelineLayout` /
 * `savePipelineLayout`, which already have their own tests in the cue
 * suite. Keeping these tests pure-function avoids needing an Electron
 * `app.getPath('userData')` mock here.
 */

import { describe, it, expect } from 'vitest';
import {
	findPipeline,
	removePipelineFromLayout,
	upsertPipeline,
	validatePipelineEntry,
} from '../../../main/cue/pipeline-layout-mutations';
import type { CuePipeline, PipelineLayoutState } from '../../../shared/cue-pipeline-types';

function makePipeline(name: string, id?: string): CuePipeline {
	return {
		id: id ?? `pipeline-${name}`,
		name,
		color: '#06b6d4',
		nodes: [
			{
				id: 'trigger-0',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { eventType: 'time.heartbeat', label: 'Trigger', config: {} } as never,
			},
		],
		edges: [],
	};
}

function makeLayout(pipelines: CuePipeline[]): PipelineLayoutState {
	return {
		version: 2,
		pipelines,
		selectedPipelineId: pipelines[0]?.id ?? null,
		perProject: {},
	};
}

describe('validatePipelineEntry', () => {
	it('accepts a structurally valid pipeline', () => {
		const result = validatePipelineEntry(makePipeline('Foo'));
		expect(result.ok).toBe(true);
	});

	it.each([
		[null, 'pipeline entry must be a JSON object'],
		[[], 'pipeline entry must be a JSON object'],
		['', 'pipeline entry must be a JSON object'],
	])('rejects non-object input %p', (input, expected) => {
		const result = validatePipelineEntry(input);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toBe(expected);
	});

	it('rejects missing or empty id', () => {
		const result = validatePipelineEntry({ ...makePipeline('Foo'), id: '' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/pipeline\.id/);
	});

	it('rejects non-array nodes', () => {
		const result = validatePipelineEntry({ ...makePipeline('Foo'), nodes: 'not-an-array' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/nodes/);
	});

	it('rejects malformed node entries', () => {
		const result = validatePipelineEntry({
			...makePipeline('Foo'),
			nodes: [{ id: '', type: 'trigger', position: {}, data: {} }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/nodes\[0\]\.id/);
	});

	it('rejects malformed edge entries', () => {
		const result = validatePipelineEntry({
			...makePipeline('Foo'),
			edges: [{ id: 'e1', source: 'a' }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/edges\[0\]/);
	});
});

describe('findPipeline', () => {
	const layout = makeLayout([makePipeline('Foo'), makePipeline('Bar', 'pipeline-Bar-2')]);

	it('finds by name', () => {
		const result = findPipeline(layout, 'Foo');
		expect(result.found).toBe(true);
		if (result.found) expect(result.pipeline.name).toBe('Foo');
	});

	it('finds by id', () => {
		const result = findPipeline(layout, 'pipeline-Bar-2');
		expect(result.found).toBe(true);
		if (result.found) expect(result.pipeline.name).toBe('Bar');
	});

	it('returns not-found for unknown identifier', () => {
		const result = findPipeline(layout, 'Nope');
		expect(result.found).toBe(false);
	});
});

describe('upsertPipeline', () => {
	it('add: appends a fresh pipeline when no conflict', () => {
		const layout = makeLayout([makePipeline('Foo')]);
		const result = upsertPipeline(layout, makePipeline('Bar'), 'add');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.layout.pipelines.map((p) => p.name)).toEqual(['Foo', 'Bar']);
		}
	});

	it('add: rejects when a pipeline with the same name already exists', () => {
		const layout = makeLayout([makePipeline('Foo')]);
		const result = upsertPipeline(layout, makePipeline('Foo'), 'add');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('already_exists');
	});

	it('add: rejects when a pipeline with the same id already exists', () => {
		const layout = makeLayout([makePipeline('Foo', 'pipeline-shared')]);
		const result = upsertPipeline(layout, makePipeline('Bar', 'pipeline-shared'), 'add');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('already_exists');
	});

	it('replace: substitutes the existing pipeline when found', () => {
		const layout = makeLayout([makePipeline('Foo'), makePipeline('Bar')]);
		const updatedFoo: CuePipeline = { ...makePipeline('Foo'), color: '#ff0000' };
		const result = upsertPipeline(layout, updatedFoo, 'replace');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.layout.pipelines).toHaveLength(2);
			expect(result.layout.pipelines.find((p) => p.name === 'Foo')?.color).toBe('#ff0000');
		}
	});

	it('replace: rejects when target does not exist', () => {
		const layout = makeLayout([makePipeline('Foo')]);
		const result = upsertPipeline(layout, makePipeline('Bar'), 'replace');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('not_found');
	});

	it('does not mutate the input layout', () => {
		const layout = makeLayout([makePipeline('Foo')]);
		const before = JSON.stringify(layout);
		upsertPipeline(layout, makePipeline('Bar'), 'add');
		expect(JSON.stringify(layout)).toBe(before);
	});
});

describe('removePipelineFromLayout', () => {
	it('removes by name', () => {
		const layout = makeLayout([makePipeline('Foo'), makePipeline('Bar')]);
		const result = removePipelineFromLayout(layout, 'Foo');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.layout.pipelines.map((p) => p.name)).toEqual(['Bar']);
			expect(result.removed.name).toBe('Foo');
		}
	});

	it('removes by id', () => {
		const layout = makeLayout([makePipeline('Foo', 'pipeline-x')]);
		const result = removePipelineFromLayout(layout, 'pipeline-x');
		expect(result.ok).toBe(true);
	});

	it('returns not_found for unknown identifier', () => {
		const layout = makeLayout([makePipeline('Foo')]);
		const result = removePipelineFromLayout(layout, 'Bar');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('not_found');
	});
});
