// Source: src/__tests__/renderer/components/PlaygroundPanel/components/AchievementsView.test.tsx
// Source: src/__tests__/renderer/components/SymphonyModal/components/SymphonyAchievementBadge.test.tsx
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { AchievementsView } from '../../../../../renderer/components/PlaygroundPanel/components';
import { makeAchievementState } from '../_fixtures';
import { mockTheme } from '../_fixtures';
import { SymphonyAchievementBadge } from '../../../../../renderer/components/SymphonyModal/components/SymphonyAchievementBadge';
import { mockTheme as source0_mockTheme } from '../../SymphonyModal/_fixtures';
import { makeAchievement } from '../../SymphonyModal/_fixtures';
vi.mock('../../../../../renderer/components/AchievementCard', () => ({
	AchievementCard: ({ autoRunStats }: { autoRunStats: unknown }) => (
		<div data-testid="achievement-card" data-stats={JSON.stringify(autoRunStats)}>
			Achievement Card
		</div>
	),
}));
vi.mock('lucide-react', async (importOriginal) => {
	const actual = await importOriginal<typeof import('lucide-react')>();
	const icon = (name: string) => {
		const C = () => <svg data-testid={`icon-${name}`} />;
		C.displayName = name;
		return C;
	};
	return { ...actual, CheckCircle: icon('CheckCircle') };
});
describe('AchievementsView', () => {
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

			const standingSection = screen
				.getByText('Standing Ovation Test')
				.closest('div')?.parentElement;
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

			const masterySection = screen
				.getByText('Keyboard Mastery Test')
				.closest('div')?.parentElement;
			const select = masterySection?.querySelector('select');
			fireEvent.change(select!, { target: { value: '3' } });
			fireEvent.click(screen.getByRole('button', { name: /Trigger Keyboard Mastery Celebration/ }));

			expect(achievements.setKeyboardMasteryLevel).toHaveBeenCalledWith(3);
			expect(achievements.triggerKeyboardMastery).toHaveBeenCalledTimes(1);
		});
	});
});
describe('SymphonyAchievementBadge', () => {
	describe('SymphonyAchievementBadge', () => {
		it('renders title, description, and icon', () => {
			const { getByText } = render(
				<SymphonyAchievementBadge
					achievement={makeAchievement({
						title: 'First PR',
						description: 'Submit your first contribution',
						icon: '🥇',
					})}
					theme={source0_mockTheme}
				/>
			);
			expect(getByText('First PR')).toBeTruthy();
			expect(getByText('Submit your first contribution')).toBeTruthy();
			expect(getByText('🥇')).toBeTruthy();
		});

		it('shows the CheckCircle icon only when earned', () => {
			const { queryByTestId, rerender } = render(
				<SymphonyAchievementBadge
					achievement={makeAchievement({ earned: false })}
					theme={source0_mockTheme}
				/>
			);
			expect(queryByTestId('icon-CheckCircle')).toBeNull();

			rerender(
				<SymphonyAchievementBadge
					achievement={makeAchievement({ earned: true })}
					theme={source0_mockTheme}
				/>
			);
			expect(queryByTestId('icon-CheckCircle')).toBeTruthy();
		});

		it('applies a faded style when not earned', () => {
			const { container } = render(
				<SymphonyAchievementBadge
					achievement={makeAchievement({ earned: false })}
					theme={source0_mockTheme}
				/>
			);
			const root = container.firstChild as HTMLElement;
			expect(root.style.opacity).toBe('0.5');
		});

		it('renders the progress bar when unearned and progress is set', () => {
			const { container } = render(
				<SymphonyAchievementBadge
					achievement={makeAchievement({ earned: false, progress: 42 })}
					theme={source0_mockTheme}
				/>
			);
			const bar = container.querySelector('div.rounded-full[style*="width"]');
			expect(bar).toBeTruthy();
			expect((bar as HTMLElement).style.width).toBe('42%');
		});

		it('omits the progress bar when earned (no need for it)', () => {
			const { container } = render(
				<SymphonyAchievementBadge
					achievement={makeAchievement({ earned: true, progress: 100 })}
					theme={source0_mockTheme}
				/>
			);
			const bar = container.querySelector('div.rounded-full[style*="width"]');
			expect(bar).toBeNull();
		});
	});
});
