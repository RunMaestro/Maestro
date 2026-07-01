import { describe, it, expect } from 'vitest';
import { buildThinkingItems } from '../../../renderer/utils/thinkingItems';
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
