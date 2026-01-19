import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { GitDiffViewer } from '../../../renderer/components/GitDiffViewer';
import type { ParsedFileDiff } from '../../../renderer/utils/gitDiffParser';

// Create mock parsed files for testing
const createMockParsedFile = (overrides: Partial<ParsedFileDiff> = {}): ParsedFileDiff => ({
	oldPath: 'src/test.ts',
	newPath: 'src/test.ts',
	diffText: 'mock diff',
	parsedDiff: [
		{
			oldPath: 'src/test.ts',
			newPath: 'src/test.ts',
			type: 'modify',
			oldRevision: 'abc1234',
			newRevision: 'def5678',
			hunks: [
				{
					oldStart: 1,
					oldLines: 3,
					newStart: 1,
					newLines: 4,
					content: '@@ -1,3 +1,4 @@',
					changes: [
						{
							type: 'normal',
							content: ' const a = 1;',
							isNormal: true,
							oldLineNumber: 1,
							newLineNumber: 1,
						},
						{ type: 'insert', content: '+const b = 2;', isInsert: true, lineNumber: 2 },
						{
							type: 'normal',
							content: ' const c = 3;',
							isNormal: true,
							oldLineNumber: 2,
							newLineNumber: 3,
						},
					],
				},
			],
		},
	],
	isBinary: false,
	isImage: false,
	isNewFile: false,
	isDeletedFile: false,
	...overrides,
});

// Mocked parseGitDiff implementations for different scenarios
const mockParseGitDiff = vi.fn();
const mockGetFileName = vi.fn((path: string) => path.split('/').pop() || path);
const mockGetDiffStats = vi.fn((parsedDiff: any[]) => {
	let additions = 0;
	let deletions = 0;
	parsedDiff?.forEach((file) => {
		file.hunks?.forEach((hunk: any) => {
			hunk.changes?.forEach((change: any) => {
				if (change.type === 'insert') additions++;
				if (change.type === 'delete') deletions++;
			});
		});
	});
	return { additions, deletions };
});

// Mock gitDiffParser utilities
vi.mock('../../../renderer/utils/gitDiffParser', () => ({
	parseGitDiff: (...args: any[]) => mockParseGitDiff(...args),
	getFileName: (path: string) => mockGetFileName(path),
	getDiffStats: (parsedDiff: any[]) => mockGetDiffStats(parsedDiff),
}));

// Mock react-diff-view to avoid complex SVG rendering
vi.mock('react-diff-view', () => ({
	Diff: ({ children, hunks, viewType, diffType }: any) => (
		<div data-testid="diff-component" data-view-type={viewType} data-diff-type={diffType}>
			{children ? children(hunks || []) : null}
		</div>
	),
	Hunk: ({ hunk }: any) => (
		<div data-testid="hunk-component" data-content={hunk?.content}>
			Hunk: {hunk?.content}
		</div>
	),
	tokenize: vi.fn(() => []),
	parseDiff: vi.fn(() => []),
}));

// Mock ImageDiffViewer
vi.mock('../../../renderer/components/ImageDiffViewer', () => ({
	ImageDiffViewer: ({ oldPath, newPath, cwd, isNewFile, isDeletedFile }: any) => (
		<div data-testid="image-diff-viewer">
			<span data-testid="old-path">{oldPath}</span>
			<span data-testid="new-path">{newPath}</span>
			<span data-testid="cwd">{cwd}</span>
			{isNewFile && <span data-testid="is-new-file">new</span>}
			{isDeletedFile && <span data-testid="is-deleted-file">deleted</span>}
		</div>
	),
}));

// Mock layer stack
const mockRegisterLayer = vi.fn(() => 'mock-layer-id');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock CSS import
vi.mock('react-diff-view/style/index.css', () => ({}));

// Sample theme for testing
const mockTheme = {
	id: 'test-theme' as const,
	name: 'Test Theme',
	mode: 'dark' as const,
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16162a',
		bgActivity: '#22223a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0088ff',
		border: '#333355',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		vibe: '#8855ff',
		statusBar: '#0d0d1a',
		scrollbarThumb: '#444466',
	},
};

