// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/cue/cue-scheduled-tasks.test.ts
// Source: src/__tests__/main/cue/cue-db-integration.test.ts
// Source: src/__tests__/main/cue/cue-fan-in-tracker.test.ts
// Source: src/__tests__/main/cue/cue-event-factory.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as s1_fs from 'fs';
import * as s1_path from 'path';
import * as s1_os from 'os';
import * as yaml from 'js-yaml';
import {
	buildScheduledTaskSubscriptions,
	cancelScheduledTask,
	collectScheduledTasks,
	createScheduledTask,
	mergeSubscriptionsIntoCueYaml,
	updateScheduledTask,
	type ScheduledTaskAgent,
} from '../../../main/cue/cue-scheduled-tasks';
import * as s2_path from 'path';
import * as s2_os from 'os';
import * as s2_fs from 'fs';
import {
	createInMemoryCueDb,
	canLoadBetterSqlite3,
	type InMemoryCueDb,
} from './cue-integration-test-helpers';
import type {
	CueSettings,
	CueSubscription,
	AgentCompletionData,
} from '../../../main/cue/cue-types';
import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import { createCueEvent } from '../../../main/cue/cue-types';
// Source: src/__tests__/main/cue/cue-scheduled-tasks.test.ts
describe('', () => {
	function readSubs(projectRoot: string): Record<string, unknown>[] {
		const filePath = s1_path.join(projectRoot, '.maestro', 'cue.yaml');
		const parsed = yaml.load(s1_fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
		return parsed.subscriptions as Record<string, unknown>[];
	}
	describe('cue-scheduled-tasks', () => {
		let projectRoot = '';
		let agent: ScheduledTaskAgent;
		beforeEach(() => {
			projectRoot = s1_fs.mkdtempSync(s1_path.join(s1_os.tmpdir(), 'cue-scheduled-tasks-'));
			agent = { id: 'agent-alpha', name: 'Alpha', projectRoot };
		});
		afterEach(() => {
			vi.restoreAllMocks();
			if (projectRoot && s1_fs.existsSync(projectRoot)) {
				s1_fs.rmSync(projectRoot, { recursive: true, force: true });
			}
		});
		describe('buildScheduledTaskSubscriptions', () => {
			it('emits two subs sharing one fire time when a task both prompts and notifies', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					prompt: 'do the thing',
					notify: { message: 'done', sticky: true },
					name: 'dual',
				});
				expect(subs.map((sub) => sub.name)).toEqual(['dual-prompt', 'dual-notify']);
				expect(new Set(subs.map((sub) => sub.fire_at)).size).toBe(1);
				expect(subs[1].notify).toEqual({ message: 'done', sticky: true });
			});
			it('rejects a task with no prompt, notification, or Auto Run', () => {
				expect(() =>
					buildScheduledTaskSubscriptions(agent, {
						agentId: agent.id,
						kind: 'once',
						fireAt: '2030-01-01T10:00:00.000Z',
					})
				).toThrow(/prompt, a notification, or an Auto Run/);
			});
			it('builds an autorun subscription carrying the captured document list', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					keepOnFailure: true,
					autoRun: {
						documents: ['/proj/Auto Run Docs/ship-it.md'],
						reset_on_completion: [true],
						prompt: 'Work the tasks',
						loop_enabled: true,
						max_loops: 3,
					},
				});
				expect(subs).toHaveLength(1);
				expect(subs[0]).toMatchObject({
					event: 'time.once',
					action: 'autorun',
					agent_id: 'agent-alpha',
					fire_at: '2030-01-01T10:00:00.000Z',
					// keepOnFailure must survive: a one-shot sub is consumed on any
					// terminal status, so without this a failed launch deletes the
					// schedule and leaves nothing to inspect.
					self_destruct_on_failure: false,
					auto_run: {
						documents: ['/proj/Auto Run Docs/ship-it.md'],
						reset_on_completion: [true],
						prompt: 'Work the tasks',
						loop_enabled: true,
						max_loops: 3,
					},
				});
				expect(subs[0].label).toBe('Auto Run: ship-it.md');
			});
			// The schedule has to fire with what the Auto Run window was set to, not
			// with the engine's defaults.
			it('writes the per-document mode and the model-hint opt-out', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					autoRun: {
						documents: ['/proj/a.md'],
						task_selection_mode: 'document',
						ignore_model_hints: true,
					},
				});
				expect(subs[0].auto_run).toMatchObject({
					task_selection_mode: 'document',
					ignore_model_hints: true,
				});
			});
			it('writes the auto-resume settings and the worktree the run fires in', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					autoRun: {
						documents: ['/proj/a.md'],
						auto_resume_on_error: false,
						auto_resume_after_min: 10,
						max_auto_resumes: 3,
						worktree: { mode: 'create-new', branch: ' nightly ', create_pr: true },
					},
				});
				expect(subs[0].auto_run).toEqual({
					documents: ['/proj/a.md'],
					auto_resume_on_error: false,
					auto_resume_after_min: 10,
					max_auto_resumes: 3,
					worktree: { mode: 'create-new', branch: 'nightly', create_pr: true },
				});
			});
			// Auto-resume is ON when absent, so only the opt-out is written.
			it('does not write auto-resume when it is left on', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					autoRun: { documents: ['/proj/a.md'], auto_resume_on_error: true },
				});
				expect(subs[0].auto_run).toEqual({ documents: ['/proj/a.md'] });
			});
			// Refused when written, not when it fires: nobody is watching then.
			it('refuses a worktree block that cannot be resolved', () => {
				expect(() =>
					buildScheduledTaskSubscriptions(agent, {
						agentId: agent.id,
						kind: 'once',
						fireAt: '2030-01-01T10:00:00.000Z',
						autoRun: { documents: ['/proj/a.md'], worktree: { mode: 'existing-open' } },
					})
				).toThrow(/auto_run\.worktree "agent_id" is required/);
			});
			// `task` is what an absent field means, so it is not written.
			it('writes neither option at its default', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					autoRun: { documents: ['/proj/a.md'], task_selection_mode: 'task' },
				});
				expect(subs[0].auto_run).toEqual({ documents: ['/proj/a.md'] });
			});
			it('refuses to pair an Auto Run with a prompt or a notification', () => {
				expect(() =>
					buildScheduledTaskSubscriptions(agent, {
						agentId: agent.id,
						kind: 'once',
						fireAt: '2030-01-01T10:00:00.000Z',
						prompt: 'do a thing',
						autoRun: { documents: ['/proj/a.md'] },
					})
				).toThrow(/cannot also carry a prompt or a notification/);
			});
			it('round-trips an autorun task through cue.yaml', () => {
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-06-01T09:30:00.000Z',
					keepOnFailure: true,
					autoRun: { documents: ['/proj/Auto Run Docs/nightly.md'] },
				});
				const written = readSubs(projectRoot);
				expect(written).toHaveLength(1);
				expect(written[0]).toMatchObject({ action: 'autorun' });
				const { tasks } = collectScheduledTasks([agent]);
				expect(tasks).toHaveLength(1);
				expect(tasks[0].action).toBe('autorun');
				expect(tasks[0].autoRun?.documents).toEqual(['/proj/Auto Run Docs/nightly.md']);
			});
			it('puts the model choice on the prompt sub only, never on the notify sub', () => {
				const subs = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'interval',
					intervalMinutes: 30,
					prompt: 'review',
					notify: { message: 'reviewed' },
					name: 'nightly',
					tier: 'high',
					effort: 'low',
				});
				expect(subs[0]).toMatchObject({ action: 'prompt', tier: 'high', effort: 'low' });
				expect(subs[1].action).toBe('notify');
				expect(subs[1]).not.toHaveProperty('tier');
				expect(subs[1]).not.toHaveProperty('effort');
			});
			it('rejects a tier and an exact model together', () => {
				expect(() =>
					buildScheduledTaskSubscriptions(agent, {
						agentId: agent.id,
						kind: 'interval',
						intervalMinutes: 30,
						prompt: 'review',
						tier: 'high',
						model: 'opus',
					})
				).toThrow(/not both/);
			});
			it('rejects a model choice on a notify-only task', () => {
				expect(() =>
					buildScheduledTaskSubscriptions(agent, {
						agentId: agent.id,
						kind: 'interval',
						intervalMinutes: 30,
						notify: { message: 'ping' },
						effort: 'high',
					})
				).toThrow(/needs a prompt/);
			});
			it('round-trips the model choice through cue.yaml into the task list', () => {
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'interval',
					intervalMinutes: 30,
					prompt: 'review',
					name: 'pinned',
					model: 'gpt-5.5-codex',
					effort: 'medium',
				});
				expect(readSubs(projectRoot)[0]).toMatchObject({
					model: 'gpt-5.5-codex',
					effort: 'medium',
				});
				const [task] = collectScheduledTasks([agent]).tasks;
				expect(task.model).toBe('gpt-5.5-codex');
				expect(task.effort).toBe('medium');
				expect(task.tier).toBeUndefined();
			});
			it('rejects an out-of-range interval', () => {
				expect(() =>
					buildScheduledTaskSubscriptions(agent, {
						agentId: agent.id,
						kind: 'interval',
						intervalMinutes: 99999,
						prompt: 'tick',
					})
				).toThrow(/interval minutes/);
			});
			it('normalizes a fire time into a UTC ISO string regardless of input offset', () => {
				const [sub] = buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00+02:00',
					prompt: 'x',
				});
				expect(sub.fire_at).toBe('2030-01-01T08:00:00.000Z');
			});
		});
		describe('collectScheduledTasks', () => {
			it('lists all three clock events, sorted by next fire, ignoring other events', () => {
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					prompt: 'later',
					name: 'later',
				});
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2029-01-01T10:00:00.000Z',
					prompt: 'sooner',
					name: 'sooner',
				});
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'interval',
					intervalMinutes: 30,
					prompt: 'tick',
					name: 'ticker',
				});
				const { tasks, warnings } = collectScheduledTasks([agent]);
				expect(warnings).toEqual([]);
				expect(tasks.map((task) => task.name)).toEqual(['sooner', 'later', 'ticker']);
				expect(tasks[2].kind).toBe('interval');
				// An interval's phase lives in engine run state, not in YAML.
				expect(tasks[2].nextFireAtMs).toBeNull();
				expect(tasks[0].agentName).toBe('Alpha');
			});
			it('reports a broken config as a warning instead of throwing', () => {
				s1_fs.mkdirSync(s1_path.join(projectRoot, '.maestro'), { recursive: true });
				s1_fs.writeFileSync(
					s1_path.join(projectRoot, '.maestro', 'cue.yaml'),
					'subscriptions: [oops\n'
				);
				const { tasks, warnings } = collectScheduledTasks([agent]);
				expect(tasks).toEqual([]);
				expect(warnings).toHaveLength(1);
				expect(warnings[0]).toContain('Alpha');
			});
			it('skips an agent with no cue.yaml silently', () => {
				expect(collectScheduledTasks([agent])).toEqual({ tasks: [], warnings: [] });
			});
		});
		describe('updateScheduledTask', () => {
			beforeEach(() => {
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'daily',
					scheduleTimes: ['09:00'],
					prompt: 'standup',
					name: 'standup',
				});
			});
			it('patches only the fields it is given', async () => {
				const result = await updateScheduledTask(projectRoot, 'standup', {
					scheduleTimes: ['9:30', '17:00'],
					enabled: false,
				});
				expect(result.updated).toBe(true);
				const sub = readSubs(projectRoot)[0];
				expect(sub.schedule_times).toEqual(['09:30', '17:00']);
				expect(sub.enabled).toBe(false);
				expect(sub.prompt).toBe('standup');
			});
			it('refuses timing fields that belong to a different recurrence', async () => {
				const result = await updateScheduledTask(projectRoot, 'standup', {
					fireAt: '2030-01-01T10:00:00.000Z',
				});
				expect(result.updated).toBe(false);
				expect(result.reason).toMatch(/one-shot/);
				expect(readSubs(projectRoot)[0].fire_at).toBeUndefined();
			});
			it('refuses a subscription that is not a scheduled task', async () => {
				const filePath = s1_path.join(projectRoot, '.maestro', 'cue.yaml');
				const parsed = yaml.load(s1_fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
				(parsed.subscriptions as Record<string, unknown>[]).push({
					name: 'on-push',
					event: 'file.changed',
					enabled: true,
					prompt: 'x',
				});
				s1_fs.writeFileSync(filePath, yaml.dump(parsed));
				const result = await updateScheduledTask(projectRoot, 'on-push', { enabled: false });
				expect(result.updated).toBe(false);
				expect(result.reason).toMatch(/not a scheduled task/);
			});
			it('sets, swaps, and clears the prompt run model choice', async () => {
				await updateScheduledTask(projectRoot, 'standup', {
					turnSettings: { tier: 'high', effort: 'low' },
				});
				expect(readSubs(projectRoot)[0]).toMatchObject({ tier: 'high', effort: 'low' });
				// The form sends every axis: a picked model with the tier nulled out.
				await updateScheduledTask(projectRoot, 'standup', {
					turnSettings: { tier: null, model: 'claude-opus-4-7', effort: 'low' },
				});
				const swapped = readSubs(projectRoot)[0];
				expect(swapped).toMatchObject({ model: 'claude-opus-4-7', effort: 'low' });
				expect(swapped).not.toHaveProperty('tier');
				await updateScheduledTask(projectRoot, 'standup', {
					turnSettings: { tier: null, model: null, effort: null },
				});
				const cleared = readSubs(projectRoot)[0];
				expect(cleared).not.toHaveProperty('tier');
				expect(cleared).not.toHaveProperty('model');
				expect(cleared).not.toHaveProperty('effort');
				expect(cleared.prompt).toBe('standup');
			});
			it('refuses a model choice on a notify task and applies none of the patch', async () => {
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'interval',
					intervalMinutes: 30,
					notify: { message: 'ping' },
					name: 'pinger',
				});
				const result = await updateScheduledTask(projectRoot, 'pinger', {
					label: 'renamed',
					turnSettings: { tier: 'high' },
				});
				expect(result.updated).toBe(false);
				expect(result.reason).toMatch(/action "notify"/);
				const pinger = readSubs(projectRoot).find((sub) => sub.name === 'pinger')!;
				expect(pinger.label).not.toBe('renamed');
				expect(pinger).not.toHaveProperty('tier');
			});
			it('preserves the leading comment header on rewrite', async () => {
				const filePath = s1_path.join(projectRoot, '.maestro', 'cue.yaml');
				s1_fs.writeFileSync(
					filePath,
					'# Pipeline: Tasks\n' + s1_fs.readFileSync(filePath, 'utf-8')
				);
				await updateScheduledTask(projectRoot, 'standup', { label: 'Morning standup' });
				expect(s1_fs.readFileSync(filePath, 'utf-8')).toMatch(/^# Pipeline: Tasks\n/);
				expect(readSubs(projectRoot)[0].label).toBe('Morning standup');
			});
		});
		describe('createScheduledTask / cancelScheduledTask', () => {
			it('rejects a duplicate subscription name rather than writing two', () => {
				const input = {
					agentId: agent.id,
					kind: 'once' as const,
					fireAt: '2030-01-01T10:00:00.000Z',
					prompt: 'x',
					name: 'dupe',
				};
				createScheduledTask(agent, input);
				expect(() => createScheduledTask(agent, input)).toThrow(/already exists/);
				expect(readSubs(projectRoot)).toHaveLength(1);
			});
			it('removes a task by name and reports a miss without throwing', async () => {
				createScheduledTask(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
					prompt: 'x',
					name: 'doomed',
				});
				expect(await cancelScheduledTask(projectRoot, 'doomed')).toMatchObject({
					removed: true,
				});
				expect(readSubs(projectRoot)).toHaveLength(0);
				expect(await cancelScheduledTask(projectRoot, 'ghost')).toMatchObject({
					removed: false,
				});
			});
		});
	});
	describe('mergeSubscriptionsIntoCueYaml', () => {
		const existing =
			'# Pipeline: Kept (color: #123456)\n' +
			yaml.dump({
				settings: { owner_agent_id: 'a1', timeout_minutes: 10 },
				subscriptions: [
					{ name: 'keep', event: 'time.heartbeat', interval_minutes: 5, prompt: 'k' },
					{ name: 'shared', event: 'time.heartbeat', interval_minutes: 5, prompt: 'old' },
				],
			});
		const incoming = [
			{ name: 'shared', event: 'time.heartbeat', interval_minutes: 9, prompt: 'new' },
			{ name: 'fresh', event: 'time.heartbeat', interval_minutes: 1, prompt: 'f' },
		];
		function subsOf(content: string): Array<Record<string, unknown>> {
			return (
				yaml.load(content) as {
					subscriptions: Array<Record<string, unknown>>;
				}
			).subscriptions;
		}
		it('appends new names, reports shared ones, and keeps the header', () => {
			const result = mergeSubscriptionsIntoCueYaml(existing, incoming);
			expect(result).toMatchObject({ added: ['fresh'], replaced: [], conflicts: ['shared'] });
			expect(result.content.startsWith('# Pipeline: Kept (color: #123456)\n')).toBe(true);
			expect(subsOf(result.content).map((s) => s.name)).toEqual(['keep', 'shared', 'fresh']);
			expect(subsOf(result.content)[1].prompt).toBe('old');
		});
		it('replaces a shared name in place when asked', () => {
			const result = mergeSubscriptionsIntoCueYaml(existing, incoming, {
				replaceExisting: true,
			});
			expect(result).toMatchObject({ added: ['fresh'], replaced: ['shared'], conflicts: [] });
			expect(subsOf(result.content).map((s) => s.name)).toEqual(['keep', 'shared', 'fresh']);
			expect(subsOf(result.content)[1].prompt).toBe('new');
		});
		it('adds only settings the file does not set', () => {
			const result = mergeSubscriptionsIntoCueYaml(existing, [], {
				settings: { owner_agent_id: 'b2', max_concurrent: 2 },
			});
			expect(result.settingsAdded).toEqual(['max_concurrent']);
			expect(result.settingsKept).toEqual(['owner_agent_id']);
			expect(
				(
					yaml.load(result.content) as {
						settings: unknown;
					}
				).settings
			).toEqual({
				owner_agent_id: 'a1',
				timeout_minutes: 10,
				max_concurrent: 2,
			});
		});
		it('starts a new document when there is no file', () => {
			const result = mergeSubscriptionsIntoCueYaml(null, incoming);
			expect(result.added).toEqual(['shared', 'fresh']);
			expect(subsOf(result.content).map((s) => s.name)).toEqual(['shared', 'fresh']);
		});
		it('throws on a file that is not YAML', () => {
			expect(() => mergeSubscriptionsIntoCueYaml('a: [unclosed', [])).toThrow();
		});
	});
});
// Source: src/__tests__/main/cue/cue-db-integration.test.ts
describe('', () => {
	describe('Phase 15B - cue-db in-memory contract', () => {
		let db: InMemoryCueDb;
		beforeEach(() => {
			db = createInMemoryCueDb();
			db.initCueDb();
		});
		// ─── Lifecycle ────────────────────────────────────────────────────────
		describe('lifecycle', () => {
			it('is ready after init and not ready after close', () => {
				expect(db.isCueDbReady()).toBe(true);
				db.closeCueDb();
				expect(db.isCueDbReady()).toBe(false);
			});
			it('initCueDb is idempotent - second call is a no-op', () => {
				// Calling init twice must not throw nor reset the current state.
				db.recordCueEvent({
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 't',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.initCueDb(); // second call
				expect(db.getRecentCueEvents(0).length).toBe(1);
			});
			it('getRecentCueEvents throws when DB is not initialized', () => {
				db.closeCueDb();
				expect(() => db.getRecentCueEvents(0)).toThrow(/not initialized/);
			});
		});
		// ─── Event journal ────────────────────────────────────────────────────
		// ─── Historical Conductor credit ──────────────────────────────────────
		describe('historical conductor credit', () => {
			const MINUTE = 60000;
			/** Record an event at `startMs` and complete it `durationMs` later. */
			function runFor(id: string, startMs: number, durationMs: number, status = 'completed') {
				db.setNowOverride(startMs);
				db.recordCueEvent({
					id,
					type: 'time.heartbeat',
					triggerName: 'hb',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.setNowOverride(startMs + durationMs);
				db.updateCueEventStatus(id, status);
			}
			it('returns 0 with no events', () => {
				expect(db.getHistoricalConductorCreditMs()).toBe(0);
			});
			it('floors each run to whole minutes independently', () => {
				// 90s + 90s credits 1m + 1m, NOT the 3m a sum-then-floor would give.
				runFor('a', 1000000, 90000);
				runFor('b', 2000000, 90000);
				expect(db.getHistoricalConductorCreditMs()).toBe(2 * MINUTE);
			});
			it('ignores sub-minute runs, matching the live credit rule', () => {
				runFor('a', 1000000, 59999);
				expect(db.getHistoricalConductorCreditMs()).toBe(0);
			});
			it('counts only completed runs', () => {
				runFor('ok', 1000000, 5 * MINUTE);
				runFor('bad', 2000000, 30 * MINUTE, 'failed');
				runFor('gone', 3000000, 10 * MINUTE, 'timeout');
				// A hung run that failed after 30 minutes is wall-clock time, not
				// credited agent work - the Usage Dashboard's total duration counts it
				// but the Conductor level must not.
				expect(db.getHistoricalConductorCreditMs()).toBe(5 * MINUTE);
			});
			it('skips in-flight runs that have no completion timestamp', () => {
				db.setNowOverride(1000000);
				db.recordCueEvent({
					id: 'running',
					type: 'time.heartbeat',
					triggerName: 'hb',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				expect(db.getHistoricalConductorCreditMs()).toBe(0);
			});
		});
		describe('event journal', () => {
			it('records and retrieves a single event', () => {
				db.recordCueEvent({
					id: 'evt-1',
					type: 'time.heartbeat',
					triggerName: 'hb',
					sessionId: 'session-1',
					subscriptionName: 'sub-1',
					status: 'running',
					payload: '{"x":1}',
				});
				const events = db.getRecentCueEvents(0);
				expect(events).toHaveLength(1);
				expect(events[0]).toMatchObject({
					id: 'evt-1',
					type: 'time.heartbeat',
					status: 'running',
					payload: '{"x":1}',
				});
				expect(events[0].completedAt).toBeNull();
			});
			it('returns events in ORDER BY created_at DESC', () => {
				db.setNowOverride(1000);
				db.recordCueEvent({
					id: 'e1',
					type: 'time.heartbeat',
					triggerName: 't',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.setNowOverride(2000);
				db.recordCueEvent({
					id: 'e2',
					type: 'time.heartbeat',
					triggerName: 't',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.setNowOverride(3000);
				db.recordCueEvent({
					id: 'e3',
					type: 'time.heartbeat',
					triggerName: 't',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.clearNowOverride();
				const events = db.getRecentCueEvents(0);
				expect(events.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
			});
			it('LIMIT clause caps the result set', () => {
				for (let i = 0; i < 10; i++) {
					db.setNowOverride(1000 + i);
					db.recordCueEvent({
						id: `e${i}`,
						type: 'time.heartbeat',
						triggerName: 't',
						sessionId: 'session-1',
						subscriptionName: 'sub',
						status: 'running',
					});
				}
				db.clearNowOverride();
				expect(db.getRecentCueEvents(0, 3)).toHaveLength(3);
				expect(db.getRecentCueEvents(0).length).toBe(10);
			});
			it('filters events by created_at >= since', () => {
				db.setNowOverride(1000);
				db.recordCueEvent({
					id: 'old',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.setNowOverride(2000);
				db.recordCueEvent({
					id: 'new',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.clearNowOverride();
				expect(db.getRecentCueEvents(1500).map((e) => e.id)).toEqual(['new']);
			});
			it('INSERT OR REPLACE overwrites a duplicate id', () => {
				db.recordCueEvent({
					id: 'dup',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.recordCueEvent({
					id: 'dup',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'completed',
				});
				const events = db.getRecentCueEvents(0);
				expect(events).toHaveLength(1);
				expect(events[0].status).toBe('completed');
			});
			it('updateCueEventStatus flips status and sets completedAt', () => {
				db.setNowOverride(1000);
				db.recordCueEvent({
					id: 'e1',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.setNowOverride(5000);
				db.updateCueEventStatus('e1', 'completed');
				const events = db.getRecentCueEvents(0);
				expect(events[0].status).toBe('completed');
				expect(events[0].completedAt).toBe(5000);
				db.clearNowOverride();
			});
			it('updateCueEventStatus is a no-op when id does not exist (mirrors WHERE match fails)', () => {
				expect(() => db.updateCueEventStatus('nonexistent', 'completed')).not.toThrow();
				expect(db.getRecentCueEvents(0)).toHaveLength(0);
			});
			it('updateCueEventStatus stamps error_message + exit_code when failure info is passed', () => {
				db.recordCueEvent({
					id: 'e-fail',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.updateCueEventStatus('e-fail', 'timeout', null, {
					errorMessage: 'first_byte_timeout',
					exitCode: 5,
				});
				const [event] = db.getRecentCueEvents(0);
				expect(event.status).toBe('timeout');
				expect(event.errorMessage).toBe('first_byte_timeout');
				expect(event.exitCode).toBe(5);
			});
			it('updateCueEventStatus leaves error_message + exit_code untouched when no failure info is passed', () => {
				db.recordCueEvent({
					id: 'e-ok',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				// A status flip with no failure object (e.g. 'stopped') must not write
				// the failure columns - they stay null/undefined.
				db.updateCueEventStatus('e-ok', 'stopped');
				const [event] = db.getRecentCueEvents(0);
				expect(event.status).toBe('stopped');
				expect(event.errorMessage ?? null).toBeNull();
				expect(event.exitCode ?? null).toBeNull();
			});
			it('safeRecordCueEvent swallows errors and is non-throwing', () => {
				db.queueWriteFailure(new Error('disk full'));
				expect(() =>
					db.safeRecordCueEvent({
						id: 'e1',
						type: 't',
						triggerName: 't',
						sessionId: 's',
						subscriptionName: 'sub',
						status: 'running',
					})
				).not.toThrow();
				// The failed write left no row - non-fatal, as documented.
				expect(db.getRecentCueEvents(0)).toHaveLength(0);
			});
			it('safeUpdateCueEventStatus swallows errors and is non-throwing', () => {
				db.recordCueEvent({
					id: 'e1',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.queueWriteFailure(new Error('disk full'));
				expect(() => db.safeUpdateCueEventStatus('e1', 'completed')).not.toThrow();
				// Status unchanged because the failure short-circuited the update.
				expect(db.getRecentCueEvents(0)[0].status).toBe('running');
			});
		});
		// ─── Rapid successive writes ──────────────────────────────────────────
		//
		// JS is single-threaded and `Promise.resolve().then(...)` just schedules
		// microtasks - there's no real concurrency. What we exercise here is a
		// microtask flood: 100 writes serialized through the event loop in
		// immediate succession. Still worth pinning because the mirror uses a
		// Map + array pair for ordering, and a naive refactor that rebuilt the
		// ordering array from the Map on every write would silently lose events.
		describe('rapid successive writes', () => {
			it('preserves all 100 events written in rapid succession', async () => {
				const writes = Array.from({ length: 100 }, (_, i) =>
					Promise.resolve().then(() =>
						db.recordCueEvent({
							id: `c${i}`,
							type: 't',
							triggerName: 't',
							sessionId: 'session-1',
							subscriptionName: 'sub',
							status: 'running',
						})
					)
				);
				await Promise.all(writes);
				expect(db.getRecentCueEvents(0)).toHaveLength(100);
			});
		});
		// ─── Heartbeat ────────────────────────────────────────────────────────
		describe('heartbeat', () => {
			it('returns null before first heartbeat', () => {
				expect(db.getLastHeartbeat()).toBeNull();
			});
			it('upserts single-row heartbeat (id=1 replacement semantics)', () => {
				db.setNowOverride(100);
				db.updateHeartbeat();
				expect(db.getLastHeartbeat()).toBe(100);
				db.setNowOverride(200);
				db.updateHeartbeat();
				expect(db.getLastHeartbeat()).toBe(200); // replaced, not appended
				db.clearNowOverride();
			});
		});
		// ─── Prune ────────────────────────────────────────────────────────────
		describe('pruneCueEvents', () => {
			it('deletes events older than the cutoff', () => {
				// Step `now` forward deterministically: old event at 1_000,
				// recent event at 9_500, prune call at 10_000. With
				// olderThanMs=5_000 the cutoff is 10_000 - 5_000 = 5_000, so the
				// old event (1_000 < 5_000) is dropped and the recent event
				// (9_500 >= 5_000) survives.
				db.setNowOverride(1000);
				db.recordCueEvent({
					id: 'old',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.setNowOverride(9500);
				db.recordCueEvent({
					id: 'recent',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.setNowOverride(10000);
				db.pruneCueEvents(5000); // cutoff = 10_000 - 5_000 = 5_000
				const ids = db.getRecentCueEvents(0).map((e) => e.id);
				expect(ids).toEqual(['recent']);
				db.clearNowOverride();
			});
			it('is a no-op when no events predate the cutoff', () => {
				db.setNowOverride(10000);
				db.recordCueEvent({
					id: 'new',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.pruneCueEvents(5000);
				expect(db.getRecentCueEvents(0)).toHaveLength(1);
				db.clearNowOverride();
			});
			it('preserves ordering of the remaining events', () => {
				db.setNowOverride(1000);
				db.recordCueEvent({
					id: 'a',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.setNowOverride(2000);
				db.recordCueEvent({
					id: 'b',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.setNowOverride(3000);
				db.recordCueEvent({
					id: 'c',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'x',
				});
				db.setNowOverride(4000);
				// cutoff = now - olderThanMs = 4000 - 2500 = 1500 → drops only 'a' (createdAt=1000).
				db.pruneCueEvents(2500);
				const ids = db.getRecentCueEvents(0).map((e) => e.id);
				expect(ids).toEqual(['c', 'b']);
				db.clearNowOverride();
			});
		});
		// ─── GitHub seen set ──────────────────────────────────────────────────
		describe('GitHub seen tracking', () => {
			it('markGitHubItemSeen is idempotent (UNIQUE on (sub, key))', () => {
				db.markGitHubItemSeen('sub-1', 'pr-42');
				db.markGitHubItemSeen('sub-1', 'pr-42');
				expect(db.isGitHubItemSeen('sub-1', 'pr-42')).toBe(true);
				// State assertion: only one row present.
				expect(db.state.githubSeen.size).toBe(1);
			});
			it('differentiates items across subscriptions', () => {
				db.markGitHubItemSeen('sub-1', 'pr-42');
				db.markGitHubItemSeen('sub-2', 'pr-42');
				expect(db.isGitHubItemSeen('sub-1', 'pr-42')).toBe(true);
				expect(db.isGitHubItemSeen('sub-2', 'pr-42')).toBe(true);
				expect(db.state.githubSeen.size).toBe(2);
			});
			it('hasAnyGitHubSeen returns true when at least one row exists for the subscription', () => {
				expect(db.hasAnyGitHubSeen('sub-1')).toBe(false);
				db.markGitHubItemSeen('sub-1', 'pr-1');
				expect(db.hasAnyGitHubSeen('sub-1')).toBe(true);
				expect(db.hasAnyGitHubSeen('sub-2')).toBe(false);
			});
			it('clearGitHubSeenForSubscription removes only matching rows', () => {
				db.markGitHubItemSeen('sub-1', 'pr-1');
				db.markGitHubItemSeen('sub-1', 'pr-2');
				db.markGitHubItemSeen('sub-2', 'pr-3');
				db.clearGitHubSeenForSubscription('sub-1');
				expect(db.isGitHubItemSeen('sub-1', 'pr-1')).toBe(false);
				expect(db.isGitHubItemSeen('sub-1', 'pr-2')).toBe(false);
				expect(db.isGitHubItemSeen('sub-2', 'pr-3')).toBe(true);
			});
			it('pruneGitHubSeen deletes rows older than cutoff', () => {
				db.setNowOverride(1000);
				db.markGitHubItemSeen('sub', 'old');
				db.setNowOverride(5000);
				db.markGitHubItemSeen('sub', 'new');
				db.setNowOverride(10000);
				db.pruneGitHubSeen(4000); // cutoff = 6000
				expect(db.isGitHubItemSeen('sub', 'old')).toBe(false);
				expect(db.isGitHubItemSeen('sub', 'new')).toBe(false);
				// Both 'old' (seen at 1000 < 6000) and 'new' (seen at 5000 < 6000) are
				// pruned because the cutoff is 6000. Document that.
				// Add a third after cutoff to verify the surviving path.
				db.setNowOverride(9000);
				db.markGitHubItemSeen('sub', 'surviving');
				db.setNowOverride(10000);
				db.pruneGitHubSeen(2000); // cutoff = 8000 → 'surviving' (seen 9000) stays
				expect(db.isGitHubItemSeen('sub', 'surviving')).toBe(true);
				db.clearNowOverride();
			});
		});
		// ─── Close / reinit persistence (in-memory simulation) ────────────────
		describe('restart simulation', () => {
			it('a fresh InMemoryCueDb starts empty - documents the test-helper contract', () => {
				// This makes explicit what cue-engine-integration.test.ts relies on:
				// `simulateRestart()` should use `resetAll()` to get a clean DB but
				// if the caller creates a NEW instance, it is also empty. If you
				// want persistence across a simulated restart, hang on to the SAME
				// InMemoryCueDb instance across close → init.
				db.recordCueEvent({
					id: 'e1',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				expect(db.getRecentCueEvents(0)).toHaveLength(1);
				// Simulate an app restart with the SAME instance: close then init.
				// Data MUST survive (we never clear state on close - only `ready`).
				db.closeCueDb();
				db.initCueDb();
				expect(db.getRecentCueEvents(0)).toHaveLength(1);
			});
			it('resetAll wipes all state AND marks the DB not-ready', () => {
				db.recordCueEvent({
					id: 'e1',
					type: 't',
					triggerName: 't',
					sessionId: 's',
					subscriptionName: 'sub',
					status: 'running',
				});
				db.markGitHubItemSeen('sub', 'x');
				db.updateHeartbeat();
				db.resetAll();
				expect(db.isCueDbReady()).toBe(false);
				db.initCueDb();
				expect(db.getRecentCueEvents(0)).toHaveLength(0);
				expect(db.state.githubSeen.size).toBe(0);
				expect(db.getLastHeartbeat()).toBeNull();
			});
		});
	});
	// ────────────────────────────────────────────────────────────────────────────
	// Optional smoke test against real better-sqlite3 when the binary is available.
	// Drift-catcher: if the mirror diverges from native behavior on a core
	// round-trip, the smoke block surfaces that when run locally. CI usually skips.
	// ────────────────────────────────────────────────────────────────────────────
	describe.skipIf(!canLoadBetterSqlite3())('Phase 15B - real SQLite smoke test', () => {
		it('real cue-db persists and retrieves one event through a full round-trip', async () => {
			// Isolate this test from the rest of the file's mocks. We cannot use
			// the top-level `vi.mock('better-sqlite3', ...)` that other cue-db
			// tests install (it would short-circuit this smoke). Pull in cue-db
			// via dynamic import after confirming the binary loads.
			const dbPath = s2_path.join(
				s2_os.tmpdir(),
				`maestro-cue-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
			);
			// Capture the cue-db module lazily so the finally block can close the
			// SQLite handle even if an assertion above throws. Leaving the handle
			// open before `fs.unlinkSync` would fail on Windows (file locked) and
			// leak the connection on POSIX.
			let cueDb: typeof import('../../../main/cue/cue-db') | null = null;
			try {
				cueDb = await import('../../../main/cue/cue-db');
				cueDb.initCueDb(undefined, dbPath);
				cueDb.recordCueEvent({
					id: 'smoke-1',
					type: 'time.heartbeat',
					triggerName: 't',
					sessionId: 'session-1',
					subscriptionName: 'sub',
					status: 'running',
				});
				const events = cueDb.getRecentCueEvents(0);
				expect(events).toHaveLength(1);
				expect(events[0].id).toBe('smoke-1');
				// Failure diagnostics round-trip: a non-completed run stamps
				// error_message + exit_code (INTEGER column, so it comes back as a
				// number, not a string) and they survive read-back.
				cueDb.updateCueEventStatus('smoke-1', 'timeout', null, {
					errorMessage: 'first_byte_timeout: no transcript output',
					exitCode: 5,
				});
				const afterFailure = cueDb.getRecentCueEvents(0);
				expect(afterFailure[0].status).toBe('timeout');
				expect(afterFailure[0].errorMessage).toBe('first_byte_timeout: no transcript output');
				expect(afterFailure[0].exitCode).toBe(5);
			} finally {
				if (cueDb) {
					try {
						cueDb.closeCueDb();
					} catch {
						/* best effort - double-close is safe, other errors are non-fatal here */
					}
				}
				try {
					s2_fs.unlinkSync(dbPath);
				} catch {
					/* best effort */
				}
			}
		});
	});
	describe.skipIf(!canLoadBetterSqlite3())('real SQLite: status reads cue.db read-only', () => {
		it('reads a live engine database without changing its schema, mode or files', async () => {
			const dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-cue-ro-'));
			const dbPath = s2_path.join(dir, 'cue.db');
			const { default: Database } = await import('better-sqlite3');
			const cueDb = await import('../../../main/cue/cue-db');
			const schemaOf = () => {
				const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
				try {
					return probe.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
				} finally {
					probe.close();
				}
			};
			try {
				// The engine's handle stays open, as it is while an engine runs.
				cueDb.initCueDb(undefined, dbPath);
				cueDb.updateHeartbeat();
				const schemaBefore = schemaOf();
				const filesBefore = s2_fs.readdirSync(dir).sort();
				const modeBefore = s2_fs.statSync(dbPath).mode;
				const figures = cueDb.readCueDbStatusFigures(dbPath);
				expect(figures.ok).toBe(true);
				if (figures.ok) {
					expect(figures.lastHeartbeatMs).toEqual(expect.any(Number));
					expect(figures.totalEvents).toBe(0);
				}
				expect(schemaOf()).toEqual(schemaBefore);
				expect(s2_fs.readdirSync(dir).sort()).toEqual(filesBefore);
				if (process.platform !== 'win32') expect(s2_fs.statSync(dbPath).mode).toBe(modeBefore);
			} finally {
				cueDb.closeCueDb();
				s2_fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});
	describe.skipIf(!canLoadBetterSqlite3())(
		'real SQLite: activity history reads cue.db read-only',
		() => {
			/**
			 * Every file in `dir` with its bytes and mode, to prove nothing changed.
			 * The `-shm` file is shared memory, not data: every WAL reader records its
			 * read mark there, so its bytes are left out and only its presence counts.
			 */
			function snapshotDir(dir: string): Record<
				string,
				{
					bytes?: string;
					mode: number;
				}
			> {
				const out: Record<
					string,
					{
						bytes?: string;
						mode: number;
					}
				> = {};
				for (const name of s2_fs.readdirSync(dir).sort()) {
					const file = s2_path.join(dir, name);
					out[name] = {
						...(name.endsWith('-shm')
							? {}
							: { bytes: s2_fs.readFileSync(file).toString('base64') }),
						mode: s2_fs.statSync(file).mode,
					};
				}
				return out;
			}
			async function seed(dbPath: string) {
				const cueDb = await import('../../../main/cue/cue-db');
				cueDb.initCueDb(undefined, dbPath);
				for (const [i, status] of ['completed', 'timeout', 'running'].entries()) {
					cueDb.recordCueEvent({
						id: `run-${i}`,
						type: 'time.scheduled',
						triggerName: 't',
						sessionId: 'agent-1',
						subscriptionName: `sub-${i}`,
						status: 'running',
					});
					// created_at is Date.now(); keep the rows apart so the order is defined.
					const until = Date.now() + 3;
					while (Date.now() < until) {
						/* spin */
					}
					if (status !== 'running') cueDb.updateCueEventStatus(`run-${i}`, status);
				}
				return cueDb;
			}
			it('reads beside an open engine handle without changing any file', async () => {
				const dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-cue-history-live-'));
				const dbPath = s2_path.join(dir, 'cue.db');
				const cueDb = await seed(dbPath);
				try {
					// The engine's handle stays open, so -wal and -shm exist.
					const before = snapshotDir(dir);
					const result = cueDb.readRecentCueEventsReadOnly(1000, dbPath);
					expect(result).toMatchObject({ ok: true, source: 'live' });
					if (result.ok)
						expect(result.records.map((r) => r.id)).toEqual(['run-2', 'run-1', 'run-0']);
					expect(snapshotDir(dir)).toEqual(before);
				} finally {
					cueDb.closeCueDb();
					s2_fs.rmSync(dir, { recursive: true, force: true });
				}
			});
			it('reads a closed WAL database with no sidecars, creating and modifying nothing', async () => {
				const dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-cue-history-closed-'));
				const dbPath = s2_path.join(dir, 'cue.db');
				const cueDb = await seed(dbPath);
				cueDb.closeCueDb();
				try {
					// A clean close checkpoints and removes the sidecars: nothing has it open.
					expect(s2_fs.readdirSync(dir)).toEqual(['cue.db']);
					const before = snapshotDir(dir);
					const result = cueDb.readRecentCueEventsReadOnly(2, dbPath);
					expect(result).toMatchObject({ ok: true, source: 'snapshot' });
					if (result.ok) {
						expect(result.records.map((r) => r.id)).toEqual(['run-2', 'run-1']);
						expect(result.records.map((r) => r.status)).toEqual(['running', 'timeout']);
					}
					expect(snapshotDir(dir)).toEqual(before);
					expect(cueDb.isCueDbReady()).toBe(false);
				} finally {
					s2_fs.rmSync(dir, { recursive: true, force: true });
				}
			});
		}
	);
	describe.skipIf(!canLoadBetterSqlite3())(
		'real SQLite: plugin receipt uninstall lifecycle',
		() => {
			it.each([
				'a'.repeat(64),
				'receipt-v3:' + 'b'.repeat(64),
				'receipt-v2:' + 'g'.repeat(64),
				'receipt-v2:' + 'a'.repeat(63),
			])(
				'retains unresolved receipt format %s and blocks only its owner before a stable write',
				async (legacyKey) => {
					const dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-cue-plugin-legacy-'));
					const cueDb = await import('../../../main/cue/cue-db');
					const receipt = { receiptId: 'receipt', payloadHash: 'hash', proof: 'proof' };
					const stableKey = 'receipt-v2:' + 'c'.repeat(64);
					try {
						cueDb.initCueDb(undefined, s2_path.join(dir, 'cue.db'));
						// Historical/malformed input is seeded directly, not through the new-format writer.
						cueDb.writePluginEventReceipt('com.example.seed', 'seed', receipt);
						const Database = (await import('better-sqlite3')).default;
						const raw = new Database(s2_path.join(dir, 'cue.db'));
						try {
							raw
								.prepare('INSERT INTO cue_plugin_receipts VALUES (?,?,?,?,?)')
								.run(
									'com.example.owner',
									legacyKey,
									receipt.receiptId,
									receipt.payloadHash,
									receipt.proof
								);
						} finally {
							raw.close();
						}
						expect(() =>
							cueDb.pluginEventReceiptCapacityAvailable('com.example.owner', {
								stableFormatOnly: true,
							})
						).toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
						expect(() =>
							cueDb.writePluginEventReceipt('com.example.owner', stableKey, receipt)
						).toThrow(expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' }));
						expect(cueDb.readPluginEventReceipt('com.example.owner', legacyKey)).toEqual(receipt);
						expect(cueDb.readPluginEventReceipt('com.example.owner', stableKey)).toBeNull();
						expect(
							cueDb.pluginEventReceiptCapacityAvailable('com.example.other', {
								stableFormatOnly: true,
							})
						).toBe(true);
						cueDb.writePluginEventReceipt('com.example.other', stableKey, receipt);
						expect(cueDb.readPluginEventReceipt('com.example.other', stableKey)).toEqual(receipt);
						expect(
							cueDb.pluginEventReceiptCapacityAvailable('com.example.other', {
								stableFormatOnly: true,
							})
						).toBe(true);
						// Read/admission checks do not rewrite the unresolved namespace.
						expect(cueDb.readPluginEventReceipt('com.example.owner', legacyKey)).toEqual(receipt);
					} finally {
						cueDb.closeCueDb();
						s2_fs.rmSync(dir, { recursive: true, force: true });
					}
				}
			);
			it('restores capacity for only the uninstalled plugin and permits a fresh installation', async () => {
				const dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-cue-plugin-purge-'));
				const cueDb = await import('../../../main/cue/cue-db');
				const receipt = { receiptId: 'receipt', payloadHash: 'hash', proof: 'proof' };
				try {
					cueDb.initCueDb(undefined, s2_path.join(dir, 'cue.db'));
					for (let index = 0; index < 4096; index++)
						cueDb.writePluginEventReceipt('com.example.owner', String(index), receipt);
					cueDb.writePluginEventReceipt('com.example.other', 'kept', receipt);
					expect(cueDb.pluginEventReceiptCapacityAvailable('com.example.owner')).toBe(false);
					cueDb.closeCueDb();
					cueDb.purgePluginEventReceipts('com.example.owner', s2_path.join(dir, 'cue.db'));
					cueDb.initCueDb(undefined, s2_path.join(dir, 'cue.db'));
					expect(cueDb.pluginEventReceiptCapacityAvailable('com.example.owner')).toBe(true);
					expect(cueDb.readPluginEventReceipt('com.example.owner', '0')).toBeNull();
					expect(cueDb.readPluginEventReceipt('com.example.other', 'kept')).toEqual(receipt);
					cueDb.writePluginEventReceipt('com.example.owner', '0', receipt);
					expect(cueDb.readPluginEventReceipt('com.example.owner', '0')).toEqual(receipt);
				} finally {
					cueDb.closeCueDb();
					s2_fs.rmSync(dir, { recursive: true, force: true });
				}
			}, 60000);
		}
	);
	describe.skipIf(!canLoadBetterSqlite3())(
		'authenticated historical plugin receipt migration',
		() => {
			it('checkpoints exact HMAC evidence across reconsent/restart; rejects tamper and unknown history', async () => {
				const { AuthorizationStore } = await import('../../../main/plugins/authorization-ledger');
				const { canonicalJson } = await import('../../../shared/canonicalJson');
				const { createHash } = await import('node:crypto');
				const cue = await import('../../../main/cue/cue-db');
				const Database = (await import('better-sqlite3')).default;
				const dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'receipt-migration-'));
				let anchor: import('../../../main/utils/keyring-anchor').Anchor | null = null;
				const deps = {
					ledgerPath: s2_path.join(dir, 'auth.sealed'),
					seal: {
						available: () => true,
						seal: (text: string) => Buffer.from(text),
						unseal: (data: Buffer) => data.toString(),
					},
					anchor: {
						available: () => true,
						read: () => anchor,
						write: (value: typeof anchor) => {
							anchor = value;
						},
						clear: () => {
							anchor = null;
						},
					},
				};
				const store = new AuthorizationStore(deps);
				const plugin = 'com.example.owner';
				const identity = {
					contentHash: 'a'.repeat(64),
					signatureStatus: 'trusted' as const,
					signerKey: 'old-signer',
				};
				const current = { ...identity, contentHash: 'b'.repeat(64) };
				const consumer = 'consumer',
					event = 'event',
					payloadHash = 'c'.repeat(64),
					receiptId = 'd'.repeat(64);
				const id = createHash('sha256')
					.update(canonicalJson([plugin, identity, consumer, event]))
					.digest('hex');
				store.mint(plugin, [], identity);
				const row = {
					receiptId,
					payloadHash,
					proof: store.pluginEventProof(plugin, identity, { id, receiptId }, { payloadHash }),
				};
				try {
					cue.initCueDb(undefined, s2_path.join(dir, 'cue.db'));
					cue.writePluginEventReceipt(plugin, id, row);
					const before = anchor;
					expect(cue.checkpointPluginEventReceipts(plugin, store)).toBe(1);
					expect(cue.readPluginEventReceipt(plugin, id)).toEqual(row); // preceding code still sees the blocking v1 original
					expect(anchor).toEqual(before);
					expect(cue.checkpointPluginEventReceipts(plugin, store)).toBe(0);
					expect(cue.pluginEventReceiptCapacityAvailable(plugin, { stableFormatOnly: true })).toBe(
						true
					);
					store.onPluginAuthorizationChange((id) => {
						try {
							cue.checkpointPluginEventReceipts(id, store);
						} catch {
							/* revoke remains mandatory */
						}
					});
					store.revoke(plugin);
					expect(store.readGrants(plugin)).toEqual([]);
					store.mint(plugin, [], current);
					cue.closeCueDb();
					cue.initCueDb(undefined, s2_path.join(dir, 'cue.db'));
					const reopened = new AuthorizationStore(deps);
					expect(
						cue.readHistoricalPluginEventReceipt(
							plugin,
							current,
							consumer,
							event,
							payloadHash,
							reopened
						)
					).toBe(receiptId);
					expect(
						cue.readHistoricalPluginEventReceipt(
							plugin,
							current,
							consumer,
							'different',
							payloadHash,
							reopened
						)
					).toBeNull();
					expect(() =>
						cue.readHistoricalPluginEventReceipt(
							plugin,
							current,
							consumer,
							event,
							'e'.repeat(64),
							reopened
						)
					).toThrow();
					expect(() =>
						cue.readHistoricalPluginEventReceipt(
							plugin,
							identity,
							consumer,
							event,
							payloadHash,
							reopened
						)
					).toThrow();
					const raw = new Database(s2_path.join(dir, 'cue.db'));
					raw
						.prepare('UPDATE cue_plugin_legacy_receipts SET receipt_id=? WHERE plugin_id=?')
						.run('f'.repeat(64), plugin);
					expect(() =>
						cue.readHistoricalPluginEventReceipt(
							plugin,
							current,
							consumer,
							event,
							payloadHash,
							reopened
						)
					).toThrow();
					raw.close();
					const unknown = 'e'.repeat(64);
					cue.writePluginEventReceipt(plugin, unknown, { ...row, proof: 'f'.repeat(64) });
					expect(cue.checkpointPluginEventReceipts(plugin, reopened)).toBe(0);
					expect(() =>
						cue.pluginEventReceiptCapacityAvailable(plugin, { stableFormatOnly: true })
					).toThrow();
					expect(cue.readPluginEventReceipt(plugin, unknown)).toEqual({
						...row,
						proof: 'f'.repeat(64),
					});
					expect(
						cue.pluginEventReceiptCapacityAvailable('com.example.other', { stableFormatOnly: true })
					).toBe(true);
				} finally {
					cue.closeCueDb();
					s2_fs.rmSync(dir, { recursive: true, force: true });
				}
			});
		}
	);
});
// Source: src/__tests__/main/cue/cue-fan-in-tracker.test.ts
describe('', () => {
	// ─── Helpers ─────────────────────────────────────────────────────────────────
	function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
		return {
			name: 'fan-in-sub',
			event: 'agent.completed',
			enabled: true,
			prompt: 'compile results',
			source_sessions: ['session-a', 'session-b'],
			...overrides,
		};
	}
	function makeSettings(overrides: Partial<CueSettings> = {}): CueSettings {
		return {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
			...overrides,
		};
	}
	function makeCompletion(overrides: Partial<AgentCompletionData> = {}): AgentCompletionData {
		return {
			sessionName: 'agent-a',
			status: 'completed',
			exitCode: 0,
			durationMs: 1000,
			stdout: 'output from agent',
			triggeredBy: 'fan-in-sub',
			chainDepth: 0,
			...overrides,
		};
	}
	// ─── Tests ───────────────────────────────────────────────────────────────────
	describe('CueFanInTracker - new inspection methods', () => {
		let dispatch: ReturnType<typeof vi.fn>;
		let onLog: ReturnType<typeof vi.fn>;
		beforeEach(() => {
			dispatch = vi.fn();
			onLog = vi.fn();
			vi.useFakeTimers();
		});
		afterEach(() => {
			// checkHealth tests additionally call vi.setSystemTime; restore real
			// timers here so other suites run against the real clock.
			vi.useRealTimers();
		});
		function makeTracker() {
			return createCueFanInTracker({
				onLog,
				getSessions: () => [
					{ id: 'session-a', name: 'Agent A', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
					{ id: 'session-b', name: 'Agent B', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
				],
				dispatchSubscription: dispatch,
			});
		}
		describe('getActiveTrackerKeys', () => {
			it('returns empty array when no trackers are active', () => {
				const tracker = makeTracker();
				expect(tracker.getActiveTrackerKeys()).toEqual([]);
			});
			it('returns the key after the first completion arrives', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				tracker.handleCompletion(
					'owner-session',
					settings,
					sub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
				expect(tracker.getActiveTrackerKeys()).toEqual(['owner-session:fan-in-sub']);
			});
			it('removes the key after all sources complete (fan-in fires)', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				const sources = ['session-a', 'session-b'];
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-a',
					'Agent A',
					makeCompletion()
				);
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-b',
					'Agent B',
					makeCompletion()
				);
				// Fan-in fired - no more active trackers
				expect(tracker.getActiveTrackerKeys()).toEqual([]);
			});
		});
		describe('getTrackerCreatedAt', () => {
			it('returns undefined for an unknown key', () => {
				const tracker = makeTracker();
				expect(tracker.getTrackerCreatedAt('nonexistent:key')).toBeUndefined();
			});
			it('returns the timestamp set when the first completion arrives', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				const before = Date.now();
				tracker.handleCompletion(
					'owner-session',
					settings,
					sub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
				const createdAt = tracker.getTrackerCreatedAt('owner-session:fan-in-sub');
				expect(createdAt).toBeGreaterThanOrEqual(before);
				expect(createdAt).toBeLessThanOrEqual(Date.now());
			});
		});
		describe('expireTracker', () => {
			it('removes the tracker and its timer without dispatching', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
				const key = 'owner:fan-in-sub';
				expect(tracker.getActiveTrackerKeys()).toContain(key);
				tracker.expireTracker(key);
				expect(tracker.getActiveTrackerKeys()).not.toContain(key);
				expect(tracker.getTrackerCreatedAt(key)).toBeUndefined();
				expect(dispatch).not.toHaveBeenCalled();
			});
			it('is a no-op for an unknown key', () => {
				const tracker = makeTracker();
				expect(() => tracker.expireTracker('nonexistent:key')).not.toThrow();
			});
		});
		describe('clearForSession - cleans up fanInCreatedAt', () => {
			it('removes createdAt entry when the owning session is cleared', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
				expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeDefined();
				tracker.clearForSession('owner');
				expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeUndefined();
				expect(tracker.getActiveTrackerKeys()).toEqual([]);
			});
		});
		describe('reset - clears all fanInCreatedAt entries', () => {
			it('removes all createdAt entries on reset', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
				expect(tracker.getActiveTrackerKeys()).toHaveLength(1);
				tracker.reset();
				expect(tracker.getActiveTrackerKeys()).toEqual([]);
				expect(tracker.getTrackerCreatedAt('owner:fan-in-sub')).toBeUndefined();
			});
		});
		// ─── Phase 12D - checkHealth ────────────────────────────────────────────
		describe('checkHealth', () => {
			const sessions = [
				{ id: 'session-a', name: 'Agent A', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
				{ id: 'session-b', name: 'Agent B', toolType: 'claude-code', cwd: '/', projectRoot: '/' },
			];
			const sub = makeSub({ fan_in_timeout_minutes: 10 });
			function primeTracker(tracker: ReturnType<typeof makeTracker>) {
				tracker.handleCompletion(
					'owner',
					makeSettings(),
					sub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
			}
			it('returns empty when no trackers are active', () => {
				const tracker = makeTracker();
				expect(
					tracker.checkHealth({ sessions, lookupSubscription: () => null, now: Date.now() })
				).toEqual([]);
			});
			it('excludes trackers <= 50% elapsed', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				primeTracker(tracker);
				// 3 minutes elapsed of a 10 minute timeout = 30%
				const now = Date.now() + 3 * 60 * 1000;
				const result = tracker.checkHealth({
					sessions,
					lookupSubscription: () => ({
						sub,
						settings: makeSettings(),
						sources: ['session-a', 'session-b'],
					}),
					now,
				});
				expect(result).toEqual([]);
			});
			it('includes trackers > 50% elapsed with correct counts', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				primeTracker(tracker);
				// 7 minutes elapsed of a 10 minute timeout = 70%
				const now = Date.now() + 7 * 60 * 1000;
				const result = tracker.checkHealth({
					sessions,
					lookupSubscription: () => ({
						sub,
						settings: makeSettings(),
						sources: ['session-a', 'session-b'],
					}),
					now,
				});
				expect(result).toHaveLength(1);
				const entry = result[0];
				expect(entry.key).toBe('owner:fan-in-sub');
				expect(entry.ownerSessionId).toBe('owner');
				expect(entry.subscriptionName).toBe('fan-in-sub');
				expect(entry.completedCount).toBe(1);
				expect(entry.expectedCount).toBe(2);
				expect(entry.pendingSourceIds).toEqual(['session-b']);
				expect(entry.percentElapsed).toBeGreaterThan(50);
				expect(entry.percentElapsed).toBeLessThan(100);
				expect(entry.timeoutMs).toBe(10 * 60 * 1000);
			});
			it('clamps negative elapsed (clock moved backward) to 0 and excludes', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				primeTracker(tracker);
				// Clock moved backward by 5 minutes from tracker creation
				const now = Date.now() - 5 * 60 * 1000;
				const result = tracker.checkHealth({
					sessions,
					lookupSubscription: () => ({
						sub,
						settings: makeSettings(),
						sources: ['session-a', 'session-b'],
					}),
					now,
				});
				expect(result).toEqual([]);
			});
			it('excludes trackers whose subscription can no longer be resolved', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				primeTracker(tracker);
				const now = Date.now() + 8 * 60 * 1000;
				const result = tracker.checkHealth({
					sessions,
					lookupSubscription: () => null, // subscription gone
					now,
				});
				expect(result).toEqual([]);
			});
			it('uses per-subscription fan_in_timeout_minutes over global settings', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				const localSub = makeSub({ fan_in_timeout_minutes: 2 });
				tracker.handleCompletion(
					'owner',
					makeSettings({ timeout_minutes: 100 }), // global 100m, but per-sub is 2m
					localSub,
					['session-a', 'session-b'],
					'session-a',
					'Agent A',
					makeCompletion()
				);
				// 1.5 minutes elapsed > 50% of 2 minute timeout
				const now = Date.now() + 90 * 1000;
				const result = tracker.checkHealth({
					sessions,
					lookupSubscription: () => ({
						sub: localSub,
						settings: makeSettings({ timeout_minutes: 100 }),
						sources: ['session-a', 'session-b'],
					}),
					now,
				});
				expect(result).toHaveLength(1);
				expect(result[0].timeoutMs).toBe(2 * 60 * 1000);
			});
			it('resolves pendingSourceIds via dedup (name+id referring to same session collapses)', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				primeTracker(tracker);
				const now = Date.now() + 8 * 60 * 1000;
				// Sources reference same session B by name + id.
				const result = tracker.checkHealth({
					sessions,
					lookupSubscription: () => ({
						sub,
						settings: makeSettings(),
						sources: ['session-a', 'session-b', 'Agent B'],
					}),
					now,
				});
				expect(result).toHaveLength(1);
				// Agent B resolves to session-b (already in set), so total expected is 2.
				expect(result[0].expectedCount).toBe(2);
			});
		});
		// ─── Regression: chainDepth propagation through fan-in ────────────────────
		// Bug 30ab9a5c4: fan-in dispatch did not forward the max chainDepth across
		// completed sources, so circular pipelines routed through fan-in nodes
		// bypassed the depth guard in CueCompletionService.notifyAgentCompleted -
		// the next dispatch saw chainDepth=0 and ran indefinitely. The fix stores
		// chainDepth in FanInSourceCompletion and the all-complete + timeout-continue
		// paths both pass `Math.max(...completions.map(c => c.chainDepth))` to
		// dispatchSubscription. These tests guard both paths.
		describe('chainDepth propagation', () => {
			it('forwards max chainDepth to dispatchSubscription when all sources complete', () => {
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				const sources = ['session-a', 'session-b'];
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-a',
					'Agent A',
					makeCompletion({ chainDepth: 3 })
				);
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-b',
					'Agent B',
					makeCompletion({ chainDepth: 7 })
				);
				expect(dispatch).toHaveBeenCalledTimes(1);
				// dispatchSubscription signature: (ownerSessionId, sub, event, completedNames, chainDepth?)
				const call = dispatch.mock.calls[0];
				expect(call[0]).toBe('owner');
				expect(call[1]).toBe(sub);
				// Last positional argument is chainDepth - must equal max(3, 7) = 7,
				// NOT the last completion's depth (would mask cycles where the
				// deepest source isn't the most recent), and NOT 0 (the original
				// bug, which let cycles run forever).
				expect(call[4]).toBe(7);
			});
			it('forwards max chainDepth in timeout-continue mode', () => {
				vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
				const tracker = makeTracker();
				const sub = makeSub({ fan_in_timeout_minutes: 10 });
				const settings = makeSettings({ timeout_on_fail: 'continue' });
				const sources = ['session-a', 'session-b'];
				// Only session-a completes; session-b is left dangling and the
				// timer fires the timeout-continue branch.
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-a',
					'Agent A',
					makeCompletion({ chainDepth: 5 })
				);
				// Advance past the per-sub fan_in_timeout_minutes (10m).
				vi.advanceTimersByTime(11 * 60 * 1000);
				expect(dispatch).toHaveBeenCalledTimes(1);
				const call = dispatch.mock.calls[0];
				// Only one completion arrived, so max == that source's chainDepth (5).
				// The bug would have passed 0 here, masking cycles when partial
				// fan-ins continue through to dispatch.
				expect(call[4]).toBe(5);
			});
			it('falls back to chainDepth=0 when completions carry no chainDepth field', () => {
				// Defensive: events from older code paths or external callers may
				// omit chainDepth. The tracker must default to 0 (matching the
				// `?? 0` fallback in cue-fan-in-tracker.ts:219) rather than NaN
				// (which Math.max returns when fed undefined).
				const tracker = makeTracker();
				const sub = makeSub();
				const settings = makeSettings();
				const sources = ['session-a', 'session-b'];
				// Spread overrides into makeCompletion but force chainDepth=undefined
				// to simulate an external completion that didn't set it.
				const completionMissingDepth = {
					sessionName: 'agent-a',
					status: 'completed' as const,
					exitCode: 0,
					durationMs: 1000,
					stdout: 'output',
					triggeredBy: 'fan-in-sub',
				};
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-a',
					'Agent A',
					completionMissingDepth as never
				);
				tracker.handleCompletion(
					'owner',
					settings,
					sub,
					sources,
					'session-b',
					'Agent B',
					completionMissingDepth as never
				);
				expect(dispatch).toHaveBeenCalledTimes(1);
				const call = dispatch.mock.calls[0];
				expect(call[4]).toBe(0);
				expect(Number.isNaN(call[4])).toBe(false);
			});
		});
	});
});
// Source: src/__tests__/main/cue/cue-event-factory.test.ts
describe('', () => {
	describe('createCueEvent', () => {
		it('returns an object with all 5 CueEvent fields', () => {
			const event = createCueEvent('time.heartbeat', 'my-trigger', { foo: 'bar' });
			expect(event).toHaveProperty('id');
			expect(event).toHaveProperty('type');
			expect(event).toHaveProperty('timestamp');
			expect(event).toHaveProperty('triggerName');
			expect(event).toHaveProperty('payload');
		});
		it('generates a valid UUID for id', () => {
			const event = createCueEvent('file.changed', 'watcher');
			expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		});
		it('generates a valid ISO timestamp', () => {
			const event = createCueEvent('time.scheduled', 'daily-check');
			const parsed = new Date(event.timestamp).getTime();
			expect(Number.isNaN(parsed)).toBe(false);
			expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
		it('sets type to the provided event type', () => {
			const event = createCueEvent('github.pull_request', 'pr-watcher');
			expect(event.type).toBe('github.pull_request');
		});
		it('sets triggerName to the provided value', () => {
			const event = createCueEvent('task.pending', 'task-scanner');
			expect(event.triggerName).toBe('task-scanner');
		});
		it('defaults payload to empty object when omitted', () => {
			const event = createCueEvent('time.heartbeat', 'heartbeat');
			expect(event.payload).toEqual({});
		});
		it('includes provided payload values', () => {
			const payload = { interval_minutes: 30, reconciled: true };
			const event = createCueEvent('time.heartbeat', 'heartbeat', payload);
			expect(event.payload).toEqual(payload);
		});
		it('generates a unique id on each call', () => {
			const event1 = createCueEvent('time.heartbeat', 'a');
			const event2 = createCueEvent('time.heartbeat', 'a');
			expect(event1.id).not.toBe(event2.id);
		});
	});
});
