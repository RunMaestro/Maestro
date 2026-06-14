import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONDUCTOR_BADGES } from '../../../../renderer/constants/conductorBadges';
import {
	BadgeHero,
	BadgeHistoryTimeline,
	BadgeProgressionBar,
	BadgeProgressRing,
	BadgeProgressToNext,
	BadgeStatsGrid,
	BadgeTooltip,
	MaxLevelCelebration,
} from '../../../../renderer/components/AchievementCard/components';
import { firstBadgeStats, level5Stats, mockTheme } from './_fixtures';

vi.mock('../../../../renderer/components/MaestroSilhouette', () => ({
	MaestroSilhouette: ({ style }: { style?: React.CSSProperties }) => (
		<div data-testid="maestro-silhouette" style={style}>
			Maestro Silhouette
		</div>
	),
}));

describe('AchievementCard components', () => {
	it('renders progress ring segments with locked and unlocked colors', () => {
		const { container } = render(
			<div className="relative">
				<BadgeProgressRing currentLevel={1} size={72} theme={mockTheme} />
			</div>
		);

		const svg = container.querySelector('svg[viewBox="0 0 72 72"]');
		const paths = svg?.querySelectorAll('path');

		expect(paths).toHaveLength(11);
		expect(paths?.[0]).toHaveAttribute('opacity', '1');
		expect(paths?.[0]).toHaveAttribute('stroke', mockTheme.colors.accent);
		expect(paths?.[5]).toHaveAttribute('opacity', '0.3');
		expect(paths?.[5]).toHaveAttribute('stroke', mockTheme.colors.border);
	});

	it('clamps next-badge progress width', () => {
		const { container, rerender } = render(
			<BadgeProgressToNext
				theme={mockTheme}
				nextBadge={CONDUCTOR_BADGES[1]}
				timeRemaining="10m remaining"
				progressPercent={150}
			/>
		);

		let progress = container.querySelector('.h-full.rounded-full') as HTMLElement;
		expect(progress).toHaveStyle({ width: '100%' });

		rerender(
			<BadgeProgressToNext
				theme={mockTheme}
				nextBadge={CONDUCTOR_BADGES[1]}
				timeRemaining="10m remaining"
				progressPercent={-10}
			/>
		);

		progress = container.querySelector('.h-full.rounded-full') as HTMLElement;
		expect(progress).toHaveStyle({ width: '0%' });
	});

	it('renders the no-badge hero state', () => {
		render(<BadgeHero currentBadge={null} currentLevel={0} theme={mockTheme} />);

		expect(screen.getByText('No Badge Yet')).toBeInTheDocument();
		expect(screen.getByText('Complete 15 minutes of AutoRun to unlock')).toBeInTheDocument();
		expect(screen.getByTestId('maestro-silhouette')).toHaveStyle({ opacity: '0.3' });
	});

	it('renders the unlocked hero state', () => {
		render(<BadgeHero currentBadge={CONDUCTOR_BADGES[0]} currentLevel={1} theme={mockTheme} />);

		expect(screen.getByText('Apprentice Conductor')).toBeInTheDocument();
		expect(screen.getByText('Level 1 of 11')).toBeInTheDocument();
		expect(screen.getByTestId('maestro-silhouette')).toHaveStyle({ opacity: '1' });
	});

	it('renders the stats grid labels and values', () => {
		render(
			<BadgeStatsGrid
				theme={mockTheme}
				cumulativeTimeFormatted="15m 0s"
				longestRunFormatted="10m 0s"
				totalRuns={3}
			/>
		);

		expect(screen.getByText('Total Time')).toBeInTheDocument();
		expect(screen.getByText('Longest Run')).toBeInTheDocument();
		expect(screen.getByText('Total Runs')).toBeInTheDocument();
		expect(screen.getByText('15m 0s')).toBeInTheDocument();
		expect(screen.getByText('10m 0s')).toBeInTheDocument();
		expect(screen.getByText('3')).toBeInTheDocument();
	});

	it('renders progression segments and tooltip selection', () => {
		const toggleBadge = vi.fn();
		const ref = { current: null };
		const { container } = render(
			<BadgeProgressionBar
				theme={mockTheme}
				allBadges={CONDUCTOR_BADGES}
				currentLevel={5}
				selectedBadge={5}
				badgeContainerRef={ref}
				onToggleBadge={toggleBadge}
			/>
		);

		expect(screen.getByText('5/11 unlocked')).toBeInTheDocument();
		expect(screen.getByText('Level 5')).toBeInTheDocument();
		expect(container.querySelectorAll('.h-3.rounded-full.cursor-pointer')).toHaveLength(11);

		fireEvent.click(container.querySelectorAll('.h-3.rounded-full.cursor-pointer')[0]);
		expect(toggleBadge).toHaveBeenCalledWith(1);
	});

	it('renders unlocked and locked tooltip states and opens conductor links', () => {
		render(
			<BadgeTooltip badge={CONDUCTOR_BADGES[0]} theme={mockTheme} isUnlocked position="left" />
		);

		expect(screen.getByText('Level 1')).toBeInTheDocument();
		expect(screen.getByText('Unlocked')).toBeInTheDocument();
		expect(screen.getByText(`"${CONDUCTOR_BADGES[0].flavorText}"`)).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole('button', { name: CONDUCTOR_BADGES[0].exampleConductor.name })
		);
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			CONDUCTOR_BADGES[0].exampleConductor.wikipediaUrl
		);
	});

	it('omits flavor text for locked tooltips', () => {
		render(
			<BadgeTooltip
				badge={CONDUCTOR_BADGES[4]}
				theme={mockTheme}
				isUnlocked={false}
				position="center"
			/>
		);

		expect(screen.getByText('Locked')).toBeInTheDocument();
		expect(screen.queryByText(`"${CONDUCTOR_BADGES[4].flavorText}"`)).not.toBeInTheDocument();
	});

	it('expands and collapses badge history', () => {
		render(<BadgeHistoryTimeline theme={mockTheme} badgeHistory={level5Stats.badgeHistory} />);

		fireEvent.click(screen.getByText('Path to the Podium: Timeline'));
		expect(screen.getByText('Principal Guest')).toBeInTheDocument();
		expect(screen.getByText('Apprentice')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Path to the Podium: Timeline'));
		expect(screen.queryByText('Principal Guest')).not.toBeInTheDocument();
	});

	it('hides badge history for one or zero records', () => {
		const { rerender } = render(
			<BadgeHistoryTimeline theme={mockTheme} badgeHistory={firstBadgeStats.badgeHistory} />
		);

		expect(screen.queryByText('Path to the Podium: Timeline')).not.toBeInTheDocument();

		rerender(<BadgeHistoryTimeline theme={mockTheme} badgeHistory={[]} />);
		expect(screen.queryByText('Path to the Podium: Timeline')).not.toBeInTheDocument();
	});

	it('renders the max-level celebration', () => {
		render(<MaxLevelCelebration theme={mockTheme} />);

		expect(screen.getByText('Maximum Level Achieved!')).toBeInTheDocument();
		expect(screen.getByText('You are a true Titan of the Baton')).toBeInTheDocument();
		expect(screen.getAllByTestId('star-icon')).toHaveLength(2);
	});
});
