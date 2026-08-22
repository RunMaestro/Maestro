import { describe, it, expect } from 'vitest';
import { chooseNextQueuedItem } from '../../../../../../renderer/hooks/agent/internal/helpers/exitDequeue';
import type { QueuedItem, AITab, Session } from '../../../../../../renderer/types';

function item(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q1',
		timestamp: 1700000000000,
		tabId: 'tab-1',
		type: 'message',
		text: 'hello',
		...overrides,
	};
}

function tab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		state: 'idle',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		...overrides,
	} as AITab;
}

type MinSession = Pick<Session, 'executionQueue' | 'state' | 'agentError' | 'aiTabs'>;

describe('chooseNextQueuedItem', () => {
	it('returns "none" when the queue is empty', () => {
		const session: MinSession = {
			executionQueue: [],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab()],
		};
		expect(chooseNextQueuedItem(session, 'tab-1')).toEqual({ action: 'none', item: null });
	});

	it('returns "none" when session is in error state with an agentError', () => {
		const session: MinSession = {
			executionQueue: [item()],
			state: 'error',
			agentError: {
				type: 'auth_expired',
				timestamp: 0,
				message: 'x',
				agentId: 'claude-code',
			} as any,
			aiTabs: [tab()],
		};
		expect(chooseNextQueuedItem(session, 'tab-1').action).toBe('none');
	});

	it('returns "dequeue" when no other tabs are busy', () => {
		const session: MinSession = {
			executionQueue: [item()],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab({ id: 'tab-1' }), tab({ id: 'tab-2', state: 'idle' })],
		};
		const decision = chooseNextQueuedItem(session, 'tab-1');
		expect(decision.action).toBe('dequeue');
		expect(decision.item?.id).toBe('q1');
	});

	it('returns "wait" when another tab is busy and item is not forceParallel/readOnly', () => {
		const session: MinSession = {
			executionQueue: [item()],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab({ id: 'tab-1' }), tab({ id: 'tab-2', state: 'busy' })],
		};
		const decision = chooseNextQueuedItem(session, 'tab-1');
		expect(decision.action).toBe('wait');
		expect(decision.item?.id).toBe('q1');
	});

	it('returns "dequeue" for forceParallel item even when other tabs are busy', () => {
		const session: MinSession = {
			executionQueue: [item({ forceParallel: true })],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab({ id: 'tab-1' }), tab({ id: 'tab-2', state: 'busy' })],
		};
		expect(chooseNextQueuedItem(session, 'tab-1').action).toBe('dequeue');
	});

	it('returns "dequeue" for readOnlyMode item even when other tabs are busy', () => {
		const session: MinSession = {
			executionQueue: [item({ readOnlyMode: true })],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab({ id: 'tab-1' }), tab({ id: 'tab-2', state: 'busy' })],
		};
		expect(chooseNextQueuedItem(session, 'tab-1').action).toBe('dequeue');
	});

	it('ignores the exiting tab when computing otherTabsBusy', () => {
		const session: MinSession = {
			executionQueue: [item()],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab({ id: 'tab-1', state: 'busy' })],
		};
		// Even though tab-1 is "busy", it's the exiting tab - the queue can dequeue.
		expect(chooseNextQueuedItem(session, 'tab-1').action).toBe('dequeue');
	});

	it('only returns the head of the queue, never later items', () => {
		const session: MinSession = {
			executionQueue: [item({ id: 'q1' }), item({ id: 'q2' })],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab()],
		};
		expect(chooseNextQueuedItem(session, 'tab-1').item?.id).toBe('q1');
	});

	it('skips a paused head item and dequeues the first runnable one', () => {
		const session: MinSession = {
			executionQueue: [item({ id: 'q1', paused: true }), item({ id: 'q2' })],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab()],
		};
		const decision = chooseNextQueuedItem(session, 'tab-1');
		expect(decision.action).toBe('dequeue');
		expect(decision.item?.id).toBe('q2');
	});

	it('returns "none" when every queued item is paused', () => {
		const session: MinSession = {
			executionQueue: [item({ id: 'q1', paused: true }), item({ id: 'q2', paused: true })],
			state: 'idle',
			agentError: undefined,
			aiTabs: [tab()],
		};
		expect(chooseNextQueuedItem(session, 'tab-1')).toEqual({ action: 'none', item: null });
	});

	// Agent Resilience: the provider just refused this turn and a retry is
	// counting down. Draining the queue into it fails every queued item against
	// the same wall, and each dispatch cancels the previous item's scheduled
	// retry - so a queue of N messages silently loses the first N-1 prompts.
	describe('with an Agent Resilience retry pending', () => {
		function idleSessionWithQueue(): MinSession {
			return {
				executionQueue: [item({ id: 'q1' }), item({ id: 'q2' })],
				state: 'idle',
				agentError: undefined,
				aiTabs: [tab()],
			};
		}

		it('holds the queue instead of dequeuing', () => {
			const decision = chooseNextQueuedItem(idleSessionWithQueue(), 'tab-1', true);
			expect(decision.action).toBe('wait');
			// The item is reported but NOT consumed - it stays queued, in order.
			expect(decision.item?.id).toBe('q1');
		});

		it('dequeues normally once no retry is pending', () => {
			expect(chooseNextQueuedItem(idleSessionWithQueue(), 'tab-1', false).action).toBe('dequeue');
			// Defaulting the parameter must not change existing callers.
			expect(chooseNextQueuedItem(idleSessionWithQueue(), 'tab-1').action).toBe('dequeue');
		});

		it('holds a forceParallel item too - the wall applies to every item', () => {
			const session: MinSession = {
				executionQueue: [item({ id: 'q1', forceParallel: true })],
				state: 'idle',
				agentError: undefined,
				aiTabs: [tab()],
			};
			expect(chooseNextQueuedItem(session, 'tab-1', true).action).toBe('wait');
		});

		it('still reports "none" for an empty queue', () => {
			const session: MinSession = {
				executionQueue: [],
				state: 'idle',
				agentError: undefined,
				aiTabs: [tab()],
			};
			expect(chooseNextQueuedItem(session, 'tab-1', true)).toEqual({ action: 'none', item: null });
		});
	});
});
