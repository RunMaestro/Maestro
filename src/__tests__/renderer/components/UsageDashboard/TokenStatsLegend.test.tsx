/**
 * Tests for the Tokens tab timeline legend and accounting presentation.
 *
 * The legend is a set of series toggles, not a static key. What matters:
 * - Clicking an entry hides its series from the stack AND rescales the chart,
 *   which is the whole point (cache reads otherwise flatten input and output).
 * - The choice is written to storage under a stable key, so it survives a
 *   restart, and is read back on the next mount.
 * - The last visible series cannot be hidden - an empty chart says nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { THEMES } from '../../../../shared/themes';
import type {
	TokenUsageAggregate,
	TokenUsageTimeBucket,
	TokenUsageTotals,
} from '../../../../shared/tokenUsage';
import { emptyTokenSpeedSummary } from '../../../../shared/tokenSpeed';
import type { UsageCost } from '../../../../shared/types';
import { providerProfileKey } from '../../../../shared/providerProfiles';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';

// In-memory stand-in for localStorage: the local jsdom build ships without a
// Storage implementation, so asserting persistence against the real one only
// ever passes on CI. Mocking the accessor tests the wiring everywhere.
const storage = new Map<string, string>();
vi.mock('../../../../renderer/utils/safeLocalStorage', () => ({
	safeStorageGet: (key: string) => (storage.has(key) ? storage.get(key)! : null),
	safeStorageSet: (key: string, value: string) => {
		storage.set(key, value);
	},
}));

import { TokenStats } from '../../../../renderer/components/UsageDashboard/TokenStats';

const theme = THEMES['dracula'];

function makeTotals(over: Partial<TokenUsageTotals> = {}): TokenUsageTotals {
	return {
		inputTokens: 1_000,
		outputTokens: 2_000,
		cacheReadTokens: 900_000,
		cacheCreationTokens: 0,
		costUsd: 12,
		costEstimated: true,
		sessionCount: 3,
		...over,
	};
}

function bucket(startMs: number, over: Partial<TokenUsageTimeBucket> = {}): TokenUsageTimeBucket {
	return { startMs, ...makeTotals(), ...over };
}

const aggregate: TokenUsageAggregate = {
	totals: makeTotals(),
	byAgent: [],
	byModel: [],
	byProject: [],
	byAccount: [],
	// Two buckets whose cache reads differ by 10x, so a rescale after hiding
	// cache reads is visible in the bar heights.
	timeline: [
		bucket(1_700_000_000_000, {
			cacheReadTokens: 100_000,
			inputTokens: 1_000,
			outputTokens: 1_000,
		}),
		bucket(1_700_086_400_000, {
			cacheReadTokens: 1_000_000,
			inputTokens: 1_000,
			outputTokens: 1_000,
		}),
	],
	series: {
		byDay: {},
		byHour: {},
		byAgentByDay: {},
		bySessionByDay: {},
	} as TokenUsageAggregate['series'],
	speed: emptyTokenSpeedSummary(),
	coverageByAgent: {},
	generatedAtMs: 1_700_086_400_000,
};

function mountTokens() {
	return render(<TokenStats timeRange="month" theme={theme} />);
}

/** Bar heights in the timeline, in render order. */
function barHeights(): string[] {
	const timeline = screen.getByTestId('token-timeline');
	return Array.from(timeline.querySelectorAll<HTMLElement>('.rounded-t-sm')).map(
		(el) => el.style.height
	);
}

