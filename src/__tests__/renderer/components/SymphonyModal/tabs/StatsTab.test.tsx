/**
 * Tests for SymphonyModal/tabs/StatsTab - three stat cards, achievement grid,
 * streak labels.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = () => <svg data-testid={`icon-${name}`} />;
		C.displayName = name;
		return C;
	};
	return {
		Zap: icon('Zap'),
		Clock: icon('Clock'),
		Flame: icon('Flame'),
		Trophy: icon('Trophy'),
		CheckCircle: icon('CheckCircle'),
	};
});

import { StatsTab } from '../../../../../renderer/components/SymphonyModal/tabs/StatsTab';
import { mockTheme, makeAchievement } from '../_fixtures';

const baseProps = (overrides: Partial<React.ComponentProps<typeof StatsTab>> = {}) => ({
	theme: mockTheme,
	formattedTotalTokens: '40K',
	formattedTotalCost: '$3.20',
	formattedTotalTime: '1h 30m',
	uniqueRepos: 4,
	currentStreakWeeks: 2,
	longestStreakWeeks: 5,
	achievements: [
		makeAchievement({ id: 'first-pr', title: 'First PR', earned: true }),
		makeAchievement({ id: 'streak-3', title: '3-week streak', earned: false }),
	],
	...overrides,
});

describe('StatsTab', () => {
	it('renders the three stat cards with their headers', () => {
		const { getByText } = render(<StatsTab {...baseProps()} />);
		expect(getByText('Tokens Donated')).toBeTruthy();
		expect(getByText('Time Contributed')).toBeTruthy();
		expect(getByText('Streak')).toBeTruthy();
	});

	it('formats the tokens-donated card with "Worth ..." sub-label', () => {
		const { getByText } = render(<StatsTab {...baseProps()} />);
		expect(getByText('40K')).toBeTruthy();
		expect(getByText('Worth $3.20')).toBeTruthy();
	});

	it('renders unique repos count under Time Contributed', () => {
		const { getByText } = render(<StatsTab {...baseProps()} />);
		expect(getByText('4 repositories')).toBeTruthy();
	});

	it('renders streak: "N weeks" + "Best: M weeks"', () => {
		const { getByText } = render(<StatsTab {...baseProps()} />);
		expect(getByText('2 weeks')).toBeTruthy();
		expect(getByText('Best: 5 weeks')).toBeTruthy();
	});

	it('renders one badge per achievement', () => {
		const { getByText } = render(<StatsTab {...baseProps()} />);
		expect(getByText('First PR')).toBeTruthy();
		expect(getByText('3-week streak')).toBeTruthy();
	});

	it('renders the Achievements header with Trophy icon', () => {
		const { getByText, getByTestId } = render(<StatsTab {...baseProps()} />);
		expect(getByText('Achievements')).toBeTruthy();
		expect(getByTestId('icon-Trophy')).toBeTruthy();
	});

	it('renders empty achievements without crashing', () => {
		const { getByText } = render(<StatsTab {...baseProps({ achievements: [] })} />);
		expect(getByText('Achievements')).toBeTruthy();
	});
});
