/**
 * Tests for src/renderer/services/queuedPrompt.ts
 *
 * The queue item a non-composer prompt becomes. Three of its fields are easy to
 * drop and each has a visible cost: `tabName` is what a closed tab's item falls
 * back to, `readOnlyMode` is what lets it bypass the parallel-execution guard,
 * and `turnSettings` is what keeps a queued turn on the model it was queued
 * with. The `@mention` flags must be STAMPED but not fired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const planCrossAgentMentions = vi.fn();
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	planCrossAgentMentions: (...args: unknown[]) => planCrossAgentMentions(...args),
}));

import {
	buildQueuedMessageItem,
	enqueuePromptForTab,
	removeQueuedItem,
	sendQueuedItemNow,
} from '../../../renderer/services/queuedPrompt';
import { registerDispatchDepsProvider } from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { Session } from '../../../renderer/types';

function seed(overrides: Partial<Session> = {}): Session {
	const session = createMockSession({
		id: 'session-1',
		aiTabs: [
			createMockAITab({ id: 'a', name: 'Alpha' }),
			createMockAITab({ id: 'b', name: 'Bravo' }),
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'a' },
			{ type: 'ai', id: 'b' },
		],
		activeTabId: 'a',
		executionQueue: [],
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

function currentQueue() {
	return useSessionStore.getState().sessions[0].executionQueue;
}

describe('buildQueuedMessageItem', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('builds a message item pinned to the given tab', () => {
		const session = seed();
		const item = buildQueuedMessageItem({
			session,
			tab: session.aiTabs[1],
			text: 'carry on',
		});

		expect(item.type).toBe('message');
		expect(item.tabId).toBe('b');
		expect(item.text).toBe('carry on');
		expect(item.tabName).toBe('Bravo');
		// Present, so a queue that drains after a model switch still runs under
		// what was selected when it was queued.
		expect(item.turnSettings).toBeDefined();
	});

	it('marks an item queued from a read-only tab', () => {
		const session = seed({
			aiTabs: [createMockAITab({ id: 'a', name: 'Alpha', readOnlyMode: true })],
			unifiedTabOrder: [{ type: 'ai', id: 'a' }],
		});
		expect(
			buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'look only' }).readOnlyMode
		).toBe(true);
	});

	it('stamps the @mention intent without firing the consult', () => {
		planCrossAgentMentions.mockReturnValue({ targetSessionIds: ['other'], suppressLocal: true });
		const session = seed();

		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: '@Other look' });

		expect(item.crossAgentMention).toBe(true);
		expect(item.crossAgentOnly).toBe(true);
		// Planning only - dispatching is processQueuedItem's job at drain time.
		expect(planCrossAgentMentions).toHaveBeenCalledWith('@Other look', 'session-1');
	});

	it('leaves the mention flags off a message that mentions nobody', () => {
		const session = seed();
		const item = buildQueuedMessageItem({ session, tab: session.aiTabs[0], text: 'plain' });
		expect(item.crossAgentMention).toBeUndefined();
		expect(item.crossAgentOnly).toBeUndefined();
	});
});

describe('enqueuePromptForTab', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('appends to the tail of the agent execution queue', () => {
		seed();
		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'first' });
		enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'second' });

		expect(currentQueue().map((item) => item.text)).toEqual(['first', 'second']);
	});

	it('falls back to the active tab when the target tab is gone', () => {
		// Losing the prompt because a tab moved is worse than answering it in the
		// tab next door - the caller has already decided this agent gets asked.
		seed();
		const item = enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'vanished',
			text: 'still ask',
		});

		expect(item!.tabId).toBe('a');
		expect(currentQueue()).toHaveLength(1);
	});

	it('returns null and queues nothing for an unknown agent', () => {
		seed();
		expect(enqueuePromptForTab({ sessionId: 'ghost', tabId: 'a', text: 'nope' })).toBeNull();
		expect(currentQueue()).toHaveLength(0);
	});

	it('returns null when the agent has no AI tab to answer in', () => {
		seed({ aiTabs: [], unifiedTabOrder: [], activeTabId: undefined });
		expect(enqueuePromptForTab({ sessionId: 'session-1', tabId: 'a', text: 'nope' })).toBeNull();
		expect(currentQueue()).toHaveLength(0);
	});
});

describe('enqueuePromptForTab with expandCommands', () => {
	const deps = {
		conductorProfile: '',
		customAICommands: [{ id: 'c', command: '/commit', description: 'Commit', prompt: 'do it' }],
		speckitCommands: [],
		openspecCommands: [],
	};

	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
		registerDispatchDepsProvider(() => deps as never);
	});
	afterEach(() => registerDispatchDepsProvider(null));

	it('queues a message that is exactly a slash command as that command', () => {
		seed();
		const item = enqueuePromptForTab({
			sessionId: 'session-1',
			tabId: 'b',
			text: ' /commit ',
			expandCommands: true,
		});
		expect(item).toMatchObject({
			type: 'command',
			command: '/commit',
			commandDescription: 'Commit',
			tabId: 'b',
			tabName: 'Bravo',
		});
		expect(item?.text).toBeUndefined();
		expect(currentQueue()).toEqual([item]);
	});

	it('leaves the same text a literal message for a caller that did not ask', () => {
		seed();
		expect(
			enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: '/commit' })
		).toMatchObject({ type: 'message', text: '/commit' });
	});

	it('leaves an unknown command, and a command inside a sentence, as messages', () => {
		seed();
		for (const text of ['/nope', 'please run /commit now']) {
			expect(
				enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text, expandCommands: true })
			).toMatchObject({ type: 'message', text });
		}
	});
});

describe('removeQueuedItem', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	it('takes the item out and says it was there', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		expect(removeQueuedItem('session-1', item.id)).toBe(true);
		expect(currentQueue()).toEqual([]);
	});

	it('says no when the item already left the queue, so it is not sent twice', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		removeQueuedItem('session-1', item.id);
		expect(removeQueuedItem('session-1', item.id)).toBe(false);
		expect(removeQueuedItem('missing-session', item.id)).toBe(false);
	});
});

describe('sendQueuedItemNow', () => {
	beforeEach(() => {
		planCrossAgentMentions.mockReset();
		planCrossAgentMentions.mockReturnValue(null);
	});

	function setTabState(tabId: string, state: 'idle' | 'busy') {
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, state } : t)),
			})),
		});
	}

	it('dequeues the item, marks its tab running, and dispatches it', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		const dispatch = vi.fn().mockResolvedValue(true);

		expect(sendQueuedItemNow('session-1', item.id, dispatch)).toBe(true);
		expect(currentQueue()).toEqual([]);
		const target = useSessionStore.getState().sessions[0].aiTabs[1];
		expect(target.state).toBe('busy');
		expect(target.logs.at(-1)).toMatchObject({ source: 'user', text: 'hi', queuedItemId: item.id });
		expect(dispatch).toHaveBeenCalledWith('session-1', item);
	});

	it('never runs over a turn already in flight on the same tab', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		setTabState('b', 'busy');
		const dispatch = vi.fn().mockResolvedValue(true);

		expect(sendQueuedItemNow('session-1', item.id, dispatch)).toBe(false);
		expect(currentQueue()).toEqual([item]);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('stamps forceParallel when another tab of the agent is mid-turn', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		setTabState('a', 'busy');
		const dispatch = vi.fn().mockResolvedValue(true);

		sendQueuedItemNow('session-1', item.id, dispatch);
		expect(dispatch).toHaveBeenCalledWith('session-1', { ...item, forceParallel: true });
	});

	it('leaves the item queued when nothing could run it yet', () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		// No dispatch deps are registered before the app's queue hook mounts.
		registerDispatchDepsProvider(null);
		expect(sendQueuedItemNow('session-1', item.id)).toBe(false);
		expect(currentQueue()).toEqual([item]);
	});

	it('owns a failed dispatch so it is not an unhandled rejection', async () => {
		seed();
		const item = enqueuePromptForTab({ sessionId: 'session-1', tabId: 'b', text: 'hi' })!;
		const dispatch = vi.fn().mockRejectedValue(new Error('spawn failed'));
		expect(sendQueuedItemNow('session-1', item.id, dispatch)).toBe(true);
		await Promise.resolve();
	});
});
