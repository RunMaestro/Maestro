/**
 * Tests for SymphonyModal/components/SymphonyAchievementBadge - earned vs unearned
 * styling, progress bar, check icon.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = () => <svg data-testid={`icon-${name}`} />;
		C.displayName = name;
		return C;
	};
	return { CheckCircle: icon('CheckCircle') };
});

import { SymphonyAchievementBadge } from '../../../../../renderer/components/SymphonyModal/components/SymphonyAchievementBadge';
import { mockTheme, makeAchievement } from '../_fixtures';

describe('SymphonyAchievementBadge', () => {
	it('renders title, description, and icon', () => {
		const { getByText } = render(
			<SymphonyAchievementBadge
				achievement={makeAchievement({
					title: 'First PR',
					description: 'Submit your first contribution',
					icon: '🥇',
				})}
				theme={mockTheme}
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
				theme={mockTheme}
			/>
		);
		expect(queryByTestId('icon-CheckCircle')).toBeNull();

		rerender(
			<SymphonyAchievementBadge achievement={makeAchievement({ earned: true })} theme={mockTheme} />
		);
		expect(queryByTestId('icon-CheckCircle')).toBeTruthy();
	});

	it('applies a faded style when not earned', () => {
		const { container } = render(
			<SymphonyAchievementBadge
				achievement={makeAchievement({ earned: false })}
				theme={mockTheme}
			/>
		);
		const root = container.firstChild as HTMLElement;
		expect(root.style.opacity).toBe('0.5');
	});

	it('renders the progress bar when unearned and progress is set', () => {
		const { container } = render(
			<SymphonyAchievementBadge
				achievement={makeAchievement({ earned: false, progress: 42 })}
				theme={mockTheme}
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
				theme={mockTheme}
			/>
		);
		const bar = container.querySelector('div.rounded-full[style*="width"]');
		expect(bar).toBeNull();
	});
});
