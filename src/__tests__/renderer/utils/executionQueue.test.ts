import { describe, it, expect } from 'vitest';
import {
	isRunnableQueueItem,
	nextRunnableQueueItem,
	hasRunnableQueueItem,
	takeNextRunnableQueueItem,
	reorderQueueItem,
	resolveQueuedItemTabName,
	hasWorkAheadOfNewMessage,
	applyQueuedItemRelease,
	getForceSendEligibility,
	shouldOfferForceSend,
	applyQueuedItemEdit,
	applyQueuedItemDispatchFailure,
} from '../../../renderer/utils/executionQueue';
import type { AITab, QueuedItem, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

function item(id: string, paused = false): QueuedItem {
	return { id, timestamp: 0, tabId: 'tab-1', type: 'message', text: id, paused };
}

function tabItem(id: string, tabId: string): QueuedItem {
	return { id, timestamp: 0, tabId, type: 'message', text: id };
}

describe('executionQueue helpers', () => {
	it('isRunnableQueueItem treats only non-paused items as runnable', () => {
		expect(isRunnableQueueItem(item('a'))).toBe(true);
		expect(isRunnableQueueItem(item('b', true))).toBe(false);
	});

	it('nextRunnableQueueItem returns the first non-paused item', () => {
		const q = [item('a', true), item('b'), item('c')];
		expect(nextRunnableQueueItem(q)?.id).toBe('b');
		expect(nextRunnableQueueItem([item('a', true)])).toBeUndefined();
		expect(nextRunnableQueueItem([])).toBeUndefined();
	});

	it('hasRunnableQueueItem reflects whether any item can run', () => {
		expect(hasRunnableQueueItem([item('a', true), item('b')])).toBe(true);
		expect(hasRunnableQueueItem([item('a', true), item('b', true)])).toBe(false);
		expect(hasRunnableQueueItem([])).toBe(false);
	});

	it('takeNextRunnableQueueItem removes the first runnable item, preserving order of the rest', () => {
		const q = [item('a', true), item('b'), item('c')];
		const { item: taken, remaining } = takeNextRunnableQueueItem(q);
		expect(taken?.id).toBe('b');
		// The paused item ahead of it stays in place; 'c' keeps its order.
		expect(remaining.map((i) => i.id)).toEqual(['a', 'c']);
	});

	it('takeNextRunnableQueueItem returns null + unchanged queue when all items are paused', () => {
		const q = [item('a', true), item('b', true)];
		const { item: taken, remaining } = takeNextRunnableQueueItem(q);
		expect(taken).toBeNull();
		expect(remaining).toBe(q);
	});
});

describe('reorderQueueItem', () => {
	it('moves an item within the whole queue when no tabId is given', () => {
		const q = [item('a'), item('b'), item('c')];
		expect(reorderQueueItem(q, 0, 2).map((i) => i.id)).toEqual(['b', 'c', 'a']);
		expect(reorderQueueItem(q, 2, 0).map((i) => i.id)).toEqual(['c', 'a', 'b']);
	});

	it('returns the same queue reference for no-op or out-of-range moves', () => {
		const q = [item('a'), item('b')];
		expect(reorderQueueItem(q, 1, 1)).toBe(q);
		expect(reorderQueueItem(q, -1, 0)).toBe(q);
		expect(reorderQueueItem(q, 0, 5)).toBe(q);
	});

	it('reorders only the target tab and keeps other tabs in their absolute slots', () => {
		// Interleaved: tab-1 at slots 0 and 2, tab-2 at slot 1.
		const q = [tabItem('a', 'tab-1'), tabItem('x', 'tab-2'), tabItem('c', 'tab-1')];
		// In tab-1's filtered view [a, c], move a (0) after c (1).
		const result = reorderQueueItem(q, 0, 1, 'tab-1');
		// tab-1 items become [c, a] back in slots 0 and 2; tab-2 'x' stays at slot 1.
		expect(result.map((i) => i.id)).toEqual(['c', 'x', 'a']);
	});

	it('treats tab-scoped indices as positions within that tab only', () => {
		const q = [
			tabItem('a', 'tab-1'),
			tabItem('b', 'tab-1'),
			tabItem('x', 'tab-2'),
			tabItem('c', 'tab-1'),
		];
		// tab-1 filtered view [a, b, c]; move c (index 2) to front (index 0).
		const result = reorderQueueItem(q, 2, 0, 'tab-1');
		expect(result.map((i) => i.id)).toEqual(['c', 'a', 'x', 'b']);
	});

	it('returns the same queue reference for out-of-range tab-scoped moves', () => {
		const q = [tabItem('a', 'tab-1'), tabItem('x', 'tab-2')];
		// tab-1 has only one item, so index 1 is out of range for its view.
		expect(reorderQueueItem(q, 0, 1, 'tab-1')).toBe(q);
	});
});

describe('hasWorkAheadOfNewMessage', () => {
	it('is false for an idle agent with an empty queue', () => {
		const session = createMockSession({ aiTabs: [createMockAITab({ id: 'tab-1' })] });
		expect(hasWorkAheadOfNewMessage(session)).toBe(false);
	});

	it('is true while any tab is mid-turn, including a closed-but-thinking orphan', () => {
		const busy = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		});
		expect(hasWorkAheadOfNewMessage(busy)).toBe(true);

		// A tab closed mid-send keeps working in the background and still holds
		// the agent's order, so a new message lands behind it.
		const orphaned = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			orphanedThinkingTabs: [createMockAITab({ id: 'tab-gone', state: 'busy' })],
		});
		expect(hasWorkAheadOfNewMessage(orphaned)).toBe(true);
	});

	it('is true when an item is waiting, and false when every item is held', () => {
		const queued = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			executionQueue: [item('a')],
		});
		expect(hasWorkAheadOfNewMessage(queued)).toBe(true);

		// A paused item is invisible to dispatch, so nothing is actually ahead.
		const held = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			executionQueue: [item('a', true)],
		});
		expect(hasWorkAheadOfNewMessage(held)).toBe(false);
	});

	it('is true while Auto Run is active, which never marks the agent busy', () => {
		const session = createMockSession({ aiTabs: [createMockAITab({ id: 'tab-1' })] });
		expect(hasWorkAheadOfNewMessage(session, { autoRunActive: true })).toBe(true);
	});
});

