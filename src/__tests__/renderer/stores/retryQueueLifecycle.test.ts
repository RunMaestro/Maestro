/**
 * Agent Resilience x message queue - full outage lifecycle.
 *
 * The unit tests around this cover the pieces (does the classifier fire, does
 * the helper return 'wait'). This file covers the CLAIM those pieces are
 * supposed to add up to, which is the thing a user actually cares about:
 *
 *   Queue three messages, hit a usage limit, walk away. When the quota resets,
 *   all three run, in the order you queued them, and none are lost.
 *
 * It drives the same call sequence `useAgentExitListener` performs on each
 * process exit - `clearRetryIfSettled` → `hasPendingRetry` → `chooseNextQueuedItem`
 * - against the real `retryStore`, so a regression in any one of them fails
 * here even if its own unit test still passes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	scheduleRetryForError,
	noteDispatch,
	clearRetryIfSettled,
	hasPendingRetry,
	getRetryEntry,
	getOutage,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import {
	chooseNextQueuedItem,
	queueIsHeldByRetry,
} from '../../../renderer/hooks/agent/internal/helpers/exitDequeue';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import { takeNextRunnableQueueItem } from '../../../renderer/utils/executionQueue';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { AgentError, QueuedItem, Session } from '../../../renderer/types';

const NOW = 1_700_000_000_000;
const SESSION = 's-queue';
const TAB = 'tab-1';

const deps = {} as unknown as ProcessQueuedItemDeps;

/** The Claude Code plan-limit notice, verbatim, with a parseable reset time. */
const LIMIT_NOTICE = "You've hit your session limit · resets 11:40am (America/Chicago)";

function quotaError(): AgentError {
	return {
		type: 'rate_limited',
		message: LIMIT_NOTICE,
		recoverable: true,
		timestamp: NOW,
		agentId: 'claude-code',
	} as AgentError;
}

function queuedItem(id: string, text: string): QueuedItem {
	return { id, timestamp: NOW, tabId: TAB, type: 'message', text };
}

/** Read the live session out of the store (the reducer mutates it as we go). */
function session(): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === SESSION)!;
}

function setQueue(queue: QueuedItem[]): void {
	useSessionStore.setState({
		sessions: [{ ...session(), executionQueue: queue }],
	} as never);
}

let processQueuedItem: ReturnType<typeof vi.fn>;
/** Every prompt actually sent to the provider, in dispatch order. */
let dispatched: string[];

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	useRetryStore.setState({ retries: {}, outages: {} });
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SESSION,
				aiTabs: [createMockAITab({ id: TAB })],
				activeTabId: TAB,
			}),
		],
	} as never);
	dispatched = [];
	processQueuedItem = vi.fn(async (_sessionId: string, item: QueuedItem) => {
		dispatched.push(item.text!);
		// Mirror the real dispatch path, which snapshots every send for replay.
		noteDispatch(_sessionId, item, deps);
	});
	useAgentStore.setState({ processQueuedItem } as never);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

/**
 * One turn of the loop the app runs per process exit, condensed to the three
 * calls that decide what happens next. Returns the item it dispatched, if any.
 */
function simulateExit(): QueuedItem | null {
	clearRetryIfSettled(SESSION, TAB);
	const decision = chooseNextQueuedItem(session(), TAB, (tabId) => hasPendingRetry(SESSION, tabId));
	if (decision.action !== 'dequeue' || !decision.item) return null;
	const { item, remaining } = takeNextRunnableQueueItem(session().executionQueue);
	setQueue(remaining);
	void useAgentStore.getState().processQueuedItem(SESSION, item!, deps);
	return item;
}

