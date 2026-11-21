// Source: src/__tests__/shared/tabStripMembership.test.ts
// Source: src/__tests__/shared/tabConversationStats.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { collectGroupMemberTabKeys } from '../../shared/tabStripMembership';
import { countOpenTabs } from '../../shared/tabStripMembership';
import { countTabStrip } from '../../shared/tabStripMembership';
import { dropOrphanedTabs } from '../../shared/tabStripMembership';
import { tabStripSlotKeys } from '../../shared/tabStripMembership';
import { tabStripVisibility } from '../../shared/tabStripMembership';
import { computeTabConversationStats } from '../../shared/tabConversationStats';
import { formatConversationDuration } from '../../shared/tabConversationStats';
import type { LogEntry } from '../../renderer/types';
describeSourceSuite('tabStripMembership', () => {
	const agent = () => ({
		aiTabs: [{ id: 'open' }, { id: 'consult', hidden: true }, { id: 'closed' }, { id: 'tiled-ai' }],
		filePreviewTabs: [{ id: 'file' }],
		browserTabs: [{ id: 'web' }],
		terminalTabs: [{ id: 'term' }, { id: 'stale-term' }],
		unifiedTabOrder: [
			{ type: 'ai', id: 'open' },
			{ type: 'ai', id: 'consult' },
			{ type: 'file', id: 'file' },
			{ type: 'browser', id: 'web' },
			{ type: 'group', id: 'g1' },
		],
		tabGroups: [
			{
				id: 'g1',
				layout: {
					kind: 'split',
					id: 's1',
					children: [
						{ kind: 'leaf', id: 'l1', tab: { type: 'ai', id: 'tiled-ai' } },
						{ kind: 'leaf', id: 'l2', tab: { type: 'terminal', id: 'term' } },
					],
				},
			},
		],
	});

	describe('tabStripMembership', () => {
		it('collects the leaves of every tiled group', () => {
			expect([...collectGroupMemberTabKeys(agent())].sort()).toEqual([
				'ai:tiled-ai',
				'terminal:term',
			]);
			expect(collectGroupMemberTabKeys({ tabGroups: [null, { layout: {} }] }).size).toBe(0);
		});

		it('classifies each tab as visible, hidden, or orphaned', () => {
			const session = agent();
			const slots = tabStripSlotKeys(session);
			const byId = (type: 'ai' | 'terminal', id: string) =>
				tabStripVisibility(type, { id, hidden: id === 'consult' }, slots);
			expect(byId('ai', 'open')).toBe('visible');
			expect(byId('ai', 'consult')).toBe('hidden');
			expect(byId('ai', 'closed')).toBe('orphaned');
			expect(byId('ai', 'tiled-ai')).toBe('visible');
			expect(byId('terminal', 'stale-term')).toBe('orphaned');
		});

		it('treats a legacy record with no order as fully visible', () => {
			expect(tabStripSlotKeys({ aiTabs: [{ id: 'a' }] })).toBeNull();
			expect(tabStripVisibility('ai', { id: 'a' }, null)).toBe('visible');
			expect(tabStripVisibility('ai', { id: 'a', hidden: true }, null)).toBe('hidden');
		});

		it('counts by kind and visibility, and counts open tabs as the visible ones', () => {
			expect(countTabStrip(agent())).toEqual({
				ai: { visible: 2, hidden: 1, orphaned: 1 },
				file: { visible: 1, hidden: 0, orphaned: 0 },
				browser: { visible: 1, hidden: 0, orphaned: 0 },
				terminal: { visible: 1, hidden: 0, orphaned: 1 },
			});
			expect(countOpenTabs(agent())).toBe(5);
			expect(countOpenTabs({})).toBe(0);
		});

		it('drops orphans, keeps hidden tabs, and returns the same reference when clean', () => {
			const { session, dropped } = dropOrphanedTabs(agent());
			expect(dropped).toBe(2);
			expect(session.aiTabs.map((tab) => tab.id)).toEqual(['open', 'consult', 'tiled-ai']);
			expect(session.terminalTabs).toEqual([{ id: 'term' }]);

			const again = dropOrphanedTabs(session);
			expect(again.session).toBe(session);
			expect(again.dropped).toBe(0);

			const hiddenOutsideOrder = { aiTabs: [{ id: 'qc', hidden: true }], unifiedTabOrder: [] };
			expect(dropOrphanedTabs(hiddenOutsideOrder).session).toBe(hiddenOutsideOrder);
		});
	});
});
describeSourceSuite('tabConversationStats', () => {
	const BASE_TIME = 1703116800000; // 2023-12-21T00:00:00.000Z

	function log(source: LogEntry['source'], offsetMs: number, text = 'x'): LogEntry {
		return {
			id: `log-${source}-${offsetMs}`,
			timestamp: BASE_TIME + offsetMs,
			source,
			text,
		};
	}

	describe('computeTabConversationStats', () => {
		it('returns zeroed stats for an empty or missing log array', () => {
			for (const input of [undefined, []]) {
				const stats = computeTabConversationStats(input);
				expect(stats.logs).toEqual([]);
				expect(stats.totalMessages).toBe(0);
				expect(stats.userMessages).toBe(0);
				expect(stats.aiMessages).toBe(0);
				expect(stats.durationMs).toBe(0);
			}
		});

		it('counts every conversation entry, not just prose', () => {
			const stats = computeTabConversationStats([
				log('user', 0),
				log('ai', 1000),
				log('tool', 2000),
				log('thinking', 3000),
				log('stdout', 4000),
			]);

			expect(stats.totalMessages).toBe(5);
			expect(stats.userMessages).toBe(1);
			expect(stats.aiMessages).toBe(2); // ai + stdout
		});

		it('drops sources that are not part of the conversation', () => {
			const stats = computeTabConversationStats([
				log('user', 0),
				log('command' as LogEntry['source'], 1000),
				log('ai', 2000),
			]);

			expect(stats.totalMessages).toBe(2);
			expect(stats.logs.map((l) => l.source)).toEqual(['user', 'ai']);
		});

		it('measures the span between the first and last conversation entry', () => {
			const stats = computeTabConversationStats([
				log('user', 0),
				log('ai', 60_000),
				log('user', 3_600_000),
			]);

			expect(stats.durationMs).toBe(3_600_000);
		});

		it('ignores dropped sources when measuring the span', () => {
			const stats = computeTabConversationStats([
				log('command' as LogEntry['source'], 0),
				log('user', 60_000),
				log('ai', 120_000),
				log('command' as LogEntry['source'], 900_000),
			]);

			expect(stats.durationMs).toBe(60_000);
		});

		it('reports a zero span for a single entry', () => {
			expect(computeTabConversationStats([log('user', 0)]).durationMs).toBe(0);
		});
	});

	describe('formatConversationDuration', () => {
		it('renders zero as 0m rather than an empty string', () => {
			expect(formatConversationDuration(0)).toBe('0m');
		});

		it('renders a real span compactly', () => {
			expect(formatConversationDuration(3_600_000)).toContain('1h');
		});
	});
});
