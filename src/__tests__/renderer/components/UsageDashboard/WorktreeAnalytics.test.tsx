/**
 * Tests for WorktreeAnalytics component
 *
 * Verifies:
 * - Parent / Worktree summary cards: a parent is an agent a live worktree was
 *   spawned from, not every non-worktree agent
 * - Ratio badge formats correctly across edge cases (no parents, both zero)
 * - Split bar reflects worktree vs other-agent query proportions and
 *   surfaces the dashed pattern on the worktree segment
 * - A "Deleted worktree agents" row makes By Branch add up to the bar
 * - Empty-data state of the activity bar shows the placeholder row
 * - Per-branch breakdown sorts by query count descending and shows the
 *   branch name + sparkline; absent worktrees render the empty hint
 * - Terminal sessions are excluded from agent counts
 * - Card-enter staggered animations are applied
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { WorktreeAnalytics } from '../../../../renderer/components/UsageDashboard/WorktreeAnalytics';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

const buildSession = (overrides: Partial<Session>): Session =>
	({
		id: 'sess-1',
		name: 'Agent One',
		toolType: 'claude-code',
		state: 'idle',
		contextUsage: 0,
		...overrides,
	}) as Session;

const buildData = (overrides: Partial<StatsAggregation> = {}): StatsAggregation =>
	({
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byLocation: { local: 0, remote: 0 },
		byDay: [],
		byHour: [],
		totalSessions: 0,
		byAgentByDay: {},
		bySessionByDay: {},
		bySessionSource: {},
		window: { startYmd: '2024-12-15', endYmd: '2024-12-21' },
		...overrides,
	}) as StatsAggregation;

const cardsText = () => screen.getByTestId('worktree-stat-cards').textContent ?? '';

describe('WorktreeAnalytics', () => {
	it('renders the section with role + aria label', () => {
		render(
			<WorktreeAnalytics
				sessions={[buildSession({ id: 'p', name: 'Parent' })]}
				data={buildData()}
				theme={theme}
			/>
		);
		expect(screen.getByTestId('worktree-analytics')).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Worktree Analytics' })).toBeInTheDocument();
	});

	it('renders Parent and Worktree summary cards with correct counts', () => {
		const sessions: Session[] = [
			buildSession({ id: 'p1', name: 'Parent A' }),
			buildSession({ id: 'p2', name: 'Parent B' }),
			buildSession({ id: 'w1', name: 'WT One', parentSessionId: 'p1' }),
			buildSession({ id: 'w2', name: 'WT Two', parentSessionId: 'p1' }),
			buildSession({ id: 'w3', name: 'WT Three', parentSessionId: 'p2' }),
		];

		render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);

		expect(cardsText()).toMatch(/Parent Agents\s*2/);
		expect(cardsText()).toMatch(/Worktree Agents\s*3/);
	});

	it('does not count standalone agents as parents', () => {
		const sessions: Session[] = [
			buildSession({ id: 'p1', name: 'Parent' }),
			buildSession({ id: 's1', name: 'Standalone' }),
			buildSession({ id: 's2', name: 'Standalone 2' }),
			buildSession({ id: 'w1', name: 'WT', parentSessionId: 'p1' }),
		];

		render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);

		expect(cardsText()).toMatch(/Parent Agents\s*1/);
		expect(screen.getByTestId('worktree-ratio-badge').textContent).toBe('1.00×');
	});

	it('excludes terminal sessions from the parent / worktree counts', () => {
		const sessions: Session[] = [
			buildSession({ id: 't1', toolType: 'terminal' }),
			buildSession({ id: 't2', toolType: 'terminal', parentSessionId: 'x' }),
			buildSession({ id: 'p1', name: 'Parent' }),
			buildSession({ id: 'w1', name: 'Worktree', parentSessionId: 'p1' }),
		];

		render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);

		expect(cardsText()).toMatch(/Parent Agents\s*1/);
		expect(cardsText()).toMatch(/Worktree Agents\s*1/);
	});

	describe('ratio badge', () => {
		it('shows a hyphen placeholder when no agents exist', () => {
			render(<WorktreeAnalytics sessions={[]} data={buildData()} theme={theme} />);
			expect(screen.getByTestId('worktree-ratio-badge').textContent).toBe('-');
		});

		it('shows the worktree-to-parent ratio with two decimals', () => {
			const sessions: Session[] = [
				buildSession({ id: 'p1' }),
				buildSession({ id: 'p2' }),
				buildSession({ id: 'w1', parentSessionId: 'p1' }),
				buildSession({ id: 'w2', parentSessionId: 'p1' }),
				buildSession({ id: 'w3', parentSessionId: 'p2' }),
			];
			render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);
			expect(screen.getByTestId('worktree-ratio-badge').textContent).toBe('1.50×');
		});

		it('shows infinity when there are worktrees but no parents (orphaned children)', () => {
			const sessions: Session[] = [buildSession({ id: 'w1', parentSessionId: 'missing' })];
			render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);
			expect(screen.getByTestId('worktree-ratio-badge').textContent).toBe('∞×');
		});
	});

	describe('activity split bar', () => {
		it('renders the empty placeholder when there is no query activity', () => {
			render(
				<WorktreeAnalytics
					sessions={[buildSession({ id: 'p1' })]}
					data={buildData({ worktreeQueries: 0, parentQueries: 0 })}
					theme={theme}
				/>
			);
			expect(screen.getByTestId('worktree-split-bar-empty')).toBeInTheDocument();
			expect(screen.queryByTestId('worktree-split-bar')).not.toBeInTheDocument();
		});

		it('sizes other-agent and worktree segments by query proportion', () => {
			render(
				<WorktreeAnalytics
					sessions={[buildSession({ id: 'p1' })]}
					data={buildData({ parentQueries: 75, worktreeQueries: 25 })}
					theme={theme}
				/>
			);
			const parent = screen.getByTestId('worktree-split-other') as HTMLElement;
			const worktree = screen.getByTestId('worktree-split-worktree') as HTMLElement;
			expect(parent.style.width).toBe('75%');
			expect(worktree.style.width).toBe('25%');
		});

		it('applies the dashed pattern to the worktree segment only', () => {
			render(
				<WorktreeAnalytics
					sessions={[buildSession({ id: 'p1' })]}
					data={buildData({ parentQueries: 50, worktreeQueries: 50 })}
					theme={theme}
				/>
			);
			const parent = screen.getByTestId('worktree-split-other') as HTMLElement;
			const worktree = screen.getByTestId('worktree-split-worktree') as HTMLElement;
			expect(parent.style.backgroundImage).toBe('');
			expect(worktree.style.backgroundImage).toContain('repeating-linear-gradient');
		});

		it('exposes overall percentages via aria-label for screen readers', () => {
			render(
				<WorktreeAnalytics
					sessions={[buildSession({ id: 'p1' })]}
					data={buildData({ parentQueries: 30, worktreeQueries: 70 })}
					theme={theme}
				/>
			);
			expect(screen.getByTestId('worktree-split-bar')).toHaveAttribute(
				'aria-label',
				'Other agents 30%, Worktree agents 70%'
			);
		});

		it('treats missing worktreeQueries / parentQueries as zero', () => {
			render(
				<WorktreeAnalytics
					sessions={[buildSession({ id: 'p1' })]}
					data={buildData()}
					theme={theme}
				/>
			);
			expect(screen.getByTestId('worktree-split-bar-empty')).toBeInTheDocument();
		});
	});

	describe('per-branch breakdown', () => {
		it('renders the empty hint when there are no worktree sessions', () => {
			render(
				<WorktreeAnalytics
					sessions={[buildSession({ id: 'p1' })]}
					data={buildData()}
					theme={theme}
				/>
			);
			expect(screen.getByTestId('worktree-branch-empty')).toBeInTheDocument();
			expect(screen.queryByTestId('worktree-branch-list')).not.toBeInTheDocument();
		});

		it('sorts worktree rows by query count descending', () => {
			const sessions: Session[] = [
				buildSession({
					id: 'low',
					name: 'Low Activity',
					parentSessionId: 'p1',
					worktreeBranch: 'feat/low',
				}),
				buildSession({
					id: 'high',
					name: 'High Activity',
					parentSessionId: 'p1',
					worktreeBranch: 'feat/high',
				}),
				buildSession({
					id: 'mid',
					name: 'Mid Activity',
					parentSessionId: 'p1',
					worktreeBranch: 'feat/mid',
				}),
			];

			const data = buildData({
				bySessionByDay: {
					low: [{ date: '2024-12-21', count: 1, duration: 0 }],
					high: [
						{ date: '2024-12-20', count: 10, duration: 0 },
						{ date: '2024-12-21', count: 15, duration: 0 },
					],
					mid: [{ date: '2024-12-21', count: 5, duration: 0 }],
				},
			});

			render(<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />);

			const rows = screen.getAllByTestId('worktree-branch-row');
			expect(rows).toHaveLength(3);

			const branchNames = rows.map(
				(row) => within(row).getByTestId('worktree-branch-name').textContent
			);
			expect(branchNames).toEqual(['feat/high', 'feat/mid', 'feat/low']);

			const counts = rows.map(
				(row) => within(row).getByTestId('worktree-branch-count').textContent
			);
			expect(counts).toEqual(['25', '5', '1']);
		});

		it('falls back to the session name when worktreeBranch is missing', () => {
			const sessions: Session[] = [
				buildSession({
					id: 'wt1',
					name: 'Unnamed Branch Agent',
					parentSessionId: 'p1',
				}),
			];
			render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);
			expect(screen.getByTestId('worktree-branch-name').textContent).toBe('Unnamed Branch Agent');
		});

		it('renders an active sparkline when bySessionByDay has data', () => {
			const sessions: Session[] = [
				buildSession({ id: 'wt1', parentSessionId: 'p1', worktreeBranch: 'feat/x' }),
			];
			const data = buildData({
				bySessionByDay: { wt1: [{ date: '2024-12-21', count: 7, duration: 0 }] },
			});
			render(<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />);
			const row = screen.getByTestId('worktree-branch-row');
			expect(row.querySelector('[data-testid="sparkline"]')).not.toBeNull();
		});

		it('renders the dashed empty sparkline when no per-session data exists', () => {
			const sessions: Session[] = [
				buildSession({ id: 'wt1', parentSessionId: 'p1', worktreeBranch: 'feat/x' }),
			];
			render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);
			const row = screen.getByTestId('worktree-branch-row');
			expect(row.querySelector('[data-testid="sparkline-empty"]')).not.toBeNull();
		});
	});

	it('staggers card-enter animation delays on branch rows (60ms)', () => {
		const sessions: Session[] = [
			buildSession({ id: 'p1', name: 'Parent' }),
			buildSession({ id: 'wt1', parentSessionId: 'p1', worktreeBranch: 'feat/a' }),
			buildSession({ id: 'wt2', parentSessionId: 'p1', worktreeBranch: 'feat/b' }),
		];
		render(<WorktreeAnalytics sessions={sessions} data={buildData()} theme={theme} />);

		const branchRows = screen.getAllByTestId('worktree-branch-row');
		expect(branchRows[0].style.animationDelay).toBe('120ms');
		expect(branchRows[1].style.animationDelay).toBe('180ms');
		branchRows.forEach((r) => expect(r.className).toContain('card-enter'));
	});

	describe('deleted worktree agents', () => {
		it('adds a remainder row so the branch rows add up to the worktree total', () => {
			const sessions: Session[] = [
				buildSession({ id: 'p1', name: 'Parent' }),
				buildSession({ id: 'wt1', parentSessionId: 'p1', worktreeBranch: 'feat/a' }),
			];
			const data = buildData({
				worktreeQueries: 12,
				parentQueries: 8,
				bySessionByDay: { wt1: [{ date: '2024-12-21', count: 5, duration: 0 }] },
			});
			render(<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />);

			expect(screen.getByTestId('worktree-branch-deleted-count').textContent).toBe('7');
		});

		it('omits the remainder row when live worktree agents account for every query', () => {
			const sessions: Session[] = [
				buildSession({ id: 'p1', name: 'Parent' }),
				buildSession({ id: 'wt1', parentSessionId: 'p1', worktreeBranch: 'feat/a' }),
			];
			const data = buildData({
				worktreeQueries: 5,
				bySessionByDay: { wt1: [{ date: '2024-12-21', count: 5, duration: 0 }] },
			});
			render(<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />);

			expect(screen.queryByTestId('worktree-branch-deleted')).not.toBeInTheDocument();
		});
	});

	it('draws the branch sparkline over calendar days, zero-filling idle ones', () => {
		const sessions: Session[] = [
			buildSession({ id: 'wt1', parentSessionId: 'p1', worktreeBranch: 'feat/x' }),
		];
		// Two active days far apart: the old "last 7 rows" sparkline drew them
		// side by side. Only the in-window day survives a 7-day calendar window.
		const data = buildData({
			bySessionByDay: {
				wt1: [
					{ date: '2024-11-01', count: 9, duration: 0 },
					{ date: '2024-12-21', count: 3, duration: 0 },
				],
			},
			window: { startYmd: '2024-10-01', endYmd: '2024-12-21' },
		});
		render(<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />);
		const row = screen.getByTestId('worktree-branch-row');
		expect(row.querySelector('[data-testid="sparkline"]')).not.toBeNull();
		// The count still covers the whole range.
		expect(within(row).getByTestId('worktree-branch-count').textContent).toBe('12');
	});
});
