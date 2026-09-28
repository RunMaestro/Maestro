/**
 * Tests for src/renderer/services/queuedPrompt.ts
 *
 * The queue item a non-composer prompt becomes. Three of its fields are easy to
 * drop and each has a visible cost: `tabName` is what a closed tab's item falls
 * back to, `readOnlyMode` is what lets it bypass the parallel-execution guard,
 * and `turnSettings` is what keeps a queued turn on the model it was queued
 * with. The `@mention` flags must be STAMPED but not fired.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const planCrossAgentMentions = vi.fn();
vi.mock('../../../renderer/services/crossAgentMentions', () => ({
	planCrossAgentMentions: (...args: unknown[]) => planCrossAgentMentions(...args),
}));

import {
	buildQueuedMessageItem,
	enqueuePromptForTab,
} from '../../../renderer/services/queuedPrompt';
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
