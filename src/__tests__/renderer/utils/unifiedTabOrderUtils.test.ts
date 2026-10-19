import { describe, it, expect, beforeEach } from 'vitest';
import {
	filterPoppedOutRefs,
	findActiveUnifiedTabIndex,
	getNavigableUnifiedTabOrder,
	ownerVisibleAiTabs,
	withoutPoppedOutTabs,
} from '../../../renderer/utils/unifiedTabOrderUtils';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import { createMockSession } from '../../helpers/mockSession';
import { useTabWindowStore } from '../../../renderer/stores/tabWindowStore';
import type { UnifiedTabRef } from '../../../renderer/types';
import type { TabWindowTabRef } from '../../../shared/tabWindowTypes';

const order: UnifiedTabRef[] = [
	{ type: 'ai', id: 'a1' },
	{ type: 'file', id: 'f1' },
	{ type: 'group', id: 'g1' },
	{ type: 'terminal', id: 't1' },
	{ type: 'browser', id: 'b1' },
];

function popOut(agentId: string, tabRefs: TabWindowTabRef[]) {
	useTabWindowStore
		.getState()
		.setWindows([{ windowId: 'tw-1', agentId, tabRefs, activeTabRef: tabRefs[0] ?? null }]);
}

describe('filterPoppedOutRefs', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	});

	it('returns the input by reference when nothing is popped out', () => {
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('returns the input by reference when the popped tabs are not in the order', () => {
		popOut('agent-a', [{ type: 'ai', id: 'elsewhere' }]);
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('returns the input by reference when another agent has the popped tab', () => {
		popOut('agent-b', [{ type: 'ai', id: 'a1' }]);
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('drops popped refs of every tab type and keeps the rest in order', () => {
		popOut('agent-a', [
			{ type: 'ai', id: 'a1' },
			{ type: 'terminal', id: 't1' },
			{ type: 'browser', id: 'b1' },
		]);
		expect(filterPoppedOutRefs('agent-a', order)).toEqual([
			{ type: 'file', id: 'f1' },
			{ type: 'group', id: 'g1' },
		]);
	});

	it('matches on type and id', () => {
		popOut('agent-a', [{ type: 'file', id: 'a1' }]);
		expect(filterPoppedOutRefs('agent-a', order)).toBe(order);
	});

	it('never drops a group ref', () => {
		popOut('agent-a', [{ type: 'file', id: 'f1' }]);
		const groupOnly: UnifiedTabRef[] = [{ type: 'group', id: 'f1' }];
		expect(filterPoppedOutRefs('agent-a', groupOnly)).toBe(groupOnly);
	});

	it('does not mutate the stored order', () => {
		popOut('agent-a', [{ type: 'ai', id: 'a1' }]);
		const stored = [...order];
		filterPoppedOutRefs('agent-a', stored);
		expect(stored).toEqual(order);
	});
});

describe('getNavigableUnifiedTabOrder with popped-out tabs', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	});

	const session = createMockSession({
		id: 'agent-a',
		aiTabs: [createMockAITab({ id: 'a1' }), createMockAITab({ id: 'h1', hidden: true })],
	});

	it('drops popped refs and hidden consult refs together', () => {
		popOut('agent-a', [{ type: 'terminal', id: 't1' }]);
		const withHidden: UnifiedTabRef[] = [...order, { type: 'ai', id: 'h1' }];
		expect(getNavigableUnifiedTabOrder(session, withHidden)).toEqual([
			{ type: 'ai', id: 'a1' },
			{ type: 'file', id: 'f1' },
			{ type: 'group', id: 'g1' },
			{ type: 'browser', id: 'b1' },
		]);
	});

	it('returns the input by reference when nothing is dropped', () => {
		popOut('agent-a', [{ type: 'ai', id: 'elsewhere' }]);
		const noHidden = createMockSession({ id: 'agent-a', aiTabs: [createMockAITab({ id: 'a1' })] });
		expect(getNavigableUnifiedTabOrder(noHidden, order)).toBe(order);
	});
});

describe('findActiveUnifiedTabIndex with popped-out tabs', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	});

	it('finds no active tab in a navigable order that dropped the popped active tab', () => {
		popOut('agent-a', [{ type: 'ai', id: 'a1' }]);
		const session = createMockSession({ id: 'agent-a', activeTabId: 'a1' });
		expect(findActiveUnifiedTabIndex(session, getNavigableUnifiedTabOrder(session, order))).toBe(
			-1
		);
		// The stored order keeps the slot, so insertion still lands beside it.
		expect(findActiveUnifiedTabIndex(session, order)).toBe(0);
	});
});

describe('withoutPoppedOutTabs / ownerVisibleAiTabs', () => {
	beforeEach(() => {
		useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
	});

	const aiTabs = [
		createMockAITab({ id: 'a1' }),
		createMockAITab({ id: 'a2' }),
		createMockAITab({ id: 'h1', hidden: true }),
	];
	const fileTabs = [createMockFileTab({ id: 'f1' }), createMockFileTab({ id: 'f2' })];

	it('returns the input by reference when nothing is popped', () => {
		expect(withoutPoppedOutTabs('agent-a', 'file', fileTabs)).toBe(fileTabs);
		const shown = [aiTabs[0], aiTabs[1]];
		expect(ownerVisibleAiTabs('agent-a', shown)).toBe(shown);
	});

	it('drops the popped tabs of the named kind only', () => {
		popOut('agent-a', [
			{ type: 'file', id: 'f2' },
			{ type: 'ai', id: 'f1' },
		]);
		expect(withoutPoppedOutTabs('agent-a', 'file', fileTabs).map((t) => t.id)).toEqual(['f1']);
	});

	it('drops popped and hidden AI tabs', () => {
		popOut('agent-a', [{ type: 'ai', id: 'a2' }]);
		expect(ownerVisibleAiTabs('agent-a', aiTabs).map((t) => t.id)).toEqual(['a1']);
	});

	it('keeps everything without an agent id', () => {
		popOut('agent-a', [{ type: 'file', id: 'f2' }]);
		expect(withoutPoppedOutTabs(undefined, 'file', fileTabs)).toBe(fileTabs);
		expect(ownerVisibleAiTabs(null, undefined)).toEqual([]);
	});
});
