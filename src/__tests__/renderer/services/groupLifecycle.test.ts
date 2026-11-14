/**
 * Tests for the group lifecycle runner: which events queue a prompt, where it
 * is queued, how a removal waits for Offboarding, and the refusals of "Run now".
 *
 * The queue itself is stubbed (it has its own tests): `enqueuePromptForTab`
 * appends a plain item, and a test drives the item through the states the
 * real drain moves it through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../renderer/services/queuedPrompt', () => ({
	enqueuePromptForTab: vi.fn(),
}));
vi.mock('../../../renderer/services/git', () => ({
	gitService: { getStatus: vi.fn(async () => ({ branch: 'main' })) },
}));
vi.mock('../../../renderer/utils/providerTabSessions', () => ({
	captureQueuedTurnSettings: vi.fn(() => ({ provider: 'claude-code' })),
}));

import {
	offboardBeforeRemoval,
	runGroupLifecycleNow,
	skipOffboarding,
	startGroupOnboarding,
} from '../../../renderer/services/groupLifecycle';
import { enqueuePromptForTab } from '../../../renderer/services/queuedPrompt';
import { useSessionStore, updateSessionWith } from '../../../renderer/stores/sessionStore';
import { useGroupLifecycleStore } from '../../../renderer/stores/groupLifecycleStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import type { Group, QueuedItem, Session } from '../../../renderer/types';
import type { GroupLifecycle } from '../../../shared/groupLifecycle';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const GROUP_ID = 'g1';

function seed(lifecycle: GroupLifecycle | undefined, sessions: Session[]): void {
	const group: Group = {
		id: GROUP_ID,
		name: 'Backend',
		emoji: '🛠',
		collapsed: false,
		...(lifecycle ? { lifecycle } : {}),
	};
	useSessionStore.setState({ groups: [group], sessions });
}

function agent(id: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id,
		name: id,
		groupId: GROUP_ID,
		aiTabs: [createMockAITab({ id: `${id}-tab` })],
		activeTabId: `${id}-tab`,
		executionQueue: [],
		...overrides,
	});
}

function storedAgent(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

/** The stubbed queue: append the item the way the real one does. */
function stubQueue(): void {
	vi.mocked(enqueuePromptForTab).mockImplementation(({ sessionId, tabId, text }) => {
		const item = { id: `item-${tabId}`, timestamp: 0, tabId, type: 'message', text } as QueuedItem;
		updateSessionWith(sessionId, (s) => ({
			...s,
			executionQueue: [...(s.executionQueue ?? []), item],
		}));
		return item;
	});
}

/** What the drain does: take the item and mark its tab running. */
function dispatch(agentId: string, tabId: string): void {
	updateSessionWith(agentId, (s) => ({
		...s,
		executionQueue: [],
		aiTabs: s.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, state: 'busy' } : tab)),
	}));
}

function finishTurn(agentId: string, tabId: string): void {
	updateSessionWith(agentId, (s) => ({
		...s,
		aiTabs: s.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, state: 'idle' } : tab)),
	}));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.mocked(enqueuePromptForTab).mockReset();
	stubQueue();
	useNotificationStore.setState({ toasts: [] });
	useGroupLifecycleStore.setState({ offboardings: {} });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('startGroupOnboarding', () => {
	it("queues the prompt in a new agent's untouched first tab, renamed, with variables filled", async () => {
		seed(
			{
				onboarding: {
					enabled: true,
					prompt: 'Hi {{AGENT_NAME}} ({{LIFECYCLE_EVENT}})',
					triggers: ['agent'],
				},
			},
			[agent('fresh')]
		);

		startGroupOnboarding('fresh');
		await vi.waitFor(() => expect(enqueuePromptForTab).toHaveBeenCalled());

		expect(enqueuePromptForTab).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'fresh',
				tabId: 'fresh-tab',
				text: 'Hi fresh (agent-created)',
			})
		);
		expect(storedAgent('fresh').aiTabs).toHaveLength(1);
		expect(storedAgent('fresh').aiTabs[0].name).toBe('Onboarding');
	});

	it('does nothing for an event the hook does not list, or a hook that is off', async () => {
		seed({ onboarding: { enabled: true, prompt: 'Hi', triggers: ['worktree'] } }, [agent('plain')]);
		startGroupOnboarding('plain');
		seed({ onboarding: { enabled: false, prompt: 'Hi', triggers: ['agent'] } }, [agent('plain')]);
		startGroupOnboarding('plain');
		await flush();
		expect(enqueuePromptForTab).not.toHaveBeenCalled();
	});

	it('runs in a steward agent, in a new background tab, about the joining agent', async () => {
		seed(
			{
				onboarding: {
					enabled: true,
					prompt: 'Register {{AGENT_NAME}} from {{PARENT_AGENT_NAME}}',
					triggers: ['worktree'],
					runsInAgentId: 'ops',
					tabName: 'Register',
				},
			},
			[
				agent('parent'),
				agent('ops', { groupId: undefined }),
				agent('wt', { parentSessionId: 'parent' }),
			]
		);

		startGroupOnboarding('wt');
		await vi.waitFor(() => expect(enqueuePromptForTab).toHaveBeenCalled());

		const call = vi.mocked(enqueuePromptForTab).mock.calls[0][0];
		expect(call.sessionId).toBe('ops');
		expect(call.text).toBe('Register wt from parent');
		const ops = storedAgent('ops');
		expect(ops.aiTabs).toHaveLength(2);
		expect(ops.aiTabs.find((tab) => tab.id === call.tabId)?.name).toBe('Register');
		// Background: the steward's visible tab did not move.
		expect(ops.activeTabId).toBe('ops-tab');
	});

	it('says so when the steward is gone', async () => {
		seed(
			{ onboarding: { enabled: true, prompt: 'Hi', triggers: ['agent'], runsInAgentId: 'ghost' } },
			[agent('fresh')]
		);
		startGroupOnboarding('fresh');
		await vi.waitFor(() =>
			expect(
				useNotificationStore.getState().toasts.some((t) => t.title === 'Onboarding Did Not Run')
			).toBe(true)
		);
		expect(enqueuePromptForTab).not.toHaveBeenCalled();
	});
});

