import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { AchievementCard } from '../../../renderer/components/AchievementCard';
import type { Theme } from '../../../renderer/types';
import type { AutoRunStats } from '../../../renderer/types';

// Mock the MaestroSilhouette component
vi.mock('../../../renderer/components/MaestroSilhouette', () => ({
	MaestroSilhouette: ({
		variant,
		size,
		style,
	}: {
		variant: string;
		size: number;
		style?: React.CSSProperties;
	}) => (
		<div data-testid="maestro-silhouette" data-variant={variant} data-size={size} style={style}>
			Maestro Silhouette
		</div>
	),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Trophy: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="trophy-icon" className={className} style={style} />
	),
	Clock: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="clock-icon" className={className} style={style} />
	),
	Zap: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="zap-icon" className={className} style={style} />
	),
	Star: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="star-icon" className={className} style={style} />
	),
	ExternalLink: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="external-link-icon" className={className} style={style} />
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="chevron-down-icon" className={className} style={style} />
	),
	History: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="history-icon" className={className} style={style} />
	),
	Share2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="share-icon" className={className} style={style} />
	),
	Copy: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="copy-icon" className={className} style={style} />
	),
	Download: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="download-icon" className={className} style={style} />
	),
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="check-icon" className={className} style={style} />
	),
}));

// Test theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e2e',
		bgSidebar: '#181825',
		bgActivity: '#11111b',
		textMain: '#cdd6f4',
		textDim: '#a6adc8',
		accent: '#8B5CF6',
		border: '#313244',
		success: '#a6e3a1',
		warning: '#f9e2af',
		error: '#f38ba8',
		info: '#89dceb',
		highlight: '#f5c2e7',
	},
};

// Base autoRunStats for tests
const baseAutoRunStats: AutoRunStats = {
	cumulativeTimeMs: 0,
	longestRunMs: 0,
	totalRuns: 0,
	lastRunMs: 0,
	badgeHistory: [],
};

// AutoRunStats with some progress (15 minutes = first badge - Apprentice Conductor)
const firstBadgeStats: AutoRunStats = {
	cumulativeTimeMs: 15 * 60 * 1000, // 15 minutes
	longestRunMs: 10 * 60 * 1000, // 10 minutes
	totalRuns: 3,
	lastRunMs: 5 * 60 * 1000,
	badgeHistory: [{ level: 1, unlockedAt: Date.now() - 86400000 }],
};

// AutoRunStats at level 5 (1 week)
const level5Stats: AutoRunStats = {
	cumulativeTimeMs: 7 * 24 * 60 * 60 * 1000, // 1 week
	longestRunMs: 2 * 60 * 60 * 1000, // 2 hours
	totalRuns: 15,
	lastRunMs: 30 * 60 * 1000,
	badgeHistory: [
		{ level: 1, unlockedAt: Date.now() - 86400000 * 5 },
		{ level: 2, unlockedAt: Date.now() - 86400000 * 4 },
		{ level: 3, unlockedAt: Date.now() - 86400000 * 3 },
		{ level: 4, unlockedAt: Date.now() - 86400000 * 2 },
		{ level: 5, unlockedAt: Date.now() - 86400000 },
	],
};

// Max level stats (10 years = level 11)
const maxLevelStats: AutoRunStats = {
	cumulativeTimeMs: 10 * 365 * 24 * 60 * 60 * 1000, // 10 years
	longestRunMs: 24 * 60 * 60 * 1000, // 24 hours
	totalRuns: 1000,
	lastRunMs: 60 * 60 * 1000,
	badgeHistory: Array.from({ length: 11 }, (_, i) => ({
		level: i + 1,
		unlockedAt: Date.now() - 86400000 * (11 - i),
	})),
};

// Mock globalStats
const mockGlobalStats = {
	totalSessions: 150,
	totalMessages: 5000,
	totalInputTokens: 1000000,
	totalOutputTokens: 500000,
	totalCacheReadTokens: 200000,
	totalCacheCreationTokens: 100000,
	totalCostUsd: 45.67,
	totalSizeBytes: 10000000,
	isComplete: true,
};

