/**
 * Tests for the Shortcuts tab (KeyboardStats).
 *
 * Verifies:
 * - The day axis spans the range's whole calendar window, zero-filled
 * - Mastery is labelled all time; firings follow the range
 * - "Most used shortcuts" names each shortcut from the live bindings
 * - Real empty and error states (not a zero-height chart)
 * - The daily chart is one keyboard stop with a tooltip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
	KeyboardStats,
	buildContinuousSeries,
} from '../../../../renderer/components/UsageDashboard/KeyboardStats';
import { toLocalYmd } from '../../../../shared/localDay';
import { THEMES } from '../../../../shared/themes';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const theme = THEMES['dracula'];

const stats = () => window.maestro.stats as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	stats().getShortcutUsageByDay.mockReset().mockResolvedValue([]);
	stats().getShortcutUsageTotal.mockReset().mockResolvedValue(0);
	stats().getShortcutUsageByShortcut.mockReset().mockResolvedValue([]);
});

describe('buildContinuousSeries', () => {
	it('fills every day of a bounded range, the same window the query used', () => {
		const now = new Date(2026, 4, 10, 15).getTime();
		const series = buildContinuousSeries([{ date: '2026-05-08', count: 3 }], 'week', now);
		expect(series).toHaveLength(7);
		expect(series[0].date).toBe('2026-05-04');
		expect(series[6].date).toBe('2026-05-10');
		expect(series[4]).toEqual({ date: '2026-05-08', count: 3 });
		expect(series.filter((d) => d.count === 0)).toHaveLength(6);
	});

	it('starts an all-time series at the first day with data', () => {
		const now = new Date(2026, 4, 10, 15).getTime();
		const series = buildContinuousSeries([{ date: '2026-05-07', count: 1 }], 'all', now);
		expect(series.map((d) => d.date)).toEqual([
			'2026-05-07',
			'2026-05-08',
			'2026-05-09',
			'2026-05-10',
		]);
	});
});

describe('KeyboardStats', () => {
	it('labels mastery as all time and firings as the selected range', async () => {
		stats().getShortcutUsageTotal.mockResolvedValue(12);
		stats().getShortcutUsageByDay.mockResolvedValue([{ date: toLocalYmd(Date.now()), count: 12 }]);
		render(<KeyboardStats timeRange="week" theme={theme} />);

		expect(await screen.findByText('Keyboard Mastery (all time)')).toBeInTheDocument();
		expect(screen.getByText('Unused Shortcuts (all time)')).toBeInTheDocument();
		const firings = (await screen.findByText('Shortcut Firings')).parentElement!.parentElement!;
		expect(firings).toHaveTextContent(/12/);
		expect(firings).toHaveTextContent(/in the selected range/);
	});

	it('shows a real empty state for a range with no firings', async () => {
		render(<KeyboardStats timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('shortcut-daily-empty')).toHaveTextContent(
			'No shortcut firings in this range'
		);
		expect(screen.getByTestId('shortcut-most-used-empty')).toBeInTheDocument();
	});

	it('shows an error when the read fails', async () => {
		stats().getShortcutUsageTotal.mockRejectedValueOnce(new Error('locked'));
		render(<KeyboardStats timeRange="week" theme={theme} />);
		expect(await screen.findByTestId('shortcut-daily-error')).toBeInTheDocument();
	});

	it('lists the most used shortcuts by name with their counts', async () => {
		stats().getShortcutUsageTotal.mockResolvedValue(9);
		stats().getShortcutUsageByDay.mockResolvedValue([{ date: toLocalYmd(Date.now()), count: 9 }]);
		stats().getShortcutUsageByShortcut.mockResolvedValue([
			{ shortcutId: 'toggleSidebar', count: 7 },
			{ shortcutId: 'retired-shortcut', count: 2 },
		]);
		render(<KeyboardStats timeRange="week" theme={theme} />);

		const rows = await screen.findAllByTestId('shortcut-most-used-row');
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).getByText('Toggle Left Panel')).toBeInTheDocument();
		expect(within(rows[0]).getByText('7')).toBeInTheDocument();
		// An id with no binding any more still shows, by id.
		expect(within(rows[1]).getByText('retired-shortcut')).toBeInTheDocument();
		expect(stats().getShortcutUsageByShortcut).toHaveBeenCalledWith('week');
	});

	it('makes the daily chart a single tab stop with a tooltip', async () => {
		const today = toLocalYmd(Date.now());
		stats().getShortcutUsageTotal.mockResolvedValue(4);
		stats().getShortcutUsageByDay.mockResolvedValue([{ date: today, count: 4 }]);
		render(<KeyboardStats timeRange="week" theme={theme} />);

		const bars = await screen.findByTestId('shortcut-daily-bars');
		expect(bars.children).toHaveLength(7);
		expect(bars).toHaveAttribute('tabindex', '0');
		fireEvent.keyDown(bars, { key: 'End' });
		expect(await screen.findByTestId('shortcut-day-tooltip')).toHaveTextContent('4 shortcuts');
	});
});