describe('applyQueuedItemRelease', () => {
	it('returns the agent to idle when the released tab was the only one working', () => {
		const session = createMockSession({
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 123,
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 123 })],
		});

		const next = applyQueuedItemRelease(session, 'tab-1');

		expect(next.aiTabs[0].state).toBe('idle');
		expect(next.aiTabs[0].thinkingStartTime).toBeUndefined();
		expect(next.state).toBe('idle');
		expect(next.busySource).toBeUndefined();
		expect(next.thinkingStartTime).toBeUndefined();
	});

	it('keeps the agent busy when another tab is still mid-turn', () => {
		// Blanking the agent state here would strand the other tab's thinking pill.
		const session = createMockSession({
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 123,
			aiTabs: [
				createMockAITab({ id: 'tab-1', state: 'busy', thinkingStartTime: 123 }),
				createMockAITab({ id: 'tab-2', state: 'busy', thinkingStartTime: 456 }),
			],
		});

		const next = applyQueuedItemRelease(session, 'tab-1');

		expect(next.aiTabs[0].state).toBe('idle');
		expect(next.aiTabs[1].state).toBe('busy');
		expect(next.state).toBe('busy');
		expect(next.thinkingStartTime).toBe(123);
	});

	it('keeps the agent busy for a still-thinking orphan tab', () => {
		const session = createMockSession({
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
			orphanedThinkingTabs: [createMockAITab({ id: 'tab-gone', state: 'busy' })],
		});

		const next = applyQueuedItemRelease(session, 'tab-1');

		expect(next.state).toBe('busy');
		expect(next.orphanedThinkingTabs?.[0].state).toBe('busy');
	});

	it('leaves the queue untouched', () => {
		const session = createMockSession({
			state: 'busy',
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
			executionQueue: [item('a'), item('b')],
		});

		expect(applyQueuedItemRelease(session, 'tab-1').executionQueue.map((i) => i.id)).toEqual([
			'a',
			'b',
		]);
	});
});

describe('resolveQueuedItemTabName', () => {
	const tab = (id: string, name?: string) => ({ id, name, state: 'idle' }) as unknown as AITab;
	const session = (tabs: AITab[], orphans: AITab[] = []) =>
		({ aiTabs: tabs, orphanedThinkingTabs: orphans }) as unknown as Session;

	it('prefers the live tab name over the snapshot taken when the item was queued', () => {
		const queued = { tabId: 'tab-1', tabName: 'New' };
		expect(resolveQueuedItemTabName(session([tab('tab-1', 'PR #1427')]), queued)).toBe('PR #1427');
	});

	it('gives two items on the same tab the same label once that tab is named', () => {
		const s = session([tab('tab-1', 'PR #1427')]);
		const first = { tabId: 'tab-1', tabName: 'New' };
		const second = { tabId: 'tab-1', tabName: 'PR #1427' };
		expect(resolveQueuedItemTabName(s, first)).toBe(resolveQueuedItemTabName(s, second));
	});

	it('falls back to an orphaned (closed but draining) tab before the snapshot', () => {
		const s = session([], [tab('tab-9', 'Draining Tab')]);
		expect(resolveQueuedItemTabName(s, { tabId: 'tab-9', tabName: 'Stale' })).toBe('Draining Tab');
	});

	it('falls back to the snapshot when the tab is gone entirely', () => {
		expect(resolveQueuedItemTabName(session([]), { tabId: 'gone', tabName: 'Old Name' })).toBe(
			'Old Name'
		);
	});
});

