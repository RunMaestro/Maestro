/**
 * PromptCadenceStats lays out `data.prompts`; the math is tested in
 * `src/__tests__/shared/promptCadence.test.ts`. What is tested here is which
 * panels render for which shape of window, and that the tiles show the
 * cadence's own figures rather than re-deriving them.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PromptCadenceStats } from '../../../../renderer/components/UsageDashboard/PromptCadenceStats';
import { computePromptCadence, emptyPromptCadence } from '../../../../shared/promptCadence';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];
const NOW = new Date(2026, 9, 16, 15, 0).getTime();
const at = (day: number, hour: number, minute = 0) =>
	new Date(2026, 9, day, hour, minute).getTime();

function weekCadence() {
	return computePromptCadence({
		timestamps: [
			at(10, 9),
			at(10, 9, 5),
			at(12, 14),
			at(13, 10),
			at(13, 10, 3),
			at(13, 10, 9),
			at(16, 11),
		],
		windowStart: '2026-10-10',
		now: NOW,
	});
}

describe('PromptCadenceStats', () => {
	it('explains the empty state instead of drawing zero tiles', () => {
		render(<PromptCadenceStats cadence={emptyPromptCadence(NOW)} theme={theme} />);
		expect(screen.getByText(/No prompts in this time range/)).toBeInTheDocument();
		expect(screen.queryByTestId('prompt-total')).toBeNull();
	});

	it('renders the cadence figures on the tiles', () => {
		render(<PromptCadenceStats cadence={weekCadence()} theme={theme} />);
		expect(within(screen.getByTestId('prompt-total')).getByText('7')).toBeInTheDocument();
		expect(
			within(screen.getByTestId('prompt-total')).getByText('4 of 7 days active')
		).toBeInTheDocument();
		// (2 + 0 + 1 + 3 + 0 + 0) / 6 complete days
		expect(within(screen.getByTestId('prompt-average')).getByText('1')).toBeInTheDocument();
		expect(within(screen.getByTestId('prompt-max')).getByText('3')).toBeInTheDocument();
		expect(within(screen.getByTestId('prompt-min')).getByText('1')).toBeInTheDocument();
		expect(within(screen.getByTestId('prompt-peak-hour')).getByText('10 AM')).toBeInTheDocument();
	});

	it('draws one bar per calendar day plus the hour and weekday strips', () => {
		render(<PromptCadenceStats cadence={weekCadence()} theme={theme} />);
		expect(screen.getAllByTestId('prompt-cadence-bar')).toHaveLength(7);
		expect(screen.getByTestId('prompt-cadence-by-hour')).toBeInTheDocument();
		expect(screen.getByTestId('prompt-cadence-by-weekday')).toBeInTheDocument();
	});

	it('drops the per-day panels for a single-day window', () => {
		const today = computePromptCadence({
			timestamps: [at(16, 9), at(16, 10)],
			windowStart: '2026-10-16',
			now: NOW,
		});
		render(<PromptCadenceStats cadence={today} theme={theme} />);
		expect(screen.getByText('Today so far.', { exact: false })).toBeInTheDocument();
		expect(screen.queryByTestId('prompt-cadence-chart')).toBeNull();
		expect(screen.queryByTestId('prompt-cadence-by-weekday')).toBeNull();
		expect(screen.getByTestId('prompt-cadence-by-hour')).toBeInTheDocument();
	});
});
