import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AchievementsView } from '../../../../../renderer/components/PlaygroundPanel/components';
import { makeAchievementState, mockTheme } from '../_fixtures';

vi.mock('../../../../../renderer/components/AchievementCard', () => ({
	AchievementCard: ({ autoRunStats }: { autoRunStats: unknown }) => (
		<div data-testid="achievement-card" data-stats={JSON.stringify(autoRunStats)}>
			Achievement Card
		</div>
	),
}));

describe('AchievementsView', () => {
	it('renders achievement controls and preview', () => {
		render(<AchievementsView theme={mockTheme} achievements={makeAchievementState()} />);

		expect(screen.getByText('Quick Set Badge Level')).toBeInTheDocument();
		expect(screen.getByText('Manual Time Controls')).toBeInTheDocument();
		expect(screen.getByText('Standing Ovation Test')).toBeInTheDocument();
		expect(screen.getByText('Keyboard Mastery Test')).toBeInTheDocument();
		expect(screen.getByTestId('achievement-card')).toBeInTheDocument();
	});

	it('wires badge buttons and reset actions', () => {
		const achievements = makeAchievementState();
		render(<AchievementsView theme={mockTheme} achievements={achievements} />);

		fireEvent.click(screen.getByRole('button', { name: 'Lv 1' }));
		fireEvent.click(screen.getByRole('button', { name: /Reset All Mock Data/ }));

		expect(achievements.setToBadgeLevel).toHaveBeenCalledWith(1);
		expect(achievements.resetMockData).toHaveBeenCalledTimes(1);
	});

	it('wires time sliders to converted values', () => {
		const achievements = makeAchievementState();
		render(<AchievementsView theme={mockTheme} achievements={achievements} />);

		const sliders = screen.getAllByRole('slider');
		fireEvent.change(sliders[0], { target: { value: '50' } });
		fireEvent.change(sliders[1], { target: { value: '25' } });
		fireEvent.change(sliders[2], { target: { value: '111' } });

		expect(achievements.setMockCumulativeTime).toHaveBeenCalledWith(expect.any(Number));
		expect(achievements.setMockLongestRun).toHaveBeenCalledWith(expect.any(Number));
		expect(achievements.setMockTotalRuns).toHaveBeenCalledWith(111);
	});

	it('wires standing ovation selection, flag, and trigger', () => {
		const achievements = makeAchievementState();
		render(<AchievementsView theme={mockTheme} achievements={achievements} />);

		const standingSection = screen.getByText('Standing Ovation Test').closest('div')?.parentElement;
		const select = standingSection?.querySelector('select');
		fireEvent.change(select!, { target: { value: '2' } });
		fireEvent.click(screen.getByLabelText('Show as New Record'));
		fireEvent.click(screen.getByRole('button', { name: /Trigger Standing Ovation/ }));

		expect(achievements.setOvationBadgeLevel).toHaveBeenCalledWith(2);
		expect(achievements.setOvationIsNewRecord).toHaveBeenCalledWith(true);
		expect(achievements.triggerOvation).toHaveBeenCalledTimes(1);
	});

	it('wires keyboard mastery level and trigger', () => {
		const achievements = makeAchievementState();
		render(<AchievementsView theme={mockTheme} achievements={achievements} />);

		const masterySection = screen.getByText('Keyboard Mastery Test').closest('div')?.parentElement;
		const select = masterySection?.querySelector('select');
		fireEvent.change(select!, { target: { value: '3' } });
		fireEvent.click(screen.getByRole('button', { name: /Trigger Keyboard Mastery Celebration/ }));

		expect(achievements.setKeyboardMasteryLevel).toHaveBeenCalledWith(3);
		expect(achievements.triggerKeyboardMastery).toHaveBeenCalledTimes(1);
	});
});
