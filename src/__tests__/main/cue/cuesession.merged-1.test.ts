// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/cue/pipeline-layout-mutations.test.ts
// Source: src/__tests__/main/cue/cue-metrics.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	findPipeline,
	removePipelineFromLayout,
	upsertPipeline,
	validatePipelineEntry,
} from '../../../main/cue/pipeline-layout-mutations';
import type { CuePipeline, PipelineLayoutState } from '../../../shared/cue-pipeline-types';
import { createCueMetrics, type CueMetricsCollector } from '../../../main/cue/cue-metrics';
// Source: src/__tests__/main/cue/pipeline-layout-mutations.test.ts
describe('', () => {
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
});
// Source: src/__tests__/main/cue/cue-metrics.test.ts
describe('', () => {
	describe('cue-metrics', () => {
		let metrics: CueMetricsCollector;
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
			metrics = createCueMetrics();
		});
		afterEach(() => {
			// Restore real timers so other suites aren't polluted.
			vi.useRealTimers();
		});
		describe('snapshot', () => {
			it('returns all counters zeroed on construction', () => {
				const snap = metrics.snapshot();
				expect(snap.runsStarted).toBe(0);
				expect(snap.runsCompleted).toBe(0);
				expect(snap.runsFailed).toBe(0);
				expect(snap.runsTimedOut).toBe(0);
				expect(snap.runsStopped).toBe(0);
				expect(snap.eventsDropped).toBe(0);
				expect(snap.queueRestored).toBe(0);
				expect(snap.fanInTimeouts).toBe(0);
				expect(snap.fanInCompletions).toBe(0);
				expect(snap.githubPollErrors).toBe(0);
				expect(snap.rateLimitBackoffs).toBe(0);
				expect(snap.configReloads).toBe(0);
				expect(snap.pathTraversalsBlocked).toBe(0);
				expect(snap.heartbeatFailures).toBe(0);
			});
			it('records startedAt as construction time', () => {
				expect(metrics.snapshot().startedAt).toBe(new Date('2026-04-21T10:00:00Z').getTime());
			});
			it('returns a fresh object each call (no shared reference)', () => {
				const a = metrics.snapshot();
				const b = metrics.snapshot();
				expect(a).not.toBe(b);
				a.runsStarted = 999;
				expect(metrics.snapshot().runsStarted).toBe(0);
			});
		});
		describe('increment', () => {
			it('bumps the targeted key by 1 by default', () => {
				metrics.increment('runsStarted');
				expect(metrics.snapshot().runsStarted).toBe(1);
			});
			it('bumps the targeted key by an explicit amount', () => {
				metrics.increment('eventsDropped', 5);
				expect(metrics.snapshot().eventsDropped).toBe(5);
			});
			it('accumulates across multiple calls', () => {
				metrics.increment('runsCompleted');
				metrics.increment('runsCompleted');
				metrics.increment('runsCompleted', 3);
				expect(metrics.snapshot().runsCompleted).toBe(5);
			});
			it('independent keys do not cross-contaminate', () => {
				metrics.increment('runsStarted', 2);
				metrics.increment('runsFailed', 7);
				const snap = metrics.snapshot();
				expect(snap.runsStarted).toBe(2);
				expect(snap.runsFailed).toBe(7);
				expect(snap.runsCompleted).toBe(0);
			});
			it('accepts zero and negative increments (decrement semantics)', () => {
				metrics.increment('runsStarted', 5);
				metrics.increment('runsStarted', -2);
				metrics.increment('runsStarted', 0);
				expect(metrics.snapshot().runsStarted).toBe(3);
			});
		});
		describe('reset', () => {
			it('returns all counters to zero', () => {
				metrics.increment('runsStarted', 10);
				metrics.increment('eventsDropped', 5);
				metrics.reset();
				const snap = metrics.snapshot();
				expect(snap.runsStarted).toBe(0);
				expect(snap.eventsDropped).toBe(0);
			});
			it('updates startedAt to the reset time', () => {
				vi.setSystemTime(new Date('2026-04-21T11:00:00Z'));
				metrics.reset();
				expect(metrics.snapshot().startedAt).toBe(new Date('2026-04-21T11:00:00Z').getTime());
			});
			it('allows fresh increments after reset', () => {
				metrics.increment('runsStarted', 10);
				metrics.reset();
				metrics.increment('runsStarted');
				expect(metrics.snapshot().runsStarted).toBe(1);
			});
		});
	});
});
