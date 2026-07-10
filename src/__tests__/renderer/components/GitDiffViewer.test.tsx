import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { GitDiffViewer } from '../../../renderer/components/GitDiffViewer';
import type { ParsedFileDiff } from '../../../renderer/utils/gitDiffParser';

import { mockTheme } from '../../helpers/mockTheme';
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
	Diff: ({ children, hunks, viewType, diffType, codeEvents, selectedChanges }: any) => (
		<div
			data-testid="diff-component"
			data-view-type={viewType}
			data-diff-type={diffType}
			data-selected-changes={(selectedChanges || []).join(',')}
		>
			{children ? children(hunks || []) : null}
			{codeEvents?.onClick &&
				hunks
					.flatMap((hunk: any) => hunk.changes || [])
					.map((change: any) => {
						const line = change.lineNumber ?? change.newLineNumber ?? change.oldLineNumber;
						return (
							<button
								key={`${change.type}-${line}`}
								data-testid={`review-change-${change.type}-${line}`}
								onClick={(event) => codeEvents.onClick({ change }, event)}
							>
								Select {change.content}
							</button>
						);
					})}
		</div>
	),
	Hunk: ({ hunk }: any) => (
		<div data-testid="hunk-component" data-content={hunk?.content}>
			Hunk: {hunk?.content}
		</div>
	),
	tokenize: vi.fn(() => []),
	parseDiff: vi.fn(() => []),
	getChangeKey: (change: any) => {
		if (change.type === 'insert') return `I${change.lineNumber}`;
		if (change.type === 'delete') return `D${change.lineNumber}`;
		return `N${change.oldLineNumber}`;
	},
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