describe('offboardBeforeRemoval', () => {
	const offboarding: GroupLifecycle = {
		offboarding: { enabled: true, prompt: 'Bye', triggers: ['agent'], timeoutMinutes: 1 },
	};

	it('resolves at once when the group has no Offboarding', async () => {
		seed(undefined, [agent('leaving')]);
		await offboardBeforeRemoval('leaving');
		expect(enqueuePromptForTab).not.toHaveBeenCalled();
	});

	it('waits for the turn to run and finish, and shows the wait meanwhile', async () => {
		seed(offboarding, [agent('leaving')]);
		let done = false;
		const removal = offboardBeforeRemoval('leaving').then(() => (done = true));
		await vi.waitFor(() => expect(enqueuePromptForTab).toHaveBeenCalled());
		const { tabId } = vi.mocked(enqueuePromptForTab).mock.calls[0][0];

		await vi.waitFor(() =>
			expect(useGroupLifecycleStore.getState().offboardings.leaving).toBeDefined()
		);
		dispatch('leaving', tabId);
		await flush();
		expect(done).toBe(false);

		finishTurn('leaving', tabId);
		await removal;
		expect(done).toBe(true);
		expect(useGroupLifecycleStore.getState().offboardings.leaving).toBeUndefined();
	});

	it('ends the wait on "Remove now"', async () => {
		seed(offboarding, [agent('leaving')]);
		const removal = offboardBeforeRemoval('leaving');
		await vi.waitFor(() =>
			expect(useGroupLifecycleStore.getState().offboardings.leaving).toBeDefined()
		);
		skipOffboarding('leaving');
		await removal;
		expect(useGroupLifecycleStore.getState().offboardings.leaving).toBeUndefined();
	});

	it('goes ahead when the time limit runs out, and says so', async () => {
		vi.useFakeTimers();
		seed(offboarding, [agent('leaving')]);
		const removal = offboardBeforeRemoval('leaving');
		await vi.advanceTimersByTimeAsync(10);
		expect(useGroupLifecycleStore.getState().offboardings.leaving).toBeDefined();
		await vi.advanceTimersByTimeAsync(60_000);
		await removal;
		expect(
			useNotificationStore.getState().toasts.some((t) => t.title === 'Offboarding Ran Out of Time')
		).toBe(true);
	});

	it('shares one wait between two removals of the same agent', async () => {
		seed(offboarding, [agent('leaving')]);
		const first = offboardBeforeRemoval('leaving');
		const second = offboardBeforeRemoval('leaving');
		expect(second).toBe(first);
		await vi.waitFor(() =>
			expect(useGroupLifecycleStore.getState().offboardings.leaving).toBeDefined()
		);
		skipOffboarding('leaving');
		await first;
		expect(enqueuePromptForTab).toHaveBeenCalledTimes(1);
	});
});

describe('runGroupLifecycleNow', () => {
	it('runs a hook that is off, on an agent of the group', async () => {
		seed({ offboarding: { enabled: false, prompt: 'Bye', triggers: [] } }, [agent('member')]);
		const outcome = await runGroupLifecycleNow(GROUP_ID, 'offboarding', 'member');
		expect(outcome).toMatchObject({
			ok: true,
			report: { stage: 'offboarding', subjectAgentId: 'member', runAgentId: 'member' },
		});
	});

	it('runs the draft it is handed instead of the stored hook', async () => {
		seed(undefined, [agent('member')]);
		const outcome = await runGroupLifecycleNow(GROUP_ID, 'onboarding', 'member', {
			enabled: false,
			prompt: 'Typed, not saved',
			triggers: ['agent'],
		});
		expect(outcome.ok).toBe(true);
		expect(vi.mocked(enqueuePromptForTab).mock.calls[0][0].text).toBe('Typed, not saved');
	});

	it('refuses a stage with no prompt and an agent outside the group', async () => {
		seed(undefined, [agent('member'), agent('outsider', { groupId: 'other' })]);
		expect(await runGroupLifecycleNow(GROUP_ID, 'onboarding', 'member')).toMatchObject({
			ok: false,
			error: expect.stringContaining('no Onboarding prompt'),
		});
		seed({ onboarding: { enabled: true, prompt: 'Hi', triggers: ['agent'] } }, [
			agent('member'),
			agent('outsider', { groupId: 'other' }),
		]);
		expect(await runGroupLifecycleNow(GROUP_ID, 'onboarding', 'outsider')).toMatchObject({
			ok: false,
			error: expect.stringContaining('is not in'),
		});
		expect(await runGroupLifecycleNow('nope', 'onboarding', 'member')).toMatchObject({
			ok: false,
			error: 'Group not found',
		});
	});
});
