/**
 * A queued prompt survives a failed dispatch - the end-to-end claim.
 *
 * The pieces around this are unit-tested elsewhere (does the classifier fire,
 * does `applyQueuedItemDispatchFailure` release the right tab). This file covers
 * the thing a user actually cares about, and the thing that was broken:
 *
 *   Queue work behind a turn, hit a usage limit, walk away. When the quota
 *   resets and the queue drains, no message is destroyed - not even when the
 *   drain races a process that has not finished dying yet.
 *
 * The incident it is written from (2026-09-09, rc): a plan-limit outage held a
 * deep queue for two and a half hours. At reset the retry fired correctly and
 * the held turn ran. The user then pressed Stop, and `handleInterrupt`
 * dispatched the next queued item ~60ms later - while the interrupted child
 * still owned its process key. `ProcessManager.spawn` refused with "Agent
 * process already running", `processQueuedItem` recorded the failure and
 * rethrew, and the interrupt handler's `.catch()` logged and stopped. The
 * updater had already taken the item out of the queue, so the prompt was gone:
 * no queue entry, no delivery, and a transcript card for a message no model
 * ever saw. A second card appeared when the exit listener re-dispatched the
 * NEXT item, which read as the same message sent twice.
 *
 * Five of the eight dispatch sites had no recovery at all. Rather than write a
 * sixth copy of it, recovery now lives in `processQueuedItem`'s catch - the one
 * place that knows why the dispatch failed - so a site only has to own its
 * rejection. These tests drive the real store through the real failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { agentAlreadyRunningMessage } from '../../../shared/processErrors';
import {
	applyQueuedItemDispatch,
	takeNextRunnableQueueItem,
} from '../../../renderer/utils/executionQueue';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import { resetStores } from '../../helpers';
import type { AgentConfig, QueuedItem, Session } from '../../../renderer/types';

// ============================================================================
// Harness
// ============================================================================

const mockSpawn = vi.fn().mockResolvedValue({ pid: 1, success: true });
const mockGetAgent = vi.fn();

(window as any).maestro = {
	process: { spawn: mockSpawn, kill: vi.fn(), interrupt: vi.fn() },
	agents: { detect: vi.fn().mockResolvedValue([]), get: mockGetAgent },
	agentError: { clearError: vi.fn() },
	prompts: {
		get: vi.fn().mockResolvedValue({ success: true, content: '' }),
	},
};

vi.mock('../../../renderer/services/git', () => ({
	gitService: { getStatus: vi.fn().mockResolvedValue({ branch: 'main', files: [] }) },
}));
vi.mock('../../../renderer/utils/templateVariables', () => ({
	substituteTemplateVariables: vi.fn((template: string) => template),
}));
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	dispatchCrossAgentMentionsForMessage: vi.fn(),
	planCrossAgentMentions: vi.fn(() => null),
}));
vi.mock('../../../renderer/utils/logger', () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const AGENT: AgentConfig = {
	id: 'claude-code',
	name: 'Claude Code',
	available: true,
	command: 'claude',
	args: [],
} as AgentConfig;

const deps: ProcessQueuedItemDeps = {
	conductorProfile: '',
	customAICommands: [],
	speckitCommands: [],
	openspecCommands: [],
};

const SESSION = 'sess-1';
const TAB = 'tab-1';

function queued(id: string, text: string, tabId = TAB): QueuedItem {
	return { id, timestamp: 0, tabId, type: 'message', text };
}

function session(): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === SESSION)!;
}

function setSession(next: Session): void {
	useSessionStore.getState().setSessions([next]);
}

/** The card a dispatch wrote for this item, if it is still in the transcript. */
function cardsFor(itemId: string, tabId = TAB): number {
	const tab = session().aiTabs.find((t) => t.id === tabId)!;
	return tab.logs.filter((log) => log.queuedItemId === itemId).length;
}

/**
 * One drain step, exactly as every dispatch site performs it: take the next
 * runnable item and mark its tab busy in one updater (which appends the
 * user-visible card), then dispatch. The site's own `.catch()` only logs -
 * putting the prompt back is `processQueuedItem`'s job now.
 */
