/**
 * Tests for a group's lifecycle prompts: the stored record, the checks a save
 * must pass, which hook an event fires, the lifecycle-only variables, and the
 * wire patch the CLI and bridge clients send.
 */

import { describe, it, expect } from 'vitest';
import {
	applyGroupLifecyclePatch,
	compactGroupLifecycle,
	defaultLifecycleHook,
	groupLifecycleProblem,
	lifecycleEventName,
	lifecycleHookFor,
	lifecycleTabName,
	lifecycleTriggerFor,
	normalizeGroupLifecycle,
	offboardingTimeoutMs,
	parseGroupLifecyclePatch,
	parseGroupLifecycleRunRequest,
	substituteLifecycleVariables,
	withGroupLifecycle,
	type GroupLifecycleHook,
} from '../../shared/groupLifecycle';
import type { Group } from '../../shared/types';

const GROUP: Group = { id: 'g1', name: 'Backend', emoji: '🛠', collapsed: false };

function hook(overrides: Partial<GroupLifecycleHook> = {}): GroupLifecycleHook {
	return { enabled: true, prompt: 'Set up', triggers: ['agent', 'worktree'], ...overrides };
}

describe('normalizeGroupLifecycle', () => {
	it('reads nothing from garbage, and keeps only well-formed fields', () => {
		expect(normalizeGroupLifecycle(undefined)).toBeUndefined();
		expect(normalizeGroupLifecycle('x')).toBeUndefined();
		expect(
			normalizeGroupLifecycle({
				onboarding: {
					enabled: true,
					prompt: 'Hi',
					triggers: ['worktree', 'moved', 'agent'],
					tier: 'enormous',
					tabName: '  ',
					runsInAgentId: ' a2 ',
					timeoutMinutes: 9,
				},
			})
		).toEqual({
			onboarding: {
				enabled: true,
				prompt: 'Hi',
				triggers: ['agent', 'worktree'],
				runsInAgentId: 'a2',
			},
		});
	});

	it('defaults missing triggers to both, and drops a stage that is off and empty', () => {
		expect(normalizeGroupLifecycle({ offboarding: { enabled: true, prompt: 'Bye' } })).toEqual({
			offboarding: { enabled: true, prompt: 'Bye', triggers: ['agent', 'worktree'] },
		});
		expect(
			normalizeGroupLifecycle({ onboarding: { enabled: false, prompt: ' ' } })
		).toBeUndefined();
	});
});

describe('compactGroupLifecycle and withGroupLifecycle', () => {
	it('removes the field when no stage is left, and trims what it keeps', () => {
		expect(
			withGroupLifecycle(
				{ ...GROUP, lifecycle: { onboarding: hook() } },
				{
					onboarding: defaultLifecycleHook('onboarding'),
				}
			)
		).toEqual(GROUP);
		expect(
			compactGroupLifecycle({ onboarding: hook({ tabName: ' Setup ', runsInAgentId: '' }) })
		).toEqual({ onboarding: { ...hook(), tabName: 'Setup' } });
	});

	it('keeps a time limit on Offboarding only', () => {
		expect(
			compactGroupLifecycle({
				onboarding: hook({ timeoutMinutes: 3 }),
				offboarding: hook({ timeoutMinutes: 3 }),
			})
		).toEqual({ onboarding: hook(), offboarding: hook({ timeoutMinutes: 3 }) });
	});
});

describe('groupLifecycleProblem', () => {
	const context = { liveAgentIds: ['a1', 'steward'] };

	it('passes a valid lifecycle and an absent one', () => {
		expect(groupLifecycleProblem(undefined, context)).toBeNull();
		expect(
			groupLifecycleProblem(
				{
					onboarding: hook({ runsInAgentId: 'steward' }),
					offboarding: hook({ timeoutMinutes: 10 }),
				},
				context
			)
		).toBeNull();
	});

	it('refuses a hook that is on with no prompt or no event', () => {
		expect(groupLifecycleProblem({ onboarding: hook({ prompt: ' ' }) }, context)).toMatchObject({
			stage: 'onboarding',
			field: 'prompt',
		});
		expect(groupLifecycleProblem({ offboarding: hook({ triggers: [] }) }, context)).toMatchObject({
			stage: 'offboarding',
			field: 'triggers',
		});
	});

	it('refuses a steward that no longer exists, even on a hook that is off', () => {
		expect(
			groupLifecycleProblem(
				{ onboarding: hook({ enabled: false, runsInAgentId: 'gone' }) },
				context
			)
		).toMatchObject({ field: 'runsIn' });
	});

	it('refuses a time limit out of range or fractional', () => {
		for (const timeoutMinutes of [0, 61, 2.5]) {
			expect(
				groupLifecycleProblem({ offboarding: hook({ timeoutMinutes }) }, context)
			).toMatchObject({ field: 'timeout' });
		}
	});
});

