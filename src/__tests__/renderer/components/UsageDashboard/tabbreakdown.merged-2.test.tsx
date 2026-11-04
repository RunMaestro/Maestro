// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/UsageDashboard/TabBreakdown.test.tsx
// Source: src/__tests__/renderer/components/UsageDashboard/AgentComparisonChart.test.tsx
import { describe, it, expect, vi } from 'vitest';
import {
	render as s1_render,
	screen as s1_screen,
	fireEvent as s1_fireEvent,
} from '@testing-library/react';
import {
	TabBreakdown,
	buildTabStats,
	applyTabFilter,
	sortTabStats,
} from '../../../../renderer/components/UsageDashboard/TabBreakdown';
import type { QueryEvent } from '../../../../shared/stats-types';
import type { Session as S1_Session } from '../../../../renderer/types';
import { createMockSession, createMockAITab } from '../../../helpers';
import { THEMES as S1_THEMES } from '../../../../shared/themes';
import {
	render as s2_render,
	screen as s2_screen,
	fireEvent as s2_fireEvent,
} from '@testing-library/react';
import React from 'react';
import { AgentComparisonChart } from '../../../../renderer/components/UsageDashboard/AgentComparisonChart';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session as S2_Session } from '../../../../renderer/types';
import { THEMES as S2_THEMES } from '../../../../shared/themes';
// TabBreakdown itself uses no icons, but its sortable headers need the sort
// carets and the Pager it renders once the tab list overflows a page needs its
// chevrons.
vi.mock('lucide-react', () => ({
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
	ChevronDown: () => <span data-testid="chevron-down" />,
	ChevronUp: () => <span data-testid="chevron-up" />,
}));
// Source: src/__tests__/renderer/components/UsageDashboard/TabBreakdown.test.tsx
describe('', () => {
	const theme = S1_THEMES['dracula'];
	const NOW = 1800000000000;
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
		it('gives an open tab with no recorded queries a row', () => {
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
			} as Partial<S1_Session>);
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
			} as Partial<S1_Session>);
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
			{ tabId: 'a', name: 'Zulu', queries: 1, totalDuration: 900, lastActive: 10, autoPercent: 50 },
			{ tabId: 'b', name: 'Alpha', queries: 9, totalDuration: 100, lastActive: 30, autoPercent: 0 },
			{ tabId: 'c', name: 'Mike', queries: 5, totalDuration: 500, lastActive: 20, autoPercent: 90 },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		] as any[];
		it('sorts by each column in its natural default direction', () => {
			expect(sortTabStats(stats, 'recent').map((s) => s.tabId)).toEqual(['b', 'c', 'a']);
			expect(sortTabStats(stats, 'queries').map((s) => s.tabId)).toEqual(['b', 'c', 'a']);
			expect(sortTabStats(stats, 'duration').map((s) => s.tabId)).toEqual(['a', 'c', 'b']);
			expect(sortTabStats(stats, 'auto').map((s) => s.tabId)).toEqual(['c', 'a', 'b']);
			expect(sortTabStats(stats, 'name').map((s) => s.tabId)).toEqual(['b', 'c', 'a']);
		});
		it('reverses when asked for the other direction', () => {
			expect(sortTabStats(stats, 'queries', 'asc').map((s) => s.tabId)).toEqual(['a', 'c', 'b']);
			expect(sortTabStats(stats, 'recent', 'asc').map((s) => s.tabId)).toEqual(['a', 'c', 'b']);
			expect(sortTabStats(stats, 'name', 'desc').map((s) => s.tabId)).toEqual(['a', 'c', 'b']);
		});
		it('sinks tabs with no recorded auto share in both directions', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const withNulls = [...stats, { tabId: 'none', name: 'None', autoPercent: null }] as any[];
			expect(
				sortTabStats(withNulls, 'auto')
					.map((s) => s.tabId)
					.at(-1)
			).toBe('none');
			expect(
				sortTabStats(withNulls, 'auto', 'asc')
					.map((s) => s.tabId)
					.at(-1)
			).toBe('none');
		});
		it('does not mutate the input array', () => {
			const order = stats.map((s) => s.tabId);
			sortTabStats(stats, 'duration');
			expect(stats.map((s) => s.tabId)).toEqual(order);
		});
	});
	describe('TabBreakdown', () => {
		const renderBreakdown = (session: S1_Session, events: QueryEvent[] | null) =>
			s1_render(<TabBreakdown session={session} theme={theme} events={events} now={NOW} />);
		it('shows a loading state until the events arrive', () => {
			renderBreakdown(createMockSession(), null);
			expect(s1_screen.getByText('Loading…')).toBeInTheDocument();
			expect(s1_screen.queryByTestId('tab-breakdown-table')).toBeNull();
		});
		it('reports when the agent has no tab-level activity at all', () => {
			renderBreakdown(createMockSession(), []);
			expect(
				s1_screen.getByText('No tab-level activity recorded for this agent.')
			).toBeInTheDocument();
		});
		it('renders one row per open tab by default', () => {
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
			const names = s1_screen.getAllByTestId('tab-row').map((c) => c.textContent);
			expect(names).toHaveLength(2);
			expect(names.join(' ')).toContain('Alpha');
			expect(names.join(' ')).toContain('Beta');
			expect(names.join(' ')).not.toContain('RETIRED');
			expect(s1_screen.getByTestId('tab-breakdown-count').textContent).toBe('2 of 3');
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
			expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(1);
			s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
			expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(2);
			expect(s1_screen.getByTestId('tab-breakdown-count').textContent).toBe('2 of 2');
		});
		it('reorders rows when a column header is clicked', () => {
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
			expect(s1_screen.getAllByTestId('tab-row')[0].textContent).toContain('Quiet');
			s1_fireEvent.click(s1_screen.getByTitle('Sort by query count'));
			expect(s1_screen.getAllByTestId('tab-row')[0].textContent).toContain('Busy');
			s1_fireEvent.click(s1_screen.getByTitle('Sort alphabetically'));
			expect(s1_screen.getAllByTestId('tab-row')[0].textContent).toContain('Busy');
		});
		it('flips the active column and switches to a new column default direction', () => {
			const session = createMockSession({
				aiTabs: [
					createMockAITab({ id: 'busy-tab', name: 'Busy' }),
					createMockAITab({ id: 'quiet-tab', name: 'Quiet' }),
				],
			});
			const events = [
				buildEvent({ id: '1', tabId: 'busy-tab', startTime: NOW - 5 * DAY }),
				buildEvent({ id: '2', tabId: 'busy-tab', startTime: NOW - 5 * DAY }),
				buildEvent({ id: '3', tabId: 'quiet-tab', startTime: NOW - DAY }),
			];
			const firstRow = () => s1_screen.getAllByTestId('tab-row')[0].textContent;
			renderBreakdown(session, events);
			// Recency starts descending; clicking it again reverses that column.
			expect(s1_screen.getByTestId('tab-breakdown-sort-recent')).toHaveAttribute(
				'aria-sort',
				'descending'
			);
			s1_fireEvent.click(s1_screen.getByTitle('Sort by recency'));
			expect(s1_screen.getByTestId('tab-breakdown-sort-recent')).toHaveAttribute(
				'aria-sort',
				'ascending'
			);
			expect(firstRow()).toContain('Busy');
			// Switching to a text column takes that column's own default (A-Z)
			// rather than inheriting the ascending state from recency.
			s1_fireEvent.click(s1_screen.getByTitle('Sort alphabetically'));
			expect(s1_screen.getByTestId('tab-breakdown-sort-name')).toHaveAttribute(
				'aria-sort',
				'ascending'
			);
			expect(s1_screen.getByTestId('tab-breakdown-sort-recent')).toHaveAttribute(
				'aria-sort',
				'none'
			);
			expect(firstRow()).toContain('Busy');
		});
		it('points at the wider filters when the agent has no open tabs', () => {
			const session = createMockSession({ aiTabs: [] });
			renderBreakdown(session, [buildEvent({ tabId: 'retired' })]);
			expect(s1_screen.queryAllByTestId('tab-row')).toHaveLength(0);
			expect(s1_screen.getByTestId('tab-breakdown-empty').textContent).toContain('Last 10');
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
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
				expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(20);
				expect(s1_screen.queryByTestId('tab-breakdown-pager')).toBeNull();
				expect(s1_screen.getByTestId('tab-breakdown-count').textContent).toBe('20 of 20');
			});
			it('caps the list at one page and shows the pager once it overflows', () => {
				const session = createMockSession({ aiTabs: [] });
				renderBreakdown(session, manyEvents(100));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
				expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(32);
				expect(s1_screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('1 / 4');
				expect(s1_screen.getByTestId('tab-breakdown-count').textContent).toBe('1-32 of 100');
			});
			it('walks pages and renders a short final page', () => {
				const session = createMockSession({ aiTabs: [] });
				renderBreakdown(session, manyEvents(100));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
				const firstTitle = s1_screen.getAllByTestId('tab-row')[0].textContent;
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('2 / 4');
				expect(s1_screen.getByTestId('tab-breakdown-count').textContent).toBe('33-64 of 100');
				expect(s1_screen.getAllByTestId('tab-row')[0].textContent).not.toBe(firstTitle);
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('4 / 4');
				// 100 items over 32-per-page leaves 4 on the last page.
				expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(4);
				expect(s1_screen.getByTestId('tab-breakdown-count').textContent).toBe('97-100 of 100');
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-prev'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('3 / 4');
			});
			it('disables the edges rather than wrapping around', () => {
				const session = createMockSession({ aiTabs: [] });
				renderBreakdown(session, manyEvents(100));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-prev')).toBeDisabled();
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-next')).toBeDisabled();
			});
			it('returns to page 1 when the sort changes', () => {
				const session = createMockSession({ aiTabs: [] });
				renderBreakdown(session, manyEvents(100));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('2 / 4');
				// Page 2 of a brand-new ordering is an arbitrary slice, so the pager
				// snaps back rather than leaving the user mid-list.
				s1_fireEvent.click(s1_screen.getByTitle('Sort alphabetically'));
				expect(s1_screen.getByTestId('tab-breakdown-pager-label').textContent).toBe('1 / 4');
			});
			it('drops the pager entirely when a narrower filter fits on one page', () => {
				const session = createMockSession({
					aiTabs: [createMockAITab({ id: 'tabid000', name: 'Still open' })],
				});
				renderBreakdown(session, manyEvents(100));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-pager-next'));
				// Narrowing from 100 tabs on page 2 down to a single open tab must not
				// strand the list on a page that no longer exists.
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-open'));
				expect(s1_screen.queryByTestId('tab-breakdown-pager')).toBeNull();
				expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(1);
				expect(s1_screen.getByTestId('tab-row').textContent).toContain('Still open');
			});
			it('never paginates the bounded filters', () => {
				const session = createMockSession({ aiTabs: [] });
				renderBreakdown(session, manyEvents(100));
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-recent10'));
				expect(s1_screen.queryByTestId('tab-breakdown-pager')).toBeNull();
				expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(10);
				s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-recent25'));
				expect(s1_screen.queryByTestId('tab-breakdown-pager')).toBeNull();
				expect(s1_screen.getAllByTestId('tab-row')).toHaveLength(25);
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
			} as Partial<S1_Session>);
			renderBreakdown(session, [
				buildEvent({ id: '1', tabId: 'tab-a' }),
				buildEvent({ id: '2', tabId: 'sleepy' }),
			]);
			expect(s1_screen.getByTestId('tab-row-active-badge')).toBeInTheDocument();
			s1_fireEvent.click(s1_screen.getByTestId('tab-breakdown-filter-all'));
			expect(s1_screen.getByTestId('tab-row-snoozed-badge')).toBeInTheDocument();
		});
		it('shows a dim placeholder rather than 0% for a tab with no queries', () => {
			const session = createMockSession({
				aiTabs: [createMockAITab({ id: 'fresh', name: 'Fresh' })],
			});
			renderBreakdown(session, [buildEvent({ tabId: 'other' })]);
			expect(s1_screen.getByTestId('tab-row-auto-pct').textContent).toBe('—');
			expect(s1_screen.getByTestId('tab-row-query-count').textContent).toBe('0');
		});
	});
});
// Source: src/__tests__/renderer/components/UsageDashboard/AgentComparisonChart.test.tsx
describe('', () => {
	let _sessionIdCounter = 0;
	function makeSession(overrides: Partial<S2_Session> = {}): S2_Session {
		_sessionIdCounter++;
		return {
			id: `s${_sessionIdCounter}`,
			name: `Session ${_sessionIdCounter}`,
			toolType: 'claude-code',
			state: 'idle',
			cwd: '/tmp',
			fullPath: '/tmp',
			projectRoot: '/tmp',
			aiLogs: [],
			shellLogs: [],
			workLog: [],
			contextUsage: 0,
			inputMode: 'ai',
			aiPid: 0,
			terminalPid: 0,
			port: 0,
			isLive: false,
			changedFiles: [],
			isGitRepo: false,
			fileTree: [],
			fileExplorerExpanded: [],
			fileExplorerScrollPos: 0,
			createdAt: 0,
			...overrides,
		} as S2_Session;
	}
	// Test theme
	const theme = S2_THEMES['dracula'];
	// Sample data for testing
	const mockData: StatsAggregation = {
		totalQueries: 50,
		totalDuration: 3600000, // 1 hour
		avgDuration: 72000, // 72 seconds
		byAgent: {
			'claude-code': { count: 30, duration: 2000000 },
			'factory-droid': { count: 20, duration: 1600000 },
			terminal: { count: 10, duration: 500000 },
		},
		bySource: { user: 35, auto: 15 },
		byDay: [
			{ date: '2024-12-20', count: 5, duration: 300000 },
			{ date: '2024-12-21', count: 10, duration: 600000 },
		],
	};
	// Data with single agent
	const singleAgentData: StatsAggregation = {
		totalQueries: 20,
		totalDuration: 1000000,
		avgDuration: 50000,
		byAgent: {
			'claude-code': { count: 20, duration: 1000000 },
		},
		bySource: { user: 20, auto: 0 },
		byDay: [],
	};
	// Data with many agents
	const manyAgentsData: StatsAggregation = {
		totalQueries: 100,
		totalDuration: 5000000,
		avgDuration: 50000,
		byAgent: {
			'claude-code': { count: 30, duration: 1500000 },
			'factory-droid': { count: 25, duration: 1200000 },
			terminal: { count: 15, duration: 800000 },
			opencode: { count: 12, duration: 600000 },
			gemini: { count: 10, duration: 500000 },
			codex: { count: 5, duration: 250000 },
			qwen: { count: 3, duration: 150000 },
		},
		bySource: { user: 70, auto: 30 },
		byDay: [],
	};
	// Empty data for edge case testing
	const emptyData: StatsAggregation = {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [],
	};
	describe('AgentComparisonChart', () => {
		describe('Rendering', () => {
			it('renders the component with title', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				expect(s2_screen.getByText('Provider Comparison')).toBeInTheDocument();
			});
			it('renders count and duration labels for each agent', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Component now shows both count and duration for each agent (no toggle)
				// Check that query count labels are present
				expect(s2_screen.getAllByText(/queries/).length).toBeGreaterThan(0);
				// Check that duration is displayed (e.g., "33m 20s" for claude-code)
				expect(s2_screen.getByText('33m 20s')).toBeInTheDocument();
			});
			it('renders agent names', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Without sessions, raw agent type keys are prettified via
				// AGENT_DISPLAY_NAMES (e.g. "claude-code" → "Claude Code").
				// Use getAllByText since names appear in both bar labels and legend.
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Terminal').length).toBeGreaterThanOrEqual(1);
			});
			it('renders with empty data showing message', () => {
				s2_render(<AgentComparisonChart data={emptyData} theme={theme} />);
				expect(s2_screen.getByText('No agent data available')).toBeInTheDocument();
			});
			it('renders single agent correctly', () => {
				s2_render(<AgentComparisonChart data={singleAgentData} theme={theme} />);
				// Use getAllByText since agent name appears in both bar label and legend
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
				// Single agent should show 100%
				expect(s2_screen.getByText('100.0%')).toBeInTheDocument();
			});
		});
		describe('Unified Count and Duration Display', () => {
			it('shows both count and duration for each agent', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Should show duration for claude-code: 2000000ms = 33m 20s
				expect(s2_screen.getByText('33m 20s')).toBeInTheDocument();
				// Should show count values - multiple "queries" labels will be present for multiple agents
				expect(s2_screen.getAllByText(/queries/).length).toBeGreaterThan(0);
			});
			it('shows query count label for single query', () => {
				const singleQueryData: StatsAggregation = {
					...singleAgentData,
					byAgent: {
						'claude-code': { count: 1, duration: 1000000 },
					},
				};
				s2_render(<AgentComparisonChart data={singleQueryData} theme={theme} />);
				// Should show "query" for count of 1 (singular form)
				expect(s2_screen.getByText(/1 query$/)).toBeInTheDocument();
			});
			it('shows formatted count with queries label', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// claude-code has 30 queries - should be displayed with "queries" suffix
				// Multiple agents have "queries" label, so use getAllByText
				const queryLabels = s2_screen.getAllByText(/\d+ queries/);
				expect(queryLabels.length).toBeGreaterThan(0);
			});
		});
		describe('Bar Sorting', () => {
			it('sorts bars by value descending', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Get all agent name labels
				const agentLabels = container.querySelectorAll('[data-testid="bar-chart-label"]');
				const agentNames = Array.from(agentLabels).map((el) => el.textContent);
				// Bars are sorted by duration: claude-code (2000000) > factory-droid
				// (1600000) > terminal (500000). Labels are prettified by buildNameMap.
				expect(agentNames[0]).toBe('Claude Code');
				expect(agentNames[1]).toBe('Factory Droid');
				expect(agentNames[2]).toBe('Terminal');
			});
		});
		describe('Percentage Labels', () => {
			it('shows percentage labels on bars', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Should have percentage labels for each agent
				// Total duration is 4100000, claude-code is 2000000 = ~48.8%
				// Using regex to find percentage patterns
				const percentages = s2_screen.getAllByText(/\d+\.\d+%/);
				expect(percentages.length).toBeGreaterThan(0);
			});
		});
		describe('Agent Colors', () => {
			it('assigns distinct colors to different agents', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Find the bar fill divs (with h-full, rounded, and flex classes - the actual colored bars)
				// These bars now use inline styles for transitions instead of Tailwind classes
				const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
				const colors = Array.from(bars)
					.map((bar) => (bar as HTMLElement).style.backgroundColor)
					.filter((c) => c !== '');
				// Should have 3 bars with colors
				expect(colors.length).toBe(3);
				// Should have different colors for each agent
				expect(new Set(colors).size).toBe(colors.length);
			});
		});
		describe('Legend', () => {
			it('shows legend with agent colors', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Legend should have color indicators
				const legendItems = container.querySelectorAll('.w-2\\.5.h-2\\.5.rounded-sm');
				expect(legendItems.length).toBeGreaterThan(0);
			});
			it('shows +N more when there are many agents', () => {
				s2_render(<AgentComparisonChart data={manyAgentsData} theme={theme} />);
				// With 7 agents, should show 6 in legend and "+1 more"
				expect(s2_screen.getByText('+1 more')).toBeInTheDocument();
			});
			it('does not show legend with empty data', () => {
				const { container } = s2_render(<AgentComparisonChart data={emptyData} theme={theme} />);
				// No legend items should be present
				const legendItems = container.querySelectorAll('.w-2\\.5.h-2\\.5.rounded-sm');
				expect(legendItems.length).toBe(0);
			});
		});
		describe('Tooltip Functionality', () => {
			it('shows tooltip on bar hover', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Find the first bar row
				const barRows = container.querySelectorAll('[role="listitem"]');
				if (barRows.length > 0) {
					s2_fireEvent.mouseEnter(barRows[0]);
					// Tooltip should appear
					// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
					const tooltip = document.body.querySelector('div.fixed.pointer-events-none');
					expect(tooltip).toBeInTheDocument();
				}
			});
			it('hides tooltip on mouse leave', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const barRows = container.querySelectorAll('[role="listitem"]');
				if (barRows.length > 0) {
					s2_fireEvent.mouseEnter(barRows[0]);
					s2_fireEvent.mouseLeave(barRows[0]);
					// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
					const tooltip = document.body.querySelector('div.fixed.pointer-events-none');
					expect(tooltip).not.toBeInTheDocument();
				}
			});
			it('tooltip shows query count and duration', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const barRows = container.querySelectorAll('[role="listitem"]');
				if (barRows.length > 0) {
					s2_fireEvent.mouseEnter(barRows[0]);
					// Tooltip should contain queries text and total text
					// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
					const tooltip = document.body.querySelector('div.fixed.pointer-events-none');
					expect(tooltip?.textContent).toContain('queries');
					expect(tooltip?.textContent).toContain('total');
				}
			});
		});
		describe('Theme Support', () => {
			it('applies theme background color', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const wrapper = container.firstChild as HTMLElement;
				expect(wrapper).toHaveStyle({
					backgroundColor: theme.colors.bgMain,
				});
			});
			it('applies theme text colors', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const title = s2_screen.getByText('Provider Comparison');
				expect(title).toHaveStyle({
					color: theme.colors.textMain,
				});
			});
			it('works with light theme', () => {
				const lightTheme = S2_THEMES['github-light'];
				s2_render(<AgentComparisonChart data={mockData} theme={lightTheme} />);
				expect(s2_screen.getByText('Provider Comparison')).toBeInTheDocument();
			});
			it('applies border colors from theme', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Legend container should have border-top
				const legendContainer = container.querySelector('.flex.flex-wrap.gap-3.mt-4.pt-3.border-t');
				expect(legendContainer).toHaveStyle({
					borderColor: theme.colors.border,
				});
			});
		});
		describe('Value Formatting', () => {
			it('formats duration values correctly', () => {
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// claude-code duration: 2000000ms = 33m 20s
				expect(s2_screen.getByText('33m 20s')).toBeInTheDocument();
			});
			it('formats large count values with K suffix', () => {
				const largeCountData: StatsAggregation = {
					...mockData,
					byAgent: {
						'claude-code': { count: 1500, duration: 100000 },
					},
				};
				s2_render(<AgentComparisonChart data={largeCountData} theme={theme} />);
				// 1500 should be formatted as 1.5K (now shown alongside duration, no toggle needed)
				expect(s2_screen.getByText(/1\.5K/)).toBeInTheDocument();
			});
			it('formats hours correctly', () => {
				const longDurationData: StatsAggregation = {
					...mockData,
					byAgent: {
						'claude-code': { count: 10, duration: 7200000 }, // 2 hours
					},
				};
				s2_render(<AgentComparisonChart data={longDurationData} theme={theme} />);
				expect(s2_screen.getByText('2h 0m')).toBeInTheDocument();
			});
		});
		describe('Bar Width Calculation', () => {
			it('highest value agent has full width bar', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Find the first bar (should be claude-code with highest duration)
				// Bars have h-full, rounded, and flex classes with inline transition styles
				const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
				if (bars.length > 0) {
					const firstBar = bars[0] as HTMLElement;
					// Should have close to 100% width
					expect(firstBar.style.width).toBe('100%');
				}
			});
		});
		describe('Hover State', () => {
			it('highlights agent name on hover', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const barRows = container.querySelectorAll('[role="listitem"]');
				if (barRows.length > 0) {
					const agentLabel = barRows[0].querySelector('[data-testid="bar-chart-label"]');
					// Before hover, should have textDim color
					expect(agentLabel).toHaveStyle({
						color: theme.colors.textDim,
					});
					s2_fireEvent.mouseEnter(barRows[0]);
					// After hover, should have textMain color
					expect(agentLabel).toHaveStyle({
						color: theme.colors.textMain,
					});
				}
			});
		});
		describe('Smooth Animations', () => {
			it('applies CSS transitions to bars for smooth width changes', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				// Find bar elements - they have h-full, rounded, and flex classes
				const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
				expect(bars.length).toBeGreaterThan(0);
				const firstBar = bars[0] as HTMLElement;
				expect(firstBar.style.transition).toContain('width');
				expect(firstBar.style.transition).toContain('0.5s');
			});
			it('uses cubic-bezier easing for smooth animation curves', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
				expect(bars.length).toBeGreaterThan(0);
				const firstBar = bars[0] as HTMLElement;
				expect(firstBar.style.transition).toContain('cubic-bezier');
			});
			it('applies opacity transition for hover effects', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const bars = container.querySelectorAll('.h-full.rounded.flex.items-center');
				expect(bars.length).toBeGreaterThan(0);
				const firstBar = bars[0] as HTMLElement;
				expect(firstBar.style.transition).toContain('opacity');
			});
		});
		describe('Worktree Differentiation', () => {
			it('splits worktree agents into separate bars and tags them with "(Worktree)"', () => {
				const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
				const worktree = makeSession({
					id: 'wt-1',
					toolType: 'claude-code',
					parentSessionId: 'parent',
				});
				const dataWithSessions: StatsAggregation = {
					...mockData,
					bySessionByDay: {
						parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
						'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
					},
				};
				s2_render(
					<AgentComparisonChart
						data={dataWithSessions}
						theme={theme}
						sessions={[parent, worktree]}
					/>
				);
				// Two sessions share toolType "claude-code" so resolveAgentDisplayName
				// falls back to the prettified type name. Labels appear in both the
				// bar row and the legend.
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Claude Code (Worktree)').length).toBeGreaterThanOrEqual(1);
			});
			it('renders the Agent vs Worktree Agent legend when worktrees are present', () => {
				const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
				const worktree = makeSession({
					id: 'wt-1',
					toolType: 'claude-code',
					parentSessionId: 'parent',
				});
				const dataWithSessions: StatsAggregation = {
					...mockData,
					bySessionByDay: {
						parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
						'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
					},
				};
				const { container } = s2_render(
					<AgentComparisonChart
						data={dataWithSessions}
						theme={theme}
						sessions={[parent, worktree]}
					/>
				);
				const legendBlock = container.querySelector(
					'[aria-label="Worktree differentiation legend"]'
				);
				expect(legendBlock).not.toBeNull();
				expect(legendBlock?.textContent).toContain('Agent');
				expect(legendBlock?.textContent).toContain('Worktree Agent');
			});
			it('does not render the worktree legend when no worktree sessions exist', () => {
				const regular = makeSession({ id: 'reg', toolType: 'claude-code' });
				const dataWithSessions: StatsAggregation = {
					...mockData,
					bySessionByDay: {
						reg: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
					},
				};
				const { container } = s2_render(
					<AgentComparisonChart data={dataWithSessions} theme={theme} sessions={[regular]} />
				);
				expect(
					container.querySelector('[aria-label="Worktree differentiation legend"]')
				).toBeNull();
			});
			it('falls back to byAgent aggregation when sessions prop is not provided', () => {
				// Without sessions, no worktree info - should render exactly the
				// providers in byAgent without "(Worktree)" suffixes.
				s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				expect(s2_screen.queryByText(/\(Worktree\)/)).not.toBeInTheDocument();
			});
		});
		describe('Drill-Down Filtering', () => {
			// `[role="listitem"]` targets the outer bar row only; the inner count/
			// duration labels have no role.
			const BAR_ROW_SELECTOR = '[role="listitem"][aria-label]';
			it('does not set cursor pointer or tabIndex when onAgentClick is not provided', () => {
				const { container } = s2_render(<AgentComparisonChart data={mockData} theme={theme} />);
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				expect(barRows.length).toBeGreaterThan(0);
				const firstRow = barRows[0] as HTMLElement;
				expect(firstRow.style.cursor).toBe('');
				expect(firstRow.getAttribute('tabIndex')).toBeNull();
			});
			it('sets cursor pointer and tabIndex when onAgentClick is provided', () => {
				const onAgentClick = vi.fn();
				const { container } = s2_render(
					<AgentComparisonChart data={mockData} theme={theme} onAgentClick={onAgentClick} />
				);
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				const firstRow = barRows[0] as HTMLElement;
				expect(firstRow.style.cursor).toBe('pointer');
				expect(firstRow.getAttribute('tabIndex')).toBe('0');
			});
			it('fires onAgentClick with the bar key and resolved label on click', () => {
				const onAgentClick = vi.fn();
				const { container } = s2_render(
					<AgentComparisonChart data={mockData} theme={theme} onAgentClick={onAgentClick} />
				);
				// Bars are sorted by duration desc → claude-code is first.
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				s2_fireEvent.click(barRows[0]);
				expect(onAgentClick).toHaveBeenCalledTimes(1);
				expect(onAgentClick).toHaveBeenCalledWith('claude-code', 'Claude Code');
			});
			it('fires onAgentClick on Enter and Space key activation', () => {
				const onAgentClick = vi.fn();
				const { container } = s2_render(
					<AgentComparisonChart data={mockData} theme={theme} onAgentClick={onAgentClick} />
				);
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				s2_fireEvent.keyDown(barRows[0], { key: 'Enter' });
				s2_fireEvent.keyDown(barRows[0], { key: ' ' });
				expect(onAgentClick).toHaveBeenCalledTimes(2);
			});
			it('dims non-matching bars to 30% opacity when activeFilterKey is set', () => {
				const { container } = s2_render(
					<AgentComparisonChart
						data={mockData}
						theme={theme}
						onAgentClick={vi.fn()}
						activeFilterKey="claude-code"
					/>
				);
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				// Sorted: claude-code (selected, opacity 1), factory-droid + terminal (dimmed)
				expect((barRows[0] as HTMLElement).style.opacity).toBe('1');
				expect((barRows[1] as HTMLElement).style.opacity).toBe('0.3');
				expect((barRows[2] as HTMLElement).style.opacity).toBe('0.3');
			});
			it('renders bars at full opacity when no filter is active', () => {
				const { container } = s2_render(
					<AgentComparisonChart
						data={mockData}
						theme={theme}
						onAgentClick={vi.fn()}
						activeFilterKey={null}
					/>
				);
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				barRows.forEach((row) => {
					expect((row as HTMLElement).style.opacity).toBe('1');
				});
			});
			it('applies an accent-colored outline to the selected bar container', () => {
				const { container } = s2_render(
					<AgentComparisonChart
						data={mockData}
						theme={theme}
						onAgentClick={vi.fn()}
						activeFilterKey="claude-code"
					/>
				);
				const barContainers = container.querySelectorAll('[role="meter"]');
				expect(barContainers.length).toBe(3);
				// Selected bar (claude-code, sorted first) gets an inset accent outline.
				const selected = barContainers[0] as HTMLElement;
				expect(selected.style.boxShadow).toContain('inset');
				expect(selected.style.boxShadow).toContain('2px');
				// Non-selected bars do not have the outline.
				expect((barContainers[1] as HTMLElement).style.boxShadow).toBe('');
			});
			it('reflects selection state via aria-pressed', () => {
				const { container } = s2_render(
					<AgentComparisonChart
						data={mockData}
						theme={theme}
						onAgentClick={vi.fn()}
						activeFilterKey="factory-droid"
					/>
				);
				const barRows = container.querySelectorAll(BAR_ROW_SELECTOR);
				// Sorted by duration: claude-code (false), factory-droid (true), terminal (false).
				expect(barRows[0].getAttribute('aria-pressed')).toBe('false');
				expect(barRows[1].getAttribute('aria-pressed')).toBe('true');
				expect(barRows[2].getAttribute('aria-pressed')).toBe('false');
			});
			it('passes the worktree key suffix when a worktree bar is clicked', () => {
				const parent = makeSession({ id: 'parent', toolType: 'claude-code' });
				const worktree = makeSession({
					id: 'wt-1',
					toolType: 'claude-code',
					parentSessionId: 'parent',
				});
				const onAgentClick = vi.fn();
				const dataWithSessions: StatsAggregation = {
					...mockData,
					bySessionByDay: {
						parent: [{ date: '2024-12-20', count: 20, duration: 1500000 }],
						'wt-1': [{ date: '2024-12-20', count: 10, duration: 500000 }],
					},
				};
				const { container } = s2_render(
					<AgentComparisonChart
						data={dataWithSessions}
						theme={theme}
						sessions={[parent, worktree]}
						onAgentClick={onAgentClick}
					/>
				);
				// Find the worktree bar by aria-label suffix and click it.
				const barRows = Array.from(container.querySelectorAll(BAR_ROW_SELECTOR)) as HTMLElement[];
				const worktreeRow = barRows.find((row) =>
					row.getAttribute('aria-label')?.startsWith('Claude Code (Worktree)')
				);
				expect(worktreeRow).toBeDefined();
				s2_fireEvent.click(worktreeRow!);
				expect(onAgentClick).toHaveBeenCalledWith(
					'claude-code__worktree',
					'Claude Code (Worktree)'
				);
			});
		});
		describe('Session Name Resolution', () => {
			it('uses the user-assigned session name when a single session matches the provider', () => {
				// One session of toolType "claude-code" - buildNameMap should pick
				// the session's name ("Backend API") for the bar label.
				const session = makeSession({
					id: 'backend-api',
					name: 'Backend API',
					toolType: 'claude-code',
				});
				const data: StatsAggregation = {
					...singleAgentData,
					byAgent: {
						'claude-code': { count: 20, duration: 1000000 },
					},
				};
				s2_render(<AgentComparisonChart data={data} theme={theme} sessions={[session]} />);
				expect(s2_screen.getAllByText('Backend API').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.queryByText('Claude Code')).not.toBeInTheDocument();
			});
			it('falls back to prettified type when multiple sessions share the same provider', () => {
				// Two distinct claude-code sessions - buildNameMap can't pick one,
				// so it should use the prettified type name.
				const a = makeSession({ id: 'a', name: 'Frontend', toolType: 'claude-code' });
				const b = makeSession({ id: 'b', name: 'Backend', toolType: 'claude-code' });
				const data: StatsAggregation = {
					...singleAgentData,
					byAgent: {
						'claude-code': { count: 20, duration: 1000000 },
					},
				};
				s2_render(<AgentComparisonChart data={data} theme={theme} sessions={[a, b]} />);
				expect(s2_screen.getAllByText('Claude Code').length).toBeGreaterThanOrEqual(1);
			});
			it('disambiguates colliding display names with " (2)" suffixes', () => {
				// Two providers, single matching session each, both named "Worker".
				// buildNameMap should append " (2)" to the second to avoid collision.
				const a = makeSession({ id: 'a', name: 'Worker', toolType: 'claude-code' });
				const b = makeSession({ id: 'b', name: 'Worker', toolType: 'opencode' });
				const data: StatsAggregation = {
					...mockData,
					byAgent: {
						'claude-code': { count: 30, duration: 2000000 },
						opencode: { count: 20, duration: 1000000 },
					},
				};
				s2_render(<AgentComparisonChart data={data} theme={theme} sessions={[a, b]} />);
				expect(s2_screen.getAllByText('Worker').length).toBeGreaterThanOrEqual(1);
				expect(s2_screen.getAllByText('Worker (2)').length).toBeGreaterThanOrEqual(1);
			});
			it('uses prettified type for providers with no matching session', () => {
				// Sessions present but none with matching toolType - falls through
				// to prettifyAgentType.
				const session = makeSession({
					id: 'unrelated',
					name: 'Unrelated',
					toolType: 'opencode',
				});
				const data: StatsAggregation = {
					...singleAgentData,
					byAgent: {
						'factory-droid': { count: 10, duration: 500000 },
					},
				};
				s2_render(<AgentComparisonChart data={data} theme={theme} sessions={[session]} />);
				expect(s2_screen.getAllByText('Factory Droid').length).toBeGreaterThanOrEqual(1);
			});
			it('uses resolved name in tooltip', () => {
				const session = makeSession({
					id: 'backend-api',
					name: 'Backend API',
					toolType: 'claude-code',
				});
				const data: StatsAggregation = {
					...singleAgentData,
					byAgent: {
						'claude-code': { count: 20, duration: 1000000 },
					},
				};
				const { container } = s2_render(
					<AgentComparisonChart data={data} theme={theme} sessions={[session]} />
				);
				const barRows = container.querySelectorAll('[role="listitem"]');
				s2_fireEvent.mouseEnter(barRows[0]);
				// Tooltip portals to document.body and uses inline zIndex (no .z-50 class).
				const tooltip = document.body.querySelector('div.fixed.pointer-events-none');
				expect(tooltip?.textContent).toContain('Backend API');
			});
		});
	});
});
