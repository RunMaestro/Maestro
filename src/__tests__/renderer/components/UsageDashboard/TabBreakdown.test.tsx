/**
 * Tests for TabBreakdown - the per-tab stat grid inside the agent detail modal.
 *
 * Verifies:
 * - Query events group per tab, with duration / auto% / recency aggregates
 * - Tab names resolve from open, snoozed, and recently-closed tabs, falling
 *   back to the id octet for tabs Maestro can no longer name
 * - Open tabs with no recorded queries still get a tile
 * - The Open / Last 10 / Last 25 / All filters and the four sort modes
 * - Sparklines are omitted (not flat-lined) for tabs idle beyond the window
 * - Loading and empty states
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	TabBreakdown,
	buildTabStats,
	applyTabFilter,
	sortTabStats,
} from '../../../../renderer/components/UsageDashboard/TabBreakdown';
import type { QueryEvent } from '../../../../shared/stats-types';
import type { Session } from '../../../../renderer/types';
import { createMockSession, createMockAITab } from '../../../helpers';
import { THEMES } from '../../../../shared/themes';

// TabBreakdown itself uses no icons, but the Pager it renders once the tab
// list overflows a page needs its chevrons.
vi.mock('lucide-react', () => ({
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
}));

const theme = THEMES['dracula'];

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const buildEvent = (overrides: Partial<QueryEvent> = {}): QueryEvent =>
	({
		id: 'q1',
		sessionId: 'session-1',
		agentType: 'claude-code',
		source: 'user',
		startTime: NOW - DAY,
		duration: 1000,
		tabId: 'tab-a',
		...overrides,
	}) as QueryEvent;

describe('buildTabStats', () => {
	it('groups events per tab and aggregates counts, duration, and auto share', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-a', name: 'Refactor' })],
		});
		const events: QueryEvent[] = [
			buildEvent({ id: '1', tabId: 'tab-a', duration: 1000, source: 'user' }),
			buildEvent({ id: '2', tabId: 'tab-a', duration: 3000, source: 'auto' }),
			buildEvent({ id: '3', tabId: 'tab-b', duration: 500, source: 'user' }),
		];

		const stats = buildTabStats(session, events, NOW);
		const a = stats.find((s) => s.tabId === 'tab-a')!;
		const b = stats.find((s) => s.tabId === 'tab-b')!;

		expect(a.name).toBe('Refactor');
		expect(a.queries).toBe(2);
		expect(a.totalDuration).toBe(4000);
		expect(a.avgDuration).toBe(2000);
		expect(a.autoPercent).toBe(50);
		expect(a.status).toBe('open');

		// tab-b has activity but is no longer anywhere on the session.
		expect(b.status).toBe('closed');
		expect(b.autoPercent).toBe(0);
	});

	it('ignores events with no tabId rather than bucketing them together', () => {
		const session = createMockSession();
		const events = [
			buildEvent({ id: '1', tabId: undefined }),
			buildEvent({ id: '2', tabId: undefined }),
			buildEvent({ id: '3', tabId: 'tab-a' }),
		];

		const stats = buildTabStats(session, events, NOW);
		expect(stats).toHaveLength(1);
		expect(stats[0].tabId).toBe('tab-a');
	});

	it('gives an open tab with no recorded queries a tile', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'fresh', name: 'Just opened', createdAt: NOW - 1000 })],
		});

		const stats = buildTabStats(session, [], NOW);
		expect(stats).toHaveLength(1);
		expect(stats[0].queries).toBe(0);
		expect(stats[0].autoPercent).toBeNull();
		// Falls back to creation time so recency sort still places it sensibly.
		expect(stats[0].lastActive).toBe(NOW - 1000);
	});

	it('names tabs from snoozed and recently-closed state, and falls back to the id octet', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'open-1', name: 'Open one' })],
			snoozedTabs: [
				{
					id: 'snooze-1',
					type: 'ai' as const,
					tab: createMockAITab({ id: 'sleepy', name: 'Snoozed one' }),
					unifiedIndex: 0,
					snoozedAt: NOW,
					wakeAt: NOW + DAY,
				},
			],
			closedTabHistory: [
				{ tab: createMockAITab({ id: 'gone', name: 'Closed one' }), index: 0, closedAt: NOW },
			],
		} as Partial<Session>);

		const events = [
			buildEvent({ id: '1', tabId: 'open-1' }),
			buildEvent({ id: '2', tabId: 'sleepy' }),
			buildEvent({ id: '3', tabId: 'gone' }),
			buildEvent({ id: '4', tabId: 'deadbeef-1111-2222-3333-444455556666' }),
		];

		const byId = new Map(buildTabStats(session, events, NOW).map((s) => [s.tabId, s]));

		expect(byId.get('open-1')!.name).toBe('Open one');
		expect(byId.get('open-1')!.status).toBe('open');
		expect(byId.get('sleepy')!.name).toBe('Snoozed one');
		expect(byId.get('sleepy')!.status).toBe('snoozed');
		expect(byId.get('gone')!.name).toBe('Closed one');
		expect(byId.get('gone')!.status).toBe('closed');
		// Unknown tab id renders as its first uppercase octet.
		expect(byId.get('deadbeef-1111-2222-3333-444455556666')!.name).toBe('DEADBEEF');
	});

	it('prefers live tab state when an id appears in more than one list', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'dup', name: 'Live name' })],
			closedTabHistory: [
				{ tab: createMockAITab({ id: 'dup', name: 'Stale name' }), index: 0, closedAt: NOW },
			],
		} as Partial<Session>);

		const stats = buildTabStats(session, [buildEvent({ tabId: 'dup' })], NOW);
		expect(stats[0].name).toBe('Live name');
		expect(stats[0].status).toBe('open');
	});

	it('flags the active and busy tab from live session state', () => {
		const session = createMockSession({
			activeTabId: 'tab-a',
			aiTabs: [
				createMockAITab({ id: 'tab-a', name: 'A', state: 'busy' }),
				createMockAITab({ id: 'tab-b', name: 'B', state: 'idle' }),
			],
		});

		const byId = new Map(buildTabStats(session, [], NOW).map((s) => [s.tabId, s]));
		expect(byId.get('tab-a')!.isActive).toBe(true);
		expect(byId.get('tab-a')!.isBusy).toBe(true);
		expect(byId.get('tab-b')!.isActive).toBe(false);
		expect(byId.get('tab-b')!.isBusy).toBe(false);
	});

	it('omits the sparkline for a tab with no activity in the trailing window', () => {
		const session = createMockSession();
		const recent = buildTabStats(
			session,
			[buildEvent({ tabId: 'recent', startTime: NOW - 2 * DAY })],
			NOW
		);
		const stale = buildTabStats(
			session,
			[buildEvent({ tabId: 'stale', startTime: NOW - 90 * DAY })],
			NOW
		);

		expect(recent[0].sparkline).not.toBeNull();
		expect(recent[0].sparkline!.reduce((a, b) => a + b, 0)).toBe(1);
		// A flat zero line would read as "idle right now" rather than "retired".
		expect(stale[0].sparkline).toBeNull();
	});
});

describe('applyTabFilter', () => {
	const stats = [
		{ tabId: 'o1', status: 'open', lastActive: 100 },
		{ tabId: 'c1', status: 'closed', lastActive: 500 },
		{ tabId: 'c2', status: 'closed', lastActive: 400 },
		{ tabId: 's1', status: 'snoozed', lastActive: 300 },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	] as any[];

	it('keeps only open tabs under the open filter', () => {
		expect(applyTabFilter(stats, 'open').map((s) => s.tabId)).toEqual(['o1']);
	});

	it('keeps everything under the all filter', () => {
		expect(applyTabFilter(stats, 'all')).toHaveLength(4);
	});

	it('ranks by recency when limiting, not by list position', () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			tabId: `t${i}`,
			status: 'closed',
			lastActive: i,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		})) as any[];

		const ten = applyTabFilter(many, 'recent10');
		expect(ten).toHaveLength(10);
		expect(ten[0].tabId).toBe('t29');
		expect(ten[9].tabId).toBe('t20');
		expect(applyTabFilter(many, 'recent25')).toHaveLength(25);
	});
});

describe('sortTabStats', () => {
	const stats = [
		{ tabId: 'a', name: 'Zulu', queries: 1, totalDuration: 900, lastActive: 10 },
		{ tabId: 'b', name: 'Alpha', queries: 9, totalDuration: 100, lastActive: 30 },
		{ tabId: 'c', name: 'Mike', queries: 5, totalDuration: 500, lastActive: 20 },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	] as any[];

	it('sorts by recency, queries, duration, and name', () => {
		expect(sortTabStats(stats, 'recent').map((s) => s.tabId)).toEqual(['b', 'c', 'a']);
		expect(sortTabStats(stats, 'queries').map((s) => s.tabId)).toEqual(['b', 'c', 'a']);
		expect(sortTabStats(stats, 'duration').map((s) => s.tabId)).toEqual(['a', 'c', 'b']);
		expect(sortTabStats(stats, 'name').map((s) => s.tabId)).toEqual(['b', 'c', 'a']);
	});

	it('does not mutate the input array', () => {
		const order = stats.map((s) => s.tabId);
		sortTabStats(stats, 'duration');
		expect(stats.map((s) => s.tabId)).toEqual(order);
	});
});

describe('TabBreakdown', () => {
	const renderBreakdown = (session: Session, events: QueryEvent[] | null) =>
		render(<TabBreakdown session={session} theme={theme} events={events} now={NOW} />);

	it('shows a loading state until the events arrive', () => {
		renderBreakdown(createMockSession(), null);
		expect(screen.getByText('Loading…')).toBeInTheDocument();
		expect(screen.queryByTestId('tab-breakdown-grid')).toBeNull();
	});

	it('reports when the agent has no tab-level activity at all', () => {
		renderBreakdown(createMockSession(), []);
		expect(screen.getByText('No tab-level activity recorded for this agent.')).toBeInTheDocument();
	});

	it('renders one tile per open tab by default', () => {
		const session = createMockSession({
			aiTabs: [
				createMockAITab({ id: 'tab-a', name: 'Alpha' }),
				createMockAITab({ id: 'tab-b', name: 'Beta' }),
			],
		});
		const events = [
			buildEvent({ id: '1', tabId: 'tab-a' }),
			buildEvent({ id: '2', tabId: 'retired' }),
		];

		renderBreakdown(session, events);

		const names = screen.getAllByTestId('tab-card').map((c) => c.textContent);
		expect(names).toHaveLength(2);
		expect(names.join(' ')).toContain('Alpha');
		expect(names.join(' ')).toContain('Beta');
		expect(names.join(' ')).not.toContain('RETIRED');
		expect(screen.getByTestId('tab-breakdown-count').textContent).toBe('2 of 3');
	});

	it('widens to retired tabs when the filter changes to All', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-a', name: 'Alpha' })],
		});
		const events = [
			buildEvent({ id: '1', tabId: 'tab-a' }),
			buildEvent({ id: '2', tabId: 'deadbeef-1111-2222-3333-444455556666' }),
		];

		renderBreakdown(session, events);
		expect(screen.getAllByTestId('tab-card')).toHaveLength(1);

		fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));

		expect(screen.getAllByTestId('tab-card')).toHaveLength(2);
		expect(screen.getByTestId('tab-breakdown-count').textContent).toBe('2 of 2');
	});

	it('reorders tiles when the sort changes', () => {
		const session = createMockSession({
			aiTabs: [
				createMockAITab({ id: 'busy-tab', name: 'Busy' }),
				createMockAITab({ id: 'quiet-tab', name: 'Quiet' }),
			],
		});
		const events = [
			// Quiet is the more recent, Busy has more queries.
			buildEvent({ id: '1', tabId: 'busy-tab', startTime: NOW - 5 * DAY }),
			buildEvent({ id: '2', tabId: 'busy-tab', startTime: NOW - 5 * DAY }),
			buildEvent({ id: '3', tabId: 'quiet-tab', startTime: NOW - DAY }),
		];

		renderBreakdown(session, events);
		expect(screen.getAllByTestId('tab-card')[0].textContent).toContain('Quiet');

		fireEvent.click(screen.getByTestId('tab-breakdown-sort-queries'));
		expect(screen.getAllByTestId('tab-card')[0].textContent).toContain('Busy');

		fireEvent.click(screen.getByTestId('tab-breakdown-sort-name'));
		expect(screen.getAllByTestId('tab-card')[0].textContent).toContain('Busy');
	});

	it('points at the wider filters when the agent has no open tabs', () => {
		const session = createMockSession({ aiTabs: [] });
		renderBreakdown(session, [buildEvent({ tabId: 'retired' })]);

		expect(screen.queryAllByTestId('tab-card')).toHaveLength(0);
		expect(screen.getByTestId('tab-breakdown-empty').textContent).toContain('Last 10');
	});

	describe('pagination', () => {
		/**
		 * N retired tabs, newest first by construction. The ids deliberately
		 * carry no dash: the unknown-tab label takes everything before the first
		 * one, so `tab-1` and `tab-2` would both render as "TAB" and the tests
		 * could not tell one page from the next.
		 */
		const manyEvents = (n: number): QueryEvent[] =>
			Array.from({ length: n }, (_, i) =>
				buildEvent({
					id: `e${i}`,
					tabId: `tabid${String(i).padStart(3, '0')}`,
					startTime: NOW - i * 1000,
				})
			);

		it('leaves the pager off when everything fits on one page', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, manyEvents(20));
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));

			expect(screen.getAllByTestId('tab-card')).toHaveLength(20);
			expect(screen.queryByTestId('tab-breakdown-pager')).toBeNull();
			expect(screen.getByTestId('tab-breakdown-count').textContent).toBe('20 of 20');
		});

		it('caps the grid at one page and shows the pager once it overflows', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, manyEvents(100));
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));

			expect(screen.getAllByTestId('tab-card')).toHaveLength(32);
			expect(screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('1 / 4');
			expect(screen.getByTestId('tab-breakdown-count').textContent).toBe('1-32 of 100');
		});

		it('walks pages and renders a short final page', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, manyEvents(100));
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));

			const firstTitle = screen.getAllByTestId('tab-card')[0].textContent;

			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			expect(screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('2 / 4');
			expect(screen.getByTestId('tab-breakdown-count').textContent).toBe('33-64 of 100');
			expect(screen.getAllByTestId('tab-card')[0].textContent).not.toBe(firstTitle);

			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			expect(screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('4 / 4');
			// 100 items over 32-per-page leaves 4 on the last page.
			expect(screen.getAllByTestId('tab-card')).toHaveLength(4);
			expect(screen.getByTestId('tab-breakdown-count').textContent).toBe('97-100 of 100');

			fireEvent.click(screen.getByTestId('tab-breakdown-pager-prev'));
			expect(screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('3 / 4');
		});

		it('disables the edges rather than wrapping around', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, manyEvents(100));
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));

			expect(screen.getByTestId('tab-breakdown-pager-prev')).toBeDisabled();

			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			expect(screen.getByTestId('tab-breakdown-pager-next')).toBeDisabled();
		});

		it('returns to page 1 when the sort changes', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, manyEvents(100));
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));
			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));
			expect(screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('2 / 4');

			// Page 2 of a brand-new ordering is an arbitrary slice, so the pager
			// snaps back rather than leaving the user mid-list.
			fireEvent.click(screen.getByTestId('tab-breakdown-sort-name'));
			expect(screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('1 / 4');
		});

		it('drops the pager entirely when a narrower filter fits on one page', () => {
			const session = createMockSession({
				aiTabs: [createMockAITab({ id: 'tabid000', name: 'Still open' })],
			});
			renderBreakdown(session, manyEvents(100));
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));
			fireEvent.click(screen.getByTestId('tab-breakdown-pager-next'));

			// Narrowing from 100 tabs on page 2 down to a single open tab must not
			// strand the grid on a page that no longer exists.
			fireEvent.click(screen.getByTestId('tab-breakdown-filter-open'));
			expect(screen.queryByTestId('tab-breakdown-pager')).toBeNull();
			expect(screen.getAllByTestId('tab-card')).toHaveLength(1);
			expect(screen.getByTestId('tab-card').textContent).toContain('Still open');
		});

		it('never paginates the bounded filters', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, manyEvents(100));

			fireEvent.click(screen.getByTestId('tab-breakdown-filter-recent10'));
			expect(screen.queryByTestId('tab-breakdown-pager')).toBeNull();
			expect(screen.getAllByTestId('tab-card')).toHaveLength(10);

			fireEvent.click(screen.getByTestId('tab-breakdown-filter-recent25'));
			expect(screen.queryByTestId('tab-breakdown-pager')).toBeNull();
			expect(screen.getAllByTestId('tab-card')).toHaveLength(25);
		});
	});

	it('badges the active tab and marks a snoozed one', () => {
		const session = createMockSession({
			activeTabId: 'tab-a',
			aiTabs: [createMockAITab({ id: 'tab-a', name: 'Alpha' })],
			snoozedTabs: [
				{
					id: 'snooze-1',
					type: 'ai' as const,
					tab: createMockAITab({ id: 'sleepy', name: 'Sleepy' }),
					unifiedIndex: 0,
					snoozedAt: NOW,
					wakeAt: NOW + DAY,
				},
			],
		} as Partial<Session>);

		renderBreakdown(session, [
			buildEvent({ id: '1', tabId: 'tab-a' }),
			buildEvent({ id: '2', tabId: 'sleepy' }),
		]);

		expect(screen.getByTestId('tab-card-active-badge')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('tab-breakdown-filter-all'));
		expect(screen.getByTestId('tab-card-snoozed-badge')).toBeInTheDocument();
	});

	it('shows a dim placeholder rather than 0% for a tab with no queries', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'fresh', name: 'Fresh' })],
		});
		renderBreakdown(session, [buildEvent({ tabId: 'other' })]);

		expect(screen.getByTestId('tab-card-auto-pct').textContent).toBe('—');
		expect(screen.getByTestId('tab-card-query-count').textContent).toBe('0');
	});
});
