/**
 * Tests for the Tokens tab timeline legend.
 *
 * The legend is a set of series toggles, not a static key. What matters:
 * - Clicking an entry hides its series from the stack AND rescales the chart,
 *   which is the whole point (cache reads otherwise flatten input and output).
 * - The choice is written to storage under a stable key, so it survives a
 *   restart, and is read back on the next mount.
 * - The last visible series cannot be hidden - an empty chart says nothing.
 *
 * Plus the tab's framing: cost is labeled API-equivalent, and the footer says
 * what the totals leave out (partial providers, SSH agents, unsupported ones).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { THEMES } from '../../../../shared/themes';
import type {
	TokenUsageAggregate,
	TokenUsageTimeBucket,
	TokenUsageTotals,
} from '../../../../shared/tokenUsage';
import { emptyTokenSpeedSummary } from '../../../../shared/tokenSpeed';

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

import {
	TokenStats,
	tokenCoverageNotes,
} from '../../../../renderer/components/UsageDashboard/TokenStats';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';

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
	excluded: { unsupportedAgents: [], remoteProjects: 0 },
	granularity: 'day',
	windowStartMs: 1_700_000_000_000,
	windowEndMs: 1_700_086_400_000,
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

		for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) {
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
		fireEvent.click(screen.getByTestId('token-timeline-legend-cacheCreationTokens'));

		const last = screen.getByTestId('token-timeline-legend-cacheReadTokens');
		await waitFor(() => expect((last as HTMLButtonElement).disabled).toBe(true));

		fireEvent.click(last);
		expect(last.getAttribute('aria-pressed')).toBe('true');
	});
});

describe('TokenStats framing', () => {
	beforeEach(() => {
		storage.clear();
		clearCachedResources();
	});

	function mountWith(over: Partial<TokenUsageAggregate>) {
		(window as unknown as { maestro: unknown }).maestro = {
			stats: { getTokenUsage: vi.fn().mockResolvedValue({ ...aggregate, ...over }) },
		};
		return render(<TokenStats timeRange="week" theme={theme} />);
	}

	it('labels the cost API-equivalent rather than as spend', async () => {
		mountWith({});
		await screen.findByTestId('token-timeline');
		expect(screen.getByText('API-equivalent Cost')).toBeInTheDocument();
		expect(screen.queryByText('Total Cost')).not.toBeInTheDocument();
	});

	it('states the last-activity attribution in the footer', async () => {
		mountWith({});
		const coverage = await screen.findByTestId('token-stats-coverage');
		expect(coverage.textContent).toContain('count toward the day of its last activity');
	});

	it('lists partial providers and what is not counted', async () => {
		mountWith({
			coverageByAgent: { 'claude-code': 'full', codex: 'partial' },
			excluded: { unsupportedAgents: ['grok'], remoteProjects: 1 },
		});
		const coverage = await screen.findByTestId('token-stats-coverage');
		expect(coverage.textContent).toContain('Partial token data for Codex');
		expect(coverage.textContent).toContain('agents running over SSH');
		expect(coverage.textContent).toContain('Grok');
	});

	it('shows the error, not an empty state, when the read fails', async () => {
		(window as unknown as { maestro: unknown }).maestro = {
			stats: { getTokenUsage: vi.fn().mockRejectedValue(new Error('disk on fire')) },
		};
		render(<TokenStats timeRange="quarter" theme={theme} />);
		const error = await screen.findByTestId('token-stats-error');
		expect(error.textContent).toContain('disk on fire');
		expect(screen.queryByTestId('token-stats-empty')).not.toBeInTheDocument();
	});
});

describe('tokenCoverageNotes', () => {
	it('says nothing when coverage is full and nothing was skipped', () => {
		expect(
			tokenCoverageNotes({ ...aggregate, coverageByAgent: { 'claude-code': 'full' } })
		).toEqual([]);
	});
});