async function drainOnce(): Promise<QueuedItem | null> {
	const { item } = takeNextRunnableQueueItem(session().executionQueue);
	if (!item) return null;
	setSession(applyQueuedItemDispatch(session(), item));
	await useAgentStore
		.getState()
		.processQueuedItem(SESSION, item, deps)
		.catch(() => {
			/* the call site owns the rejection, nothing more */
		});
	return item;
}

beforeEach(() => {
	resetStores(useAgentStore, useSessionStore);
	vi.clearAllMocks();
	mockGetAgent.mockResolvedValue(AGENT);
	mockSpawn.mockResolvedValue({ pid: 1, success: true });
	setSession(
		createMockSession({
			id: SESSION,
			cwd: '/test',
			fullPath: '/test',
			projectRoot: '/test',
			aiTabs: [createMockAITab({ id: TAB })],
			activeTabId: TAB,
			executionQueue: [],
		} as Partial<Session>)
	);
});

// ============================================================================
// The incident
// ============================================================================

describe('a queue drain that races a dying process', () => {
	it('delivers the prompt exactly once and cards it exactly once', async () => {
		setSession({
			...session(),
			executionQueue: [queued('q1', 'back-merge main into rc'), queued('q2', 'build maestro')],
		});

		// Stop was pressed. The child still owns its process key, so the first
		// dispatch is refused.
		mockSpawn.mockRejectedValueOnce(new Error(agentAlreadyRunningMessage(`${SESSION}-ai-${TAB}`)));
		await drainOnce();

		// Nothing was lost and nothing was said: the prompt is back at the head of
		// the queue, ahead of the message queued behind it, and the transcript does
		// not claim it was sent.
		expect(session().executionQueue.map((i) => i.id)).toEqual(['q1', 'q2']);
		expect(cardsFor('q1')).toBe(0);
		expect(session().aiTabs[0].state).toBe('idle');
		expect(session().state).toBe('idle');

		// A collision is transient, so the item comes back RUNNABLE - the exit
		// listener drains it for real a moment later, once the child is gone.
		expect(session().executionQueue[0].paused).toBeFalsy();
		await drainOnce();

		expect(mockSpawn).toHaveBeenCalledTimes(2);
		expect(mockSpawn.mock.calls[1][0].prompt).toBe('back-merge main into rc');
		expect(cardsFor('q1')).toBe(1);
		expect(session().executionQueue.map((i) => i.id)).toEqual(['q2']);
	});

	it('writes no red error frame for a collision', async () => {
		setSession({ ...session(), executionQueue: [queued('q1', 'hello')] });
		mockSpawn.mockRejectedValueOnce(new Error(agentAlreadyRunningMessage(`${SESSION}-ai-${TAB}`)));

		await drainOnce();

		// The user has nothing to act on here, and during an outage this frame
		// lands directly under the retry card that is already explaining the wait.
		expect(session().aiTabs[0].logs.filter((l) => l.source === 'error')).toHaveLength(0);
	});

	it('does not walk the rest of the queue into the same wall', async () => {
		setSession({
			...session(),
			executionQueue: [queued('q1', 'first'), queued('q2', 'second'), queued('q3', 'third')],
		});
		mockSpawn.mockRejectedValue(new Error(agentAlreadyRunningMessage(`${SESSION}-ai-${TAB}`)));

		// Three drain triggers fire in quick succession, which is what a released
		// outage looks like: exit listener, runtime recovery, and Stop all at once.
		await drainOnce();
		await drainOnce();
		await drainOnce();

		// Every message is still queued, still in order, still exactly one copy.
		expect(session().executionQueue.map((i) => i.id)).toEqual(['q1', 'q2', 'q3']);
		expect(session().aiTabs[0].logs).toHaveLength(0);
	});
});

// ============================================================================
// Failures that are NOT transient
// ============================================================================

