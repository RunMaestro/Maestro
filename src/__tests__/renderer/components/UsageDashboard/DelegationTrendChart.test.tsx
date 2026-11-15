/**
 * Tests for DelegationTrendChart's x-axis label density.
 *
 * `computeAxisLabelIndices` owns the thinning rule and is unit-tested beside it
 * in `chartUtils.test.ts`. What is tested HERE is the WIRING: that the chart
 * actually passes a smaller budget on a phone. That is the half a refactor can
 * drop silently - the helper keeps its default, every test of it still passes,
 * and the only symptom is seven date labels printed on top of each other on a
 * 390px screen.
 *
 * Also: the bars span the whole selected window, the Cue retention caption
 * reads the user's retention setting, the Time/Queries choice is remembered,
 * and the tooltip is the shared ChartTooltip.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DelegationTrendChart } from '../../../../renderer/components/UsageDashboard/DelegationTrendChart';
import type { DelegationDay } from '../../../../shared/delegation';
import { THEMES } from '../../../../shared/themes';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

const storage = new Map<string, string>();
vi.mock('../../../../renderer/utils/safeLocalStorage', () => ({
	safeStorageGet: (key: string) => (storage.has(key) ? storage.get(key)! : null),
	safeStorageSet: (key: string, value: string) => {
		storage.set(key, value);
	},
}));

vi.mock('../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';

const theme = THEMES['dracula'];

/** A month of days, so the axis has far more ticks than either budget labels. */
function monthOfDays(): DelegationDay[] {
	return Array.from({ length: 30 }, (_, i) => ({
		date: `2026-09-${String(i + 1).padStart(2, '0')}`,
		interactive: { count: 10 + i, durationMs: (10 + i) * 60_000 },
		autoRun: { count: i, durationMs: i * 60_000 },
		cue: { count: 0, durationMs: 0 },
	}));
}

/**
 * Render the chart and read the date captions under its bars.
 *
 * Each render is unmounted before the next, so the two runs cannot see each
 * other's DOM - the query is by class rather than a test id, which would
 * otherwise match both.
 */
function renderAxisLabels(phone: boolean): string[] {
	vi.mocked(usePhoneLayout).mockReturnValue(phone);
	const { container, unmount } = render(
		<DelegationTrendChart
			days={monthOfDays()}
			dayWindow={{ startYmd: '2026-09-01', endYmd: '2026-09-30' }}
			theme={theme}
		/>
	);
	const row = container.querySelector('[aria-hidden="true"].relative.mt-2');
	const labels = row
		? Array.from(row.querySelectorAll('span')).map((el) => el.textContent ?? '')
		: [];
	unmount();
	return labels;
}

describe('DelegationTrendChart axis labels', () => {
	afterEach(() => {
		vi.mocked(usePhoneLayout).mockReturnValue(false);
	});

	it('thins the labels on a phone and keeps both ends', () => {
		const wide = renderAxisLabels(false);
		const narrow = renderAxisLabels(true);

		// Seven "Aug 20"-sized labels need ~300px; a phone chart gets ~340px.
		expect(wide.length).toBeGreaterThan(narrow.length);
		expect(narrow.length).toBeGreaterThanOrEqual(2);
		// Both budgets still print the first and last date - the axis has to end
		// on the real end date whatever the density.
		expect(narrow[0]).toBe(wide[0]);
		expect(narrow[narrow.length - 1]).toBe(wide[wide.length - 1]);
	});
});

describe('DelegationTrendChart window, retention, and persistence', () => {
	beforeEach(() => {
		storage.clear();
		useSettingsStore.setState({ cueHistoryRetentionDays: 7 } as never);
	});

	it('draws a bar for every day of the window, not just first to last active day', () => {
		render(
			<DelegationTrendChart
				days={monthOfDays().slice(10, 12)}
				dayWindow={{ startYmd: '2026-09-01', endYmd: '2026-09-30' }}
				theme={theme}
			/>
		);
		expect(screen.getAllByTestId('delegation-trend-bar')).toHaveLength(30);
	});

	it('says there is no activity when the window is all zeros', () => {
		render(
			<DelegationTrendChart
				days={[]}
				dayWindow={{ startYmd: '2026-09-01', endYmd: '2026-09-07' }}
				theme={theme}
			/>
		);
		expect(screen.getByText('No activity in this range')).toBeInTheDocument();
		expect(screen.queryAllByTestId('delegation-trend-bar')).toHaveLength(0);
	});

	it('names the retention setting in the Cue caption, and drops it inside the window', () => {
		useSettingsStore.setState({ cueHistoryRetentionDays: 14 } as never);
		const window30 = { startYmd: '2026-09-01', endYmd: '2026-09-30' };
		const { unmount } = render(
			<DelegationTrendChart days={monthOfDays()} dayWindow={window30} theme={theme} />
		);
		expect(screen.getByTestId('delegation-trend-cue-notice')).toHaveTextContent(
			'Cue runs older than 14 days are pruned'
		);
		unmount();

		render(
			<DelegationTrendChart
				days={monthOfDays().slice(0, 7)}
				dayWindow={{ startYmd: '2026-09-01', endYmd: '2026-09-07' }}
				theme={theme}
			/>
		);
		expect(screen.queryByTestId('delegation-trend-cue-notice')).toBeNull();
	});

	it('remembers the Time / Queries choice', () => {
		const window30 = { startYmd: '2026-09-01', endYmd: '2026-09-30' };
		const { unmount } = render(
			<DelegationTrendChart days={monthOfDays()} dayWindow={window30} theme={theme} />
		);
		fireEvent.click(screen.getByRole('button', { name: /query count/i }));
		expect(storage.get('usageDashboard.activity.delegationMode')).toBe('count');
		unmount();

		render(<DelegationTrendChart days={monthOfDays()} dayWindow={window30} theme={theme} />);
		expect(screen.getByRole('button', { name: /query count/i }).getAttribute('aria-pressed')).toBe(
			'true'
		);
	});

	it('shows the hovered bar in the shared tooltip', () => {
		render(
			<DelegationTrendChart
				days={monthOfDays()}
				dayWindow={{ startYmd: '2026-09-01', endYmd: '2026-09-30' }}
				theme={theme}
			/>
		);
		fireEvent.mouseEnter(screen.getAllByTestId('delegation-trend-bar')[2], {
			clientX: 100,
			clientY: 100,
		});
		expect(screen.getByTestId('delegation-trend-tooltip')).toHaveTextContent('Interactive');
	});
});
