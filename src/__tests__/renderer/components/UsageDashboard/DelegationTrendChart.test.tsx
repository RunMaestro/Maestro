/**
 * Tests for DelegationTrendChart's x-axis label density.
 *
 * `computeAxisLabelIndices` owns the thinning rule and is unit-tested beside it
 * in `chartUtils.test.ts`. What is tested HERE is the WIRING: that the chart
 * actually passes a smaller budget on a phone. That is the half a refactor can
 * drop silently - the helper keeps its default, every test of it still passes,
 * and the only symptom is seven date labels printed on top of each other on a
 * 390px screen.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { DelegationTrendChart } from '../../../../renderer/components/UsageDashboard/DelegationTrendChart';
import type { DelegationDay } from '../../../../shared/delegation';
import { THEMES } from '../../../../shared/themes';

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
		<DelegationTrendChart days={monthOfDays()} timeRange="month" theme={theme} />
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