describe('TokenStats timeline legend', () => {
	beforeEach(() => {
		storage.clear();
		clearCachedResources();
		(window as unknown as { maestro: unknown }).maestro = {
			stats: { getTokenUsage: vi.fn().mockResolvedValue(aggregate) },
		};
	});

	it('shows every series by default', async () => {
		mountTokens();
		await screen.findByTestId('token-timeline');

		for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens']) {
			expect(screen.getByTestId(`token-timeline-legend-${key}`).getAttribute('aria-pressed')).toBe(
				'true'
			);
		}
	});

	it('hides a series and rescales the chart when its legend entry is clicked', async () => {
		mountTokens();
		await screen.findByTestId('token-timeline');

		// With cache reads in play the small bucket is a tenth of the tall one.
		expect(barHeights()).toEqual(['10.179640718562874%', '100%']);

		fireEvent.click(screen.getByTestId('token-timeline-legend-cacheReadTokens'));

		expect(
			screen.getByTestId('token-timeline-legend-cacheReadTokens').getAttribute('aria-pressed')
		).toBe('false');
		// Input + output are identical across both buckets, so dropping cache reads
		// makes them equal rather than leaving one invisible.
		expect(barHeights()).toEqual(['100%', '100%']);
	});

	it('remembers each series choice across a remount', async () => {
		const first = mountTokens();
		await screen.findByTestId('token-timeline');

		fireEvent.click(screen.getByTestId('token-timeline-legend-outputTokens'));
		expect(storage.get('usageDashboard.tokens.timelineSeries.outputTokens')).toBe('false');

		first.unmount();

		mountTokens();
		await screen.findByTestId('token-timeline');
		expect(
			screen.getByTestId('token-timeline-legend-outputTokens').getAttribute('aria-pressed')
		).toBe('false');
		expect(
			screen.getByTestId('token-timeline-legend-inputTokens').getAttribute('aria-pressed')
		).toBe('true');
	});

	it('refuses to hide the last visible series', async () => {
		mountTokens();
		await screen.findByTestId('token-timeline');

		fireEvent.click(screen.getByTestId('token-timeline-legend-inputTokens'));
		fireEvent.click(screen.getByTestId('token-timeline-legend-outputTokens'));

		const last = screen.getByTestId('token-timeline-legend-cacheReadTokens');
		await waitFor(() => expect((last as HTMLButtonElement).disabled).toBe(true));

		fireEvent.click(last);
		expect(last.getAttribute('aria-pressed')).toBe('true');
	});

	it.each<{ name: string; cost: UsageCost; text: string; width: string }>([
		{ name: 'unknown', cost: { status: 'unknown' }, text: 'Unknown', width: '0%' },
		{
			name: 'partial without an amount',
			cost: { status: 'partial' },
			text: 'Unknown (partial)',
			width: '0%',
		},
		{
			name: 'partial ticks',
			cost: { status: 'partial', costUsdTicks: '12500000000' },
			text: '$1.25 (partial)',
			width: '100%',
		},
		{
			name: 'partial zero',
			cost: { status: 'partial', costUsdTicks: '0' },
			text: '$0.00 (partial)',
			width: '1%',
		},
		{
			name: 'exact zero',
			cost: { status: 'exact', costUsdTicks: '0' },
			text: '$0.00',
			width: '1%',
		},
		{
			name: 'exact ticks overriding a stale numeric amount',
			cost: { status: 'exact', costUsdTicks: '12500000000', costUsd: 99 },
			text: '$1.25',
			width: '100%',
		},
		...(['complete', 'partial', 'unknown'] as const).map((completeness) => ({
			name: `${completeness} estimate`,
			cost: {
				status: 'estimated' as const,
				costUsd: 1.25,
				model: 'legacy-model',
				pricingRevision: 'fixture',
				completeness,
			},
			text: completeness === 'complete' ? '~$1.25' : '~$1.25 (partial)',
			width: '100%',
		})),
	])('keeps $name cost evidence across cards, rows and tooltips', async ({ cost, text, width }) => {
		// Deliberately conflicting legacy projections must not replace canonical evidence.
		const totals = makeTotals({
			costUsd: 99,
			costEstimated: cost.status !== 'estimated',
			accounting: { completeness: 'partial', cost },
		});
		const rawModel = 'xai/grok-4-fast-non-reasoning:2026-10';
		const data: TokenUsageAggregate = {
			...aggregate,
			totals,
			byAgent: [{ ...totals, key: 'grok', label: 'Grok CLI' }],
			byAccount: [{ ...totals, key: providerProfileKey('grok', 'work'), label: 'Grok work' }],
			byModel: [{ ...totals, key: JSON.stringify(['grok', rawModel]), label: rawModel }],
			byProject: [{ ...totals, key: 'fixture-project', label: 'Fixture project' }],
			timeline: [bucket(1_700_000_000_000, totals)],
		};
		vi.mocked(window.maestro.stats.getTokenUsage).mockResolvedValue(data);
		mountTokens();
		expect(await screen.findByRole('group', { name: `Total Cost: ${text}` })).toBeInTheDocument();
		for (const dimension of ['agent', 'account', 'model', 'project']) {
			const chart = screen.getByTestId(`token-by-${dimension}`);
			const row = within(chart).getByText(text).parentElement!;
			expect(row.querySelector<HTMLElement>('.h-full')!.style.width).toBe(width);
			fireEvent.mouseEnter(row);
			expect(await screen.findByText(`Cost: ${text}`)).toBeInTheDocument();
			expect(screen.queryByText('~ cost estimated from rates') !== null).toBe(
				cost.status === 'estimated'
			);
			fireEvent.mouseLeave(row);
		}
		const timelineRow = screen
			.getByTestId('token-timeline')
			.querySelector('.rounded-t-sm')!.parentElement!;
		fireEvent.mouseEnter(timelineRow);
		expect(await screen.findByText(`Cost: ${text}`)).toBeInTheDocument();
		fireEvent.mouseLeave(timelineRow);
		expect(screen.getByTestId('token-speed-empty')).toHaveTextContent('No timed API calls');
		expect(screen.queryByTestId('token-speed-cards')).not.toBeInTheDocument();
		expect(screen.getByTestId('token-speed-stats')).not.toHaveTextContent('0 tok/s');
	});

	it('keeps mixed-provider costs and raw model aliases distinct from the authoritative total', async () => {
		const rawModels = ['grok-4-fast', 'grok-4-fast-non-reasoning'];
		const known = makeTotals({
			costUsd: 1.25,
			costEstimated: false,
			accounting: {
				completeness: 'partial',
				cost: { status: 'partial', costUsdTicks: '12500000000' },
			},
		});
		const unknown = makeTotals({
			costUsd: 0,
			costEstimated: false,
			accounting: { completeness: 'unknown', cost: { status: 'unknown' } },
		});
		vi.mocked(window.maestro.stats.getTokenUsage).mockResolvedValue({
			...aggregate,
			totals: {
				...known,
				accounting: {
					completeness: 'partial',
					cost: { status: 'partial', costUsdTicks: '32500000000' },
				},
			},
			byAgent: [
				{ ...known, key: 'grok', label: 'Grok CLI' },
				{
					...makeTotals({ costUsd: 2, costEstimated: false }),
					key: 'claude-code',
					label: 'Claude Code',
				},
			],
			byModel: [known, unknown].map((totals, i) => ({
				...totals,
				key: JSON.stringify(['grok', rawModels[i]]),
				label: rawModels[i],
			})),
			byAccount: [known, unknown].map((totals, i) => ({
				...totals,
				key: providerProfileKey('grok', `fixture-account-${i}`),
				label: `Grok account ${i}`,
			})),
		});
		mountTokens();
		expect(
			await screen.findByRole('group', { name: 'Total Cost: $3.25 (partial)' })
		).toBeInTheDocument();
		const agents = screen.getByTestId('token-by-agent');
		expect(within(agents).getByText('$1.25 (partial)')).toBeInTheDocument();
		expect(within(agents).getByText('$2.00')).toBeInTheDocument();
		for (const [i, cost] of ['$1.25 (partial)', 'Unknown'].entries()) {
			const models = screen.getByTestId('token-by-model');
			const model = within(models).getByText(rawModels[i]);
			expect(model).toHaveAttribute('title', JSON.stringify(['grok', rawModels[i]]));
			expect(model.parentElement).toHaveTextContent(cost);
			const account = within(screen.getByTestId('token-by-account')).getByText(`Grok account ${i}`);
			expect(account).toHaveAttribute('title', `fixture-account-${i}`);
			expect(account.parentElement).toHaveTextContent(cost);
		}
		expect(screen.getByText(/partial amounts include only known spend/)).toBeInTheDocument();
	});

	it.each([false, true])(
		'preserves legacy cost display with estimated=%s',
		async (costEstimated) => {
			vi.mocked(window.maestro.stats.getTokenUsage).mockResolvedValue({
				...aggregate,
				totals: makeTotals({ costUsd: 2, costEstimated }),
			});
			mountTokens();
			expect(
				await screen.findByRole('group', { name: `Total Cost: ${costEstimated ? '~' : ''}$2.00` })
			).toBeInTheDocument();
		}
	);
});

