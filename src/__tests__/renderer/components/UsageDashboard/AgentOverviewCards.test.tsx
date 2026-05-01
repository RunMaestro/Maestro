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
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentOverviewCards } from '../../../../renderer/components/UsageDashboard/AgentOverviewCards';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

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

		const cards = screen.getAllByTestId('agent-card');
		const dots = cards.map((c) => c.querySelector('[data-testid="agent-card-status-dot"]'));

		// Hex → JSDOM-normalised rgb()
		const hexToRgb = (hex: string) => {
			const v = hex.replace('#', '');
			const r = parseInt(v.slice(0, 2), 16);
			const g = parseInt(v.slice(2, 4), 16);
			const b = parseInt(v.slice(4, 6), 16);
			return `rgb(${r}, ${g}, ${b})`;
		};

		expect((dots[0] as HTMLElement).style.backgroundColor).toBe(hexToRgb(theme.colors.success));
		expect((dots[1] as HTMLElement).style.backgroundColor).toBe(hexToRgb(theme.colors.warning));
		expect((dots[2] as HTMLElement).style.backgroundColor).toBe(hexToRgb(theme.colors.error));
		// `waiting_input` → textDim fallback
		expect((dots[3] as HTMLElement).style.backgroundColor).toBe(hexToRgb(theme.colors.textDim));
	});

	it('animates the status dot only when the session is busy', () => {
		const sessions: Session[] = [
			buildSession({ id: 'idle', name: 'Idle', state: 'idle' }),
			buildSession({ id: 'busy', name: 'Busy', state: 'busy' }),
		];

		render(<AgentOverviewCards sessions={sessions} data={buildData()} theme={theme} />);

		const cards = screen.getAllByTestId('agent-card');
		const idleDot = cards[0].querySelector('[data-testid="agent-card-status-dot"]') as HTMLElement;
		const busyDot = cards[1].querySelector('[data-testid="agent-card-status-dot"]') as HTMLElement;

		expect(idleDot.style.animation).toBe('');
		expect(busyDot.style.animation).toContain('status-pulse');
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

		const cards = screen.getAllByTestId('agent-card');

		// Worktree card
		expect(cards[0].querySelector('[data-testid="agent-card-wt-badge"]')).not.toBeNull();
		expect(cards[0].querySelector('[data-testid="agent-card-branch"]')?.textContent).toBe(
			'feature/awesome'
		);
		expect(cards[0].style.border).toContain('dashed');

		// Parent (non-worktree) card
		expect(cards[1].querySelector('[data-testid="agent-card-wt-badge"]')).toBeNull();
		expect(cards[1].querySelector('[data-testid="agent-card-branch"]')).toBeNull();
		expect(cards[1].style.border).toContain('solid');
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

			const cards = screen.getAllByTestId('agent-card');
			// Parent claude-code card should be selected
			expect(cards[0].dataset.selected).toBe('true');
			expect(cards[0].style.border).toBe(`2px solid ${hexToRgb(theme.colors.accent)}`);
			// codex card should not be selected
			expect(cards[1].dataset.selected).toBeUndefined();
			// Worktree of claude-code should NOT match the bare provider key
			expect(cards[2].dataset.selected).toBeUndefined();
			expect(cards[2].style.border).toContain('dashed');
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
});
