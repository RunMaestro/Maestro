/**
 * Tests for the token speed surfaces: the shared avg/peak cards (Overview and
 * Tokens tab), the Overview row that fetches its own range, and the Tokens tab
 * section with its metric toggle and sortable tables.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { THEMES } from '../../../../shared/themes';
import {
	emptyTokenSpeedSummary,
	type TokenSpeedGroup,
	type TokenSpeedStats,
	type TokenSpeedSummary,
} from '../../../../shared/tokenSpeed';
import type { TokenUsageAggregate } from '../../../../shared/tokenUsage';

const storage = new Map<string, string>();
vi.mock('../../../../renderer/utils/safeLocalStorage', () => ({
	safeStorageGet: (key: string) => (storage.has(key) ? storage.get(key)! : null),
	safeStorageSet: (key: string, value: string) => {
		storage.set(key, value);
	},
}));

import {
	OverviewTokenSpeed,
	TokenSpeedCards,
} from '../../../../renderer/components/UsageDashboard/TokenSpeedCards';
import { TokenSpeedStats as TokenSpeedSection } from '../../../../renderer/components/UsageDashboard/TokenSpeedStats';

const theme = THEMES['dracula'];
const HOUR = new Date(2026, 9, 15, 14, 0).getTime();

function stats(over: Partial<TokenSpeedStats> = {}): TokenSpeedStats {
	return {
		calls: 10,
		inputTokens: 100_000,
		outputTokens: 1_000,
		durationMs: 10_000,
		avgInputTps: 10_000,
		avgOutputTps: 100,
		avgTotalTps: 10_100,
		peakInputTps: 40_000,
		peakOutputTps: 250,
		peakTotalTps: 40_250,
		...over,
	};
}

function group(key: string, over: Partial<TokenSpeedStats> = {}): TokenSpeedGroup {
	return { key, label: key, ...stats(over) };
}

function summary(over: Partial<TokenSpeedSummary> = {}): TokenSpeedSummary {
	return {
		...emptyTokenSpeedSummary(),
		overall: stats({ peakOutputAtMs: HOUR, peakOutputModel: 'claude-opus-5-5' }),
		byAgent: [group('Claude Code', { avgOutputTps: 120 }), group('Codex', { avgOutputTps: 50 })],
		byModel: [
			group('claude-opus-5-5', { avgOutputTps: 118 }),
			group('gpt-6.1', { avgOutputTps: 49 }),
		],
		byHourOfDay: Array.from({ length: 24 }, (_, h) =>
			h === 3 ? stats({ avgOutputTps: 140 }) : h === 9 ? stats({ avgOutputTps: 80 }) : stats()
		),
		granularity: 'day',
		timeline: [
			{ startMs: HOUR, ...stats() },
			{ startMs: HOUR + 86_400_000, ...stats({ avgOutputTps: 110 }) },
		],
		busiestHour: { startMs: HOUR, inputTps: 30_000, outputTps: 400, totalTps: 30_400 },
		measuredAgents: ['claude-code', 'codex'],
		...over,
	};
}

beforeEach(() => {
	storage.clear();
});

describe('TokenSpeedCards', () => {
	it('shows average and peak input, output, and total rates', () => {
		render(<TokenSpeedCards speed={summary()} theme={theme} />);

		const cards = screen.getByTestId('token-speed-cards');
		for (const label of [
			'Avg Output',
			'Avg Input',
			'Avg Total',
			'Peak Output',
			'Peak Input',
			'Peak Total',
		]) {
			expect(within(cards).getByText(label)).toBeInTheDocument();
		}
		expect(within(cards).getByText('100 tok/s')).toBeInTheDocument();
		expect(within(cards).getByText('10.0K tok/s')).toBeInTheDocument();
		expect(within(cards).getByText('250 tok/s')).toBeInTheDocument();
		// Where the output peak happened, and on what.
		expect(within(cards).getByText(/claude-opus-5-5 · Oct 15, 2 PM/)).toBeInTheDocument();
		expect(within(cards).getByText(/busiest hour: 30.4K tok\/s/)).toBeInTheDocument();
	});

	it('explains an empty range instead of showing zero rates', () => {
		render(<TokenSpeedCards speed={emptyTokenSpeedSummary()} theme={theme} />);
		expect(screen.getByTestId('token-speed-empty')).toHaveTextContent('No timed API calls');
		expect(screen.queryByTestId('token-speed-cards')).not.toBeInTheDocument();
	});
});

describe('OverviewTokenSpeed', () => {
	it('fetches the range and renders its cards', async () => {
		const getTokenUsage = vi.fn().mockResolvedValue({ speed: summary() } as TokenUsageAggregate);
		(window as unknown as { maestro: unknown }).maestro = { stats: { getTokenUsage } };

		render(<OverviewTokenSpeed timeRange="week" theme={theme} />);

		expect(await screen.findByTestId('overview-token-speed')).toBeInTheDocument();
		expect(screen.getByText('Tokens per Second')).toBeInTheDocument();
		expect(getTokenUsage).toHaveBeenCalledWith(
			expect.objectContaining({ granularity: 'day' }),
			false
		);
	});

	it('reports a failed read when there is nothing to show', async () => {
		const getTokenUsage = vi.fn().mockRejectedValue(new Error('no transcripts'));
		(window as unknown as { maestro: unknown }).maestro = { stats: { getTokenUsage } };

		render(<OverviewTokenSpeed timeRange="day" theme={theme} />);

		expect(
			await screen.findByText(/Couldn't read token speed: no transcripts/)
		).toBeInTheDocument();
	});
});

describe('TokenSpeedStats section', () => {
	it('draws the charts and both tables', () => {
		render(<TokenSpeedSection speed={summary()} theme={theme} />);

		expect(screen.getByTestId('token-speed-timeline')).toBeInTheDocument();
		expect(screen.getByTestId('token-speed-by-agent-chart')).toBeInTheDocument();
		expect(screen.getByTestId('token-speed-by-model-chart')).toBeInTheDocument();
		expect(screen.getAllByTestId('token-speed-by-agent-row')).toHaveLength(2);
		expect(screen.getAllByTestId('token-speed-by-model-row')).toHaveLength(2);
	});

	it('names the fastest and slowest hour of day', () => {
		render(<TokenSpeedSection speed={summary()} theme={theme} />);
		expect(screen.getByTestId('token-speed-by-hour')).toHaveTextContent(
			'Fastest 3a (140), slowest 9a (80.0)'
		);
	});

	it('switches every chart to the chosen metric and remembers the choice', () => {
		render(<TokenSpeedSection speed={summary()} theme={theme} />);
		expect(screen.getByText('Output tokens per second over time')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('token-speed-metric-input'));

		expect(screen.getByText('Input tokens per second over time')).toBeInTheDocument();
		expect(screen.getByText('Input speed by provider')).toBeInTheDocument();
		expect(storage.get('usageDashboard.tokens.speedMetric')).toBe('input');
	});

	it('sorts a table by the clicked column', () => {
		render(<TokenSpeedSection speed={summary()} theme={theme} />);
		const rows = () =>
			screen.getAllByTestId('token-speed-by-model-row').map((r) => r.firstChild?.textContent);

		// Fastest average output first by default.
		expect(rows()).toEqual(['claude-opus-5-5', 'gpt-6.1']);

		const sortByName = () =>
			act(() => {
				fireEvent.click(
					within(screen.getByTestId('token-speed-by-model-sort-label')).getByRole('button')
				);
			});

		// A text column starts A-Z.
		sortByName();
		expect(rows()).toEqual(['claude-opus-5-5', 'gpt-6.1']);

		sortByName();
		expect(rows()).toEqual(['gpt-6.1', 'claude-opus-5-5']);
	});

	it('keeps only the cards when nothing was measured', () => {
		render(<TokenSpeedSection speed={emptyTokenSpeedSummary()} theme={theme} />);
		expect(screen.getByTestId('token-speed-empty')).toBeInTheDocument();
		expect(screen.queryByTestId('token-speed-timeline')).not.toBeInTheDocument();
	});
});
