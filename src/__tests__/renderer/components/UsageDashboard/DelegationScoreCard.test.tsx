/**
 * Tests for the Delegation Score card.
 *
 * The card carries two marks that mean different things - a fill at the highest
 * milestone ever unlocked, and a live marker at the current score - and it
 * writes the high-water mark to settings. Those are the parts worth pinning:
 * the fill must never retreat, and a score that merely ROUNDS UP to a milestone
 * must not unlock it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DelegationScoreCard } from '../../../../renderer/components/UsageDashboard/DelegationScoreCard';
import { mockTheme } from '../../../helpers/mockTheme';
import type { DelegationTotals } from '../../../../shared/delegation';

vi.mock('lucide-react', () => ({
	Info: () => <span data-testid="info-icon" />,
	Rocket: () => <span data-testid="rocket-icon" />,
}));

const HOUR = 3_600_000;

function totals(interactiveMs: number, autoRunMs: number, cueMs = 0): DelegationTotals {
	return {
		interactive: { count: 10, durationMs: interactiveMs },
		autoRun: { count: 2, durationMs: autoRunMs },
		cue: { count: 1, durationMs: cueMs },
	};
}

describe('DelegationScoreCard', () => {
	const onUnlockMilestone = vi.fn();

	beforeEach(() => vi.clearAllMocks());

	it('scores Auto Run and Cue together against interactive time', () => {
		render(
			<DelegationScoreCard
				totals={totals(1 * HOUR, 2 * HOUR, 1 * HOUR)}
				theme={mockTheme}
				unlockedMilestone={0}
				onUnlockMilestone={onUnlockMilestone}
			/>
		);
		expect(screen.getByTestId('delegation-score-value')).toHaveTextContent('75%');
	});

	it('unlocks the milestone the raw score reached', () => {
		render(
			<DelegationScoreCard
				totals={totals(1 * HOUR, 3 * HOUR)}
				theme={mockTheme}
				unlockedMilestone={0}
				onUnlockMilestone={onUnlockMilestone}
			/>
		);
		expect(onUnlockMilestone).toHaveBeenCalledWith(75);
	});

	it('does not unlock a milestone the score only rounds up to', () => {
		// 74.6% renders as "75%" but has not earned the 75 mark.
		render(
			<DelegationScoreCard
				totals={totals(254, 746)}
				theme={mockTheme}
				unlockedMilestone={0}
				onUnlockMilestone={onUnlockMilestone}
			/>
		);
		expect(screen.getByTestId('delegation-score-value')).toHaveTextContent('75%');
		expect(onUnlockMilestone).toHaveBeenCalledWith(50);
	});

	it('keeps the bar filled at the stored milestone after the score falls', () => {
		render(
			<DelegationScoreCard
				totals={totals(9 * HOUR, 1 * HOUR)}
				theme={mockTheme}
				unlockedMilestone={75}
				onUnlockMilestone={onUnlockMilestone}
			/>
		);
		expect(screen.getByTestId('delegation-score-value')).toHaveTextContent('10%');
		expect(screen.getByTestId('delegation-milestone-fill')).toHaveStyle({ width: '75%' });
		// And it must not try to re-write a mark it already holds.
		expect(onUnlockMilestone).not.toHaveBeenCalled();
	});

	it('renders an honest empty state and unlocks nothing without data', () => {
		render(
			<DelegationScoreCard
				totals={null}
				theme={mockTheme}
				unlockedMilestone={0}
				onUnlockMilestone={onUnlockMilestone}
			/>
		);
		expect(screen.getByTestId('delegation-score-value')).toHaveTextContent('0%');
		expect(screen.queryByTestId('delegation-live-marker')).not.toBeInTheDocument();
		expect(onUnlockMilestone).not.toHaveBeenCalled();
	});

	it('names the next milestone and what it would take', () => {
		render(
			<DelegationScoreCard
				totals={totals(1 * HOUR, 0)}
				theme={mockTheme}
				unlockedMilestone={0}
				onUnlockMilestone={onUnlockMilestone}
			/>
		);
		const next = screen.getByTestId('delegation-next-milestone');
		expect(next).toHaveTextContent('Next: 25%');
		// 1h interactive, nothing delegated: 20m of delegated time reaches 25%,
		// because the added time counts on both sides of the ratio.
		expect(next).toHaveTextContent('20m');
	});
});