describe('Grok token presentation', () => {
	beforeEach(() => {
		storage.clear();
		clearCachedResources();
	});

	/** An aggregate shaped like the accessor's Grok output over two accounts. */
	function grokAggregate(cost: UsageCost, completeness: 'complete' | 'partial' | 'unknown') {
		const totals = makeTotals({
			inputTokens: 60,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheCreationTokens: 10,
			costUsd: 0,
			costEstimated: false,
			sessionCount: 2,
			accounting: { completeness, cost },
		});
		const half = { ...totals, inputTokens: 30, outputTokens: 10, sessionCount: 1 };
		return {
			...aggregate,
			totals,
			byAgent: [{ ...totals, key: 'grok', label: 'Grok CLI' }],
			byAccount: ['alpha', 'beta'].map((a) => ({
				...half,
				key: providerProfileKey('grok', `/home/u/.grok-${a}`),
				label: `Grok ${a}`,
			})),
			timeline: [bucket(1_700_000_000_000, totals)],
			coverageByAgent: {
				grok: completeness === 'complete' ? ('full' as const) : ('partial' as const),
			},
		};
	}

	function mountWith(data: TokenUsageAggregate) {
		(window as unknown as { maestro: unknown }).maestro = {
			stats: { getTokenUsage: vi.fn().mockResolvedValue(data) },
		};
		return mountTokens();
	}

	it.each<{
		name: string;
		cost: UsageCost;
		completeness: 'complete' | 'partial' | 'unknown';
		text: string;
	}>([
		{
			name: 'exact zero',
			cost: { status: 'exact', costUsdTicks: '0' },
			completeness: 'complete',
			text: '$0.00',
		},
		{ name: 'unknown', cost: { status: 'unknown' }, completeness: 'unknown', text: 'Unknown' },
		{
			name: 'unknown merged with zero',
			cost: { status: 'partial', costUsdTicks: '0', costUsd: 0 },
			completeness: 'partial',
			text: '$0.00 (partial)',
		},
	])('shows $name Grok spend apart from token counts', async ({ cost, completeness, text }) => {
		mountWith(grokAggregate(cost, completeness));
		expect(await screen.findByRole('group', { name: `Total Cost: ${text}` })).toBeInTheDocument();
		// Tokens are never presented as money, and cache creation counts on the input side.
		expect(screen.getByRole('group', { name: 'Input Tokens: 60' })).toBeInTheDocument();
		expect(screen.getByText('30% of input served from cache')).toBeInTheDocument();
		expect(screen.getByTestId('token-stats')).toHaveTextContent(
			'2 sessions read from agent transcripts.'
		);
		for (const a of ['alpha', 'beta']) {
			const row = within(screen.getByTestId('token-by-account')).getByText(`Grok ${a}`);
			expect(row).toHaveAttribute('title', `/home/u/.grok-${a}`);
			expect(row.parentElement).toHaveTextContent(text);
		}
		expect(screen.queryByText(/~ are estimated/)).not.toBeInTheDocument();
		expect(screen.getByText(/partial amounts include only known spend/)).toBeInTheDocument();
		// No provider quota, balance or reset data is invented on this tab.
		expect(screen.getByTestId('token-stats')).not.toHaveTextContent(
			/quota|balance|unlimited|resets?/i
		);
	});
});
