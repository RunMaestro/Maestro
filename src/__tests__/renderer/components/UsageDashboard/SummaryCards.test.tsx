/**
 * Tests for SummaryCards component
 *
 * Verifies:
 * - The metric grid renders every card, in order, with formatted values
 * - Range-scoped cards read the aggregation; Agents / Open Tabs are marked "now"
 * - Queries/Agent divides by agents active in the range, not agents that exist
 * - Top Provider uses the provider display name and the shared ranking
 * - The streak comes from the all-time `streak` field, not the range's days
 * - Tokens describes every bucket it sums and its priced coverage
 * - The ratio card and its Cue retention caption
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
	AnimatedNumber,
	MetricCard,
	SummaryCards,
	countActiveDays,
	findBestDay,
	getCardStyles,
	lastDaysSeries,
} from '../../../../renderer/components/UsageDashboard/SummaryCards';
import type { StatsAggregation } from '../../../../renderer/hooks/stats/useStats';
import type { Session } from '../../../../renderer/types';
import type { DelegationTotals } from '../../../../shared/delegation';
import { THEMES } from '../../../../shared/themes';
import { emptyPromptCadence } from '../../../../shared/promptCadence';

const theme = THEMES['dracula'];

function makeData(overrides: Partial<StatsAggregation> = {}): StatsAggregation {
	return {
		totalQueries: 150,
		totalDuration: 7200000, // 2 hours
		avgDuration: 48000, // 48 seconds
		queryDurationPercentiles: { count: 0, min: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 },
		queryDurationPercentilesByAgent: {},
		autoRunTaskDurationPercentiles: {
			count: 0,
			min: 0,
			p50: 0,
			p75: 0,
			p90: 0,
			p95: 0,
			p99: 0,
			max: 0,
		},
		byAgent: {
			'claude-code': { count: 100, duration: 5000000 },
			codex: { count: 50, duration: 2200000 },
		},
		bySource: { user: 120, auto: 30 },
		byLocation: { local: 120, remote: 30 },
		byDay: [
			{ date: '2024-12-20', count: 50, duration: 2400000 },
			{ date: '2024-12-21', count: 100, duration: 4800000 },
		],
		byDayHour: [],
		window: { startYmd: '2024-12-20', endYmd: '2024-12-21' },
		earliestQueryAt: null,
		streak: { current: 2, longest: 9 },
		byHour: [],
		totalSessions: 25,
		byAgentByDay: {},
		bySessionByDay: {},
		bySessionSource: {},
		bySessionLastQuery: {},
		bySessionTokens: {},
		worktreeQueries: 0,
		parentQueries: 150,
		byAgentWorktree: {},
		imageAnnotations: 0,
		prompts: emptyPromptCadence(),
		...overrides,
	} as StatsAggregation;
}

const mockData = makeData();

const emptyData = makeData({
	totalQueries: 0,
	totalDuration: 0,
	avgDuration: 0,
	byAgent: {},
	bySource: { user: 0, auto: 0 },
	byLocation: { local: 0, remote: 0 },
	byDay: [],
	streak: { current: 0, longest: 0 },
	totalSessions: 0,
});

const mockSessions = [
	{
		id: 's1',
		toolType: 'claude-code',
		aiTabs: [{ id: 'tab1' }, { id: 'tab2' }, { id: 'tab3' }],
		filePreviewTabs: [{ id: 'file1' }],
	},
	{
		id: 's2',
		toolType: 'codex',
		aiTabs: [{ id: 'tab4' }],
		filePreviewTabs: [{ id: 'file2' }, { id: 'file3' }],
	},
	{
		id: 's3',
		toolType: 'terminal',
		aiTabs: [{ id: 'tab5' }],
		filePreviewTabs: [],
	},
] as unknown as Session[];

const delegation: DelegationTotals = {
	interactive: { count: 100, durationMs: 6_000_000 },
	autoRun: { count: 10, durationMs: 3_000_000 },
	cue: { count: 5, durationMs: 1_000_000 },
};

const CARD_ORDER = [
	'Agents',
	'Open Tabs',
	'Total Queries',
	'Queries/Agent',
	'Tokens',
	'Cost',
	'Total Time',
	'Avg Duration',
	'Top Provider',
	'Current Streak',
	'Best Day',
	'Active Days',
	'Image Annotations',
];

describe('SummaryCards', () => {
	describe('Rendering', () => {
		it('renders the summary cards container', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByTestId('summary-cards')).toBeInTheDocument();
		});

		it('renders the thirteen range cards in order (no peak hour card)', () => {
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);

			const cards = screen.getAllByTestId('metric-card');
			expect(cards).toHaveLength(CARD_ORDER.length);
			cards.forEach((card, index) => {
				expect(card.getAttribute('aria-label')).toMatch(new RegExp(`^${CARD_ORDER[index]}`));
			});
			// The peak hour is stated once, on the radial Activity by Hour chart.
			expect(screen.queryByText('Peak Hour')).not.toBeInTheDocument();
		});

		it('adds the Interactive vs Delegated card when the split is supplied', () => {
			render(<SummaryCards data={mockData} theme={theme} delegation={delegation} />);

			expect(screen.getAllByTestId('metric-card')).toHaveLength(CARD_ORDER.length + 1);
			// 4,000,000 of 10,000,000 ms delegated = 40%.
			expect(
				screen.getByRole('group', { name: 'Interactive vs Delegated: 60 / 40' })
			).toBeInTheDocument();
			expect(screen.getByText('40% ran without you')).toBeInTheDocument();
		});

		it('hides the ratio card when the split tracked no time', () => {
			render(
				<SummaryCards
					data={mockData}
					theme={theme}
					delegation={{
						interactive: { count: 0, durationMs: 0 },
						autoRun: { count: 0, durationMs: 0 },
						cue: { count: 0, durationMs: 0 },
					}}
				/>
			);
			expect(screen.queryByTestId('summary-delegation-ratio')).not.toBeInTheDocument();
		});

		it('notes Cue retention on the ratio card only when asked to', () => {
			const { rerender } = render(
				<SummaryCards data={mockData} theme={theme} delegation={delegation} />
			);
			expect(screen.queryByTestId('summary-cue-retention')).not.toBeInTheDocument();

			rerender(
				<SummaryCards data={mockData} theme={theme} delegation={delegation} cueRetentionDays={14} />
			);
			expect(screen.getByTestId('summary-cue-retention')).toHaveTextContent(
				'Cue time covers only the last 14 days'
			);
		});

		// Regression for issue #1399: the Tokens and Cost cards used to sum each
		// agent's persisted lifetime `usageStats`, which cannot move when the
		// dashboard's range selector does.
		it('reads Tokens and Cost from the range-scoped totals, not lifetime usageStats', () => {
			const sessionsWithLifetimeUsage = [
				{
					id: 's1',
					toolType: 'claude-code',
					aiTabs: [],
					filePreviewTabs: [],
					usageStats: {
						inputTokens: 900_000_000,
						outputTokens: 900_000_000,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: 999,
					},
				},
			] as unknown as Session[];

			render(
				<SummaryCards
					data={makeData({
						totalQueries: 40,
						bySessionTokens: {
							s1: {
								inputTokens: 1_000_000,
								outputTokens: 500_000,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								costUsd: 12.5,
								pricedQueries: 40,
							},
						},
					})}
					theme={theme}
					sessions={sessionsWithLifetimeUsage}
				/>
			);

			expect(screen.getByRole('group', { name: 'Tokens: 1.5M' })).toBeInTheDocument();
			expect(screen.getByRole('group', { name: 'Cost: $12.50' })).toBeInTheDocument();
		});

		it('names every bucket the Tokens headline sums, cache included', () => {
			render(
				<SummaryCards
					data={makeData({
						totalQueries: 10,
						bySessionTokens: {
							s1: {
								inputTokens: 1_000,
								outputTokens: 2_000,
								cacheReadTokens: 3_000,
								cacheCreationTokens: 4_000,
								costUsd: 1,
								pricedQueries: 10,
							},
						},
					})}
					theme={theme}
				/>
			);

			expect(screen.getByRole('group', { name: 'Tokens: 10.0K' })).toBeInTheDocument();
			const detail = screen.getByTestId('tokens-card-detail');
			expect(detail).toHaveTextContent('1.0K in');
			expect(detail).toHaveTextContent('2.0K out');
			expect(detail).toHaveTextContent('7.0K cache');
			// Every query was priced: no coverage line.
			expect(detail).not.toHaveTextContent('priced');
		});

		it('says how many queries the token and cost totals cover when some were unpriced', () => {
			render(
				<SummaryCards
					data={makeData({
						totalQueries: 150,
						bySessionTokens: {
							s1: {
								inputTokens: 1_000,
								outputTokens: 1_000,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								costUsd: 2,
								pricedQueries: 40,
							},
						},
					})}
					theme={theme}
				/>
			);

			expect(screen.getByTestId('tokens-card-detail')).toHaveTextContent(
				'40 of 150 queries priced'
			);
			expect(screen.getAllByText('40 of 150 queries priced')).toHaveLength(2);
		});

		it('shows the placeholder for Tokens when the selected range recorded none', () => {
			render(<SummaryCards data={makeData({ bySessionTokens: {} })} theme={theme} />);

			expect(screen.getByRole('group', { name: 'Tokens: -' })).toBeInTheDocument();
			expect(screen.getByRole('group', { name: 'Cost: -' })).toBeInTheDocument();
		});

		// The stats DB only stores provider-REPORTED cost, so a provider that
		// prices nothing itself would blank the Cost card without the rate-table
		// fallback.
		it('estimates Cost from the rate table when the range reported none', () => {
			const sessions = [
				{ id: 's1', toolType: 'claude-code', aiTabs: [], filePreviewTabs: [] },
			] as unknown as Session[];

			render(
				<SummaryCards
					data={makeData({
						bySessionTokens: {
							s1: {
								inputTokens: 1_000_000,
								outputTokens: 1_000_000,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
								costUsd: 0,
								pricedQueries: 10,
							},
						},
					})}
					theme={theme}
					sessions={sessions}
				/>
			);

			expect(screen.getByText('Est. Cost')).toBeInTheDocument();
			expect(screen.getByRole('group', { name: /^Est\. Cost: ~\$/ })).toBeInTheDocument();
		});

		it('renders Total Queries metric', async () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Total Queries')).toBeInTheDocument();
			expect(await screen.findByText('150')).toBeInTheDocument();
		});

		it('renders Total Time metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Total Time')).toBeInTheDocument();
			expect(screen.getByText('2h 0m')).toBeInTheDocument();
		});

		it('renders Avg Duration metric, and the placeholder when there are no queries', () => {
			const { unmount } = render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('48s')).toBeInTheDocument();
			unmount();

			render(<SummaryCards data={emptyData} theme={theme} />);
			expect(screen.getByRole('group', { name: 'Avg Duration: -' })).toBeInTheDocument();
		});

		it('renders Image Annotations metric', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Image Annotations')).toBeInTheDocument();
		});
	});

	describe('Scope captions', () => {
		it('marks the live cards as "now" and the streak as "all time"', () => {
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);

			expect(screen.getByRole('group', { name: /^Agents \(now\): 2/ })).toBeInTheDocument();
			expect(screen.getByRole('group', { name: /^Open Tabs \(now\): 8/ })).toBeInTheDocument();
			expect(
				screen.getByRole('group', { name: /^Current Streak \(all time\): 2d/ })
			).toBeInTheDocument();
			const hints = screen.getAllByTestId('metric-card-label-hint').map((el) => el.textContent);
			expect(hints).toEqual(['now', 'now', 'all time']);
		});

		it('leaves range-scoped cards without a caption', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			const card = screen.getByRole('group', { name: /^Total Queries/ });
			expect(card.querySelector('[data-testid="metric-card-label-hint"]')).toBeNull();
		});
	});

	describe('Queries/Agent', () => {
		it('divides by the agents active in the range, not by the agents that exist', () => {
			// 150 queries over 25 active agents; the 2 live non-terminal agents are irrelevant.
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);
			expect(screen.getByRole('group', { name: 'Queries/Agent: 6.0' })).toBeInTheDocument();
			expect(screen.getByText('across 25 active agents')).toBeInTheDocument();
		});

		it('shows the placeholder when no agent ran a query', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);
			expect(screen.getByRole('group', { name: 'Queries/Agent: -' })).toBeInTheDocument();
		});
	});

	describe('Top Provider', () => {
		it('names the busiest provider by display name with its query count', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByRole('group', { name: /^Top Provider: Claude Code/ })).toBeInTheDocument();
			expect(screen.getByText('100 queries')).toBeInTheDocument();
		});

		it('ranks by query count even when another provider ran longer', () => {
			render(
				<SummaryCards
					data={makeData({
						byAgent: {
							'claude-code': { count: 10, duration: 9_000_000 },
							codex: { count: 20, duration: 1_000 },
						},
					})}
					theme={theme}
				/>
			);
			expect(screen.getByRole('group', { name: /^Top Provider: Codex/ })).toBeInTheDocument();
		});

		it('shows the placeholder when no provider ran a query', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);
			expect(screen.getByRole('group', { name: 'Top Provider: -' })).toBeInTheDocument();
		});
	});

	describe('Streak, best day, active days', () => {
		it('reads the streak from the all-time field, not the range days', () => {
			// Only two days in range, but the streak spans further back.
			render(
				<SummaryCards data={makeData({ streak: { current: 40, longest: 61 } })} theme={theme} />
			);
			expect(
				screen.getByRole('group', { name: /^Current Streak \(all time\): 40d/ })
			).toBeInTheDocument();
			expect(screen.getByText('Best: 61d')).toBeInTheDocument();
		});

		it('shows a zero streak as 0d', () => {
			render(<SummaryCards data={emptyData} theme={theme} />);
			expect(
				screen.getByRole('group', { name: /^Current Streak \(all time\): 0d/ })
			).toBeInTheDocument();
		});

		it('names the best day with the canonical calendar format', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByText('Dec 21, 2024')).toBeInTheDocument();
		});

		it('counts active days out of the days in range', () => {
			render(
				<SummaryCards
					data={makeData({
						byDay: [
							{ date: '2024-12-19', count: 0, duration: 0 },
							{ date: '2024-12-20', count: 3, duration: 1 },
							{ date: '2024-12-21', count: 0, duration: 0 },
						],
					})}
					theme={theme}
				/>
			);
			expect(screen.getByRole('group', { name: 'Active Days: 1' })).toBeInTheDocument();
			expect(screen.getByText('of 3 days')).toBeInTheDocument();
		});
	});

	describe('Open Tabs', () => {
		it('renders Open Tabs metric with correct count', () => {
			render(<SummaryCards data={mockData} theme={theme} sessions={mockSessions} />);
			expect(screen.getByRole('group', { name: /Open Tabs \(now\): 8/i })).toBeInTheDocument();
		});

		it('counts browser and terminal tabs, and skips hidden AI tabs, like the tab strip', () => {
			const sessions = [
				{
					id: 's1',
					toolType: 'claude-code',
					aiTabs: [{ id: 'tab1' }, { id: 'consult', hidden: true }],
					filePreviewTabs: [{ id: 'file1' }],
					browserTabs: [{ id: 'browser1' }],
					terminalTabs: [{ id: 'term1' }, { id: 'term2' }],
				},
			] as unknown as Session[];
			render(<SummaryCards data={mockData} theme={theme} sessions={sessions} />);
			expect(screen.getByRole('group', { name: /Open Tabs \(now\): 5/i })).toBeInTheDocument();
			expect(screen.getByTestId('open-tab-breakdown')).toHaveTextContent(
				'1 AI · 1 file · 1 browser · 2 terminal'
			);
		});

		it('leaves out a tab with no slot in the strip (#2008)', () => {
			const sessions = [
				{
					id: 's1',
					toolType: 'claude-code',
					aiTabs: [{ id: 'open' }, { id: 'orphan' }],
					unifiedTabOrder: [{ type: 'ai', id: 'open' }],
				},
			] as unknown as Session[];
			render(<SummaryCards data={mockData} theme={theme} sessions={sessions} />);
			expect(screen.getByRole('group', { name: /Open Tabs \(now\): 1/i })).toBeInTheDocument();
		});

		it('renders Open Tabs as 0 when no sessions provided', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByRole('group', { name: /Open Tabs \(now\): 0/i })).toBeInTheDocument();
		});
	});

	describe('Number Formatting', () => {
		it('formats thousands with K suffix', async () => {
			render(<SummaryCards data={makeData({ totalQueries: 1500 })} theme={theme} />);
			expect(await screen.findByText('1.5K')).toBeInTheDocument();
		});

		it('formats millions with M suffix', async () => {
			render(<SummaryCards data={makeData({ totalQueries: 1500000 })} theme={theme} />);
			expect(await screen.findByText('1.5M')).toBeInTheDocument();
		});

		it('formats minutes and seconds correctly', () => {
			render(<SummaryCards data={makeData({ avgDuration: 125000 })} theme={theme} />);
			expect(screen.getByText('2m 5s')).toBeInTheDocument();
		});
	});

	describe('Theme Support', () => {
		it('applies theme background color to cards', () => {
			render(<SummaryCards data={mockData} theme={theme} />);
			screen.getAllByTestId('metric-card').forEach((card) => {
				expect(card).toHaveStyle({ backgroundColor: theme.colors.bgActivity });
			});
		});

		it('works with light theme', () => {
			render(<SummaryCards data={mockData} theme={THEMES['github-light']} />);
			expect(screen.getByText('Total Queries')).toBeInTheDocument();
		});
	});

	describe('Sparklines', () => {
		const sevenDays = makeData({
			byDay: [
				{ date: '2024-12-13', count: 99, duration: 99 },
				{ date: '2024-12-14', count: 99, duration: 99 },
				{ date: '2024-12-15', count: 10, duration: 600000 },
				{ date: '2024-12-16', count: 20, duration: 1200000 },
				{ date: '2024-12-17', count: 15, duration: 800000 },
				{ date: '2024-12-18', count: 30, duration: 1500000 },
				{ date: '2024-12-19', count: 25, duration: 1300000 },
				{ date: '2024-12-20', count: 0, duration: 0 },
				{ date: '2024-12-21', count: 0, duration: 0 },
			],
		});

		it('renders sparklines on Total Queries and Total Time cards', () => {
			render(<SummaryCards data={sevenDays} theme={theme} />);

			const queriesCard = screen.getByRole('group', { name: /^Total Queries/ });
			const totalTimeCard = screen.getByRole('group', { name: /^Total Time/ });
			expect(queriesCard.querySelector('[data-testid="sparkline"]')).not.toBeNull();
			expect(totalTimeCard.querySelector('[data-testid="sparkline"]')).not.toBeNull();
		});

		it('does not render sparklines on live cards', () => {
			render(<SummaryCards data={sevenDays} theme={theme} sessions={mockSessions} />);
			const agentsCard = screen.getByRole('group', { name: /^Agents/ });
			expect(agentsCard.querySelector('[data-testid="sparkline"]')).toBeNull();
		});

		it('omits the sparkline when the range has fewer than two days', () => {
			render(
				<SummaryCards
					data={makeData({ byDay: [{ date: '2024-12-21', count: 5, duration: 10 }] })}
					theme={theme}
				/>
			);
			const queriesCard = screen.getByRole('group', { name: /^Total Queries/ });
			expect(queriesCard.querySelector('[data-testid^="sparkline"]')).toBeNull();
		});
	});

	describe('Grid Layout', () => {
		it('uses a 3-column grid by default and honors the columns prop', () => {
			const { rerender } = render(<SummaryCards data={mockData} theme={theme} />);
			expect(screen.getByTestId('summary-cards')).toHaveStyle({
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			});
			rerender(<SummaryCards data={mockData} theme={theme} columns={2} />);
			expect(screen.getByTestId('summary-cards')).toHaveStyle({
				gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
			});
		});
	});
});

describe('SummaryCards helpers', () => {
	const byDay = [
		{ date: '2024-12-01', count: 1, duration: 10 },
		{ date: '2024-12-02', count: 0, duration: 0 },
		{ date: '2024-12-03', count: 7, duration: 70 },
		{ date: '2024-12-04', count: 2, duration: 20 },
		{ date: '2024-12-05', count: 0, duration: 0 },
		{ date: '2024-12-06', count: 3, duration: 30 },
		{ date: '2024-12-07', count: 0, duration: 0 },
		{ date: '2024-12-08', count: 4, duration: 40 },
	];

	it('lastDaysSeries takes the last seven gap-filled days, zeros kept', () => {
		expect(lastDaysSeries(byDay, (d) => d.count)).toEqual([0, 7, 2, 0, 3, 0, 4]);
		expect(lastDaysSeries(byDay.slice(0, 2), (d) => d.duration)).toEqual([10, 0]);
	});

	it('findBestDay picks the busiest day, or null when idle', () => {
		expect(findBestDay(byDay)).toEqual({ date: '2024-12-03', count: 7 });
		expect(findBestDay([{ date: '2024-12-01', count: 0, duration: 0 }])).toBeNull();
	});

	it('countActiveDays counts days with a query', () => {
		expect(countActiveDays(byDay)).toBe(5);
	});
});

describe('SummaryCards - active agents in range', () => {
	it('reports how many agents ran a query in the range beside the status dots', () => {
		render(
			<SummaryCards
				data={makeData({
					bySessionByDay: { s1: [{ date: '2024-12-21', count: 4, duration: 1000 }] },
				})}
				theme={theme}
				sessions={mockSessions}
			/>
		);
		expect(screen.getByTestId('agent-active-count')).toHaveTextContent('1 active in range');
	});

	it('excludes terminal sessions from the active count', () => {
		render(
			<SummaryCards
				data={makeData({
					bySessionByDay: { s3: [{ date: '2024-12-21', count: 9, duration: 1000 }] },
				})}
				theme={theme}
				sessions={mockSessions}
			/>
		);
		expect(screen.getByTestId('agent-active-count')).toHaveTextContent('0 active in range');
	});

	it('omits the active count when no sessions are supplied', () => {
		render(<SummaryCards data={mockData} theme={theme} />);
		expect(screen.queryByTestId('agent-active-count')).not.toBeInTheDocument();
	});
});

describe('MetricCard', () => {
	// A formatted figure carries no spaces, so a value too wide for its column
	// (`~$39,605.06` in a 176px card on a phone) had nowhere to break.
	it('lets a long value wrap inside its card instead of overflowing it', () => {
		render(<SummaryCards data={mockData} theme={theme} />);
		const values = screen
			.getAllByTestId('metric-card')
			.map((card) => card.querySelector('.font-bold'))
			.filter((el): el is HTMLElement => el instanceof HTMLElement);
		expect(values.length).toBeGreaterThan(0);
		for (const value of values) {
			expect(value.style.overflowWrap).toBe('anywhere');
		}
	});

	it('renders a subValue line and a custom test id', () => {
		render(
			<MetricCard
				icon={<span />}
				label="Runs"
				value="12"
				subValue="3 failed"
				theme={theme}
				testId="runs-card"
			/>
		);
		const card = screen.getByTestId('runs-card');
		expect(card).toHaveAttribute('aria-label', 'Runs: 12, 3 failed');
		expect(screen.getByText('3 failed')).toBeInTheDocument();
	});

	// jsdom drops 8-digit hex colors from inline styles, so the variant is
	// checked on the style object rather than on the rendered element.
	it('tints the filled variant with the accent override', () => {
		expect(getCardStyles('filled', theme, '#112233')).toMatchObject({
			backgroundColor: '#11223326',
			border: '1px solid #1122334D',
		});
		expect(getCardStyles('elevated', theme)).toMatchObject({
			backgroundColor: theme.colors.bgActivity,
			borderTop: `2px solid ${theme.colors.accent}`,
		});
	});
});

describe('AnimatedNumber', () => {
	it('renders the final numeric value after the count-up animation completes', async () => {
		render(<AnimatedNumber value="150" />);
		expect(await screen.findByText('150')).toBeInTheDocument();
	});

	it('starts numeric values from 0 before the animation runs', () => {
		const { container } = render(<AnimatedNumber value="150" />);
		expect(container.textContent).toBe('0');
	});

	it('preserves the K suffix and decimal precision while animating', async () => {
		render(<AnimatedNumber value="1.5K" />);
		expect(await screen.findByText('1.5K')).toBeInTheDocument();
	});

	it('preserves the % suffix while animating', async () => {
		render(<AnimatedNumber value="80%" />);
		expect(await screen.findByText('80%')).toBeInTheDocument();
	});

	it('renders non-numeric strings (durations, names, the placeholder) immediately', () => {
		const { rerender } = render(<AnimatedNumber value="12h 34m" />);
		expect(screen.getByText('12h 34m')).toBeInTheDocument();
		rerender(<AnimatedNumber value="Claude Code" />);
		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		rerender(<AnimatedNumber value="-" />);
		expect(screen.getByText('-')).toBeInTheDocument();
	});
});