describe('queued messages across a quota outage', () => {
	it('holds the queue, then drains it in order when the quota resets', async () => {
		// The user queues three follow-ups behind the turn that is running.
		const queue = [
			queuedItem('q1', 'first'),
			queuedItem('q2', 'second'),
			queuedItem('q3', 'third'),
		];
		setQueue(queue);

		// The running turn is dispatched and fails on the plan limit.
		void useAgentStore.getState().processQueuedItem(SESSION, queuedItem('q0', 'running'), deps);
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduleRetryForError(SESSION, TAB, quotaError())).toBe(true);

		// The process exits. THE WHOLE POINT: the queue must not drain into the
		// wall. Before this fix each of q1..q3 dispatched, failed, and superseded
		// the previous retry - so only q3 survived and q0..q2 were lost.
		expect(simulateExit()).toBeNull();
		expect(session().executionQueue).toHaveLength(3);
		expect(dispatched).toEqual(['running']);

		// The retry is parked on the real reset time, not an arbitrary backoff.
		const entry = getRetryEntry(SESSION, TAB)!;
		expect(entry.strategy).toBe('token-exhaustion');
		expect(entry.nextRetryAt).toBeGreaterThan(NOW + 60 * 60 * 1000);

		// Quota resets. The retry fires and replays the ORIGINAL failed prompt.
		await vi.advanceTimersByTimeAsync(entry.nextRetryAt - NOW + 10);
		expect(dispatched).toEqual(['running', 'running']);
		expect(getRetryEntry(SESSION, TAB)?.status).toBe('in-flight');

		// That resend succeeds and exits, which releases the queue. Each
		// subsequent exit walks one more item, in the order they were queued.
		expect(simulateExit()?.id).toBe('q1');
		expect(simulateExit()?.id).toBe('q2');
		expect(simulateExit()?.id).toBe('q3');

		expect(dispatched).toEqual(['running', 'running', 'first', 'second', 'third']);
		expect(session().executionQueue).toHaveLength(0);
		// The outage is over and its card has frozen into a summary.
		expect(hasPendingRetry(SESSION, TAB)).toBe(false);
		expect(getOutage(entry.outageId)?.status).toBe('recovered');
	});

	it('keeps holding while the provider is still refusing', async () => {
		setQueue([queuedItem('q1', 'first')]);
		void useAgentStore.getState().processQueuedItem(SESSION, queuedItem('q0', 'running'), deps);
		await vi.advanceTimersByTimeAsync(0);
		scheduleRetryForError(SESSION, TAB, quotaError());

		const first = getRetryEntry(SESSION, TAB)!;
		await vi.advanceTimersByTimeAsync(first.nextRetryAt - NOW + 10);

		// The resend fails too. agent-error arrives BEFORE process-exit, so the
		// entry is back to 'scheduled' by the time the exit lands - and the queue
		// must stay held rather than reading the reschedule as a recovery.
		scheduleRetryForError(SESSION, TAB, quotaError());
		expect(getRetryEntry(SESSION, TAB)?.status).toBe('scheduled');

		expect(simulateExit()).toBeNull();
		expect(session().executionQueue).toHaveLength(1);
		// Same outage continued, not a fresh one - the card keeps one running count.
		expect(getRetryEntry(SESSION, TAB)?.outageId).toBe(first.outageId);
		expect(getRetryEntry(SESSION, TAB)?.attempt).toBe(1);
	});
});

describe('queueIsHeldByRetry', () => {
	const OTHER = 'tab-2';

	it('holds when the queued item targets a DIFFERENT tab that is in an outage', () => {
		// The exiting tab is fine; the item is addressed to a tab that is waiting
		// out its own limit. Dispatching there would supersede that tab's retry
		// and lose the prompt it was holding.
		const pending = (tabId: string) => tabId === OTHER;
		const s = { executionQueue: [{ ...queuedItem('q1', 'x'), tabId: OTHER }] };
		expect(queueIsHeldByRetry(s, TAB, pending)).toBe(true);
	});

	it('holds when the EXITING tab is in an outage, whoever the item targets', () => {
		const pending = (tabId: string) => tabId === TAB;
		const s = { executionQueue: [{ ...queuedItem('q1', 'x'), tabId: OTHER }] };
		expect(queueIsHeldByRetry(s, TAB, pending)).toBe(true);
	});

	it('does not hold when neither tab has a retry pending', () => {
		const s = { executionQueue: [queuedItem('q1', 'x')] };
		expect(queueIsHeldByRetry(s, TAB, () => false)).toBe(false);
	});

	it('does not hold an empty queue', () => {
		expect(queueIsHeldByRetry({ executionQueue: [] }, TAB, () => false)).toBe(false);
	});
});