describe('GitDiffViewer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: return empty array (no files)
		mockParseGitDiff.mockReturnValue([]);
		// jsdom in this environment doesn't provide a working Storage on
		// window.localStorage, so install a minimal in-memory mock that
		// satisfies the Storage methods the component uses. Same pattern as
		// ProcessMonitor.test.tsx / QuickActionsModal.test.tsx.
		const store = new Map<string, string>();
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			writable: true,
			value: {
				getItem: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
				setItem: vi.fn((key: string, value: string) => {
					store.set(key, String(value));
				}),
				removeItem: vi.fn((key: string) => {
					store.delete(key);
				}),
				clear: vi.fn(() => {
					store.clear();
				}),
				key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
				get length() {
					return store.size;
				},
			},
		});
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
			// Close button renders as either "Close (Esc)" (md+) or "×" (narrow);
			// accessible name from aria-label catches both.
			expect(screen.getByRole('button', { name: /close diff viewer/i })).toBeInTheDocument();
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

		it('shows current file position in header for single file', () => {
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

			expect(screen.getByText('File 1 of 1')).toBeInTheDocument();
		});

		it('shows current file position in header for multiple files', () => {
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

			fireEvent.click(screen.getByRole('button', { name: /close diff viewer/i }));
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

			fireEvent.click(screen.getByRole('button', { name: /close diff viewer/i }));
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe('File header open-in-preview', () => {
		it('dismisses the viewer and opens the file as a preview tab on header click', () => {
			const onClose = vi.fn();
			const onOpenFile = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/app.ts', newPath: 'src/app.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
					onOpenFile={onOpenFile}
				/>
			);

			fireEvent.click(screen.getByTitle('Open src/app.ts in a preview tab'));

			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onOpenFile).toHaveBeenCalledWith('/test/project/src/app.ts', 'app.ts');
		});

		it('does not make a deleted file header clickable', () => {
			const onClose = vi.fn();
			const onOpenFile = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({
					oldPath: 'src/gone.ts',
					newPath: 'src/gone.ts',
					isDeletedFile: true,
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
					onOpenFile={onOpenFile}
				/>
			);

			expect(screen.queryByTitle(/Open .* in a preview tab/)).toBeNull();
		});

		it('renders a non-interactive file header when onOpenFile is omitted', () => {
			const onClose = vi.fn();
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/app.ts', newPath: 'src/app.ts' }),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={onClose}
				/>
			);

			expect(screen.queryByTitle(/Open .* in a preview tab/)).toBeNull();
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

			// The Plus icon from lucide-react should be present with green color (inline style for colorblind support)
			const greenSpans = Array.from(document.querySelectorAll<HTMLSpanElement>('span')).filter(
				(s) => s.style.color === 'rgb(34, 197, 94)'
			);
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

			// There should be red minus sign for deletions (inline style for colorblind support)
			const redSpans = Array.from(document.querySelectorAll<HTMLSpanElement>('span')).filter(
				(s) => s.style.color === 'rgb(239, 68, 68)'
			);
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

	describe('Rehearsal review', () => {
		it('selects a diff line, captures a note, and sends structured feedback', () => {
			const onSendReview = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
					onSendReview={onSendReview}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /open review panel/i }));
			expect(screen.getByRole('complementary', { name: /diff review/i })).toBeInTheDocument();
			expect(screen.getByText('Change Brief')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('tab', { name: /notes/i }));
			expect(screen.getByText('Select a line in the diff')).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('review-change-insert-2'));

			const note = screen.getByRole('textbox', { name: /review note for comment 1/i });
			const send = screen.getByRole('button', { name: /send review/i });
			expect(send).toBeDisabled();
			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-selected-changes', 'I2');

			fireEvent.change(note, { target: { value: 'Handle the empty state explicitly.' } });
			expect(send).toBeEnabled();

			fireEvent.click(screen.getByRole('tab', { name: /prompt/i }));
			expect(screen.getByText(/Please revise the current changes/)).toBeInTheDocument();
			expect(screen.getByText(/Handle the empty state explicitly/)).toBeInTheDocument();

			fireEvent.click(send);

			expect(onSendReview).toHaveBeenCalledTimes(1);
			expect(onSendReview.mock.calls[0][0]).toContain('"file": "src/test.ts"');
			expect(onSendReview.mock.calls[0][0]).toContain('"location": "new line 2"');
			expect(onSendReview.mock.calls[0][0]).toContain(
				'"comment": "Handle the empty state explicitly."'
			);
		});

		it('removes a comment when the selected line is clicked again', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /open review panel/i }));
			fireEvent.click(screen.getByTestId('review-change-insert-2'));
			fireEvent.click(screen.getByRole('tab', { name: /notes/i }));
			expect(
				screen.getByRole('textbox', { name: /review note for comment 1/i })
			).toBeInTheDocument();

			fireEvent.click(screen.getByTestId('review-change-insert-2'));
			expect(screen.queryByRole('textbox', { name: /review note/i })).not.toBeInTheDocument();
			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-selected-changes', '');
		});

		it('keeps send disabled when the active tab cannot accept AI feedback', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /open review panel/i }));
			fireEvent.click(screen.getByTestId('review-change-insert-2'));
			fireEvent.click(screen.getByRole('tab', { name: /notes/i }));
			fireEvent.change(screen.getByRole('textbox', { name: /review note for comment 1/i }), {
				target: { value: 'Use a clearer name.' },
			});

			expect(screen.getByText('Switch to an AI tab to send this review.')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /send review/i })).toBeDisabled();
		});

		it('sends high-level feedback without requiring line selection', () => {
			const onSendReview = vi.fn();
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
					onSendReview={onSendReview}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /open review panel/i }));
			const overallFeedback = screen.getByRole('textbox', {
				name: /overall feedback/i,
			});
			const send = screen.getByRole('button', { name: /send review/i });
			expect(send).toBeDisabled();

			fireEvent.change(overallFeedback, {
				target: { value: 'Split the persistence work into a separate change.' },
			});
			expect(send).toBeEnabled();
			fireEvent.click(screen.getByRole('tab', { name: /prompt/i }));
			expect(
				screen.getByText(/Split the persistence work into a separate change/)
			).toBeInTheDocument();

			fireEvent.click(send);
			expect(onSendReview).toHaveBeenCalledTimes(1);
			expect(onSendReview.mock.calls[0][0]).toContain('Overall feedback:');
			expect(onSendReview.mock.calls[0][0]).toContain(
				'Split the persistence work into a separate change.'
			);
		});

		it('jumps from a risk card to the corresponding file', () => {
			mockParseGitDiff.mockReturnValue([
				createMockParsedFile({ oldPath: 'src/app.ts', newPath: 'src/app.ts' }),
				createMockParsedFile({
					oldPath: 'src/main/security/permissions.ts',
					newPath: 'src/main/security/permissions.ts',
				}),
			]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /open review panel/i }));
			const riskPath = screen.getAllByText('src/main/security/permissions.ts')[0];
			fireEvent.click(riskPath.closest('button')!);

			expect(screen.getByText('File 2 of 2')).toBeInTheDocument();
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

			const closeButton = screen.getByRole('button', { name: /close diff viewer/i });
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

	describe('View type persistence', () => {
		const STORAGE_KEY = 'maestro.gitDiffViewer.viewType';

		it('uses initialViewType when nothing is persisted', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
					initialViewType="split"
				/>
			);

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'split');
		});

		it('reads the stored view type from localStorage and overrides initialViewType', () => {
			window.localStorage.setItem(STORAGE_KEY, 'split');
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
					initialViewType="unified"
				/>
			);

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'split');
		});

		it('persists the chosen view type when the toggle is clicked', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			expect(window.localStorage.getItem(STORAGE_KEY)).toBe('unified');

			const toggle = screen.getByRole('button', { name: /switch to side-by-side/i });
			act(() => {
				fireEvent.click(toggle);
			});

			expect(window.localStorage.getItem(STORAGE_KEY)).toBe('split');
			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'split');
		});

		it('ignores invalid values stored in localStorage and falls back to initialViewType', () => {
			window.localStorage.setItem(STORAGE_KEY, 'garbage');
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
					initialViewType="split"
				/>
			);

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'split');
		});
	});

	describe('Enter key toggle', () => {
		const STORAGE_KEY = 'maestro.gitDiffViewer.viewType';

		it('toggles view type when Enter is pressed and focus is not on a form control', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'unified');

			act(() => {
				// Move focus off the auto-focused dialog button (if any) onto the body
				// so the Enter handler doesn't get short-circuited by isFormControl().
				(document.activeElement as HTMLElement | null)?.blur();
				fireEvent.keyDown(window, { key: 'Enter' });
			});

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'split');
			expect(window.localStorage.getItem(STORAGE_KEY)).toBe('split');

			act(() => {
				fireEvent.keyDown(window, { key: 'Enter' });
			});

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'unified');
			expect(window.localStorage.getItem(STORAGE_KEY)).toBe('unified');
		});

		it('ignores Enter with modifier keys', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			act(() => {
				(document.activeElement as HTMLElement | null)?.blur();
				fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
				fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
				fireEvent.keyDown(window, { key: 'Enter', shiftKey: true });
				fireEvent.keyDown(window, { key: 'Enter', altKey: true });
			});

			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'unified');
		});

		it('does not toggle when a button is focused (so the button activates instead)', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			const closeButton = screen.getByRole('button', { name: /close diff viewer/i });

			act(() => {
				closeButton.focus();
				fireEvent.keyDown(closeButton, { key: 'Enter' });
			});

			// View type stays unified because the keydown originated from a button
			// and was skipped by isFormControl().
			expect(screen.getByTestId('diff-component')).toHaveAttribute('data-view-type', 'unified');
		});

		it('documents the Enter shortcut in the footer with the opposite view label', () => {
			mockParseGitDiff.mockReturnValue([createMockParsedFile()]);

			const { unmount } = render(
				<GitDiffViewer
					diffText="mock diff"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
					initialViewType="unified"
				/>
			);

			expect(screen.getByText(/to toggle side-by-side view/i)).toBeInTheDocument();

			// The persisted preference is read by the useState initializer, which
			// only runs on mount — so unmount and remount to pick up the change.
			unmount();
			window.localStorage.setItem(STORAGE_KEY, 'split');
			render(
				<GitDiffViewer
					diffText="mock diff (alt)"
					cwd="/test/project"
					theme={mockTheme}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText(/to toggle unified view/i)).toBeInTheDocument();
		});
	});
});
