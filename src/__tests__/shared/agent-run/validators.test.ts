import { describe, expect, it } from 'vitest';
import {
	summarizeAgentRun,
	validateAgentRun,
	validateAgentRunStrict,
	validateAgentRunEvent,
	validateAgentRunEvents,
	validateAgentRunFile,
} from '../../../shared/agent-run';

const validRun = {
	id: 'run-1',
	createdAt: 100,
	updatedAt: 200,
	provider: 'claude-code',
	model: 'sonnet',
	agentId: 'agent-1',
	agentName: 'Reviewer',
	sessionId: 'session-1',
	tabId: 'tab-1',
	cwd: '/repo',
	repo: 'owner/repo',
	worktreePath: '/repo/.worktrees/run-1',
	branch: 'agent/run-1',
	baseBranch: 'main',
	prompt: 'Fix the thing',
	status: 'completed',
	artifacts: [{ name: 'log', path: '/tmp/log.txt', kind: 'log' }],
	touchedFiles: ['src/a.ts', 'src/b.ts'],
	checks: [
		{ name: 'unit', status: 'passed', command: 'vitest' },
		{ name: 'typecheck', status: 'failed', summary: 'one error' },
	],
	reviews: [
		{
			file: 'src/a.ts',
			line: 7,
			severity: 'high',
			category: 'correctness',
			message: 'Race condition',
			confidence: 0.9,
			status: 'open',
			suggestedFix: 'Await the write.',
		},
		{
			severity: 'low',
			category: 'style',
			message: 'Rename for clarity',
			status: 'fixed',
		},
	],
	pullRequest: {
		number: 42,
		url: 'https://example.test/pr/42',
		state: 'open',
		mergeable: true,
		headBranch: 'agent/run-1',
		baseBranch: 'main',
	},
	merge: { status: 'merged', commit: 'abc123' },
	nextAction: 'ship',
	source: 'unit-test',
	metadata: {
		adapter: 'test-harness',
		nested: { retained: true },
	},
};

describe('validateAgentRun', () => {
	it('accepts a valid run and preserves metadata', () => {
		const run = validateAgentRun(validRun);

		expect(run).not.toBeNull();
		expect(run?.id).toBe('run-1');
		expect(run?.status).toBe('completed');
		expect(run?.metadata).toEqual(validRun.metadata);
		expect(run?.checks).toHaveLength(2);
		expect(run?.reviews).toHaveLength(2);
	});

	it('preserves future provider strings', () => {
		const run = validateAgentRun({ ...validRun, provider: 'future-agent-adapter' });

		expect(run?.provider).toBe('future-agent-adapter');
	});

	it.each(['qwen', 'qwen-code', 'qwen-coder', 'qwen3-coder'])(
		'persists %s as the canonical qwen3-coder provider',
		(provider) => {
			const roundTripped = JSON.parse(
				JSON.stringify(validateAgentRunFile({ runs: [{ ...validRun, provider }] }))
			);

			expect(roundTripped.runs[0].provider).toBe('qwen3-coder');
		}
	);

	it('returns null for malformed runs', () => {
		expect(validateAgentRun({ ...validRun, id: 12 })).toBeNull();
		expect(validateAgentRun({ ...validRun, updatedAt: Number.POSITIVE_INFINITY })).toBeNull();
		expect(validateAgentRun({ ...validRun, status: 'paused' })).toBeNull();
	});

	it('strict validation rejects malformed child evidence instead of dropping it', () => {
		expect(
			validateAgentRunStrict({
				...validRun,
				checks: [{ status: 'passed' }],
			})
		).toBeNull();
		expect(
			validateAgentRunStrict({
				...validRun,
				reviews: [{ severity: 'not-real', category: 'x', message: 'x', status: 'open' }],
			})
		).toBeNull();
	});

	it('strict validation rejects malformed optional evidence instead of dropping it', () => {
		expect(
			validateAgentRunStrict({
				...validRun,
				pullRequest: { ...validRun.pullRequest, url: 1 },
			})
		).toBeNull();
		expect(
			validateAgentRunStrict({
				...validRun,
				merge: { status: 'bogus' },
			})
		).toBeNull();
		expect(
			validateAgentRunStrict({
				...validRun,
				source: 123,
			})
		).toBeNull();
		expect(
			validateAgentRunStrict({
				...validRun,
				reviews: [{ ...validRun.reviews[0], confidence: 'high' }],
			})
		).toBeNull();
	});
});

describe('validateAgentRunFile', () => {
	it('drops malformed runs without throwing', () => {
		const parsed = validateAgentRunFile({
			runs: [validRun, { ...validRun, id: '' }, null, { ...validRun, id: 'run-2' }],
		});

		expect(parsed.runs.map((run) => run.id)).toEqual(['run-1', 'run-2']);
	});
});

describe('validateAgentRunEvent', () => {
	it('accepts valid events', () => {
		const event = validateAgentRunEvent({
			id: 'event-1',
			runId: 'run-1',
			timestamp: 300,
			type: 'status',
			message: 'Run completed',
			status: 'completed',
			data: { exitCode: 0 },
		});

		expect(event).toEqual({
			id: 'event-1',
			runId: 'run-1',
			timestamp: 300,
			type: 'status',
			message: 'Run completed',
			status: 'completed',
			data: { exitCode: 0 },
		});
	});

	it('drops invalid JSONL events without throwing', () => {
		const events = validateAgentRunEvents([
			JSON.stringify({ id: 'event-1', runId: 'run-1', timestamp: 300, type: 'started' }),
			'{not-json',
			JSON.stringify({ id: 'event-2', runId: 'run-1', timestamp: Number.NaN, type: 'bad' }),
			'',
			JSON.stringify({ id: 'event-3', runId: 'run-1', timestamp: 400, type: 'completed' }),
		]);

		expect(events.map((event) => event.id)).toEqual(['event-1', 'event-3']);
	});
});

describe('summarizeAgentRun', () => {
	it('counts checks, reviews, and touched files', () => {
		const run = validateAgentRun(validRun);
		expect(run).not.toBeNull();

		const summary = summarizeAgentRun(run!);

		expect(summary).toMatchObject({
			id: 'run-1',
			provider: 'claude-code',
			status: 'completed',
			touchedFileCount: 2,
			checkCount: 2,
			passedCheckCount: 1,
			failedCheckCount: 1,
			reviewFindingCount: 2,
			openReviewFindingCount: 1,
			fixedReviewFindingCount: 1,
		});
	});
});
