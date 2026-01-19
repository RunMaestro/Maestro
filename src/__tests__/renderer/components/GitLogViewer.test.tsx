import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GitLogViewer } from '../../../renderer/components/GitLogViewer';
import type { Theme } from '../../../renderer/types';

// Mock react-diff-view
vi.mock('react-diff-view', () => ({
	Diff: ({
		children,
		hunks,
	}: {
		children: (hunks: unknown[]) => React.ReactNode;
		hunks: unknown[];
	}) => <div data-testid="diff-view">{children(hunks)}</div>,
	Hunk: ({ hunk }: { hunk: { content: string } }) => <div data-testid="hunk">{hunk.content}</div>,
}));

// Mock react-diff-view CSS
vi.mock('react-diff-view/style/index.css', () => ({}));

// Mock the LayerStackContext
const mockRegisterLayer = vi.fn().mockReturnValue('mock-layer-id');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock parseGitDiff
vi.mock('../../../renderer/utils/gitDiffParser', () => ({
	parseGitDiff: vi.fn((diff: string) => {
		if (!diff || diff.trim() === '') return [];
		return [
			{
				newPath: 'src/test.ts',
				oldPath: 'src/test.ts',
				parsedDiff: [
					{
						type: 'modify',
						hunks: [{ content: '@@ -1,3 +1,4 @@' }],
					},
				],
			},
		];
	}),
}));

