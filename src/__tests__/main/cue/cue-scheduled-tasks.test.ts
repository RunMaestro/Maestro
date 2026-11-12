/**
 * Tests for the Scheduled Tasks domain module - the code both the Cue modal's
 * Scheduled Tasks tab (over IPC) and `maestro-cli cue schedule` sit on top of.
 *
 * Everything runs against a real temp project root so the YAML round-trip is
 * asserted on disk rather than against a mocked writer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
	buildScheduledTaskSubscriptions,
	cancelScheduledTask,
	collectScheduledTasks,
	createScheduledTask,
	updateScheduledTask,
	type ScheduledTaskAgent,
} from '../../../main/cue/cue-scheduled-tasks';

function readSubs(projectRoot: string): Record<string, unknown>[] {
	const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
	const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
	return parsed.subscriptions as Record<string, unknown>[];
}

describe('cue-scheduled-tasks', () => {
	let projectRoot = '';
	let agent: ScheduledTaskAgent;

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-scheduled-tasks-'));
		agent = { id: 'agent-alpha', name: 'Alpha', projectRoot };
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (projectRoot && fs.existsSync(projectRoot)) {
			fs.rmSync(projectRoot, { recursive: true, force: true });
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

		it('rejects a task with neither a prompt nor a notification', () => {
			expect(() =>
				buildScheduledTaskSubscriptions(agent, {
					agentId: agent.id,
					kind: 'once',
					fireAt: '2030-01-01T10:00:00.000Z',
				})
			).toThrow(/prompt, a notification, or both/);
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

			expect(readSubs(projectRoot)[0]).toMatchObject({ model: 'gpt-5.5-codex', effort: 'medium' });
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
			fs.mkdirSync(path.join(projectRoot, '.maestro'), { recursive: true });
			fs.writeFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'subscriptions: [oops\n');

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
			const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
			const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
			(parsed.subscriptions as Record<string, unknown>[]).push({
				name: 'on-push',
				event: 'file.changed',
				enabled: true,
				prompt: 'x',
			});
			fs.writeFileSync(filePath, yaml.dump(parsed));

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
			const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
			fs.writeFileSync(filePath, '# Pipeline: Tasks\n' + fs.readFileSync(filePath, 'utf-8'));

			await updateScheduledTask(projectRoot, 'standup', { label: 'Morning standup' });

			expect(fs.readFileSync(filePath, 'utf-8')).toMatch(/^# Pipeline: Tasks\n/);
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

			expect(await cancelScheduledTask(projectRoot, 'doomed')).toMatchObject({ removed: true });
			expect(readSubs(projectRoot)).toHaveLength(0);
			expect(await cancelScheduledTask(projectRoot, 'ghost')).toMatchObject({ removed: false });
		});
	});

	describe('tasks delivered into an existing tab (tabId)', () => {
		const tabInput = {
			agentId: 'agent-alpha',
			kind: 'once' as const,
			fireAt: '2030-01-01T15:00:00.000Z',
			prompt: 'find more candidates',
			name: 'follow-up',
			tabId: 'tab-123',
		};

		it('writes one cli dispatch into the tab, holding the prompt once', () => {
			createScheduledTask(agent, tabInput);

			const [sub] = readSubs(projectRoot);
			expect(sub).toMatchObject({
				name: 'follow-up',
				event: 'time.once',
				action: 'command',
				command: {
					mode: 'cli',
					cli: {
						command: 'send',
						target: 'agent-alpha',
						tab: 'tab-123',
						message: 'find more candidates',
					},
				},
			});
			expect(sub.prompt).toBeUndefined();
		});

		it('lists the task with its tab and the dispatched message as the prompt', () => {
			createScheduledTask(agent, tabInput);

			const { tasks, warnings } = collectScheduledTasks([agent]);
			expect(warnings).toEqual([]);
			expect(tasks[0]).toMatchObject({
				action: 'command',
				tabId: 'tab-123',
				prompt: 'find more candidates',
			});
		});

		it('edits the dispatched message, not a second prompt copy', async () => {
			createScheduledTask(agent, tabInput);

			const result = await updateScheduledTask(projectRoot, 'follow-up', { prompt: 'try again' });

			expect(result.updated).toBe(true);
			const [sub] = readSubs(projectRoot);
			expect((sub.command as { cli: { message: string } }).cli.message).toBe('try again');
			expect(sub.prompt).toBeUndefined();
		});

		it('keeps the notify half a plain notify when both are asked for', () => {
			const subs = buildScheduledTaskSubscriptions(agent, {
				...tabInput,
				notify: { message: 'fired' },
			});
			expect(subs.map((sub) => sub.action)).toEqual(['command', 'notify']);
		});

		it('refuses a model choice, since the tab runs on its own model', () => {
			expect(() => buildScheduledTaskSubscriptions(agent, { ...tabInput, tier: 'low' })).toThrow(
				/tab's model/
			);
		});

		it('refuses a tab with nothing to deliver', () => {
			expect(() =>
				buildScheduledTaskSubscriptions(agent, {
					...tabInput,
					prompt: undefined,
					notify: { message: 'ping' },
				})
			).toThrow(/needs a prompt to deliver/);
		});
	});
});
