/**
 * Tests for describePipeline / derivePipelineHealth - the prose + health
 * verdict behind the Cue Pipeline List tab.
 *
 * Pure functions: no React, no DOM, no IPC.
 */

import { describe, it, expect } from 'vitest';
import {
	describePipeline,
	derivePipelineHealth,
	stripPipelinePrefix,
} from '../../shared/cue-pipeline-summary';
import type { CuePipeline, PipelineNode } from '../../shared/cue-pipeline-types';
import type { CueRunResult } from '../../shared/cue/contracts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function trigger(id: string, extras: Record<string, unknown> = {}): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType: 'time.scheduled',
			label: 'Scheduled',
			config: { schedule_times: ['09:00'] },
			subscriptionName: 'Daily Digest',
			...extras,
		},
	} as PipelineNode;
}

function agent(id: string, sessionName: string, sessionId = `${sessionName}-id`): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: { sessionId, sessionName, toolType: 'claude-code' },
	} as PipelineNode;
}

function pipeline(overrides: Partial<CuePipeline> = {}): CuePipeline {
	return {
		id: 'p1',
		name: 'Daily Digest',
		color: '#06b6d4',
		nodes: [trigger('t1'), agent('a1', 'rc'), agent('a2', 'Maestro')],
		edges: [
			{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
			{ id: 'e2', source: 'a1', target: 'a2', mode: 'pass' },
		],
		...overrides,
	};
}

function run(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'r1',
		sessionId: 's1',
		sessionName: 'rc',
		subscriptionName: 'Daily Digest',
		event: { type: 'time.scheduled', payload: {} },
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 12_000,
		startedAt: '2026-08-20T09:00:00.000Z',
		endedAt: '2026-08-20T09:00:12.000Z',
		...overrides,
	} as CueRunResult;
}

// ─── describePipeline ────────────────────────────────────────────────────────

