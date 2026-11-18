/**
 * Tests for the Resilience panel (Tokens tab).
 *
 * Verifies:
 * - Summary math: survived, bridged downtime, recovery rate, retries
 * - Error state when the read fails (never "no outages")
 * - Day timeline covers every calendar day of the range, stepping by local
 *   day (a DST change cannot skip one), and is a single keyboard stop
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
	ResilienceStats,
	buildResilienceDays,
	summarizeResilience,
} from '../../../../renderer/components/UsageDashboard/ResilienceStats';
import type { ResilienceEvent } from '../../../../shared/stats-types';
import { THEMES } from '../../../../shared/themes';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const theme = THEMES['dracula'];
const MINUTE = 60_000;

function outage(overrides: Partial<ResilienceEvent> = {}): ResilienceEvent {
	const startedAt = Date.now() - 1000;
	return {
		id: 'o-1',
		sessionId: 'agent-1',
		agentType: 'claude-code',
		strategy: 'availability',
		outcome: 'recovered',
		startedAt,
		resolvedAt: startedAt + 5 * MINUTE,
		retries: 2,
		...overrides,
	};
}

const getResilience = () =>
	window.maestro.stats.getResilience as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	getResilience().mockReset();
	getResilience().mockResolvedValue([]);
});

describe('summarizeResilience', () => {
	it('bridges only recovered downtime and rates recovered over all outages', () => {
		const summary = summarizeResilience([
			outage({ id: 'a', strategy: 'token-exhaustion' }),
			outage({ id: 'b' }),
			outage({ id: 'c', outcome: 'stopped', retries: 1 }),
		]);
		expect(summary).toMatchObject({
			total: 3,
			recovered: 2,
			quotaRecovered: 1,
			availabilityRecovered: 1,
			bridgedMs: 10 * MINUTE,
			longestMs: 5 * MINUTE,
			retries: 5,
			rate: 67,
		});
	});
});

describe('buildResilienceDays', () => {
	it('has one entry per calendar day of the range, zero-filled', () => {
		const now = new Date(2026, 2, 10, 12).getTime();
		const days = buildResilienceDays(
			[outage({ startedAt: new Date(2026, 2, 8, 9).getTime() })],
			'week',
			{ recovered: 'green', stopped: 'red' },
			now
		);
		expect(days.map((d) => d.date)).toEqual([
			'2026-03-04',
			'2026-03-05',
			'2026-03-06',
			'2026-03-07',
			'2026-03-08',
			'2026-03-09',
			'2026-03-10',
		]);
		expect(days[4]).toMatchObject({ recovered: 1, stopped: 0 });
	});
});

describe('ResilienceStats', () => {
	it('renders the tiles for the range', async () => {
		getResilience().mockResolvedValue([outage(), outage({ id: 'b', outcome: 'stopped' })]);
		render(<ResilienceStats timeRange="week" theme={theme} />);

		const label = await screen.findByText('Recovery Rate');
		expect(label.parentElement!.parentElement).toHaveTextContent(/50%/);
		expect(screen.getByText('1 of 2 outages')).toBeInTheDocument();
	});

	it('shows the empty state for a quiet range', async () => {
		render(<ResilienceStats timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('resilience-stats-empty')).toBeInTheDocument();
	});

	it('shows an error, not "no outages", when the read fails', async () => {
		getResilience().mockRejectedValueOnce(new Error('locked'));
		render(<ResilienceStats timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('resilience-stats-error')).toBeInTheDocument();
		expect(screen.queryByTestId('resilience-stats-empty')).not.toBeInTheDocument();
	});

	it('draws a 7-day timeline that the keyboard can read', async () => {
		getResilience().mockResolvedValue([outage()]);
		render(<ResilienceStats timeRange="week" theme={theme} />);

		const bars = await screen.findByTestId('resilience-timeline-bars');
		expect(bars.children).toHaveLength(7);
		expect(within(bars).queryAllByRole('button')).toHaveLength(0);
		fireEvent.keyDown(bars, { key: 'End' });
		expect(await screen.findByTestId('resilience-timeline-tooltip')).toHaveTextContent(
			'1 recovered'
		);
	});
});
