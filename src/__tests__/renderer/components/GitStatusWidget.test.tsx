/**
 * @fileoverview Tests for GitStatusWidget component
 *
 * GitStatusWidget displays git change statistics (additions, deletions, modifications)
 * with a hover tooltip showing per-file changes with GitHub-style diff bars.
 *
 * The component uses the centralized GitStatusContext for git data instead
 * of calling gitService directly. Tests mock the useGitStatus hook.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { GitStatusWidget } from '../../../renderer/components/GitStatusWidget';
import type { Theme } from '../../../renderer/types';
import type { GitStatusData, GitFileChange } from '../../../renderer/contexts/GitStatusContext';

// Mock the GitStatusContext hooks (focused contexts)
const mockGetFileCount = vi.fn<[string], number>();
const mockGetFileDetails = vi.fn<
	[string],
	| {
			fileChanges?: GitFileChange[];
			totalAdditions: number;
			totalDeletions: number;
			modifiedCount: number;
	  }
	| undefined
>();
const mockRefreshGitStatus = vi.fn<[], Promise<void>>();

vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	// Focused hooks used by GitStatusWidget
	useGitFileStatus: () => ({
		getFileCount: mockGetFileCount,
		hasChanges: (sessionId: string) => mockGetFileCount(sessionId) > 0,
		isLoading: false,
	}),
	useGitDetail: () => ({
		getFileDetails: mockGetFileDetails,
		refreshGitStatus: mockRefreshGitStatus,
	}),
	// Legacy hook (still exported for backwards compatibility)
	useGitStatus: () => ({
		gitStatusMap: new Map(),
		getStatus: (sessionId: string) => {
			const fileCount = mockGetFileCount(sessionId);
			const details = mockGetFileDetails(sessionId);
			if (fileCount === 0 && !details) return undefined;
			return {
				fileCount,
				...details,
				ahead: 0,
				behind: 0,
				lastUpdated: Date.now(),
			};
		},
		getFileCount: mockGetFileCount,
		refreshGitStatus: mockRefreshGitStatus,
		isLoading: false,
	}),
}));

// Helper to create GitStatusData for tests
const createGitStatusData = (overrides: Partial<GitStatusData> = {}): GitStatusData => ({
	fileCount: 1,
	totalAdditions: 10,
	totalDeletions: 5,
	modifiedCount: 1,
	ahead: 0,
	behind: 0,
	lastUpdated: Date.now(),
	fileChanges: [{ path: 'file.ts', additions: 10, deletions: 5 }],
	...overrides,
});

// Helper to set up mock for GitStatusData (updates both focused mocks)
const mockGetStatus = {
	mockReturnValue: (data: GitStatusData | undefined) => {
		if (data === undefined) {
			mockGetFileCount.mockReturnValue(0);
			mockGetFileDetails.mockReturnValue(undefined);
		} else {
			mockGetFileCount.mockReturnValue(data.fileCount);
			mockGetFileDetails.mockReturnValue({
				fileChanges: data.fileChanges,
				totalAdditions: data.totalAdditions,
				totalDeletions: data.totalDeletions,
				modifiedCount: data.modifiedCount,
			});
		}
	},
};

// Create a mock theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgInput: '#0f3460',
		textMain: '#eaeaea',
		textDim: '#a0a0a0',
		border: '#2a2a4a',
		accent: '#e94560',
		scrollbarThumb: '#444',
		scrollbarTrack: '#222',
		syntax1: '#ff6b6b',
		syntax2: '#4ecdc4',
		syntax3: '#45b7d1',
		syntax4: '#96ceb4',
	},
};

describe('GitStatusWidget', () => {
	const mockOnViewDiff = vi.fn();

	const defaultProps = {
		sessionId: 'test-session-id',
		isGitRepo: true,
		theme: mockTheme,
		onViewDiff: mockOnViewDiff,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Default: no git status (renders null)
		mockGetStatus.mockReturnValue(undefined);
		mockGetFileCount.mockReturnValue(0);
	});

	afterEach(() => {
		vi.clearAllTimers();
	});

	describe('Rendering Conditions', () => {
		it('should return null when isGitRepo is false', () => {
			const { container } = render(<GitStatusWidget {...defaultProps} isGitRepo={false} />);
			expect(container.firstChild).toBeNull();
		});

		it('should return null when there are no file changes', () => {
			mockGetStatus.mockReturnValue(undefined);
			const { container } = render(<GitStatusWidget {...defaultProps} />);
			expect(container.firstChild).toBeNull();
		});

		it('should render the widget when there are file changes', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('should reset state when isGitRepo changes to false', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			const { rerender, container } = render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button')).toBeInTheDocument();

			rerender(<GitStatusWidget {...defaultProps} isGitRepo={false} />);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('Git Data Loading', () => {
		it('should call getFileCount with the session ID', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);
			expect(mockGetFileCount).toHaveBeenCalledWith('test-session-id');
		});

		it('should reload git status on sessionId change', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			const { rerender } = render(<GitStatusWidget {...defaultProps} />);
			expect(mockGetFileCount).toHaveBeenCalledWith('test-session-id');

			rerender(<GitStatusWidget {...defaultProps} sessionId="another-session" />);
			expect(mockGetFileCount).toHaveBeenCalledWith('another-session');
		});

		it('should handle git service errors gracefully', () => {
			mockGetStatus.mockReturnValue(undefined);
			const { container } = render(<GitStatusWidget {...defaultProps} />);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('Statistics Calculation', () => {
		it('should display additions count correctly', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 42,
					totalDeletions: 0,
					fileCount: 1,
					fileChanges: [{ path: 'file.ts', additions: 42, deletions: 0 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByText('42')).toBeInTheDocument();
		});

		it('should display deletions count correctly', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 0,
					totalDeletions: 17,
					fileCount: 1,
					fileChanges: [{ path: 'file.ts', additions: 0, deletions: 17 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByText('17')).toBeInTheDocument();
		});

		it('should display modified count correctly', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 7,
					totalDeletions: 4,
					modifiedCount: 2,
					fileCount: 2,
					fileChanges: [
						{ path: 'file1.ts', additions: 5, deletions: 3 },
						{ path: 'file2.ts', additions: 2, deletions: 1 },
					],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			// Component displays modifiedCount with FileEdit icon
			expect(screen.getByText('2')).toBeInTheDocument();
		});

		it('should calculate totals from multiple files', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 30,
					totalDeletions: 20,
					fileCount: 3,
					fileChanges: [
						{ path: 'file1.ts', additions: 10, deletions: 5 },
						{ path: 'file2.ts', additions: 20, deletions: 0 },
						{ path: 'file3.ts', additions: 0, deletions: 15 },
					],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByText('30')).toBeInTheDocument();
			expect(screen.getByText('20')).toBeInTheDocument();
		});

		it('should handle files with rename status (R)', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 5,
					totalDeletions: 2,
					fileCount: 1,
					fileChanges: [{ path: 'newfile.ts', additions: 5, deletions: 2 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByText('1')).toBeInTheDocument();
		});

		it('should handle untracked files (?)', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 100,
					totalDeletions: 0,
					fileCount: 1,
					fileChanges: [{ path: 'newfile.ts', additions: 100, deletions: 0 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByText('100')).toBeInTheDocument();
		});

		it('should handle files not in numstat map', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 0,
					totalDeletions: 0,
					fileCount: 1,
					fileChanges: [],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});
	});

	describe('Click Handlers', () => {
		it('should call onViewDiff when button is clicked', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);
			fireEvent.click(screen.getByRole('button'));
			expect(mockOnViewDiff).toHaveBeenCalled();
		});

		it('should call onViewDiff when "View Full Diff" link is clicked in tooltip', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);

			const viewDiffButton = screen.getByText('View Full Diff');
			fireEvent.click(viewDiffButton);
			expect(mockOnViewDiff).toHaveBeenCalled();
		});
	});

	describe('Tooltip Behavior', () => {
		it('should show tooltip on mouse enter', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('View Full Diff')).toBeInTheDocument();
		});

		it('should hide tooltip on mouse leave after delay', () => {
			vi.useFakeTimers();
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('View Full Diff')).toBeInTheDocument();

			fireEvent.mouseLeave(container);
			act(() => {
				vi.advanceTimersByTime(200); // 150ms delay + buffer
			});
			expect(screen.queryByText('View Full Diff')).not.toBeInTheDocument();

			vi.useRealTimers();
		});

		it('should keep tooltip open when moving to tooltip content', () => {
			vi.useFakeTimers();
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('View Full Diff')).toBeInTheDocument();

			fireEvent.mouseLeave(container);
			vi.advanceTimersByTime(50);

			const tooltip = screen.getByText('View Full Diff').closest('div');
			fireEvent.mouseEnter(tooltip!);
			vi.advanceTimersByTime(150);
			expect(screen.getByText('View Full Diff')).toBeInTheDocument();

			vi.useRealTimers();
		});

		it('should close tooltip when leaving tooltip content', () => {
			vi.useFakeTimers();
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);

			const tooltip = screen.getByText('View Full Diff').closest('div');
			fireEvent.mouseEnter(tooltip!);
			fireEvent.mouseLeave(tooltip!);

			act(() => {
				vi.advanceTimersByTime(200); // 150ms delay + buffer
			});
			expect(screen.queryByText('View Full Diff')).not.toBeInTheDocument();

			vi.useRealTimers();
		});

		it('should clear timeout when mouse re-enters container', () => {
			vi.useFakeTimers();
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			fireEvent.mouseLeave(container);
			vi.advanceTimersByTime(50);
			fireEvent.mouseEnter(container);
			vi.advanceTimersByTime(150);
			expect(screen.getByText('View Full Diff')).toBeInTheDocument();

			vi.useRealTimers();
		});
	});

	describe('File Changes Display', () => {
		it('should display file path in tooltip', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileChanges: [{ path: 'src/components/Widget.tsx', additions: 10, deletions: 5 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('src/components/Widget.tsx')).toBeInTheDocument();
		});

		it('should display multiple files in tooltip', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 2,
					fileChanges: [
						{ path: 'file1.ts', additions: 10, deletions: 5 },
						{ path: 'file2.ts', additions: 3, deletions: 1 },
					],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('file1.ts')).toBeInTheDocument();
			expect(screen.getByText('file2.ts')).toBeInTheDocument();
		});

		it('should display per-file additions and deletions', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 15,
					totalDeletions: 7,
					fileChanges: [{ path: 'file.ts', additions: 15, deletions: 7 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('+15')).toBeInTheDocument();
			// Component uses unicode minus sign (−) not hyphen-minus (-)
			expect(screen.getByText('−7')).toBeInTheDocument();
		});

		it('should display summary in tooltip header', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 3,
					totalAdditions: 25,
					totalDeletions: 10,
					modifiedCount: 3,
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			// Header format: "Changed Files ({totalChanges}) • +{additions} −{deletions}"
			// totalChanges = additions + deletions + modified = 25 + 10 + 3 = 38
			expect(screen.getByText(/Changed Files \(38\)/)).toBeInTheDocument();
		});

		it('should not display addition count when 0 for a file', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileChanges: [{ path: 'file.ts', additions: 0, deletions: 5 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.queryByText('+0')).not.toBeInTheDocument();
		});

		it('should not display deletion count when 0 for a file', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileChanges: [{ path: 'file.ts', additions: 5, deletions: 0 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.queryByText('-0')).not.toBeInTheDocument();
		});
	});

	describe('Icon Display', () => {
		it('should render GitBranch icon', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button').querySelector('svg')).toBeInTheDocument();
		});

		it('should not show Plus icon when no additions', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 0,
					totalDeletions: 5,
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.queryByText('0')).not.toBeInTheDocument();
		});

		it('should not show Minus icon when no deletions', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 5,
					totalDeletions: 0,
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.queryByText('−0')).not.toBeInTheDocument();
		});

		it('should not show FileEdit icon when no modified files', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 0,
				})
			);
			const { container } = render(<GitStatusWidget {...defaultProps} />);
			expect(container.firstChild).toBeNull();
		});
	});

	describe('Status Code Parsing', () => {
		it('should handle single character status codes', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 1,
					fileChanges: [{ path: 'file.ts', additions: 5, deletions: 0 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('should handle working tree modifications (space + M)', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 1,
					fileChanges: [{ path: 'file.ts', additions: 5, deletions: 3 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});

		it('should handle working tree renames (space + R)', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 1,
					fileChanges: [{ path: 'renamed.ts', additions: 2, deletions: 1 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByRole('button')).toBeInTheDocument();
		});
	});

	describe('Theme Styling', () => {
		it('should apply theme colors to the main button', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);
			const button = screen.getByRole('button');
			// Component uses textMain for the button
			expect(button).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('should apply theme colors to tooltip background', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);

			const tooltip = screen.getByText('View Full Diff').closest('div');
			expect(tooltip).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('should apply theme border colors', () => {
			mockGetStatus.mockReturnValue(createGitStatusData());
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);

			const tooltip = screen.getByText('View Full Diff').closest('div');
			expect(tooltip).toHaveStyle({ borderColor: mockTheme.colors.border });
		});
	});

	describe('GitHub-style Diff Bars', () => {
		it('should render diff bars for files with changes', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileChanges: [{ path: 'file.ts', additions: 10, deletions: 5 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);

			// Check for the green (additions) and red (deletions) bars with Tailwind classes
			const tooltip = screen.getByText('file.ts').closest('div')!.parentElement!;
			expect(tooltip.querySelector('.bg-green-500')).toBeInTheDocument();
			expect(tooltip.querySelector('.bg-red-500')).toBeInTheDocument();
		});

		it('should only render green bar when there are only additions', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 10,
					totalDeletions: 0,
					fileChanges: [{ path: 'file.ts', additions: 10, deletions: 0 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('+10')).toBeInTheDocument();
		});

		it('should only render red bar when there are only deletions', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 0,
					totalDeletions: 10,
					fileChanges: [{ path: 'file.ts', additions: 0, deletions: 10 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			// Component uses unicode minus sign (−) not hyphen-minus (-)
			expect(screen.getByText('−10')).toBeInTheDocument();
		});

		it('should not render diff bars when file has no changes', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 1,
					fileChanges: [{ path: 'file.ts', additions: 0, deletions: 0 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.queryByText('+0')).not.toBeInTheDocument();
			expect(screen.queryByText('-0')).not.toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty status string', () => {
			mockGetStatus.mockReturnValue(undefined);
			const { container } = render(<GitStatusWidget {...defaultProps} />);
			expect(container.firstChild).toBeNull();
		});

		it('should handle special characters in file paths', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileChanges: [{ path: 'src/[components]/file (1).tsx', additions: 5, deletions: 2 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);
			expect(screen.getByText('src/[components]/file (1).tsx')).toBeInTheDocument();
		});

		it('should handle many files', () => {
			const fileChanges = Array.from({ length: 20 }, (_, i) => ({
				path: `file${i}.ts`,
				additions: i,
				deletions: i % 3,
			}));
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileCount: 20,
					totalAdditions: 190,
					totalDeletions: 27,
					modifiedCount: 20,
					fileChanges,
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			// Check that additions/deletions/modifiedCount are displayed
			expect(screen.getByText('190')).toBeInTheDocument();
			expect(screen.getByText('27')).toBeInTheDocument();
			expect(screen.getByText('20')).toBeInTheDocument();
		});

		it('should handle very large numbers', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					totalAdditions: 99999,
					totalDeletions: 88888,
					fileCount: 1,
					fileChanges: [{ path: 'file.ts', additions: 99999, deletions: 88888 }],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);
			expect(screen.getByText('99999')).toBeInTheDocument();
		});

		it('should have proper accessibility with title attribute on file paths', () => {
			mockGetStatus.mockReturnValue(
				createGitStatusData({
					fileChanges: [
						{ path: 'very/long/path/to/deeply/nested/file.ts', additions: 5, deletions: 2 },
					],
				})
			);
			render(<GitStatusWidget {...defaultProps} />);

			const container = screen.getByRole('button').parentElement!;
			fireEvent.mouseEnter(container);

			const filePath = screen.getByText('very/long/path/to/deeply/nested/file.ts');
			expect(filePath).toHaveAttribute('title', 'very/long/path/to/deeply/nested/file.ts');
		});
	});
});
