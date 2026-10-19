import { describe, it, expect } from 'vitest';
import {
	buildTabWindowThinkingItems,
	buildThinkingItems,
} from '../../../renderer/utils/thinkingItems';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

describe('buildThinkingItems', () => {
	it('returns no items when nothing is busy', () => {
		const sessions = [
			createMockSession({ id: 'a', state: 'idle' }),
			createMockSession({ id: 'b', state: 'idle' }),
		];
		expect(buildThinkingItems(sessions)).toEqual([]);
	});

	it('emits one item per busy AI tab', () => {
		const busyTabs = [
			createMockAITab({ id: 't1', state: 'busy' }),
			createMockAITab({ id: 't2', state: 'busy' }),
			createMockAITab({ id: 't3', state: 'idle' }),
		];
		const sessions = [
			createMockSession({ id: 'a', state: 'busy', busySource: 'ai', aiTabs: busyTabs }),
		];
		const items = buildThinkingItems(sessions);
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.tab?.id)).toEqual(['t1', 't2']);
		expect(items.every((i) => i.session.id === 'a')).toBe(true);
	});

	it('falls back to a legacy (tab: null) item when busy with no tab-level tracking', () => {
		const sessions = [createMockSession({ id: 'a', state: 'busy', busySource: 'ai', aiTabs: [] })];
		const items = buildThinkingItems(sessions);
		expect(items).toEqual([{ session: sessions[0], tab: null }]);
	});

	it('does NOT emit a legacy item when the session is busy via terminal, not AI', () => {
		const sessions = [
			createMockSession({ id: 'a', state: 'busy', busySource: 'terminal', aiTabs: [] }),
		];
		expect(buildThinkingItems(sessions)).toEqual([]);
	});

	it('includes orphaned (closed-but-still-thinking) tabs', () => {
		const orphan = createMockAITab({ id: 'orphan', state: 'busy' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'idle',
				orphanedThinkingTabs: [orphan],
			}),
		];
		const items = buildThinkingItems(sessions);
		expect(items).toEqual([{ session: sessions[0], tab: orphan }]);
	});

	it('does not list a closed tab parked idle by a held queued item', () => {
		// Regression: closing a tab that owns a HELD message parks it in
		// orphanedThinkingTabs (idle) as a dispatch target. No process runs for
		// it, yet the pill showed it as "Thinking..." until the item was removed.
		const parked = createMockAITab({ id: 'closed', state: 'idle' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'idle',
				aiTabs: [createMockAITab({ id: 't1', state: 'idle' })],
				orphanedThinkingTabs: [parked],
				executionQueue: [
					{
						id: 'q1',
						timestamp: 1,
						tabId: 'closed',
						type: 'message',
						text: 'later',
						paused: true,
					},
				],
			}),
		];
		expect(buildThinkingItems(sessions)).toEqual([]);
	});

	it('keeps the legacy fallback when the only orphan is parked idle', () => {
		const parked = createMockAITab({ id: 'closed', state: 'idle' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [createMockAITab({ id: 't1', state: 'idle' })],
				orphanedThinkingTabs: [parked],
			}),
		];
		expect(buildThinkingItems(sessions)).toEqual([{ session: sessions[0], tab: null }]);
	});

	it('skips the legacy fallback when only orphaned tabs are present (no double count)', () => {
		const orphan = createMockAITab({ id: 'orphan', state: 'busy' });
		const sessions = [
			createMockSession({
				id: 'a',
				state: 'busy',
				busySource: 'ai',
				aiTabs: [],
				orphanedThinkingTabs: [orphan],
			}),
		];
		// One entry for the orphan, NOT an extra legacy {tab: null} entry.
		const items = buildThinkingItems(sessions);
		expect(items).toEqual([{ session: sessions[0], tab: orphan }]);
	});

	describe('window scoping (ownsSession gate)', () => {
		const owned = createMockSession({
			id: 'owned',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 'owned-tab', state: 'busy' })],
		});
		const remote = createMockSession({
			id: 'remote',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [createMockAITab({ id: 'remote-tab', state: 'busy' })],
		});
		const sessions = [owned, remote];

		it('includes every session when no ownership predicate is given', () => {
			const items = buildThinkingItems(sessions);
			expect(items.map((i) => i.session.id)).toEqual(['owned', 'remote']);
		});

		it('drops agents this window does not own', () => {
			const ownsSession = (id: string) => id === 'owned';
			const items = buildThinkingItems(sessions, ownsSession);
			expect(items).toHaveLength(1);
			expect(items[0].session.id).toBe('owned');
		});

		it('drops orphaned thinking tabs for agents owned by another window', () => {
			const remoteOrphan = createMockSession({
				id: 'remote',
				state: 'idle',
				orphanedThinkingTabs: [createMockAITab({ id: 'remote-orphan', state: 'busy' })],
			});
			const ownsSession = (id: string) => id === 'owned';
			const items = buildThinkingItems([owned, remoteOrphan], ownsSession);
			expect(items.map((i) => i.session.id)).toEqual(['owned']);
		});

		it('returns nothing when this window owns none of the busy agents', () => {
			const ownsSession = () => false;
			expect(buildThinkingItems(sessions, ownsSession)).toEqual([]);
		});
	});
});

describe('buildTabWindowThinkingItems', () => {
	// The tab window holds a2 and a3; the owner keeps a1. Its copy of a1 is frozen
	// at the last snapshot (Tab Windows, D2), so the busy state it shows can be stale.
	const STRIP = [
		{ type: 'ai' as const, id: 'a2' },
		{ type: 'ai' as const, id: 'a3' },
	];
	const agent = (tabs: { a1?: 'busy' | 'idle'; a2?: 'busy' | 'idle'; a3?: 'busy' | 'idle' }) =>
		createMockSession({
			id: 'agent',
			state: 'busy',
			busySource: 'ai',
			aiTabs: [
				createMockAITab({ id: 'a1', state: tabs.a1 ?? 'idle' }),
				createMockAITab({ id: 'a2', state: tabs.a2 ?? 'idle' }),
				createMockAITab({ id: 'a3', state: tabs.a3 ?? 'idle' }),
			],
		});

	it('lists the busy tabs of the strip', () => {
		const items = buildTabWindowThinkingItems(agent({ a2: 'busy', a3: 'busy' }), STRIP);
		expect(items.map((item) => item.tab?.id)).toEqual(['a2', 'a3']);
		expect(items.every((item) => item.session.id === 'agent')).toBe(true);
	});

	it('never lists a tab outside the strip, whose state here is frozen', () => {
		const items = buildTabWindowThinkingItems(agent({ a1: 'busy', a2: 'busy' }), STRIP);
		expect(items.map((item) => item.tab?.id)).toEqual(['a2']);
	});

	it('shows nothing when only a tab outside the strip is busy (no legacy item)', () => {
		expect(buildTabWindowThinkingItems(agent({ a1: 'busy' }), STRIP)).toEqual([]);
	});

	it('lists a closed tab that is still thinking: that state is live here', () => {
		const orphan = createMockAITab({ id: 'closed', state: 'busy' });
		const session = { ...agent({}), state: 'idle' as const, orphanedThinkingTabs: [orphan] };
		const items = buildTabWindowThinkingItems(session, STRIP);
		expect(items.map((item) => item.tab)).toEqual([orphan]);
	});

	it('shows nothing while the agent is idle', () => {
		expect(buildTabWindowThinkingItems({ ...agent({}), state: 'idle' }, STRIP)).toEqual([]);
	});
});