describe('shouldOfferForceSend', () => {
	const tab = (id: string, state: 'idle' | 'busy') => ({ id, state }) as unknown as AITab;
	const session = (tabs: AITab[]) => ({ aiTabs: tabs }) as unknown as Session;
	const queued = { tabId: 'tab-1' };
	const eligibility = (tabs: AITab[], forcedParallelEnabled = true) =>
		getForceSendEligibility(session(tabs), queued, { forcedParallelEnabled });

	it('offers the control on a quiet agent, where forcing is always allowed', () => {
		const e = eligibility([tab('tab-1', 'idle')]);
		expect(e.canForce).toBe(true);
		expect(shouldOfferForceSend(e)).toBe(true);
	});

	it('offers it disabled when only the Forced Parallel setting is in the way', () => {
		// The one blocked reason the user can act on: the tooltip names a
		// setting, so the dimmed button is a signpost rather than a dead control.
		const e = eligibility([tab('tab-1', 'idle'), tab('tab-2', 'busy')], false);
		expect(e.blockedReason).toBe('needs-forced-parallel');
		expect(shouldOfferForceSend(e)).toBe(true);
	});

	it("hides it when the item's own tab is mid-turn", () => {
		// A tab runs one turn at a time, so the item is next in line by
		// definition and the wait resolves itself.
		const e = eligibility([tab('tab-1', 'busy')]);
		expect(e.blockedReason).toBe('target-tab-busy');
		expect(shouldOfferForceSend(e)).toBe(false);
	});

	it('hides it when there is no tab left to run on', () => {
		// No AI tabs at all, so there is not even an active tab to fall back to.
		const e = eligibility([]);
		expect(e.blockedReason).toBe('no-target-tab');
		expect(shouldOfferForceSend(e)).toBe(false);
	});

	it('hides it when eligibility has not been computed', () => {
		expect(shouldOfferForceSend(null)).toBe(false);
		expect(shouldOfferForceSend(undefined)).toBe(false);
	});
});

/**
 * applyQueuedItemEdit is the single write for a queued-message edit. Both save
 * paths call it - the inline chat list (App.tsx, active agent) and the
 * Execution Queue browser (useQueueHandlers, any agent by id) - because they
 * had already drifted once: one of them dropped `turnSettings`, silently
 * discarding the model and effort the user had just picked in the modal.
 */
describe('applyQueuedItemEdit', () => {
	const patch = (over: Partial<QueuedItem['turnSettings']> | undefined = undefined) => ({
		text: 'edited',
		images: [] as string[],
		turnSettings: over ?? {},
	});

	it('writes the model/effort override onto the target item', () => {
		const queue = [item('a'), item('b')];

		const next = applyQueuedItemEdit(queue, 'a', {
			text: 'edited',
			images: [],
			turnSettings: { model: 'opus', effort: 'ultrathink' },
		});

		expect(next[0].text).toBe('edited');
		expect(next[0].turnSettings).toEqual({ model: 'opus', effort: 'ultrathink' });
	});

	it('leaves every other item untouched', () => {
		const queue = [item('a'), item('b')];

		const next = applyQueuedItemEdit(queue, 'a', patch({ model: 'opus' }));

		expect(next[1]).toBe(queue[1]);
		expect(next[1].text).toBe('b');
	});

	it('assigns turnSettings rather than merging, so a cleared picker clears', () => {
		const queue = [{ ...item('a'), turnSettings: { model: 'opus', effort: 'ultrathink' } }];

		// User cleared the model back to "Default" but kept the effort.
		const next = applyQueuedItemEdit(queue, 'a', patch({ effort: 'ultrathink' }));

		expect(next[0].turnSettings).toEqual({ effort: 'ultrathink' });
		expect(next[0].turnSettings?.model).toBeUndefined();
	});

	it('preserves queue order and length', () => {
		const queue = [item('a'), item('b'), item('c')];

		const next = applyQueuedItemEdit(queue, 'b', patch({ model: 'opus' }));

		expect(next.map((i) => i.id)).toEqual(['a', 'b', 'c']);
	});

	it('is a no-op when the id is not in the queue', () => {
		const queue = [item('a')];

		const next = applyQueuedItemEdit(queue, 'missing', patch({ model: 'opus' }));

		expect(next[0]).toBe(queue[0]);
	});

	it('does not disturb an item paused state', () => {
		const queue = [item('a', /* paused */ true)];

		const next = applyQueuedItemEdit(queue, 'a', patch({ model: 'opus' }));

		expect(next[0].paused).toBe(true);
	});
});