describe('lifecycleHookFor and lifecycleTriggerFor', () => {
	const group = { lifecycle: { onboarding: hook({ triggers: ['worktree'] }) } };

	it('fires only an enabled hook with a prompt, for a trigger it lists', () => {
		expect(lifecycleHookFor(group, 'onboarding', 'worktree')).toMatchObject({ prompt: 'Set up' });
		expect(lifecycleHookFor(group, 'onboarding', 'agent')).toBeNull();
		expect(lifecycleHookFor(group, 'offboarding', 'worktree')).toBeNull();
		expect(lifecycleHookFor(undefined, 'onboarding', 'agent')).toBeNull();
		expect(
			lifecycleHookFor(
				{ lifecycle: { onboarding: hook({ enabled: false }) } },
				'onboarding',
				'agent'
			)
		).toBeNull();
	});

	it('reads a worktree agent by either link to its parent', () => {
		expect(lifecycleTriggerFor({})).toBe('agent');
		expect(lifecycleTriggerFor({ parentSessionId: 'p' })).toBe('worktree');
		expect(lifecycleTriggerFor({ worktreeParentPath: '/repo' })).toBe('worktree');
	});
});

describe('names, tabs and time limits', () => {
	it('names the event and the tab', () => {
		expect(lifecycleEventName('onboarding', 'worktree')).toBe('worktree-created');
		expect(lifecycleEventName('offboarding', 'agent')).toBe('agent-removed');
		expect(lifecycleTabName(hook(), 'offboarding')).toBe('Offboarding');
		expect(lifecycleTabName(hook({ tabName: 'Teardown' }), 'offboarding')).toBe('Teardown');
	});

	it('bounds the time limit and defaults it to five minutes', () => {
		expect(offboardingTimeoutMs(hook())).toBe(5 * 60_000);
		expect(offboardingTimeoutMs(hook({ timeoutMinutes: 500 }))).toBe(60 * 60_000);
		expect(offboardingTimeoutMs(hook({ timeoutMinutes: 0 }))).toBe(60_000);
	});
});

describe('substituteLifecycleVariables', () => {
	it('fills the lifecycle-only variables and leaves the general ones for the next step', () => {
		expect(
			substituteLifecycleVariables(
				'{{LIFECYCLE_EVENT}} {{PARENT_AGENT_NAME}} {{PARENT_PATH}} {{AGENT_NAME}}',
				{ event: 'worktree-created', parentAgentName: 'Maestro', parentPath: '/repo' }
			)
		).toBe('worktree-created Maestro /repo {{AGENT_NAME}}');
		expect(substituteLifecycleVariables('[{{PARENT_PATH}}]', { event: 'agent-created' })).toBe(
			'[]'
		);
	});
});

describe('parseGroupLifecyclePatch and applyGroupLifecyclePatch', () => {
	it('parses a patch and refuses unknown stages, keys and values by name', () => {
		expect(
			parseGroupLifecyclePatch({
				onboarding: { tier: 'default', tabName: ' ', triggers: ['worktree', 'agent'] },
				offboarding: null,
			})
		).toEqual({
			ok: true,
			patch: {
				onboarding: { tier: null, tabName: null, triggers: ['agent', 'worktree'] },
				offboarding: null,
			},
		});
		expect(parseGroupLifecyclePatch({ midboarding: {} })).toMatchObject({ ok: false });
		expect(parseGroupLifecyclePatch({ onboarding: { colour: 'red' } })).toMatchObject({
			ok: false,
			error: expect.stringContaining('colour'),
		});
		expect(parseGroupLifecyclePatch({ onboarding: { timeoutMinutes: 3 } })).toMatchObject({
			ok: false,
			error: 'Only Offboarding has a time limit.',
		});
		expect(parseGroupLifecyclePatch({ onboarding: { tier: 'huge' } })).toMatchObject({ ok: false });
		expect(parseGroupLifecyclePatch({})).toMatchObject({ ok: false });
	});

	it('starts a new stage from its default and merges onto a stored one', () => {
		expect(
			applyGroupLifecyclePatch(undefined, { onboarding: { enabled: true, prompt: 'Hi' } })
		).toEqual({
			onboarding: { enabled: true, prompt: 'Hi', triggers: ['agent', 'worktree'] },
		});
		expect(
			applyGroupLifecyclePatch(
				{ offboarding: hook({ tier: 'low', runsInAgentId: 's' }) },
				{ offboarding: { tier: null, runsInAgentId: null, timeoutMinutes: 10 } }
			)
		).toEqual({ offboarding: hook({ timeoutMinutes: 10 }) });
	});

	it('removes a stage set to null, and the whole record when nothing is left', () => {
		expect(applyGroupLifecyclePatch({ onboarding: hook() }, { onboarding: null })).toBeUndefined();
	});
});

describe('parseGroupLifecycleRunRequest', () => {
	it('needs a stage and an agent', () => {
		expect(parseGroupLifecycleRunRequest({ stage: 'onboarding', agentId: ' a1 ' })).toEqual({
			ok: true,
			request: { stage: 'onboarding', agentId: 'a1' },
		});
		expect(parseGroupLifecycleRunRequest({ stage: 'onboarding' }).ok).toBe(false);
		expect(parseGroupLifecycleRunRequest({ stage: 'during', agentId: 'a1' }).ok).toBe(false);
	});
});