// Mock ClipboardItem for jsdom environment
class MockClipboardItem {
	private _data: Record<string, Blob>;
	constructor(data: Record<string, Blob>) {
		this._data = data;
	}
	get types() {
		return Object.keys(this._data);
	}
	getType(type: string) {
		return Promise.resolve(this._data[type]);
	}
}
(global as any).ClipboardItem = MockClipboardItem;

// Mock navigator.clipboard.write for jsdom environment
const mockClipboard = {
	write: vi.fn().mockResolvedValue(undefined),
	writeText: vi.fn().mockResolvedValue(undefined),
	read: vi.fn().mockResolvedValue([]),
	readText: vi.fn().mockResolvedValue(''),
};
Object.defineProperty(navigator, 'clipboard', {
	value: mockClipboard,
	writable: true,
});

describe('AchievementCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Basic Rendering', () => {
		it('renders the achievement card container', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});

		it('renders with correct theme colors', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />
			);

			const card = container.firstChild as HTMLElement;
			expect(card).toHaveStyle({ borderColor: mockTheme.colors.border });
			expect(card).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
		});

		it('renders trophy icons', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			// There are multiple trophy icons (header and stats grid)
			const trophyIcons = screen.getAllByTestId('trophy-icon');
			expect(trophyIcons.length).toBeGreaterThan(0);
		});

		it('renders share button', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			expect(screen.getByTestId('share-icon')).toBeInTheDocument();
		});

		it('renders Maestro silhouette', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			expect(screen.getByTestId('maestro-silhouette')).toBeInTheDocument();
		});
	});

	describe('No Badge State', () => {
		it('shows "No Badge Yet" message when no time accumulated', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			expect(screen.getByText('No Badge Yet')).toBeInTheDocument();
		});

		it('shows unlock hint for first badge', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			expect(screen.getByText('Complete 15 minutes of AutoRun to unlock')).toBeInTheDocument();
		});

		it('renders silhouette with low opacity when no badge', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			const silhouette = screen.getByTestId('maestro-silhouette');
			expect(silhouette).toHaveStyle({ opacity: '0.3' });
		});

		it('shows 0/11 unlocked when no badges', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={baseAutoRunStats} />);

			expect(screen.getByText('0/11 unlocked')).toBeInTheDocument();
		});
	});

	describe('First Badge State', () => {
		it('shows badge name for first level (Apprentice Conductor)', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('Apprentice Conductor')).toBeInTheDocument();
		});

		it('shows level indicator', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('Level 1 of 11')).toBeInTheDocument();
		});

		it('shows progress bar to next level', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			// Should show "Next: Assistant" (shortName for level 2)
			expect(screen.getByText(/Next:/)).toBeInTheDocument();
		});

		it('renders silhouette with full opacity when badge unlocked', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const silhouette = screen.getByTestId('maestro-silhouette');
			expect(silhouette).toHaveStyle({ opacity: '1' });
		});

		it('shows level badge number', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			// Look for the text "1" - the level number
			expect(screen.getByText('1')).toBeInTheDocument();
		});

		it('shows 1/11 unlocked', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('1/11 unlocked')).toBeInTheDocument();
		});
	});

	describe('Stats Grid', () => {
		it('renders three stat columns', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('Total Time')).toBeInTheDocument();
			expect(screen.getByText('Longest Run')).toBeInTheDocument();
			expect(screen.getByText('Total Runs')).toBeInTheDocument();
		});

		it('shows formatted total time', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			// formatCumulativeTime(15 min) returns "15m 0s"
			expect(screen.getByText('15m 0s')).toBeInTheDocument();
		});

		it('shows total runs count', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('3')).toBeInTheDocument();
		});

		it('renders clock icon for Total Time', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByTestId('clock-icon')).toBeInTheDocument();
		});

		it('renders zap icon for Total Runs', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByTestId('zap-icon')).toBeInTheDocument();
		});
	});

	describe('Badge Progression Bar', () => {
		it('shows progression label', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('Badge Progression')).toBeInTheDocument();
		});

		it('shows correct unlocked count for level 5', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />);

			expect(screen.getByText('5/11 unlocked')).toBeInTheDocument();
		});

		it('renders 11 badge segments', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			// Each badge segment is an h-3 rounded-full div
			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			expect(segments.length).toBe(11);
		});
	});

	describe('Badge Tooltip', () => {
		it('opens tooltip when clicking on a badge segment', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Click first segment
			fireEvent.click(segments[0]);

			// Should show Level 1 in tooltip
			expect(screen.getByText('Level 1')).toBeInTheDocument();
		});

		it('shows badge description in tooltip', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			fireEvent.click(segments[0]);

			// Level 1 - should show "Unlocked" status
			expect(screen.getByText('Unlocked')).toBeInTheDocument();
		});

		it('shows "Locked" for unearned badges', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			// Click on level 5 segment (index 4)
			fireEvent.click(segments[4]);

			expect(screen.getByText('Locked')).toBeInTheDocument();
		});

		it('closes tooltip when clicking on same badge again', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Click to open
			fireEvent.click(segments[0]);
			expect(screen.getByText('Level 1')).toBeInTheDocument();

			// Click again to close
			fireEvent.click(segments[0]);

			// Tooltip should close - Level 1 text only exists in tooltip
			await waitFor(() => {
				expect(screen.queryByText('Level 1')).not.toBeInTheDocument();
			});
		});

		it('shows external link button in tooltip', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			fireEvent.click(segments[0]);

			expect(screen.getByTestId('external-link-icon')).toBeInTheDocument();
		});

		it('opens external link when clicking conductor link', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			fireEvent.click(segments[0]);

			// Find the button with external link (Gustavo Dudamel for level 1)
			const linkButton = screen.getByRole('button', { name: /Gustavo Dudamel/i });
			fireEvent.click(linkButton);

			expect(window.maestro.shell.openExternal).toHaveBeenCalled();
		});

		it('closes tooltip when clicking outside', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			fireEvent.click(segments[0]);

			expect(screen.getByText('Level 1')).toBeInTheDocument();

			// Advance timers to allow click listener to be added
			vi.advanceTimersByTime(10);

			// Click outside (on document)
			fireEvent.click(document.body);

			await waitFor(() => {
				expect(screen.queryByText('Level 1')).not.toBeInTheDocument();
			});
		});

		it('shows flavor text only for unlocked badges', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Level 1 (unlocked) - should show flavor text in quotes
			fireEvent.click(segments[0]);
			// Check for italic text (flavor text styling)
			const italicText = container.querySelector('.italic');
			expect(italicText).toBeInTheDocument();
		});
	});

	describe('Badge Unlock History', () => {
		it('does not show history for first badge only', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.queryByText('Path to the Podium: Timeline')).not.toBeInTheDocument();
		});

		it('shows history button for multiple badges', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />);

			expect(screen.getByText('Path to the Podium: Timeline')).toBeInTheDocument();
		});

		it('expands history when clicking button', async () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />);

			const historyButton = screen.getByText('Path to the Podium: Timeline');
			fireEvent.click(historyButton);

			// Should show badge history entries - short names
			await waitFor(() => {
				expect(screen.getByText('Principal Guest')).toBeInTheDocument(); // Level 5 shortName
			});
		});

		it('shows history icon', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />);

			expect(screen.getByTestId('history-icon')).toBeInTheDocument();
		});

		it('collapses history when clicking again', async () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />);

			const historyButton = screen.getByText('Path to the Podium: Timeline');

			// Expand
			fireEvent.click(historyButton);
			await waitFor(() => {
				expect(screen.getByText('Principal Guest')).toBeInTheDocument();
			});

			// Collapse
			fireEvent.click(historyButton);
			await waitFor(() => {
				expect(screen.queryByText('Principal Guest')).not.toBeInTheDocument();
			});
		});
	});

	describe('Max Level Celebration', () => {
		it('shows celebration message at max level', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />);

			expect(screen.getByText('Maximum Level Achieved!')).toBeInTheDocument();
		});

		it('shows star icons in celebration', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />);

			const stars = screen.getAllByTestId('star-icon');
			expect(stars.length).toBe(2);
		});

		it('shows "Titan of the Baton" text', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />);

			expect(screen.getByText('You are a true Titan of the Baton')).toBeInTheDocument();
		});

		it('does not show progress bar at max level', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />);

			// "Next:" text only appears when there's a next badge
			expect(screen.queryByText(/Next:/)).not.toBeInTheDocument();
		});

		it('shows 11/11 unlocked', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />);

			expect(screen.getByText('11/11 unlocked')).toBeInTheDocument();
		});
	});

	describe('Share Menu', () => {
		it('opens share menu when clicking share button', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');
			fireEvent.click(shareButton);

			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();
			expect(screen.getByText('Save as Image')).toBeInTheDocument();
		});

		it('closes share menu when clicking again', async () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');

			// Open
			fireEvent.click(shareButton);
			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();

			// Close
			fireEvent.click(shareButton);
			await waitFor(() => {
				expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument();
			});
		});

		it('renders copy icon in menu', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');
			fireEvent.click(shareButton);

			expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
		});

		it('renders download icon in menu', () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');
			fireEvent.click(shareButton);

			expect(screen.getByTestId('download-icon')).toBeInTheDocument();
		});

		it('closes share menu when clicking outside', async () => {
			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');
			fireEvent.click(shareButton);

			expect(screen.getByText('Copy to Clipboard')).toBeInTheDocument();

			// Advance timers
			vi.advanceTimersByTime(10);

			// Click outside
			fireEvent.click(document.body);

			await waitFor(() => {
				expect(screen.queryByText('Copy to Clipboard')).not.toBeInTheDocument();
			});
		});
	});

	describe('Copy to Clipboard', () => {
		it('attempts to generate image for clipboard', async () => {
			// Mock canvas context for image generation
			const mockContext = {
				createRadialGradient: vi.fn().mockReturnValue({
					addColorStop: vi.fn(),
				}),
				createLinearGradient: vi.fn().mockReturnValue({
					addColorStop: vi.fn(),
				}),
				fillStyle: '',
				strokeStyle: '',
				lineWidth: 0,
				font: '',
				textAlign: '',
				textBaseline: '',
				letterSpacing: '',
				fillRect: vi.fn(),
				roundRect: vi.fn(),
				fill: vi.fn(),
				stroke: vi.fn(),
				beginPath: vi.fn(),
				arc: vi.fn(),
				fillText: vi.fn(),
				measureText: vi.fn().mockReturnValue({ width: 100 }),
			};
			HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext);

			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');
			fireEvent.click(shareButton);

			const copyButton = screen.getByText('Copy to Clipboard');

			// Clicking copy button should trigger image generation
			fireEvent.click(copyButton);

			// The canvas context should be accessed for image generation
			expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled();
		});
	});

	describe('Download Image', () => {
		it('attempts to generate image for download', async () => {
			// Mock canvas context
			const mockContext = {
				createRadialGradient: vi.fn().mockReturnValue({
					addColorStop: vi.fn(),
				}),
				createLinearGradient: vi.fn().mockReturnValue({
					addColorStop: vi.fn(),
				}),
				fillStyle: '',
				strokeStyle: '',
				lineWidth: 0,
				font: '',
				textAlign: '',
				textBaseline: '',
				letterSpacing: '',
				fillRect: vi.fn(),
				roundRect: vi.fn(),
				fill: vi.fn(),
				stroke: vi.fn(),
				beginPath: vi.fn(),
				arc: vi.fn(),
				fillText: vi.fn(),
				measureText: vi.fn().mockReturnValue({ width: 100 }),
			};
			HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext);

			render(<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />);

			const shareButton = screen.getByTitle('Share achievements');
			fireEvent.click(shareButton);

			const saveButton = screen.getByText('Save as Image');
			fireEvent.click(saveButton);

			// The canvas context should be accessed for image generation
			expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled();
		});
	});

	describe('Global Stats Display', () => {
		it('displays global stats when provided', () => {
			// GlobalStats are shown in the shareable image, not in the main UI
			// The main UI shows autoRunStats
			render(
				<AchievementCard
					theme={mockTheme}
					autoRunStats={firstBadgeStats}
					globalStats={mockGlobalStats}
				/>
			);

			// Should still render normally
			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});

		it('handles null globalStats', () => {
			render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} globalStats={null} />
			);

			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});

		it('handles undefined globalStats', () => {
			render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} globalStats={undefined} />
			);

			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});
	});

	describe('Escape Handler', () => {
		it('calls onEscapeWithBadgeOpen with handler when badge is selected', () => {
			const mockOnEscape = vi.fn();
			const { container } = render(
				<AchievementCard
					theme={mockTheme}
					autoRunStats={firstBadgeStats}
					onEscapeWithBadgeOpen={mockOnEscape}
				/>
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			fireEvent.click(segments[0]);

			// Should have called with a function
			expect(mockOnEscape).toHaveBeenCalledWith(expect.any(Function));
		});

		it('calls onEscapeWithBadgeOpen with null when badge is deselected', async () => {
			const mockOnEscape = vi.fn();
			const { container } = render(
				<AchievementCard
					theme={mockTheme}
					autoRunStats={firstBadgeStats}
					onEscapeWithBadgeOpen={mockOnEscape}
				/>
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Select badge
			fireEvent.click(segments[0]);
			expect(mockOnEscape).toHaveBeenCalledWith(expect.any(Function));

			// Deselect badge
			fireEvent.click(segments[0]);

			await waitFor(() => {
				expect(mockOnEscape).toHaveBeenCalledWith(null);
			});
		});

		it('escape handler closes badge and returns true', () => {
			let capturedHandler: (() => boolean) | null = null;
			const mockOnEscape = vi.fn((handler) => {
				capturedHandler = handler;
			});

			const { container } = render(
				<AchievementCard
					theme={mockTheme}
					autoRunStats={firstBadgeStats}
					onEscapeWithBadgeOpen={mockOnEscape}
				/>
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');
			fireEvent.click(segments[0]);

			// Now call the captured handler
			expect(capturedHandler).not.toBeNull();
			const result = capturedHandler!();

			expect(result).toBe(true);
		});
	});

	describe('Badge Progress Ring', () => {
		it('renders SVG with correct dimensions', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const svg = container.querySelector('svg[viewBox="0 0 72 72"]');
			expect(svg).toBeInTheDocument();
		});

		it('renders 11 path segments', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const svg = container.querySelector('svg[viewBox="0 0 72 72"]');
			const paths = svg?.querySelectorAll('path');
			expect(paths?.length).toBe(11);
		});

		it('unlocked segments have higher opacity', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const svg = container.querySelector('svg[viewBox="0 0 72 72"]');
			const paths = svg?.querySelectorAll('path');

			// First segment (level 1) should be unlocked with opacity 1
			expect(paths?.[0]).toHaveAttribute('opacity', '1');

			// Later segments should be locked with opacity 0.3
			expect(paths?.[5]).toHaveAttribute('opacity', '0.3');
		});

		it('unlocked segments use accent color', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const svg = container.querySelector('svg[viewBox="0 0 72 72"]');
			const paths = svg?.querySelectorAll('path');

			// First segment (level 1 <= 3) should use accent color
			expect(paths?.[0]).toHaveAttribute('stroke', mockTheme.colors.accent);
		});

		it('locked segments use border color', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const svg = container.querySelector('svg[viewBox="0 0 72 72"]');
			const paths = svg?.querySelectorAll('path');

			// Locked segment should use border color
			expect(paths?.[5]).toHaveAttribute('stroke', mockTheme.colors.border);
		});
	});

	describe('Tooltip Positioning', () => {
		it('positions tooltip left for level 1-2 badges', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Click first segment
			fireEvent.click(segments[0]);

			// Tooltip should have left: 0
			const tooltip = container.querySelector('.absolute.bottom-full');
			expect(tooltip).toHaveStyle({ left: '0px' });
		});

		it('positions tooltip center for middle badges', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Click 5th segment (index 4)
			fireEvent.click(segments[4]);

			// Tooltip should have left: 50% and transform: translateX(-50%)
			const tooltip = container.querySelector('.absolute.bottom-full');
			expect(tooltip).toHaveStyle({ left: '50%' });
		});

		it('positions tooltip right for level 10-11 badges', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Click last segment (index 10)
			fireEvent.click(segments[10]);

			// Tooltip should have right: 0
			const tooltip = container.querySelector('.absolute.bottom-full');
			expect(tooltip).toHaveStyle({ right: '0px' });
		});
	});

	describe('Color Interpolation', () => {
		// Test through the badge progression bar colors
		it('uses accent color for levels 1-3 (unlocked)', () => {
			// Need a stats object that has 3 levels unlocked
			const level3Stats: AutoRunStats = {
				cumulativeTimeMs: 8 * 60 * 60 * 1000, // 8 hours (level 3)
				longestRunMs: 4 * 60 * 60 * 1000,
				totalRuns: 10,
				lastRunMs: 60 * 60 * 1000,
				badgeHistory: Array.from({ length: 3 }, (_, i) => ({
					level: i + 1,
					unlockedAt: Date.now() - 86400000 * (3 - i),
				})),
			};

			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={level3Stats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Level 1-3 should have accent color (they're unlocked)
			for (let i = 0; i < 3; i++) {
				expect(segments[i]).toHaveStyle({ backgroundColor: mockTheme.colors.accent });
			}
		});

		it('uses gold color (#FFD700) for levels 4-7 (unlocked)', () => {
			// Need 3 months of time to reach level 7
			const level7Stats: AutoRunStats = {
				cumulativeTimeMs: 3 * 30 * 24 * 60 * 60 * 1000, // 3 months (level 7 requires 3 months)
				longestRunMs: 24 * 60 * 60 * 1000,
				totalRuns: 100,
				lastRunMs: 60 * 60 * 1000,
				badgeHistory: Array.from({ length: 7 }, (_, i) => ({
					level: i + 1,
					unlockedAt: Date.now() - 86400000 * (7 - i),
				})),
			};

			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={level7Stats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Levels 4-7 should have gold color (#FFD700) when unlocked
			for (let i = 3; i < 7; i++) {
				expect(segments[i]).toHaveStyle({ backgroundColor: '#FFD700' });
			}
		});

		it('uses orange color (#FF6B35) for levels 8-11 (unlocked)', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={maxLevelStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Levels 8-11 should have orange color (#FF6B35) when unlocked
			for (let i = 7; i < 11; i++) {
				expect(segments[i]).toHaveStyle({ backgroundColor: '#FF6B35' });
			}
		});

		it('uses border color for locked badges', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Locked segments (2-11) should have border color
			for (let i = 1; i < 11; i++) {
				expect(segments[i]).toHaveStyle({ backgroundColor: mockTheme.colors.border });
			}
		});
	});

	describe('Current Badge Styling', () => {
		it('adds box shadow to current level badge segment', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// First segment (current level) should have box shadow
			const style = segments[0].getAttribute('style') || '';
			expect(style).toContain('box-shadow');
			expect(style).not.toContain('box-shadow: none');
		});

		it('no box shadow on non-current badge segments', () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={firstBadgeStats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Second segment (not current level) should have no box shadow
			const style = segments[1].getAttribute('style') || '';
			expect(style).toContain('box-shadow: none');
		});
	});

	describe('Edge Cases', () => {
		it('handles zero cumulative time', () => {
			const zeroTimeStats: AutoRunStats = {
				cumulativeTimeMs: 0,
				longestRunMs: 0,
				totalRuns: 0,
				lastRunMs: 0,
				badgeHistory: [],
			};

			render(<AchievementCard theme={mockTheme} autoRunStats={zeroTimeStats} />);

			expect(screen.getByText('No Badge Yet')).toBeInTheDocument();
		});

		it('handles very large cumulative time', () => {
			const hugeTimeStats: AutoRunStats = {
				cumulativeTimeMs: 100 * 365 * 24 * 60 * 60 * 1000, // 100 years
				longestRunMs: 365 * 24 * 60 * 60 * 1000, // 1 year
				totalRuns: 10000,
				lastRunMs: 24 * 60 * 60 * 1000,
				badgeHistory: Array.from({ length: 11 }, (_, i) => ({
					level: i + 1,
					unlockedAt: Date.now() - 86400000 * (11 - i),
				})),
			};

			render(<AchievementCard theme={mockTheme} autoRunStats={hugeTimeStats} />);

			// Should still show max level
			expect(screen.getByText('Maximum Level Achieved!')).toBeInTheDocument();
		});

		it('handles empty badgeHistory array', () => {
			const noHistoryStats: AutoRunStats = {
				cumulativeTimeMs: 15 * 60 * 1000, // 15 minutes (has a badge)
				longestRunMs: 10 * 60 * 1000,
				totalRuns: 3,
				lastRunMs: 5 * 60 * 1000,
				badgeHistory: [], // Empty history
			};

			render(<AchievementCard theme={mockTheme} autoRunStats={noHistoryStats} />);

			// Should not show history button
			expect(screen.queryByText('Unlock History')).not.toBeInTheDocument();
		});

		it('handles undefined badgeHistory', () => {
			const undefinedHistoryStats = {
				cumulativeTimeMs: 15 * 60 * 1000,
				longestRunMs: 10 * 60 * 1000,
				totalRuns: 3,
				lastRunMs: 5 * 60 * 1000,
				// badgeHistory is undefined
			} as AutoRunStats;

			render(<AchievementCard theme={mockTheme} autoRunStats={undefinedHistoryStats} />);

			// Should not crash and should render
			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});

		it('handles light theme mode', () => {
			const lightTheme: Theme = {
				...mockTheme,
				mode: 'light',
				colors: {
					...mockTheme.colors,
					bgMain: '#ffffff',
					bgSidebar: '#f8f8f8',
					bgActivity: '#f0f0f0',
					textMain: '#333333',
					textDim: '#666666',
				},
			};

			render(<AchievementCard theme={lightTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});

		it('handles rapid badge selection changes', async () => {
			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={level5Stats} />
			);

			const segments = container.querySelectorAll('.h-3.rounded-full.cursor-pointer');

			// Rapid clicks on different badges
			fireEvent.click(segments[0]);
			fireEvent.click(segments[1]);
			fireEvent.click(segments[2]);
			fireEvent.click(segments[3]);
			fireEvent.click(segments[4]);

			// Should show the last clicked badge (level 5)
			expect(screen.getByText('Level 5')).toBeInTheDocument();
		});

		it('handles special characters in theme IDs', () => {
			const specialTheme: Theme = {
				...mockTheme,
				id: 'test-theme-special',
				name: 'Test Theme Special',
			};

			render(<AchievementCard theme={specialTheme} autoRunStats={firstBadgeStats} />);

			expect(screen.getByText('Maestro Achievements')).toBeInTheDocument();
		});
	});

	describe('Progress Percentage', () => {
		it('shows progress toward next badge', () => {
			const halfwayStats: AutoRunStats = {
				cumulativeTimeMs: 37.5 * 60 * 1000, // 37.5 minutes (halfway from 15min to 60min)
				longestRunMs: 15 * 60 * 1000,
				totalRuns: 5,
				lastRunMs: 10 * 60 * 1000,
				badgeHistory: [{ level: 1, unlockedAt: Date.now() - 86400000 }],
			};

			const { container } = render(
				<AchievementCard theme={mockTheme} autoRunStats={halfwayStats} />
			);

			// Progress bar should exist
			const progressBar = container.querySelector('.h-2.rounded-full.overflow-hidden');
			expect(progressBar).toBeInTheDocument();
		});
	});

	describe('Default Export', () => {
		it('exports AchievementCard as default', async () => {
			const module = await import('../../../renderer/components/AchievementCard');
			expect(module.default).toBe(module.AchievementCard);
		});
	});
});