describe('GitDiffViewer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: return empty array (no files)
		mockParseGitDiff.mockReturnValue([]);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Initial render', () => {
		it('renders empty state when parseGitDiff returns empty array', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([]);

			render(<GitDiffViewer diffText="" cwd="/test/project" theme={mockTheme} onClose={onClose} />);

			expect(screen.getByText('No changes to display')).toBeInTheDocument();
			expect(screen.getByText('Git Diff')).toBeInTheDocument();
			expect(screen.getByText('Close (Esc)')).toBeInTheDocument();
		});

		it('renders with dialog role and aria attributes', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toBeInTheDocument();
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Git Diff Preview');
		});

		it('renders header with title and cwd', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Git Diff')).toBeInTheDocument();
			expect(screen.getByText('/test/project')).toBeInTheDocument();
		});

		it('shows file count for single file', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('1 file changed')).toBeInTheDocument();
		});

		it('shows file count for multiple files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('2 files changed')).toBeInTheDocument();
		});

		it('focuses the dialog on mount', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('tabIndex', '-1');
		});
	});

	describe('Layer stack integration', () => {
		it('registers layer on mount', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(mockRegisterLayer).toHaveBeenCalledWith({
				type: 'modal',
				priority: expect.any(Number),
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				ariaLabel: 'Git Diff Preview',
				onEscape: expect.any(Function),
			});
		});

		it('unregisters layer on unmount', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			const { unmount } = render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			unmount();
			expect(mockUnregisterLayer).toHaveBeenCalledWith('mock-layer-id');
		});

		it('updates layer handler after mount', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(mockUpdateLayerHandler).toHaveBeenCalledWith('mock-layer-id', expect.any(Function));
		});

		it('escape handler calls onClose', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Get the onEscape handler from registerLayer call and invoke it
			const onEscape = mockRegisterLayer.mock.calls[0][0].onEscape;
			onEscape();

			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Close functionality', () => {
		it('calls onClose when close button is clicked', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
			expect(onClose).toHaveBeenCalled();
		});

		it('calls onClose when clicking backdrop', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Click on backdrop (the fixed overlay)
			const backdrop = screen.getByRole('dialog').parentElement;
			fireEvent.click(backdrop!);
			expect(onClose).toHaveBeenCalled();
		});

		it('does NOT call onClose when clicking inside modal', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			fireEvent.click(screen.getByRole('dialog'));
			expect(onClose).not.toHaveBeenCalled();
		});

		it('calls onClose when clicking close button in empty state', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([]);

			render(<GitDiffViewer diffText="" cwd="/test/project" theme={mockTheme} onClose={onClose} />);

			fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('Tab navigation', () => {
		it('renders tabs for each file', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Both filenames should appear in the tabs (may appear multiple times in footer too)
			expect(screen.getAllByText('file1.ts').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('file2.ts').length).toBeGreaterThanOrEqual(1);
		});

		it('shows first tab as active by default', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Find the tab button by looking in the tab bar (first button with filename)
			const allFile1 = screen.getAllByText('file1.ts');
			const tab1 = allFile1.find((el) => el.closest('button'))?.closest('button');
			expect(tab1).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('switches tab on click', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Click second tab
			fireEvent.click(screen.getByText('file2.ts'));

			// Check file position in footer
			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
		});

		it('shows file position in footer', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('File 1 of 2')).toBeInTheDocument();

			fireEvent.click(screen.getByText('file2.ts'));
			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
		});
	});

	describe('Keyboard navigation', () => {
		it('switches to next tab with Cmd+]', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('File 1 of 2')).toBeInTheDocument();

			act(() => {
				fireEvent.keyDown(window, { key: ']', metaKey: true });
			});

			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
		});

		it('switches to previous tab with Cmd+[', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// First move to tab 2
			fireEvent.click(screen.getByText('file2.ts'));
			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();

			// Then go back with keyboard
			act(() => {
				fireEvent.keyDown(window, { key: '[', metaKey: true });
			});

			expect(screen.getByText('File 1 of 2')).toBeInTheDocument();
		});

		it('wraps around at end when pressing Cmd+]', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Start at tab 2
			fireEvent.click(screen.getByText('file2.ts'));
			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();

			// Press Cmd+] should wrap to tab 1
			act(() => {
				fireEvent.keyDown(window, { key: ']', metaKey: true });
			});

			expect(screen.getByText('File 1 of 2')).toBeInTheDocument();
		});

		it('wraps around at start when pressing Cmd+[', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Start at tab 1
			expect(screen.getByText('File 1 of 2')).toBeInTheDocument();

			// Press Cmd+[ should wrap to last tab
			act(() => {
				fireEvent.keyDown(window, { key: '[', metaKey: true });
			});

			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
		});

		it('works with Ctrl key for Windows/Linux', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			act(() => {
				fireEvent.keyDown(window, { key: ']', ctrlKey: true });
			});

			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
		});

		it('cleans up keyboard listener on unmount', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);
			const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

			const { unmount } = render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
			removeEventListenerSpy.mockRestore();
		});
	});

	describe('File type handling', () => {
		it('shows ImageDiffViewer for image files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'assets/logo.png',
					newPath: 'assets/logo.png',
					isBinary: true,
					isImage: true,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByTestId('image-diff-viewer')).toBeInTheDocument();
			expect(screen.getByTestId('new-path')).toHaveTextContent('assets/logo.png');
		});

		it('shows image icon in tab for image files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'assets/logo.png',
					newPath: 'assets/logo.png',
					isBinary: true,
					isImage: true,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// lucide-react renders as SVG, check for presence via testid or class
			const allLogos = screen.getAllByText('logo.png');
			const tab = allLogos.find((el) => el.closest('button'))?.closest('button');
			const svgIcon = tab?.querySelector('svg');
			expect(svgIcon).toBeInTheDocument();
		});

		it('passes isNewFile to ImageDiffViewer for new images', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: '/dev/null',
					newPath: 'assets/new-icon.svg',
					isBinary: true,
					isImage: true,
					isNewFile: true,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByTestId('is-new-file')).toBeInTheDocument();
		});

		it('passes isDeletedFile to ImageDiffViewer for deleted images', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'assets/old-icon.jpg',
					newPath: '/dev/null',
					isBinary: true,
					isImage: true,
					isDeletedFile: true,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByTestId('is-deleted-file')).toBeInTheDocument();
		});

		it('shows binary message for non-image binary files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/data.bin',
					newPath: 'src/data.bin',
					isBinary: true,
					isImage: false,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Binary file changed')).toBeInTheDocument();
			expect(screen.getByText('src/data.bin')).toBeInTheDocument();
		});

		it('shows binary label in tab for binary files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/data.bin',
					newPath: 'src/data.bin',
					isBinary: true,
					isImage: false,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('binary')).toBeInTheDocument();
		});

		it('shows normal diff for text files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByTestId('diff-component')).toBeInTheDocument();
		});

		it('renders hunks for text diffs', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Check the Diff component is rendered with unified view
			const diffComponent = screen.getByTestId('diff-component');
			expect(diffComponent).toHaveAttribute('data-view-type', 'unified');
		});
	});

	describe('Stats display', () => {
		it('shows additions in tab for text files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// The Plus icon from lucide-react should be present with green color
			const greenSpans = document.querySelectorAll('.text-green-500');
			expect(greenSpans.length).toBeGreaterThan(0);
		});

		it('shows deletions in tab for text files with deletions', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/file2.ts',
					newPath: 'src/file2.ts',
					parsedDiff: [
						{
							oldPath: 'src/file2.ts',
							newPath: 'src/file2.ts',
							type: 'modify',
							oldRevision: 'abc',
							newRevision: 'def',
							hunks: [
								{
									oldStart: 1,
									oldLines: 3,
									newStart: 1,
									newLines: 1,
									content: '@@ -1,3 +1,1 @@',
									changes: [
										{ type: 'delete', content: '-const a = 1;', isDelete: true, lineNumber: 1 },
										{ type: 'delete', content: '-const b = 2;', isDelete: true, lineNumber: 2 },
										{
											type: 'normal',
											content: ' const c = 3;',
											isNormal: true,
											oldLineNumber: 3,
											newLineNumber: 1,
										},
									],
								},
							],
						},
					],
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// There should be red minus sign for deletions
			const redSpans = document.querySelectorAll('.text-red-500');
			expect(redSpans.length).toBeGreaterThan(0);
		});

		it('shows additions and deletions in footer', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText(/additions/)).toBeInTheDocument();
			expect(screen.getByText(/deletions/)).toBeInTheDocument();
		});

		it('shows Image file in footer for images', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'assets/logo.png',
					newPath: 'assets/logo.png',
					isBinary: true,
					isImage: true,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Image file')).toBeInTheDocument();
		});

		it('shows Binary file in footer for non-image binaries', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/data.bin',
					newPath: 'src/data.bin',
					isBinary: true,
					isImage: false,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText('Binary file')).toBeInTheDocument();
		});
	});

	describe('Theme styling', () => {
		it('applies theme background color to dialog', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveStyle({ backgroundColor: mockTheme.colors.bgMain });
		});

		it('applies theme colors to header', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const headerTitle = screen.getByText('Git Diff');
			expect(headerTitle).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('injects theme-specific CSS for diff view', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Style element should be present with theme colors
			const styleElements = document.querySelectorAll('style');
			const diffStyles = Array.from(styleElements).find((el) =>
				el.textContent?.includes('.diff-gutter')
			);
			expect(diffStyles).toBeTruthy();
			expect(diffStyles?.textContent).toContain(mockTheme.colors.bgSidebar);
		});
	});

	describe('Edge cases', () => {
		it('handles empty cwd', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(<GitDiffViewer diffText="mock diff" cwd="" theme={mockTheme} onClose={onClose} />);

			// Should still render
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('handles long file paths by showing just filename', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'very/long/path/to/some/deeply/nested/directory/structure/file.ts',
					newPath: 'very/long/path/to/some/deeply/nested/directory/structure/file.ts',
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Should show just the filename in tab (via getFileName mock)
			// May appear multiple times (tab + footer)
			expect(screen.getAllByText('file.ts').length).toBeGreaterThanOrEqual(1);
		});

		it('handles special characters in file paths', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/file-with-dashes.ts',
					newPath: 'src/file-with-dashes.ts',
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// May appear multiple times (tab + footer)
			expect(screen.getAllByText('file-with-dashes.ts').length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('File header display', () => {
		it('shows old and new path in file header', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Look for the file header with paths
			expect(screen.getByText(/src\/test.ts → src\/test.ts/)).toBeInTheDocument();
		});

		it('shows current file in footer', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.getByText(/Current file:/)).toBeInTheDocument();
		});
	});

	describe('Tab scroll behavior', () => {
		it('scrolls to active tab when changed', async () => {
			const onClose = vi.fn();
			const scrollIntoViewMock = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			// Mock scrollIntoView on button elements
			const originalScrollIntoView = Element.prototype.scrollIntoView;
			Element.prototype.scrollIntoView = scrollIntoViewMock;

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Change tab
			fireEvent.click(screen.getByText('file2.ts'));

			await waitFor(() => {
				expect(scrollIntoViewMock).toHaveBeenCalled();
			});

			Element.prototype.scrollIntoView = originalScrollIntoView;
		});
	});

	describe('Mixed file types', () => {
		it('handles mixed text, image, and binary files', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/code.ts', newPath: 'src/code.ts' }),
				createMockParsedFile({
					oldPath: 'assets/logo.png',
					newPath: 'assets/logo.png',
					isBinary: true,
					isImage: true,
				}),
				createMockParsedFile({
					oldPath: 'data/file.bin',
					newPath: 'data/file.bin',
					isBinary: true,
					isImage: false,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// All tabs should be present (may appear multiple times)
			expect(screen.getAllByText('code.ts').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('logo.png').length).toBeGreaterThanOrEqual(1);
			expect(screen.getAllByText('file.bin').length).toBeGreaterThanOrEqual(1);

			// First tab (code) shows diff component
			expect(screen.getByTestId('diff-component')).toBeInTheDocument();
		});

		it('switches between different file types correctly', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/code.ts', newPath: 'src/code.ts' }),
				createMockParsedFile({
					oldPath: 'assets/logo.png',
					newPath: 'assets/logo.png',
					isBinary: true,
					isImage: true,
				}),
				createMockParsedFile({
					oldPath: 'data/file.bin',
					newPath: 'data/file.bin',
					isBinary: true,
					isImage: false,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Tab 1: code - shows diff component
			expect(screen.getByTestId('diff-component')).toBeInTheDocument();

			// Tab 2: image - shows ImageDiffViewer
			fireEvent.click(screen.getByText('logo.png'));
			expect(screen.getByTestId('image-diff-viewer')).toBeInTheDocument();

			// Tab 3: binary - shows binary message
			fireEvent.click(screen.getByText('file.bin'));
			expect(screen.getByText('Binary file changed')).toBeInTheDocument();
		});
	});

	describe('Unable to parse fallback', () => {
		it('shows fallback message when parsedDiff is empty for non-binary file', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/empty.ts',
					newPath: 'src/empty.ts',
					parsedDiff: [], // Empty parsed diff
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Should show unable to parse message since hunks are empty
			expect(screen.getByText('Unable to parse diff for this file')).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('has correct heading structure', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// Title should be visible
			expect(screen.getByText('Git Diff')).toBeInTheDocument();
		});

		it('close button is accessible', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const closeButton = screen.getByText('Close (Esc)');
			expect(closeButton.tagName).toBe('BUTTON');
		});

		it('tabs are button elements', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/file1.ts', newPath: 'src/file1.ts' }),
				createMockParsedFile({ oldPath: 'src/file2.ts', newPath: 'src/file2.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const allFile1 = screen.getAllByText('file1.ts');
			const tab = allFile1.find((el) => el.closest('button'))?.closest('button');
			expect(tab).toBeInTheDocument();
		});
	});

	describe('Memoization', () => {
		it('calls parseGitDiff with diffText', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="test diff content"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(mockParseGitDiff).toHaveBeenCalledWith('test diff content');
		});

		it('parses diff only when diffText changes', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			const { rerender } = render(
				<GitDiffViewer
					diffText="original diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			const initialCallCount = mockParseGitDiff.mock.calls.length;

			// Re-render with same diffText but different cwd
			rerender(
				<GitDiffViewer
					diffText="original diff"
					cwd="/different/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			// parseGitDiff should NOT be called again since diffText is the same
			// (due to useMemo)
			expect(mockParseGitDiff.mock.calls.length).toBe(initialCallCount);

			// Should still render with new cwd
			expect(screen.getByText('/different/project')).toBeInTheDocument();
		});
	});

	describe('Empty state in main view', () => {
		it('renders empty state with proper dialog structure', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([]);

			render(<GitDiffViewer diffText="" cwd="/test/project" theme={mockTheme} onClose={onClose} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Git Diff Preview');
		});

		it('calls onClose when clicking backdrop in empty state', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([]);

			render(<GitDiffViewer diffText="" cwd="/test/project" theme={mockTheme} onClose={onClose} />);

			const backdrop = screen.getByRole('dialog').parentElement;
			fireEvent.click(backdrop!);
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('getDiffStats integration', () => {
		it('calls getDiffStats for active file', () => {
			const onClose = vi.fn();
			const mockFile = createMockParsedFile();
			mockParseGitDiff.mockReturnValue([mockFile]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(mockGetDiffStats).toHaveBeenCalledWith(mockFile.parsedDiff);
		});
	});

	describe('getFileName integration', () => {
		it('calls getFileName for tab labels', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ newPath: 'src/deep/nested/file.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(mockGetFileName).toHaveBeenCalledWith('src/deep/nested/file.ts');
		});
	});
});