describe('a dispatch that fails for a real reason', () => {
	it('holds the prompt in the queue and says why', async () => {
		setSession({ ...session(), executionQueue: [queued('q1', 'hello')] });
		mockSpawn.mockRejectedValueOnce(new Error('ENOENT: claude not found'));

		await drainOnce();

		const queue = session().executionQueue;
		expect(queue.map((i) => i.id)).toEqual(['q1']);
		// Held, not runnable: a missing binary would refuse this identically on the
		// next tick, and a runnable item would spin the queue against it forever.
		expect(queue[0].paused).toBe(true);

		const errors = session().aiTabs[0].logs.filter((l) => l.source === 'error');
		expect(errors).toHaveLength(1);
		expect(errors[0].text).toContain('ENOENT: claude not found');
		expect(errors[0].text).toContain('held in the queue');
		// And the card for the undelivered prompt is gone, so resuming the held
		// item does not read as the same message sent twice.
		expect(cardsFor('q1')).toBe(0);
	});

	it('still rethrows, because Agent Resilience reschedules off the throw', async () => {
		setSession({ ...session(), executionQueue: [queued('q1', 'hello')] });
		mockSpawn.mockRejectedValueOnce(new Error('boom'));
		const { item } = takeNextRunnableQueueItem(session().executionQueue);
		setSession(applyQueuedItemDispatch(session(), item!));

		await expect(useAgentStore.getState().processQueuedItem(SESSION, item!, deps)).rejects.toThrow(
			'boom'
		);
	});
});

// ============================================================================
// Multi-tab bookkeeping
// ============================================================================

describe('recovery on a multi-tab agent', () => {
	it('releases only the tab this dispatch marked busy', async () => {
		setSession({
			...session(),
			aiTabs: [createMockAITab({ id: TAB }), createMockAITab({ id: 'tab-2', state: 'busy' })],
			executionQueue: [queued('q1', 'hello')],
		});
		mockSpawn.mockRejectedValueOnce(new Error(agentAlreadyRunningMessage(`${SESSION}-ai-${TAB}`)));

		await drainOnce();

		// Sweeping every busy tab told the recovery effect the agent was free, and
		// it walked the whole queue into a live process, one message per render.
		expect(session().aiTabs.find((t) => t.id === TAB)!.state).toBe('idle');
		expect(session().aiTabs.find((t) => t.id === 'tab-2')!.state).toBe('busy');
		expect(session().state).toBe('busy');
	});

	it('leaves an identical message the user really sent earlier alone', async () => {
		const tab = createMockAITab({
			id: TAB,
			logs: [{ id: 'earlier', timestamp: 1, source: 'user', text: 'build maestro' }],
		});
		setSession({ ...session(), aiTabs: [tab], executionQueue: [queued('q1', 'build maestro')] });
		mockSpawn.mockRejectedValueOnce(new Error(agentAlreadyRunningMessage(`${SESSION}-ai-${TAB}`)));

		await drainOnce();

		// Matching by text would have deleted the user's real history here.
		expect(session().aiTabs[0].logs.map((l) => l.id)).toEqual(['earlier']);
	});
});

// ============================================================================
// Slash commands
// ============================================================================

describe('a slash command that fails to dispatch', () => {
	it('takes its own card back too', async () => {
		// The command path writes the card inside processQueuedItem rather than in
		// the caller's dequeue updater, so it needs the same stamp - `/maestro-build`
		// appearing twice in the incident transcript is exactly this.
		const item: QueuedItem = {
			id: 'q1',
			timestamp: 0,
			tabId: TAB,
			type: 'command',
			command: '/build',
		};
		setSession({ ...session(), executionQueue: [item] });
		mockSpawn.mockRejectedValueOnce(new Error(agentAlreadyRunningMessage(`${SESSION}-ai-${TAB}`)));

		const withCommands: ProcessQueuedItemDeps = {
			...deps,
			customAICommands: [
				{ command: '/build', description: 'Build', prompt: 'run the build' } as never,
			],
		};

		setSession(applyQueuedItemDispatch(session(), item));
		await useAgentStore
			.getState()
			.processQueuedItem(SESSION, item, withCommands)
			.catch(() => {});

		expect(cardsFor('q1')).toBe(0);
		expect(session().executionQueue.map((i) => i.id)).toEqual(['q1']);
	});
});
