/**
 * Tests for the Cue Template Context Builder.
 *
 * Verifies the enricher registry correctly maps event payloads to
 * templateContext.cue fields for all event types.
 */

import { describe, it, expect } from 'vitest';
import { buildCueTemplateContext } from '../../../main/cue/cue-template-context-builder';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'file.changed',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'test-trigger',
		payload: {},
		...overrides,
	};
}

function createSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'test-sub',
		event: 'file.changed',
		enabled: true,
		prompt: 'test prompt',
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('cue-template-context-builder', () => {
	describe('base enricher (all event types)', () => {
		it('populates common fields from event metadata', () => {
			const event = createEvent({
				type: 'time.heartbeat',
				timestamp: '2026-04-10T12:00:00.000Z',
			});
			const sub = createSubscription({ name: 'heartbeat-check' });

			const ctx = buildCueTemplateContext(event, sub, 'run-abc');

			expect(ctx.eventType).toBe('time.heartbeat');
			expect(ctx.eventTimestamp).toBe('2026-04-10T12:00:00.000Z');
			expect(ctx.triggerName).toBe('heartbeat-check');
			expect(ctx.runId).toBe('run-abc');
		});

		it('populates file fields from payload', () => {
			const event = createEvent({
				payload: {
					path: '/project/src/app.ts',
					filename: 'app.ts',
					directory: '/project/src',
					extension: '.ts',
					changeType: 'change',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.filePath).toBe('/project/src/app.ts');
			expect(ctx.fileName).toBe('app.ts');
			expect(ctx.fileDir).toBe('/project/src');
			expect(ctx.fileExt).toBe('.ts');
			expect(ctx.fileChangeType).toBe('change');
		});

		it('populates agent.completed source fields from payload', () => {
			const event = createEvent({
				type: 'agent.completed',
				payload: {
					sourceSession: 'builder',
					sourceOutput: 'Build OK',
					status: 'completed',
					exitCode: 0,
					durationMs: 5000,
					triggeredBy: 'file-watch',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.sourceSession).toBe('builder');
			expect(ctx.sourceOutput).toBe('Build OK');
			expect(ctx.sourceStatus).toBe('completed');
			expect(ctx.sourceExitCode).toBe('0');
			expect(ctx.sourceDuration).toBe('5000');
			expect(ctx.sourceTriggeredBy).toBe('file-watch');
		});

		it('defaults all fields to empty string when payload is empty', () => {
			const event = createEvent({ payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.filePath).toBe('');
			expect(ctx.fileName).toBe('');
			expect(ctx.fileDir).toBe('');
			expect(ctx.fileExt).toBe('');
			expect(ctx.fileChangeType).toBe('');
			expect(ctx.sourceSession).toBe('');
			expect(ctx.sourceOutput).toBe('');
			expect(ctx.sourceStatus).toBe('');
			expect(ctx.sourceExitCode).toBe('');
			expect(ctx.sourceDuration).toBe('');
			expect(ctx.sourceTriggeredBy).toBe('');
		});
	});

	describe('task.pending enricher', () => {
		it('populates task-specific fields', () => {
			const event = createEvent({
				type: 'task.pending',
				payload: {
					path: '/project/TODO.md',
					filename: 'TODO.md',
					directory: '/project',
					taskCount: 3,
					taskList: '- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3',
					content: '# TODO\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.taskFile).toBe('/project/TODO.md');
			expect(ctx.taskFileName).toBe('TODO.md');
			expect(ctx.taskFileDir).toBe('/project');
			expect(ctx.taskCount).toBe('3');
			expect(ctx.taskList).toBe('- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3');
			expect(ctx.taskContent).toBe('# TODO\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3');
		});

		it('preserves base cue fields alongside task fields', () => {
			const event = createEvent({
				type: 'task.pending',
				timestamp: '2026-04-10T15:00:00.000Z',
				payload: { taskCount: 1, taskList: '- [ ] One' },
			});
			const sub = createSubscription({ name: 'task-watcher' });

			const ctx = buildCueTemplateContext(event, sub, 'run-2');

			// Base fields present
			expect(ctx.eventType).toBe('task.pending');
			expect(ctx.triggerName).toBe('task-watcher');
			expect(ctx.runId).toBe('run-2');
			// Task fields present
			expect(ctx.taskCount).toBe('1');
		});

		it('defaults task fields to empty/zero when payload is missing', () => {
			const event = createEvent({ type: 'task.pending', payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.taskFile).toBe('');
			expect(ctx.taskFileName).toBe('');
			expect(ctx.taskFileDir).toBe('');
			expect(ctx.taskCount).toBe('0');
			expect(ctx.taskList).toBe('');
			expect(ctx.taskContent).toBe('');
		});
	});

	describe('github.pull_request enricher', () => {
		it('populates GitHub PR fields', () => {
			const event = createEvent({
				type: 'github.pull_request',
				payload: {
					type: 'pull_request',
					number: 42,
					title: 'Add feature X',
					author: 'octocat',
					url: 'https://github.com/owner/repo/pull/42',
					body: 'This PR adds feature X',
					labels: 'enhancement,review-needed',
					state: 'open',
					repo: 'owner/repo',
					head_branch: 'feature-x',
					base_branch: 'main',
					assignees: 'dev1',
					merged_at: '',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.ghType).toBe('pull_request');
			expect(ctx.ghNumber).toBe('42');
			expect(ctx.ghTitle).toBe('Add feature X');
			expect(ctx.ghAuthor).toBe('octocat');
			expect(ctx.ghUrl).toBe('https://github.com/owner/repo/pull/42');
			expect(ctx.ghBody).toBe('This PR adds feature X');
			expect(ctx.ghLabels).toBe('enhancement,review-needed');
			expect(ctx.ghState).toBe('open');
			expect(ctx.ghRepo).toBe('owner/repo');
			expect(ctx.ghBranch).toBe('feature-x');
			expect(ctx.ghBaseBranch).toBe('main');
			expect(ctx.ghAssignees).toBe('dev1');
			expect(ctx.ghMergedAt).toBe('');
		});

		it('preserves base cue fields alongside GitHub fields', () => {
			const event = createEvent({
				type: 'github.pull_request',
				payload: { number: 1, title: 'Test' },
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.eventType).toBe('github.pull_request');
			expect(ctx.ghNumber).toBe('1');
		});
	});

	describe('github.issue enricher', () => {
		it('populates GitHub issue fields', () => {
			const event = createEvent({
				type: 'github.issue',
				payload: {
					type: 'issue',
					number: 99,
					title: 'Bug report',
					author: 'user1',
					url: 'https://github.com/owner/repo/issues/99',
					body: 'Found a bug',
					labels: 'bug',
					state: 'open',
					repo: 'owner/repo',
					assignees: 'dev1,dev2',
				},
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.ghType).toBe('issue');
			expect(ctx.ghNumber).toBe('99');
			expect(ctx.ghTitle).toBe('Bug report');
			expect(ctx.ghAssignees).toBe('dev1,dev2');
			// head_branch / base_branch not in payload → empty string
			expect(ctx.ghBranch).toBe('');
			expect(ctx.ghBaseBranch).toBe('');
		});
	});

	describe('unknown event types', () => {
		it('still returns base fields for unregistered event types', () => {
			const event = createEvent({
				type: 'app.startup' as any,
				timestamp: '2026-04-10T08:00:00.000Z',
			});
			const sub = createSubscription({ name: 'boot-task' });

			const ctx = buildCueTemplateContext(event, sub, 'run-5');

			// Base fields always populated
			expect(ctx.eventType).toBe('app.startup');
			expect(ctx.triggerName).toBe('boot-task');
			expect(ctx.runId).toBe('run-5');
			// No event-specific enricher for app.startup, so no extra fields
			expect(ctx.taskFile).toBeUndefined();
			expect(ctx.ghType).toBeUndefined();
		});

		it('handles time.heartbeat (no specific enricher) gracefully', () => {
			const event = createEvent({ type: 'time.heartbeat', payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.eventType).toBe('time.heartbeat');
			expect(ctx.filePath).toBe('');
		});

		it('handles time.scheduled (no specific enricher) gracefully', () => {
			const event = createEvent({ type: 'time.scheduled', payload: {} });

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.eventType).toBe('time.scheduled');
		});
	});

	describe('edge cases', () => {
		it('coerces numeric payload values to strings', () => {
			const event = createEvent({
				type: 'agent.completed',
				payload: { exitCode: 137, durationMs: 0 },
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.sourceExitCode).toBe('137');
			expect(ctx.sourceDuration).toBe('0');
		});

		it('coerces boolean payload values to strings', () => {
			const event = createEvent({
				payload: { status: false as any },
			});

			const ctx = buildCueTemplateContext(event, createSubscription(), 'run-1');

			expect(ctx.sourceStatus).toBe('false');
		});
	});
});