describe('GitLogViewer', () => {
	const theme: Theme = {
		name: 'dark',
		colors: {
			bgMain: '#1a1a2e',
			bgSidebar: '#16213e',
			bgActivity: '#0f3460',
			textMain: '#e8e8e8',
			textDim: '#888888',
			border: '#335',
			accent: '#00d9ff',
			buttonBg: '#0f3460',
			buttonText: '#e8e8e8',
			inputBg: '#16213e',
			inputText: '#e8e8e8',
			success: '#22c55e',
			warning: '#f59e0b',
		},
	};

	const defaultProps = {
		cwd: '/test/project',
		theme,
		onClose: vi.fn(),
	};

	const createGitLogEntry = (overrides = {}) => ({
		hash: 'abc123def456789012345678901234567890abcd',
		shortHash: 'abc123d',
		author: 'Test Author',
		date: '2025-12-07T10:30:00Z',
		refs: [],
		subject: 'feat: add new feature',
		additions: 50,
		deletions: 10,
		...overrides,
	});

	const gitLogMock = () => vi.mocked(window.maestro.git.log);
	const gitShowMock = () => vi.mocked(window.maestro.git.show);
	const gitCommitCountMock = () => vi.mocked(window.maestro.git.commitCount);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ shouldAdvanceTime: true });

		gitLogMock().mockResolvedValue({
			entries: [createGitLogEntry()],
			error: undefined,
		});

		gitCommitCountMock().mockResolvedValue({
			count: 1,
			error: null,
		});

		gitShowMock().mockResolvedValue({
			stdout: `commit abc123def456789012345678901234567890abcd
Author: Test Author <test@example.com>
Date:   Sat Dec 7 10:30:00 2025 -0800

    feat: add new feature

---
 src/test.ts | 10 +++++++---
 1 file changed, 7 insertions(+), 3 deletions(-)

diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,4 @@
+import { something } from 'somewhere';
 const foo = 'bar';`,
			stderr: '',
			exitCode: 0,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Initial render', () => {
		it('should render with dialog role and aria attributes', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Git Log Viewer');
		});

		it('should display loading state initially', () => {
			gitLogMock().mockImplementation(() => new Promise(() => {})); // Never resolves
			render(<GitLogViewer {...defaultProps} />);

			expect(screen.getByText('Loading git log...')).toBeInTheDocument();
		});

		it('should display header with title and cwd', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('Git Log')).toBeInTheDocument();
			expect(screen.getByText('/test/project')).toBeInTheDocument();
		});

		it('should display commit count in header', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
					createGitLogEntry({ hash: 'abc3', shortHash: 'abc3' }),
				],
				error: undefined,
			});
			gitCommitCountMock().mockResolvedValue({ count: 3, error: null });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('3 commits')).toBeInTheDocument();
			});
		});

		it('should display "X of TOTAL commits" when total exceeds displayed', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
				],
				error: undefined,
			});
			gitCommitCountMock().mockResolvedValue({ count: 500, error: null });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('2 of 500 commits')).toBeInTheDocument();
			});
		});

		it('should handle commitCount error gracefully', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry()],
				error: undefined,
			});
			gitCommitCountMock().mockResolvedValue({ count: 0, error: 'Failed to count' });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				// Falls back to showing just the number of loaded entries
				expect(screen.getByText('1 commits')).toBeInTheDocument();
			});
		});

		it('should display Close button with Esc hint', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('Close (Esc)')).toBeInTheDocument();
		});
	});

	describe('Error handling', () => {
		it('should display error message when git log fails', async () => {
			gitLogMock().mockResolvedValue({
				entries: [],
				error: 'Not a git repository',
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Not a git repository')).toBeInTheDocument();
			});
		});

		it('should display error message when exception is thrown', async () => {
			gitLogMock().mockRejectedValue(new Error('Network error'));

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Network error')).toBeInTheDocument();
			});
		});

		it('should display generic error for non-Error exceptions', async () => {
			gitLogMock().mockRejectedValue('Unknown error');

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Failed to load git log')).toBeInTheDocument();
			});
		});
	});

	describe('Empty state', () => {
		it('should display empty state when no commits found', async () => {
			gitLogMock().mockResolvedValue({
				entries: [],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('No commits found')).toBeInTheDocument();
			});
		});
	});

	describe('Commit list display', () => {
		it('should display commit subject', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getAllByText('feat: add new feature').length).toBeGreaterThan(0);
			});
		});

		it('should display commit short hash', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('abc123d')).toBeInTheDocument();
			});
		});

		it('should display commit author', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getAllByText('Test Author').length).toBeGreaterThan(0);
			});
		});

		it('should display additions and deletions', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('+50')).toBeInTheDocument();
				expect(screen.getByText('-10')).toBeInTheDocument();
			});
		});

		it('should hide additions when zero', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ additions: 0, deletions: 5 })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('+0')).not.toBeInTheDocument();
				expect(screen.getByText('-5')).toBeInTheDocument();
			});
		});

		it('should hide deletions when zero', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ additions: 5, deletions: 0 })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('+5')).toBeInTheDocument();
				expect(screen.queryByText('-0')).not.toBeInTheDocument();
			});
		});
	});

	describe('Ref display (branches and tags)', () => {
		it('should display branch refs', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ refs: ['main', 'develop'] })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('main')).toBeInTheDocument();
				expect(screen.getByText('develop')).toBeInTheDocument();
			});
		});

		it('should display tag refs with tag prefix removed', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ refs: ['tag: v1.0.0'] })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('v1.0.0')).toBeInTheDocument();
			});
		});

		it('should display HEAD indicator with branch', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ refs: ['HEAD -> main'] })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('main')).toBeInTheDocument();
			});
		});

		it('should display remote branch refs', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ refs: ['origin/main'] })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('origin/main')).toBeInTheDocument();
			});
		});
	});

	describe('Date formatting', () => {
		it("should format today's date as time only", async () => {
			const now = new Date();
			const todayDate = now.toISOString();

			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ date: todayDate })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				// Should show time format like "10:30 AM"
				expect(screen.getByText(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)).toBeInTheDocument();
			});
		});

		it('should format yesterday\'s date with "Yesterday"', async () => {
			const yesterday = new Date();
			yesterday.setDate(yesterday.getDate() - 1);
			yesterday.setHours(14, 30, 0, 0);

			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ date: yesterday.toISOString() })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText(/Yesterday/)).toBeInTheDocument();
			});
		});

		it('should format older dates with full date', async () => {
			// Use a date that's definitely not today or yesterday
			const oldDate = new Date('2024-06-15T10:30:00Z');

			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ date: oldDate.toISOString() })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				// Should show date format like "Jun 15, 2024"
				expect(screen.getByText(/Jun\s+15,?\s+2024/)).toBeInTheDocument();
			});
		});

		it('should handle invalid date gracefully', async () => {
			// When date is invalid, the formatDate function returns the original string
			// due to the try-catch block
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ date: 'invalid-date-format' })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Component should render without crashing even with invalid date
			expect(screen.getByText('1 commits')).toBeInTheDocument();
		});
	});

	describe('Commit selection', () => {
		it('should select first commit by default', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({
						hash: 'first123456789012345678901234567890abcd',
						shortHash: 'first12',
						subject: 'First commit',
					}),
					createGitLogEntry({
						hash: 'second23456789012345678901234567890abcd',
						shortHash: 'second2',
						subject: 'Second commit',
					}),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// First commit should have details shown on the right - full hash appears in details
			expect(screen.getByText('first123456789012345678901234567890abcd')).toBeInTheDocument();
		});

		it('should change selection when clicking a commit', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1', subject: 'First commit' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2', subject: 'Second commit' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Click on second commit
			fireEvent.click(screen.getByText('Second commit'));

			// Check that second commit's hash is shown (this would trigger a new show call)
			expect(gitShowMock()).toHaveBeenCalledWith('/test/project', 'abc2');
		});

		it('should display commit position in footer', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
					createGitLogEntry({ hash: 'abc3', shortHash: 'abc3' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Commit 1 of 3')).toBeInTheDocument();
			});
		});
	});

	describe('Keyboard navigation', () => {
		it('should navigate down with ArrowDown', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			fireEvent.keyDown(window, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(screen.getByText('Commit 2 of 2')).toBeInTheDocument();
			});
		});

		it('should navigate up with ArrowUp', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// First go down
			fireEvent.keyDown(window, { key: 'ArrowDown' });
			await waitFor(() => {
				expect(screen.getByText('Commit 2 of 2')).toBeInTheDocument();
			});

			// Then go back up
			fireEvent.keyDown(window, { key: 'ArrowUp' });
			await waitFor(() => {
				expect(screen.getByText('Commit 1 of 2')).toBeInTheDocument();
			});
		});

		it('should navigate with j/k keys (vim style)', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Navigate down with j
			fireEvent.keyDown(window, { key: 'j' });
			await waitFor(() => {
				expect(screen.getByText('Commit 2 of 2')).toBeInTheDocument();
			});

			// Navigate up with k
			fireEvent.keyDown(window, { key: 'k' });
			await waitFor(() => {
				expect(screen.getByText('Commit 1 of 2')).toBeInTheDocument();
			});
		});

		it('should navigate with PageDown', async () => {
			const entries = Array.from({ length: 20 }, (_, i) =>
				createGitLogEntry({ hash: `hash${i}`, shortHash: `hash${i}` })
			);
			gitLogMock().mockResolvedValue({ entries, error: undefined });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			fireEvent.keyDown(window, { key: 'PageDown' });

			await waitFor(() => {
				expect(screen.getByText('Commit 11 of 20')).toBeInTheDocument();
			});
		});

		it('should navigate with PageUp', async () => {
			const entries = Array.from({ length: 20 }, (_, i) =>
				createGitLogEntry({ hash: `hash${i}`, shortHash: `hash${i}` })
			);
			gitLogMock().mockResolvedValue({ entries, error: undefined });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// First go down twice (PageDown moves by 10)
			fireEvent.keyDown(window, { key: 'PageDown' });
			fireEvent.keyDown(window, { key: 'PageDown' });

			await waitFor(() => {
				// Should be at position 20 (max)
				expect(screen.getByText('Commit 20 of 20')).toBeInTheDocument();
			});

			fireEvent.keyDown(window, { key: 'PageUp' });

			await waitFor(() => {
				expect(screen.getByText('Commit 10 of 20')).toBeInTheDocument();
			});
		});

		it('should navigate to start with Home', async () => {
			const entries = Array.from({ length: 20 }, (_, i) =>
				createGitLogEntry({ hash: `hash${i}`, shortHash: `hash${i}` })
			);
			gitLogMock().mockResolvedValue({ entries, error: undefined });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Go somewhere in the middle
			fireEvent.keyDown(window, { key: 'PageDown' });

			// Then Home
			fireEvent.keyDown(window, { key: 'Home' });

			await waitFor(() => {
				expect(screen.getByText('Commit 1 of 20')).toBeInTheDocument();
			});
		});

		it('should navigate to end with End', async () => {
			const entries = Array.from({ length: 20 }, (_, i) =>
				createGitLogEntry({ hash: `hash${i}`, shortHash: `hash${i}` })
			);
			gitLogMock().mockResolvedValue({ entries, error: undefined });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			fireEvent.keyDown(window, { key: 'End' });

			await waitFor(() => {
				expect(screen.getByText('Commit 20 of 20')).toBeInTheDocument();
			});
		});

		it('should not go below first entry', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry()],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Try to go up when already at first
			fireEvent.keyDown(window, { key: 'ArrowUp' });

			await waitFor(() => {
				expect(screen.getByText('Commit 1 of 1')).toBeInTheDocument();
			});
		});

		it('should not go above last entry', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'abc1' }),
					createGitLogEntry({ hash: 'abc2', shortHash: 'abc2' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Go to last
			fireEvent.keyDown(window, { key: 'End' });
			// Try to go further down
			fireEvent.keyDown(window, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(screen.getByText('Commit 2 of 2')).toBeInTheDocument();
			});
		});
	});

	describe('Close functionality', () => {
		it('should call onClose when Close button is clicked', async () => {
			const onClose = vi.fn();
			render(<GitLogViewer {...defaultProps} onClose={onClose} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));

			expect(onClose).toHaveBeenCalled();
		});

		it('should call onClose when backdrop is clicked', async () => {
			const onClose = vi.fn();
			render(<GitLogViewer {...defaultProps} onClose={onClose} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Click the backdrop (the outer div)
			const backdrop = screen.getByRole('dialog').parentElement;
			fireEvent.click(backdrop!);

			expect(onClose).toHaveBeenCalled();
		});

		it('should NOT call onClose when clicking inside modal', async () => {
			const onClose = vi.fn();
			render(<GitLogViewer {...defaultProps} onClose={onClose} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Click inside the dialog
			fireEvent.click(screen.getByRole('dialog'));

			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Layer stack integration', () => {
		it('should register layer on mount', async () => {
			render(<GitLogViewer {...defaultProps} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith({
				type: 'modal',
				priority: expect.any(Number),
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				ariaLabel: 'Git Log Viewer',
				onEscape: expect.any(Function),
			});
		});

		it('should unregister layer on unmount', async () => {
			const { unmount } = render(<GitLogViewer {...defaultProps} />);

			unmount();

			expect(mockUnregisterLayer).toHaveBeenCalledWith('mock-layer-id');
		});

		it('should call onClose when escape handler is triggered', async () => {
			const onClose = vi.fn();
			render(<GitLogViewer {...defaultProps} onClose={onClose} />);

			// Get the onEscape handler from register call
			const registerCall = mockRegisterLayer.mock.calls[0][0];
			registerCall.onEscape();

			expect(onClose).toHaveBeenCalled();
		});

		it('should update layer handler when onClose changes', async () => {
			const { rerender } = render(<GitLogViewer {...defaultProps} />);

			const newOnClose = vi.fn();
			rerender(<GitLogViewer {...defaultProps} onClose={newOnClose} />);

			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});
	});

	describe('Commit details display', () => {
		it('should display full commit hash in details pane', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Full hash appears in the details section
			expect(screen.getByText('abc123def456789012345678901234567890abcd')).toBeInTheDocument();
		});

		it('should display commit date in full format in details', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// The details pane shows full date with time via toLocaleString()
			// Match the full datetime format (e.g., "12/7/2025, 10:30:00 AM" or "Dec 7, 2025, 10:30:00 AM")
			expect(
				screen.getByText(
					/12\/7\/2025,\s+\d+:\d+:\d+\s+(AM|PM)|Dec\s+7,?\s+2025,\s+\d+:\d+:\d+\s+(AM|PM)/
				)
			).toBeInTheDocument();
		});
	});

	describe('Diff loading and display', () => {
		it('should show loading state while fetching diff', async () => {
			gitShowMock().mockImplementation(() => new Promise(() => {})); // Never resolves

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('Loading diff...')).toBeInTheDocument();
		});

		it('should load diff for selected commit', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(gitShowMock()).toHaveBeenCalledWith(
				'/test/project',
				'abc123def456789012345678901234567890abcd'
			);
		});

		it('should display diff view when available', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			// Check for the mocked diff view
			expect(screen.getByTestId('diff-view')).toBeInTheDocument();
		});

		it('should display no diff message when diff is empty', async () => {
			gitShowMock().mockResolvedValue({
				stdout: 'commit abc\nAuthor: Test\nDate: now\n\n    message\n',
				stderr: '',
				exitCode: 0,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('No diff available for this commit')).toBeInTheDocument();
		});

		it('should handle diff loading error gracefully', async () => {
			gitShowMock().mockRejectedValue(new Error('Failed to load diff'));

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			// Should show no diff message (null diff state)
			expect(screen.getByText('No diff available for this commit')).toBeInTheDocument();
		});

		it('should show file path in diff header', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('src/test.ts')).toBeInTheDocument();
		});
	});

	describe('Commit body parsing', () => {
		it('should display multi-line commit body', async () => {
			gitShowMock().mockResolvedValue({
				stdout: `commit abc123
Author: Test Author <test@example.com>
Date:   Sat Dec 7 10:30:00 2025 -0800

    feat: add new feature

    This is the detailed description.
    It spans multiple lines.
    With more details.

---
 src/test.ts | 10 +++++++---
 1 file changed, 7 insertions(+), 3 deletions(-)

diff --git a/src/test.ts b/src/test.ts
@@ -1,3 +1,4 @@
+import { something } from 'somewhere';`,
				stderr: '',
				exitCode: 0,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(screen.getByText(/This is the detailed description/)).toBeInTheDocument();
		});

		it('should not display body when commit only has subject line', async () => {
			gitShowMock().mockResolvedValue({
				stdout: `commit abc123
Author: Test Author <test@example.com>
Date:   Sat Dec 7 10:30:00 2025 -0800

    feat: add new feature

---
 src/test.ts | 10 +++++++---`,
				stderr: '',
				exitCode: 0,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			// Body section should not appear (no whitespace-pre-wrap div with commit body)
			const bodySection = document.querySelector('.whitespace-pre-wrap');
			expect(bodySection).toBeNull();
		});
	});

	describe('Commit stats display', () => {
		it('should display file change stats', async () => {
			gitShowMock().mockResolvedValue({
				stdout: `commit abc123
Author: Test Author <test@example.com>
Date:   Sat Dec 7 10:30:00 2025 -0800

    feat: add new feature

 src/test.ts | 10 +++++++---
 1 file changed, 7 insertions(+), 3 deletions(-)

diff --git a/src/test.ts b/src/test.ts`,
				stderr: '',
				exitCode: 0,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(
				screen.getByText('1 file changed, 7 insertions(+), 3 deletions(-)')
			).toBeInTheDocument();
		});

		it('should display multiple file stats', async () => {
			gitShowMock().mockResolvedValue({
				stdout: `commit abc123
Author: Test Author <test@example.com>
Date:   Sat Dec 7 10:30:00 2025 -0800

    feat: add new feature

 src/foo.ts   | 5 +++++
 src/bar.ts   | 3 +--
 2 files changed, 6 insertions(+), 2 deletions(-)

diff --git a/src/foo.ts b/src/foo.ts`,
				stderr: '',
				exitCode: 0,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('src/foo.ts | 5 +++++')).toBeInTheDocument();
			expect(screen.getByText('src/bar.ts | 3 +--')).toBeInTheDocument();
		});
	});

	describe('Footer', () => {
		it('should display keyboard navigation hints', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// The navigation hints are structured with kbd elements
			expect(screen.getByText(/navigate/)).toBeInTheDocument();
			expect(screen.getByText(/close/)).toBeInTheDocument();
			expect(screen.getByText('↑↓')).toBeInTheDocument();
			expect(screen.getByText('j/k')).toBeInTheDocument();
			expect(screen.getByText('Esc')).toBeInTheDocument();
		});

		it('should show commit position when entries exist', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ hash: 'abc1' }), createGitLogEntry({ hash: 'abc2' })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Commit 1 of 2')).toBeInTheDocument();
			});
		});

		it('should not show commit position when no entries', async () => {
			gitLogMock().mockResolvedValue({
				entries: [],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText(/Commit \d+ of \d+/)).not.toBeInTheDocument();
			});
		});
	});

	describe('Scroll behavior', () => {
		it('should scroll selected item into view', async () => {
			const scrollIntoViewMock = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoViewMock;

			const entries = Array.from({ length: 20 }, (_, i) =>
				createGitLogEntry({ hash: `hash${i}`, shortHash: `hash${i}` })
			);
			gitLogMock().mockResolvedValue({ entries, error: undefined });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Navigate down
			fireEvent.keyDown(window, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(scrollIntoViewMock).toHaveBeenCalledWith({
					behavior: 'smooth',
					block: 'nearest',
				});
			});
		});
	});

	describe('Edge cases', () => {
		it('should handle entries with no refs', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ refs: [], subject: 'unique commit with no refs' })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Should render without crashing - subject appears in both list and details
			expect(screen.getAllByText('unique commit with no refs').length).toBeGreaterThan(0);
		});

		it('should handle commits with no additions/deletions', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ additions: 0, deletions: 0 })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Should not show +0 or -0
			expect(screen.queryByText(/[+-]0/)).not.toBeInTheDocument();
		});

		it('should handle special characters in commit subject', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ subject: 'fix: handle <script> & "quotes"' })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getAllByText('fix: handle <script> & "quotes"').length).toBeGreaterThan(0);
			});
		});

		it('should handle unicode in commit subject', async () => {
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ subject: '🚀 feat: add emoji support 日本語' })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getAllByText('🚀 feat: add emoji support 日本語').length).toBeGreaterThan(0);
			});
		});

		it('should handle very long commit subject with truncation', async () => {
			const longSubject = 'a'.repeat(500);
			gitLogMock().mockResolvedValue({
				entries: [createGitLogEntry({ subject: longSubject })],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Subject should be in the document (truncated by CSS)
			expect(screen.getAllByText(longSubject).length).toBeGreaterThan(0);
		});

		it('should handle diff that fails to parse', async () => {
			const { parseGitDiff } = await import('../../../renderer/utils/gitDiffParser');
			vi.mocked(parseGitDiff).mockReturnValue([]);

			gitShowMock().mockResolvedValue({
				stdout: `commit abc123
Author: Test
Date: now

    message

diff --git a/malformed
this is not valid diff`,
				stderr: '',
				exitCode: 0,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading diff...')).not.toBeInTheDocument();
			});

			expect(screen.getByText('No diff available for this commit')).toBeInTheDocument();
		});

		it('should handle rapid navigation without crashing', async () => {
			const entries = Array.from({ length: 50 }, (_, i) =>
				createGitLogEntry({ hash: `hash${i}`, shortHash: `hash${i}` })
			);
			gitLogMock().mockResolvedValue({ entries, error: undefined });

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Rapidly navigate
			for (let i = 0; i < 20; i++) {
				fireEvent.keyDown(window, { key: 'ArrowDown' });
			}

			await waitFor(() => {
				expect(screen.getByText('Commit 21 of 50')).toBeInTheDocument();
			});
		});
	});

	describe('API integration', () => {
		it('should call git.log with correct cwd and limit', async () => {
			render(<GitLogViewer {...defaultProps} cwd="/custom/path" />);

			await waitFor(() => {
				expect(gitLogMock()).toHaveBeenCalledWith('/custom/path', { limit: 200 });
			});
		});

		it('should call git.show when selecting different commit', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'first-hash' }),
					createGitLogEntry({ hash: 'second-hash' }),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Initially loads first commit diff
			expect(gitShowMock()).toHaveBeenCalledWith('/test/project', 'first-hash');

			// Navigate to second commit
			fireEvent.keyDown(window, { key: 'ArrowDown' });

			await waitFor(() => {
				expect(gitShowMock()).toHaveBeenCalledWith('/test/project', 'second-hash');
			});
		});
	});

	describe('Theme styling', () => {
		it('should apply theme colors to modal', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveStyle({ backgroundColor: theme.colors.bgMain });
		});

		it('should apply accent color to git icon', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Find the GitCommit icon wrapper
			const header = screen.getByText('Git Log').parentElement;
			const icon = header?.querySelector('svg');
			expect(icon).toHaveStyle({ color: theme.colors.accent });
		});

		it('should apply error color to error message', async () => {
			gitLogMock().mockResolvedValue({
				entries: [],
				error: 'Test error',
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				const errorEl = screen.getByText('Test error');
				expect(errorEl).toHaveClass('text-red-500');
			});
		});

		it('should apply selection background to selected commit', async () => {
			gitLogMock().mockResolvedValue({
				entries: [
					createGitLogEntry({ hash: 'abc1', shortHash: 'first1', subject: 'First unique commit' }),
					createGitLogEntry({
						hash: 'abc2',
						shortHash: 'second1',
						subject: 'Second unique commit',
					}),
				],
				error: undefined,
			});

			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			// Find the first commit row using its short hash (unique to list)
			const firstShortHash = screen.getByText('first1');
			const firstCommitRow = firstShortHash.closest('div[class*="cursor-pointer"]');
			expect(firstCommitRow).toHaveStyle({ backgroundColor: theme.colors.bgActivity });
		});
	});

	describe('Focus management', () => {
		it('should auto-focus dialog on mount', async () => {
			render(<GitLogViewer {...defaultProps} />);

			await waitFor(() => {
				expect(screen.queryByText('Loading git log...')).not.toBeInTheDocument();
			});

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});
});
