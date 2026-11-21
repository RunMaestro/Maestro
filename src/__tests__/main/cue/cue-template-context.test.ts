// Related Cue tests; each source keeps its own hooks and state.
// Source: src/__tests__/main/cue/cue-template-context-builder.test.ts
// Source: src/__tests__/main/cue/cue-template-context-builder.upstream.test.ts
import { describe, it, expect } from 'vitest';
import {
	buildCueTemplateContext as s0_buildCueTemplateContext,
	projectCueEventPaths,
} from '../../../main/cue/cue-template-context-builder';
import { substituteTemplateVariables } from '../../../shared/templateVariables';
import type { CueEvent, CueSubscription as S0_CueSubscription } from '../../../main/cue/cue-types';
import { buildCueTemplateContext as s1_buildCueTemplateContext } from '../../../main/cue/cue-template-context-builder';
import { createCueEvent } from '../../../main/cue/cue-types';
import type { CueSubscription as S1_CueSubscription } from '../../../main/cue/cue-types';
describe('cue-template-context-builder', () => {
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
	function createSubscription(overrides: Partial<S0_CueSubscription> = {}): S0_CueSubscription {
		return {
			name: 'test-sub',
			event: 'file.changed',
			enabled: true,
			prompt: 'test prompt',
			...overrides,
		};
	}
	// ─── Tests ───────────────────────────────────────────────────────────────────
	describe('host-mounted file and task execution templates', () => {
		it.each(['file.changed', 'task.pending'] as const)(
			'projects all path fields for %s',
			(type) => {
				const event = createEvent({
					type,
					payload: {
						path: '/mnt/box/home/dev/app/tasks.md',
						directory: '/mnt/box/home/dev/app',
						filename: 'tasks.md',
						taskList: 'L1: work',
						taskCount: 1,
					},
				});
				const projected = projectCueEventPaths(event, { id: 'box', hostMountRoot: '/mnt/box' });
				const cue = s0_buildCueTemplateContext(
					projected,
					createSubscription({ event: type }),
					'run'
				);
				const template =
					'{{CUE_FILE_PATH}} {{CUE_FILE_DIR}}' +
					(type === 'task.pending' ? ' {{CUE_TASK_FILE}} {{CUE_TASK_FILE_DIR}}' : '');
				expect(
					substituteTemplateVariables(template, {
						session: {
							id: 'remote',
							name: 'Remote',
							toolType: 'claude-code',
							cwd: '/home/dev/app',
						},
						cue,
					})
				).toBe(
					'/home/dev/app/tasks.md /home/dev/app' +
						(type === 'task.pending' ? ' /home/dev/app/tasks.md /home/dev/app' : '')
				);
				expect(event.payload.path).toBe('/mnt/box/home/dev/app/tasks.md');
				expect(projected.payload.taskList).toBe('L1: work');
			}
		);
		it('leaves non-file events and unmounted sessions unchanged', () => {
			const event = createEvent({ type: 'agent.completed', payload: { path: '/mnt/box/report' } });
			expect(projectCueEventPaths(event, { id: 'box', hostMountRoot: '/mnt/box' })).toBe(event);
			expect(projectCueEventPaths(createEvent(), { id: 'box' }).payload).toEqual({});
		});
	});
	describe('cue-template-context-builder', () => {
		describe('base enricher (all event types)', () => {
			it('populates common fields from event metadata', () => {
				const event = createEvent({
					type: 'time.heartbeat',
					timestamp: '2026-04-10T12:00:00.000Z',
				});
				const sub = createSubscription({ name: 'heartbeat-check' });
				const ctx = s0_buildCueTemplateContext(event, sub, 'run-abc');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
				expect(ctx.sourceSession).toBe('builder');
				expect(ctx.sourceOutput).toBe('Build OK');
				expect(ctx.sourceStatus).toBe('completed');
				expect(ctx.sourceExitCode).toBe('0');
				expect(ctx.sourceDuration).toBe('5000');
				expect(ctx.sourceTriggeredBy).toBe('file-watch');
			});
			it('defaults all fields to empty string when payload is empty', () => {
				const event = createEvent({ payload: {} });
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, sub, 'run-2');
				// Base fields present
				expect(ctx.eventType).toBe('task.pending');
				expect(ctx.triggerName).toBe('task-watcher');
				expect(ctx.runId).toBe('run-2');
				// Task fields present
				expect(ctx.taskCount).toBe('1');
			});
			it('defaults task fields to empty/zero when payload is missing', () => {
				const event = createEvent({ type: 'task.pending', payload: {} });
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
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
				const ctx = s0_buildCueTemplateContext(event, sub, 'run-5');
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
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
				expect(ctx.eventType).toBe('time.heartbeat');
				expect(ctx.filePath).toBe('');
			});
			it('handles time.scheduled (no specific enricher) gracefully', () => {
				const event = createEvent({ type: 'time.scheduled', payload: {} });
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
				expect(ctx.eventType).toBe('time.scheduled');
			});
		});
		describe('edge cases', () => {
			it('coerces numeric payload values to strings', () => {
				const event = createEvent({
					type: 'agent.completed',
					payload: { exitCode: 137, durationMs: 0 },
				});
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
				expect(ctx.sourceExitCode).toBe('137');
				expect(ctx.sourceDuration).toBe('0');
			});
			it('coerces boolean payload values to strings', () => {
				const event = createEvent({
					payload: { status: false as any },
				});
				const ctx = s0_buildCueTemplateContext(event, createSubscription(), 'run-1');
				expect(ctx.sourceStatus).toBe('false');
			});
		});
	});
});
describe('cue-template-context-builder.upstream', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function makeSub(overrides: Partial<S1_CueSubscription> = {}): S1_CueSubscription {
		return {
			name: 'test-sub',
			event: 'agent.completed',
			enabled: true,
			prompt: 'test',
			...overrides,
		};
	}
	// ─── Tests ──────────────────────────────────────────────────────────────────
	describe('cue-template-context-builder - per-source upstream output', () => {
		describe('perSourceOutputs', () => {
			it('creates output_ keys for each source in perSourceOutputs', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					perSourceOutputs: {
						'Agent A': 'output-a',
						'Agent B': 'output-b',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				expect(ctx.output_AGENT_A).toBe('output-a');
				expect(ctx.output_AGENT_B).toBe('output-b');
			});
			it('does not add output_ keys when perSourceOutputs is absent', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					sourceSession: 'worker',
					sourceOutput: 'done',
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				// No output_* keys should exist (except base fields)
				const outputKeys = Object.keys(ctx).filter((k) => k.startsWith('output_'));
				expect(outputKeys).toHaveLength(0);
			});
			it('handles empty perSourceOutputs map', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					perSourceOutputs: {},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				const outputKeys = Object.keys(ctx).filter((k) => k.startsWith('output_'));
				expect(outputKeys).toHaveLength(0);
			});
		});
		describe('forwardedOutputs', () => {
			it('creates forwarded_ keys for each source in forwardedOutputs', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					forwardedOutputs: {
						'Agent C': 'forwarded-c',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				expect(ctx.forwarded_AGENT_C).toBe('forwarded-c');
			});
			it('does not add forwarded_ keys when forwardedOutputs is absent', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				const forwardedKeys = Object.keys(ctx).filter((k) => k.startsWith('forwarded_'));
				expect(forwardedKeys).toHaveLength(0);
			});
		});
		describe('name sanitization', () => {
			it('sanitizes special characters in session names to underscores', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					perSourceOutputs: {
						'my-agent.1': 'output-special',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				expect(ctx.output_MY_AGENT_1).toBe('output-special');
			});
			it('sanitizes names with multiple special characters', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					perSourceOutputs: {
						'agent--with...dots': 'value',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				// Multiple non-alphanumeric chars collapse to a single underscore
				expect(ctx.output_AGENT_WITH_DOTS).toBe('value');
			});
			it('strips leading and trailing non-alphanumeric from sanitized names', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					perSourceOutputs: {
						'-leading-': 'val',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				expect(ctx.output_LEADING).toBe('val');
			});
			it('uppercases lowercase names', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					forwardedOutputs: {
						'lowercase agent': 'fwd',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				expect(ctx.forwarded_LOWERCASE_AGENT).toBe('fwd');
			});
		});
		describe('combined perSourceOutputs + forwardedOutputs', () => {
			it('includes both output_ and forwarded_ keys when both maps are present', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					perSourceOutputs: {
						'Agent A': 'output-a',
					},
					forwardedOutputs: {
						'Agent B': 'forwarded-b',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				expect(ctx.output_AGENT_A).toBe('output-a');
				expect(ctx.forwarded_AGENT_B).toBe('forwarded-b');
			});
			it('preserves base fields alongside per-source fields', () => {
				const event = createCueEvent('agent.completed', 'chain-sub', {
					sourceSession: 'Agent A',
					sourceOutput: 'combined output',
					perSourceOutputs: {
						'Agent A': 'per-source-a',
					},
				});
				const ctx = s1_buildCueTemplateContext(event, makeSub(), 'run-1');
				// Base source fields
				expect(ctx.sourceSession).toBe('Agent A');
				expect(ctx.sourceOutput).toBe('combined output');
				// Per-source field
				expect(ctx.output_AGENT_A).toBe('per-source-a');
			});
		});
	});
});