// ============================================================================
// applyQueuedItemDispatchFailure
// ============================================================================

describe('applyQueuedItemDispatchFailure', () => {
	function sessionWithCard(overrides: Partial<Session> = {}): Session {
		const tab = createMockAITab({
			id: 'tab-1',
			state: 'busy',
			thinkingStartTime: 111,
			logs: [
				{ id: 'log-old', timestamp: 1, source: 'user', text: 'send this' },
				{ id: 'log-card', timestamp: 2, source: 'user', text: 'send this', queuedItemId: 'q1' },
			],
		});
		return createMockSession({
			id: 's1',
			state: 'busy',
			busySource: 'ai',
			thinkingStartTime: 111,
			aiTabs: [tab],
			activeTabId: 'tab-1',
			executionQueue: [],
			...overrides,
		} as Partial<Session>);
	}

	const failed: QueuedItem = {
		id: 'q1',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'send this',
	};

	it('releases the tab, removes only the card this dispatch wrote, and re-queues at the head', () => {
		const later: QueuedItem = { ...failed, id: 'q2', text: 'later' };
		const next = applyQueuedItemDispatchFailure(
			sessionWithCard({ executionQueue: [later] }),
			failed,
			{
				hold: false,
			}
		);

		expect(next.aiTabs[0].state).toBe('idle');
		expect(next.aiTabs[0].thinkingStartTime).toBeUndefined();
		expect(next.state).toBe('idle');
		// The identical message the user really did send earlier survives; only the
		// stamped card for this failed dispatch goes.
		expect(next.aiTabs[0].logs.map((l) => l.id)).toEqual(['log-old']);
		// Head of the queue, so it keeps its place ahead of everything behind it.
		expect(next.executionQueue.map((i) => i.id)).toEqual(['q1', 'q2']);
		expect(next.executionQueue[0].paused).toBeFalsy();
	});

	it('holds the item when the failure is not a transient collision', () => {
		const next = applyQueuedItemDispatchFailure(sessionWithCard(), failed, { hold: true });

		expect(next.executionQueue.map((i) => i.id)).toEqual(['q1']);
		// Preserved and visible, but it cannot spin the queue against a wall that
		// would refuse it identically on the next tick.
		expect(next.executionQueue[0].paused).toBe(true);
	});

	it('is idempotent when the item is already back in the queue', () => {
		// `retryStore.holdFailedItemInQueue` parks the failed turn in the queue for
		// the life of an outage. A second copy would double-send the prompt.
		const held = sessionWithCard({ executionQueue: [failed] });

		const next = applyQueuedItemDispatchFailure(held, failed, { hold: false });

		expect(next.executionQueue.map((i) => i.id)).toEqual(['q1']);
	});

	it('leaves the agent busy when another tab is still running its own turn', () => {
		const base = sessionWithCard();
		const withOther = {
			...base,
			aiTabs: [...base.aiTabs, createMockAITab({ id: 'tab-2', state: 'busy' })],
		} as Session;

		const next = applyQueuedItemDispatchFailure(withOther, failed, { hold: false });

		expect(next.aiTabs.find((t) => t.id === 'tab-1')!.state).toBe('idle');
		expect(next.aiTabs.find((t) => t.id === 'tab-2')!.state).toBe('busy');
		expect(next.state).toBe('busy');
	});

	it('strips the card from a closed-but-still-draining orphan tab', () => {
		const orphan = createMockAITab({
			id: 'tab-9',
			state: 'busy',
			logs: [{ id: 'log-card', timestamp: 2, source: 'user', text: 'x', queuedItemId: 'q1' }],
		});
		const base = createMockSession({
			id: 's1',
			state: 'busy',
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
			executionQueue: [],
			orphanedThinkingTabs: [orphan],
		} as Partial<Session>);

		const next = applyQueuedItemDispatchFailure(
			base,
			{ ...failed, tabId: 'tab-9' },
			{
				hold: false,
			}
		);

		expect(next.orphanedThinkingTabs![0].logs).toHaveLength(0);
		expect(next.orphanedThinkingTabs![0].state).toBe('idle');
	});
});
