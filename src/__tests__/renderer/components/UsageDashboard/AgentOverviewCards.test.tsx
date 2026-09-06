/**
 * Tests for AgentOverviewCards component
 *
 * Verifies:
 * - Renders one card per non-terminal session
 * - Status dot color reflects session state (idle/busy/error/other)
 * - Worktree children show the WT badge, dashed border, and branch row
 * - Query count comes from bySessionByDay when present, falls back to byAgent
 * - Sparklines render with per-session counts (accent color for worktrees)
 * - Empty / terminal-only session arrays render nothing
 * - Staggered card-enter animation delays are applied
 * - The fuzzy agent filter narrows cards live and clears from the ESC pill
 * - The group dropdown narrows the grid, and only offers groups that hold agents
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentOverviewCards } from '../../../../renderer/components/UsageDashboard/AgentOverviewCards';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

// The agent filter registers a layer while it holds text so Escape clears the
// box instead of closing the dashboard. Stub the stack so the component can
// render standalone.
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

const theme = THEMES['dracula'];

// JSDOM normalises hex colors to rgb() when they're read back off `element.style`
const hexToRgb = (hex: string): string => {
	const v = hex.replace('#', '');
	const r = parseInt(v.slice(0, 2), 16);
	const g = parseInt(v.slice(2, 4), 16);
	const b = parseInt(v.slice(4, 6), 16);
	return `rgb(${r}, ${g}, ${b})`;
};

const buildSession = (overrides: Partial<Session>): Session =>
	({
		id: 'sess-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		contextUsage: 0,
		...overrides,
	}) as Session;

const buildData = (overrides: Partial<StatsAggregation> = {}): StatsAggregation => ({
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byLocation: { local: 0, remote: 0 },
	byDay: [],
	byHour: [],
	totalSessions: 0,
	sessionsByAgent: {},
	sessionsByDay: [],
	avgSessionDuration: 0,
	byAgentByDay: {},
	bySessionByDay: {},
	bySessionSource: {},
	bySessionLastQuery: {},
	...overrides,
});

describe('AgentOverviewCards', () => {
	it('renders the grid container with one card per non-terminal session', () => {
		const sessions: Session[] = [
			buildSession({ id: 's1', name: 'Alpha' }),
			buildSession({ id: 's2', name: 'Beta', toolType: 'codex' }),
			buildSession({ id: 's3', name: 'Term', toolType: 'terminal' }),
		];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		expect(screen.getByTestId('agent-overview-cards')).toBeInTheDocument();
		const cards = screen.getAllByTestId('agent-card');
		expect(cards).toHaveLength(2);
		expect(screen.getByText('Alpha')).toBeInTheDocument();
		expect(screen.getByText('Beta')).toBeInTheDocument();
		expect(screen.queryByText('Term')).not.toBeInTheDocument();
	});

	it('renders nothing when there are no non-terminal sessions', () => {
		const { container: emptyContainer } = render(
			<AgentOverviewCards sessions={[]} data={buildData()} theme={theme} />
		);
		expect(emptyContainer.firstChild).toBeNull();

		const { container: terminalOnly } = render(
			<AgentOverviewCards
				sessions={[buildSession({ id: 't1', toolType: 'terminal' })]}
				data={buildData()}
				theme={theme}
			/>
		);
		expect(terminalOnly.firstChild).toBeNull();
	});

	it('colors the status dot based on session state', () => {
		const sessions: Session[] = [
			buildSession({ id: 'idle', name: 'Idle', state: 'idle' }),
			buildSession({ id: 'busy', name: 'Busy', state: 'busy' }),
			buildSession({ id: 'err', name: 'Err', state: 'error' }),
			buildSession({ id: 'wait', name: 'Wait', state: 'waiting_input' }),
		];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		// Cards sort alphabetically by name - look up by content rather than
		// index so the test isn't coupled to the ordering.
		const cardByName = (name: string) =>
			(screen.getByText(name).closest('[data-testid="agent-card"]') as HTMLElement) ?? null;
		const dotIn = (name: string) =>
			cardByName(name).querySelector('[data-testid="agent-card-status-dot"]') as HTMLElement;

		expect(dotIn('Idle').style.backgroundColor).toBe(hexToRgb(theme.colors.success));
		expect(dotIn('Busy').style.backgroundColor).toBe(hexToRgb(theme.colors.warning));
		expect(dotIn('Err').style.backgroundColor).toBe(hexToRgb(theme.colors.error));
		// `waiting_input` → textDim fallback
		expect(dotIn('Wait').style.backgroundColor).toBe(hexToRgb(theme.colors.textDim));
	});

	it('animates the status dot only when the session is busy', () => {
		const sessions: Session[] = [
			buildSession({ id: 'idle', name: 'Idle', state: 'idle' }),
			buildSession({ id: 'busy', name: 'Busy', state: 'busy' }),
		];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		const cardByName = (name: string) =>
			screen.getByText(name).closest('[data-testid="agent-card"]') as HTMLElement;
		const dotIn = (name: string) =>
			cardByName(name).querySelector('[data-testid="agent-card-status-dot"]') as HTMLElement;

		expect(dotIn('Idle').style.animation).toBe('');
		expect(dotIn('Busy').style.animation).toContain('status-pulse');
	});

	it('renders the WT badge, branch row, and dashed border for worktree children', () => {
		const sessions: Session[] = [
			buildSession({
				id: 'wt-1',
				name: 'Worktree One',
				parentSessionId: 'parent-1',
				worktreeBranch: 'feature/awesome',
			}),
			buildSession({ id: 'p-1', name: 'Parent One' }),
		];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		const cardByName = (name: string) =>
			screen.getByText(name).closest('[data-testid="agent-card"]') as HTMLElement;

		const worktreeCard = cardByName('Worktree One');
		expect(worktreeCard.querySelector('[data-testid="agent-card-wt-badge"]')).not.toBeNull();
		expect(worktreeCard.querySelector('[data-testid="agent-card-branch"]')?.textContent).toBe(
			'feature/awesome'
		);
		expect(worktreeCard.style.border).toContain('dashed');

		const parentCard = cardByName('Parent One');
		expect(parentCard.querySelector('[data-testid="agent-card-wt-badge"]')).toBeNull();
		expect(parentCard.querySelector('[data-testid="agent-card-branch"]')).toBeNull();
		expect(parentCard.style.border).toContain('solid');
	});

	it('uses bySessionByDay totals for the query count when present', () => {
		const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];
		const data = buildData({
			bySessionByDay: {
				s1: [
					{ date: '2024-12-20', count: 7, duration: 1000 },
					{ date: '2024-12-21', count: 13, duration: 2000 },
				],
			},
			byAgent: {
				// Provider total should be ignored when per-session data exists.
				'claude-code': { count: 999, duration: 0 },
			},
		});

		render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

		expect(screen.getByTestId('agent-card-query-count').textContent).toBe('20');
	});

	it('falls back to byAgent[toolType] when bySessionByDay has no entry', () => {
		const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];
		const data = buildData({
			byAgent: { 'claude-code': { count: 42, duration: 0 } },
		});

		render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

		expect(screen.getByTestId('agent-card-query-count').textContent).toBe('42');
	});

	it('shows 0 instead of duplicating the provider total when multiple sessions share a provider', () => {
		// Two sessions of the same toolType with no per-session bySessionByDay
		// data. Reusing the provider total for each card would render "42" on
		// both, overstating per-agent usage. Expect 0 on each instead.
		const sessions: Session[] = [
			buildSession({ id: 's1', name: 'Alpha' }),
			buildSession({ id: 's2', name: 'Beta' }),
		];
		const data = buildData({
			byAgent: { 'claude-code': { count: 42, duration: 0 } },
		});

		render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

		const counts = screen.getAllByTestId('agent-card-query-count');
		expect(counts).toHaveLength(2);
		for (const node of counts) {
			expect(node.textContent).toBe('0');
		}
	});

	it('renders a per-session sparkline when bySessionByDay has data', () => {
		const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];
		const data = buildData({
			bySessionByDay: {
				s1: [{ date: '2024-12-21', count: 5, duration: 1000 }],
			},
		});

		render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

		// Single non-zero day → renders the active sparkline (the empty
		// dashed-baseline state would emit `sparkline-empty` instead).
		const card = screen.getByTestId('agent-card');
		expect(card.querySelector('[data-testid="sparkline"]')).not.toBeNull();
	});

	it('renders the empty/dashed sparkline when no per-session day data exists', () => {
		const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		const card = screen.getByTestId('agent-card');
		expect(card.querySelector('[data-testid="sparkline-empty"]')).not.toBeNull();
	});

	describe('Drill-down filter highlight', () => {
		it('does not highlight any card when activeFilterKey is null', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', toolType: 'claude-code' }),
				buildSession({ id: 's2', name: 'Beta', toolType: 'codex' }),
			];

			render(
				<AgentOverviewCards
					sessions={sessions}
					data={buildData()}
					theme={theme}
					activeFilterKey={null}
				/>
			);

			const cards = screen.getAllByTestId('agent-card');
			cards.forEach((card) => {
				expect(card.dataset.selected).toBeUndefined();
				expect(card.style.border).not.toContain('2px');
			});
		});

		it('highlights only the parent card whose toolType matches a provider key', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Claude', toolType: 'claude-code' }),
				buildSession({ id: 's2', name: 'Codex', toolType: 'codex' }),
				buildSession({
					id: 's3',
					name: 'Claude WT',
					toolType: 'claude-code',
					parentSessionId: 's1',
					worktreeBranch: 'feature/x',
				}),
			];

			render(
				<AgentOverviewCards
					sessions={sessions}
					data={buildData()}
					theme={theme}
					activeFilterKey="claude-code"
				/>
			);

			const cardByName = (name: string) =>
				screen.getByText(name).closest('[data-testid="agent-card"]') as HTMLElement;

			// Parent claude-code card should be selected
			const parent = cardByName('Claude');
			expect(parent.dataset.selected).toBe('true');
			expect(parent.style.border).toBe(`2px solid ${hexToRgb(theme.colors.accent)}`);
			// codex card should not be selected
			expect(cardByName('Codex').dataset.selected).toBeUndefined();
			// Worktree of claude-code should NOT match the bare provider key
			const worktree = cardByName('Claude WT');
			expect(worktree.dataset.selected).toBeUndefined();
			expect(worktree.style.border).toContain('dashed');
		});

		it('highlights only worktree cards when filter key has __worktree suffix', () => {
			const sessions: Session[] = [
				buildSession({ id: 'p1', name: 'Claude Parent', toolType: 'claude-code' }),
				buildSession({
					id: 'wt1',
					name: 'Claude WT',
					toolType: 'claude-code',
					parentSessionId: 'p1',
					worktreeBranch: 'feature/x',
				}),
			];

			render(
				<AgentOverviewCards
					sessions={sessions}
					data={buildData()}
					theme={theme}
					activeFilterKey="claude-code__worktree"
				/>
			);

			const cards = screen.getAllByTestId('agent-card');
			// Parent should NOT be highlighted by the worktree key
			expect(cards[0].dataset.selected).toBeUndefined();
			// Worktree card should be highlighted
			expect(cards[1].dataset.selected).toBe('true');
			expect(cards[1].style.border).toBe(`2px solid ${hexToRgb(theme.colors.accent)}`);
		});

		it('highlights a single card when filter key matches the session id', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', toolType: 'claude-code' }),
				buildSession({ id: 's2', name: 'Beta', toolType: 'claude-code' }),
			];

			render(
				<AgentOverviewCards
					sessions={sessions}
					data={buildData()}
					theme={theme}
					activeFilterKey="s2"
				/>
			);

			const cards = screen.getAllByTestId('agent-card');
			expect(cards[0].dataset.selected).toBeUndefined();
			expect(cards[1].dataset.selected).toBe('true');
		});

		it('highlights nothing when the filter key does not match any session', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', toolType: 'claude-code' }),
			];

			render(
				<AgentOverviewCards
					sessions={sessions}
					data={buildData()}
					theme={theme}
					activeFilterKey="opencode"
				/>
			);

			const cards = screen.getAllByTestId('agent-card');
			expect(cards[0].dataset.selected).toBeUndefined();
		});
	});

	describe('Created / age', () => {
		it('renders an age badge per session when createdAt is set', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', createdAt: Date.now() - 5 * 60_000 }), // 5m
				buildSession({ id: 's2', name: 'Beta', createdAt: Date.now() - 3 * 86_400_000 }), // 3d
			];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			const cardByName = (name: string) =>
				screen.getByText(name).closest('[data-testid="agent-card"]') as HTMLElement;
			const ageIn = (name: string) =>
				cardByName(name).querySelector('[data-testid="agent-card-age"]') as HTMLElement;

			expect(ageIn('Alpha').textContent).toBe('5m');
			expect(ageIn('Beta').textContent).toBe('3d');
		});

		it('omits the age badge when createdAt is missing', () => {
			const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			expect(screen.queryByTestId('agent-card-age')).toBeNull();
		});

		it('sorts cards by createdAt descending (most recent first)', () => {
			const now = Date.now();
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Oldest', createdAt: now - 30 * 86_400_000 }),
				buildSession({ id: 's2', name: 'Newest', createdAt: now - 60_000 }),
				buildSession({ id: 's3', name: 'Middle', createdAt: now - 86_400_000 }),
			];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			fireEvent.click(screen.getByTestId('agent-overview-sort-created'));

			const cards = screen.getAllByTestId('agent-card');
			expect(cards[0].textContent).toContain('Newest');
			expect(cards[1].textContent).toContain('Middle');
			expect(cards[2].textContent).toContain('Oldest');
		});
	});

	describe('Recent / last query', () => {
		it('sorts cards by last query descending and sinks agents with none', () => {
			const now = Date.now();
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Stale', createdAt: now }),
				buildSession({ id: 's2', name: 'Fresh', createdAt: now }),
				buildSession({ id: 's3', name: 'Never', createdAt: now }),
			];
			const data = buildData({
				bySessionLastQuery: { s1: now - 86_400_000, s2: now - 60_000 },
			});

			render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

			fireEvent.click(screen.getByTestId('agent-overview-sort-recent'));

			const cards = screen.getAllByTestId('agent-card');
			expect(cards[0].textContent).toContain('Fresh');
			expect(cards[1].textContent).toContain('Stale');
			expect(cards[2].textContent).toContain('Never');
		});

		it('swaps the corner badge from age to last query and highlights it', () => {
			const now = Date.now();
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', createdAt: now - 3 * 86_400_000 }),
			];
			const data = buildData({ bySessionLastQuery: { s1: now - 5 * 60_000 } });

			render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);
			expect(screen.getByTestId('agent-card-age').textContent).toBe('3d');

			fireEvent.click(screen.getByTestId('agent-overview-sort-recent'));

			const age = screen.getByTestId('agent-card-age') as HTMLElement;
			expect(age.textContent).toBe('5m');
			expect(age.dataset.highlighted).toBe('true');
		});

		it('drops the corner badge when the agent has no query in range', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', createdAt: Date.now() - 86_400_000 }),
			];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);
			fireEvent.click(screen.getByTestId('agent-overview-sort-recent'));

			expect(screen.queryByTestId('agent-card-age')).toBeNull();
		});
	});

	describe('Auto % column', () => {
		it('renders the auto-source share for each session from bySessionSource', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha' }),
				buildSession({ id: 's2', name: 'Beta' }),
			];
			const data = buildData({
				bySessionSource: {
					s1: { user: 30, auto: 70 },
					s2: { user: 80, auto: 20 },
				},
			});

			render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

			const cardByName = (name: string) =>
				screen.getByText(name).closest('[data-testid="agent-card"]') as HTMLElement;
			const pctIn = (name: string) =>
				cardByName(name).querySelector('[data-testid="agent-card-auto-pct"]') as HTMLElement;

			expect(pctIn('Alpha').textContent).toBe('70%');
			expect(pctIn('Beta').textContent).toBe('20%');
		});

		it('shows an em-dash when the session has no recorded queries', () => {
			const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			expect(screen.getByTestId('agent-card-auto-pct').textContent).toBe('\u2014');
		});

		it('sorts cards by auto % descending and sinks no-data sessions to the bottom', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha' }), // 25% auto
				buildSession({ id: 's2', name: 'Beta' }), // 75% auto
				buildSession({ id: 's3', name: 'Gamma' }), // no data
			];
			const data = buildData({
				bySessionSource: {
					s1: { user: 75, auto: 25 },
					s2: { user: 25, auto: 75 },
				},
			});

			render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

			fireEvent.click(screen.getByTestId('agent-overview-sort-auto'));

			const cards = screen.getAllByTestId('agent-card');
			expect(cards[0].textContent).toContain('Beta');
			expect(cards[1].textContent).toContain('Alpha');
			expect(cards[2].textContent).toContain('Gamma');
		});
	});

	describe('Sort highlight', () => {
		it('does not highlight any stat under the default Name sort', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', createdAt: Date.now() - 60_000 }),
			];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			expect(
				(screen.getByTestId('agent-card-query-count') as HTMLElement).dataset.highlighted
			).toBeUndefined();
			expect(
				(screen.getByTestId('agent-card-tab-count') as HTMLElement).dataset.highlighted
			).toBeUndefined();
			expect(
				(screen.getByTestId('agent-card-auto-pct') as HTMLElement).dataset.highlighted
			).toBeUndefined();
			expect(
				(screen.getByTestId('agent-card-age') as HTMLElement).dataset.highlighted
			).toBeUndefined();
		});

		it('highlights the age badge when Created sort is active', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha', createdAt: Date.now() - 60_000 }),
			];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);
			fireEvent.click(screen.getByTestId('agent-overview-sort-created'));

			expect((screen.getByTestId('agent-card-age') as HTMLElement).dataset.highlighted).toBe(
				'true'
			);
			expect(
				(screen.getByTestId('agent-card-query-count') as HTMLElement).dataset.highlighted
			).toBeUndefined();
		});

		it('highlights the query count when Queries sort is active', () => {
			const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);
			fireEvent.click(screen.getByTestId('agent-overview-sort-queries'));

			expect(
				(screen.getByTestId('agent-card-query-count') as HTMLElement).dataset.highlighted
			).toBe('true');
			expect(
				(screen.getByTestId('agent-card-tab-count') as HTMLElement).dataset.highlighted
			).toBeUndefined();
		});

		it('highlights the tab count when Tabs sort is active', () => {
			const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];

			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);
			fireEvent.click(screen.getByTestId('agent-overview-sort-tabs'));

			expect((screen.getByTestId('agent-card-tab-count') as HTMLElement).dataset.highlighted).toBe(
				'true'
			);
		});

		it('highlights the auto % when Auto % sort is active', () => {
			const sessions: Session[] = [buildSession({ id: 's1', name: 'Alpha' })];
			const data = buildData({
				bySessionSource: { s1: { user: 30, auto: 70 } },
			});

			render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);
			fireEvent.click(screen.getByTestId('agent-overview-sort-auto'));

			expect((screen.getByTestId('agent-card-auto-pct') as HTMLElement).dataset.highlighted).toBe(
				'true'
			);
		});
	});

	describe('fuzzy agent filter', () => {
		const filterSessions = (): Session[] => [
			buildSession({ id: 's1', name: '🕵️ Agent OSINT' }),
			buildSession({ id: 's2', name: 'Bug Bounty' }),
			buildSession({ id: 's3', name: 'Cyber Stocks' }),
			buildSession({
				id: 's4',
				name: 'acappella',
				parentSessionId: 's1',
				worktreeBranch: 'feat/provider-auth-recovery',
			}),
		];

		const typeFilter = (value: string) => {
			fireEvent.change(screen.getByTestId('agent-overview-filter-input'), {
				target: { value },
			});
		};

		it('renders every card and no match count before anything is typed', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			expect(screen.getAllByTestId('agent-card')).toHaveLength(4);
			expect(screen.queryByTestId('agent-overview-filter-count')).toBeNull();
			expect(screen.queryByTestId('agent-overview-filter-clear')).toBeNull();
		});

		it('narrows the grid live as the user types', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			typeFilter('bounty');

			const names = screen.getAllByTestId('agent-card').map((c) => c.textContent);
			expect(names).toHaveLength(1);
			expect(names[0]).toContain('Bug Bounty');
			expect(screen.getByTestId('agent-overview-filter-count').textContent).toBe('1 of 4');
		});

		it('matches non-contiguous characters (fuzzy, not substring)', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			typeFilter('cbst');

			const names = screen.getAllByTestId('agent-card').map((c) => c.textContent);
			expect(names).toHaveLength(1);
			expect(names[0]).toContain('Cyber Stocks');
		});

		it('matches a name whose leading emoji would otherwise break the prefix', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			typeFilter('agent');

			const names = screen.getAllByTestId('agent-card').map((c) => c.textContent);
			expect(names).toHaveLength(1);
			expect(names[0]).toContain('Agent OSINT');
		});

		it('matches a worktree on its branch name', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			typeFilter('provider-auth');

			const names = screen.getAllByTestId('agent-card').map((c) => c.textContent);
			expect(names).toHaveLength(1);
			expect(names[0]).toContain('acappella');
		});

		it('ranks the best match first under the default Name sort', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Backups' }),
				buildSession({ id: 's2', name: 'Bug Bounty' }),
			];
			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			// Alphabetically Backups leads; "bug" is a prefix match on Bug Bounty.
			typeFilter('bug');

			const names = screen.getAllByTestId('agent-card').map((c) => c.textContent);
			expect(names[0]).toContain('Bug Bounty');
		});

		it('keeps an explicit sort order while filtering', () => {
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Beta', aiTabs: [{}, {}] } as Partial<Session>),
				buildSession({ id: 's2', name: 'Bravo', aiTabs: [{}, {}, {}, {}] } as Partial<Session>),
			];
			render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

			fireEvent.click(screen.getByTestId('agent-overview-sort-tabs'));
			typeFilter('b');

			const counts = screen
				.getAllByTestId('agent-card-tab-count')
				.map((el) => Number(el.textContent));
			expect(counts).toEqual([4, 2]);
		});

		it('shows an empty-state message when nothing matches', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			typeFilter('zzzz');

			expect(screen.queryAllByTestId('agent-card')).toHaveLength(0);
			expect(screen.queryByTestId('agent-overview-cards')).toBeNull();
			expect(screen.getByTestId('agent-overview-no-matches').textContent).toContain('zzzz');
			expect(screen.getByTestId('agent-overview-filter-count').textContent).toBe('0 of 4');
		});

		it('restores every card when the ESC pill clears the filter', () => {
			render(<AgentOverviewCards sessions={filterSessions()} data={buildData()} theme={theme} />);

			typeFilter('bounty');
			expect(screen.getAllByTestId('agent-card')).toHaveLength(1);

			fireEvent.click(screen.getByTestId('agent-overview-filter-clear'));

			expect(screen.getAllByTestId('agent-card')).toHaveLength(4);
			expect((screen.getByTestId('agent-overview-filter-input') as HTMLInputElement).value).toBe(
				''
			);
		});

		it('leaves query counts untouched by the filter', () => {
			// Two claude-code sessions with no per-session breakdown: the provider
			// fallback must stay suppressed even when the filter shows just one.
			const sessions: Session[] = [
				buildSession({ id: 's1', name: 'Alpha' }),
				buildSession({ id: 's2', name: 'Beta' }),
			];
			const data = buildData({ byAgent: { 'claude-code': { count: 99, totalDuration: 0 } } });
			render(<AgentOverviewCards sessions={sessions} data={data} theme={theme} />);

			typeFilter('alpha');

			expect(screen.getByTestId('agent-card-query-count').textContent).toBe('0');
		});
	});

	it('staggers card-enter animation delays at 60ms per card', () => {
		const sessions: Session[] = [
			buildSession({ id: 'a', name: 'A' }),
			buildSession({ id: 'b', name: 'B' }),
			buildSession({ id: 'c', name: 'C' }),
		];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		const cards = screen.getAllByTestId('agent-card');
		expect(cards[0].style.animationDelay).toBe('0ms');
		expect(cards[1].style.animationDelay).toBe('60ms');
		expect(cards[2].style.animationDelay).toBe('120ms');
		cards.forEach((c) => expect(c.className).toContain('card-enter'));
	});

	describe('group filter dropdown', () => {
		const GROUPS = [
			{ id: 'g-acme', name: 'Acme Corp', emoji: '\u{1F3E2}' },
			{ id: 'g-internal', name: 'Internal' },
		];
		const GROUPED_SESSIONS: Session[] = [
			buildSession({ id: 's1', name: 'Alpha', groupId: 'g-acme' }),
			buildSession({ id: 's2', name: 'Beta', groupId: 'g-acme' }),
			buildSession({ id: 's3', name: 'Gamma', groupId: 'g-internal' }),
			buildSession({ id: 's4', name: 'Delta' }),
		];

		const renderWithGroups = (
			sessions: Session[] = GROUPED_SESSIONS,
			groups: Array<{ id: string; name: string; emoji?: string }> = GROUPS
		) =>
			render(
				<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} groups={groups} />
			);

		/** Open the dropdown and pick an option by its visible label. */
		const pickGroup = (label: string) => {
			fireEvent.click(screen.getByLabelText('Filter agents by group'));
			fireEvent.click(screen.getByRole('option', { name: label }));
		};

		it('renders the dropdown ahead of the keyword filter', () => {
			renderWithGroups();

			const trigger = screen.getByLabelText('Filter agents by group');
			const search = screen.getByTestId('agent-overview-filter-input');
			// Node.compareDocumentPosition: 4 = trigger precedes search.
			expect(trigger.compareDocumentPosition(search) & 4).toBeTruthy();
		});

		it('shows every agent until a group is picked', () => {
			renderWithGroups();

			expect(screen.getAllByTestId('agent-card')).toHaveLength(4);
		});

		it('narrows the grid to the picked group', () => {
			renderWithGroups();

			pickGroup('\u{1F3E2} Acme Corp');

			expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
			expect(screen.getByText('Alpha')).toBeInTheDocument();
			expect(screen.queryByText('Gamma')).not.toBeInTheDocument();
		});

		it('offers an Ungrouped option that shows only unfiled agents', () => {
			renderWithGroups();

			pickGroup('Ungrouped');

			expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
			expect(screen.getByText('Delta')).toBeInTheDocument();
		});

		it('omits groups that hold no agents', () => {
			// An option whose every selection yields an empty grid is a dead end.
			renderWithGroups([buildSession({ id: 's1', name: 'Alpha', groupId: 'g-acme' })]);

			fireEvent.click(screen.getByLabelText('Filter agents by group'));

			expect(screen.queryByRole('option', { name: 'Internal' })).not.toBeInTheDocument();
			expect(screen.getByRole('option', { name: '\u{1F3E2} Acme Corp' })).toBeInTheDocument();
		});

		it('treats an agent whose group was deleted as ungrouped', () => {
			// A dangling groupId must not make an agent unreachable from every
			// option - the Left Bar and the group rollup both do the same.
			renderWithGroups(
				[
					// A populated real group so the dropdown has something to offer.
					buildSession({ id: 's1', name: 'Alpha', groupId: 'g-acme' }),
					buildSession({ id: 's9', name: 'Orphan', groupId: 'g-gone' }),
				],
				GROUPS
			);

			pickGroup('Ungrouped');

			expect(screen.getByText('Orphan')).toBeInTheDocument();
			expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
		});

		it('does not render the dropdown when no groups are configured', () => {
			// With nothing to pick between, the control could only ever no-op.
			renderWithGroups([buildSession({ id: 's1', name: 'Alpha' })], []);

			expect(screen.queryByLabelText('Filter agents by group')).not.toBeInTheDocument();
		});

		it('composes with the keyword filter', () => {
			renderWithGroups();

			pickGroup('\u{1F3E2} Acme Corp');
			fireEvent.change(screen.getByTestId('agent-overview-filter-input'), {
				target: { value: 'Alpha' },
			});

			expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
			expect(screen.getByText('Alpha')).toBeInTheDocument();
		});
	});
	describe('active-only toggle', () => {
		const SESSIONS: Session[] = [
			buildSession({ id: 's1', name: 'Alpha' }),
			buildSession({ id: 's2', name: 'Beta', toolType: 'codex' }),
		];
		// Only Alpha recorded a query in the range.
		const DATA = buildData({
			byAgent: { 'claude-code': { count: 9, duration: 0 }, codex: { count: 4, duration: 0 } },
			bySessionByDay: { s1: [{ date: '2026-09-01', count: 9, duration: 1000 }] },
		});

		const toggle = () => screen.getByTestId('agent-overview-active-only');

		it('is off by default and shows every agent', () => {
			render(<AgentOverviewCards sessions={SESSIONS} data={DATA} theme={theme} />);

			expect(toggle()).toHaveAttribute('aria-checked', 'false');
			expect(screen.getAllByTestId('agent-card')).toHaveLength(2);
		});

		it('drops agents with no queries in the range when switched on', () => {
			render(<AgentOverviewCards sessions={SESSIONS} data={DATA} theme={theme} />);

			fireEvent.click(toggle());

			expect(toggle()).toHaveAttribute('aria-checked', 'true');
			expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
			expect(screen.getByText('Alpha')).toBeInTheDocument();
			expect(screen.queryByText('Beta')).not.toBeInTheDocument();
		});

		it('does not count the provider-total fallback as activity', () => {
			// Beta is the only codex agent, so its CARD borrows the provider total.
			// That must not promote it to "active" - it ran nothing itself.
			render(<AgentOverviewCards sessions={SESSIONS} data={DATA} theme={theme} />);
			fireEvent.click(toggle());

			expect(screen.queryByText('Beta')).not.toBeInTheDocument();
		});

		it('keeps the toolbar and explains itself when it empties the grid', () => {
			// Emptying the grid must never hide the control that emptied it.
			render(<AgentOverviewCards sessions={SESSIONS} data={buildData()} theme={theme} />);

			fireEvent.click(toggle());

			expect(toggle()).toBeInTheDocument();
			expect(screen.getByTestId('agent-overview-group-empty')).toHaveTextContent(
				'No agents ran a query in this time range.'
			);
		});

		it('composes with the keyword filter', () => {
			render(
				<AgentOverviewCards
					sessions={[...SESSIONS, buildSession({ id: 's3', name: 'Alpine' })]}
					data={{
						...DATA,
						bySessionByDay: {
							...DATA.bySessionByDay,
							s3: [{ date: '2026-09-01', count: 2, duration: 100 }],
						},
					}}
					theme={theme}
				/>
			);

			fireEvent.click(toggle());
			fireEvent.change(screen.getByTestId('agent-overview-filter-input'), {
				target: { value: 'Alph' },
			});

			expect(screen.getAllByTestId('agent-card')).toHaveLength(1);
			expect(screen.getByText('Alpha')).toBeInTheDocument();
		});
	});
});