describe('describePipeline', () => {
	it('reads the flow left-to-right from the trigger', () => {
		const desc = describePipeline(pipeline());
		expect(desc.flow).toBe('Scheduled (09:00) → rc → Maestro');
		expect(desc.steps.map((s) => s.label)).toEqual(['rc', 'Maestro']);
		expect(desc.agentIds).toEqual(['rc-id', 'Maestro-id']);
	});

	// Node ORDER in the array is not execution order - a hand-authored YAML can
	// list the last agent first. The flow line must follow the edges instead.
	it('orders steps by edge depth, not array position', () => {
		const desc = describePipeline(
			pipeline({
				nodes: [agent('a2', 'Maestro'), agent('a1', 'rc'), trigger('t1')],
			})
		);
		expect(desc.flow).toBe('Scheduled (09:00) → rc → Maestro');
	});

	it('keeps nodes unreachable from any trigger, sorted last', () => {
		const desc = describePipeline(
			pipeline({
				nodes: [trigger('t1'), agent('a1', 'rc'), agent('orphan', 'Stray')],
				edges: [{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' }],
			})
		);
		expect(desc.steps.map((s) => s.label)).toEqual(['rc', 'Stray']);
	});

	it('collapses multiple triggers into a count', () => {
		const desc = describePipeline(
			pipeline({
				nodes: [
					trigger('t1'),
					trigger('t2', { eventType: 'app.startup', config: {} }),
					agent('a1', 'rc'),
				],
				edges: [
					{ id: 'e1', source: 't1', target: 'a1', mode: 'pass' },
					{ id: 'e2', source: 't2', target: 'a1', mode: 'pass' },
				],
			})
		);
		expect(desc.flow).toBe('2 triggers → rc');
		expect(desc.triggers).toHaveLength(2);
	});

	it('prefers a custom trigger label over the event-type label', () => {
		const desc = describePipeline(
			pipeline({ nodes: [trigger('t1', { customLabel: 'Morning Check' }), agent('a1', 'rc')] })
		);
		expect(desc.flow).toBe('Morning Check (09:00) → rc');
	});

	it('counts unresolved-agent error nodes', () => {
		const desc = describePipeline(
			pipeline({
				nodes: [
					trigger('t1'),
					{
						id: 'x1',
						type: 'error',
						position: { x: 0, y: 0 },
						data: {
							reason: 'missing-target',
							subscriptionName: 'Daily Digest',
							message: 'Agent "gone" not found',
						},
					} as PipelineNode,
				],
				edges: [{ id: 'e1', source: 't1', target: 'x1', mode: 'pass' }],
			})
		);
		expect(desc.errorCount).toBe(1);
	});
});

// ─── derivePipelineHealth ────────────────────────────────────────────────────

describe('derivePipelineHealth', () => {
	const empty = { activeRuns: [], activityLog: [] };

	it('reports healthy when the most recent finished run completed', () => {
		const health = derivePipelineHealth(pipeline(), { ...empty, activityLog: [run()] });
		expect(health.status).toBe('healthy');
		expect(health.recentRunCount).toBe(1);
		expect(health.recentFailureCount).toBe(0);
	});

	it('reports failing when the most recent finished run failed', () => {
		const health = derivePipelineHealth(pipeline(), {
			...empty,
			activityLog: [run({ status: 'failed', exitCode: 1 })],
		});
		expect(health.status).toBe('failing');
		expect(health.detail).toContain('exit 1');
	});

	// The log arrives newest-first but is sorted defensively - an out-of-order
	// feed must not make an old success outrank a recent failure.
	it('picks the newest finished run regardless of array order', () => {
		const health = derivePipelineHealth(pipeline(), {
			...empty,
			activityLog: [
				run({ runId: 'old', endedAt: '2026-08-19T09:00:12.000Z' }),
				run({ runId: 'new', status: 'timeout', endedAt: '2026-08-20T09:00:12.000Z' }),
			],
		});
		expect(health.status).toBe('failing');
		expect(health.lastRun?.runId).toBe('new');
		expect(health.detail).toContain('timed out');
	});

	it('matches chain subscriptions back to their pipeline', () => {
		const health = derivePipelineHealth(pipeline(), {
			...empty,
			activityLog: [run({ subscriptionName: 'Daily Digest-chain-2' })],
		});
		expect(health.recentRunCount).toBe(1);
	});

	it('prefers the explicit pipelineName over the subscription-name fallback', () => {
		const health = derivePipelineHealth(pipeline(), {
			...empty,
			activityLog: [run({ subscriptionName: 'unrelated-sub', pipelineName: 'Daily Digest' })],
		});
		expect(health.recentRunCount).toBe(1);
	});

	it('running outranks every other state', () => {
		const health = derivePipelineHealth(pipeline(), {
			activeRuns: [run({ status: 'running' })],
			activityLog: [run({ status: 'failed' })],
			configErrors: ['needs at least one trigger'],
		});
		expect(health.status).toBe('running');
		expect(health.activeRunCount).toBe(1);
		// The config problem is still reported - it just doesn't win the badge.
		expect(health.issues).toContain('needs at least one trigger');
	});

	it('reports invalid ahead of disabled and failing', () => {
		const health = derivePipelineHealth(pipeline(), {
			...empty,
			activityLog: [run({ status: 'failed' })],
			configErrors: ['needs at least one agent or command'],
			disabled: true,
		});
		expect(health.status).toBe('invalid');
	});

	it('reports disabled when every trigger is switched off', () => {
		const health = derivePipelineHealth(pipeline(), { ...empty, disabled: true });
		expect(health.status).toBe('disabled');
	});

	it('surfaces unresolved agent nodes as an issue', () => {
		const withError = pipeline({
			nodes: [
				trigger('t1'),
				{
					id: 'x1',
					type: 'error',
					position: { x: 0, y: 0 },
					data: {
						reason: 'missing-target',
						subscriptionName: 'Daily Digest',
						message: 'gone',
					},
				} as PipelineNode,
			],
			edges: [{ id: 'e1', source: 't1', target: 'x1', mode: 'pass' }],
		});
		const health = derivePipelineHealth(withError, empty);
		expect(health.status).toBe('invalid');
		expect(health.issues[0]).toContain('no longer exists');
	});

	// The activity log is a bounded window, so "no recent runs" must not be
	// overstated as "never run".
	it('reports idle without claiming the pipeline has never run', () => {
		const health = derivePipelineHealth(pipeline(), empty);
		expect(health.status).toBe('idle');
		expect(health.label).toBe('No recent runs');
		expect(health.detail).not.toMatch(/never/i);
	});

	it('treats a stopped run as a failure', () => {
		const health = derivePipelineHealth(pipeline(), {
			...empty,
			activityLog: [run({ status: 'stopped' })],
		});
		expect(health.status).toBe('failing');
		expect(health.detail).toContain('was stopped');
	});

	it('ignores runs belonging to other pipelines', () => {
		const health = derivePipelineHealth(pipeline(), {
			activeRuns: [run({ subscriptionName: 'Other', status: 'running' })],
			activityLog: [run({ subscriptionName: 'Other', status: 'failed' })],
		});
		expect(health.status).toBe('idle');
		expect(health.activeRunCount).toBe(0);
	});
});

describe('stripPipelinePrefix', () => {
	it('removes the quoted pipeline name validatePipelines prepends', () => {
		expect(stripPipelinePrefix('"Daily Digest": needs at least one trigger', 'Daily Digest')).toBe(
			'needs at least one trigger'
		);
	});

	it('leaves an unprefixed message alone', () => {
		expect(stripPipelinePrefix('something else', 'Daily Digest')).toBe('something else');
	});
});
