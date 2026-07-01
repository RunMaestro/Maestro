import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../renderer/utils/logger';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FileExplorerPanel } from '../../../renderer/components/FileExplorerPanel';
import type { Session, Theme } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';

import { mockTheme } from '../../helpers/mockTheme';
import { spyOnListeners, expectAllListenersRemoved } from '../../helpers/listenerLeakAssertions';
// Mock lucide-react
vi.mock('lucide-react', () => ({
	ChevronRight: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-right" className={className} style={style}>
			▶
		</span>
	),
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-down" className={className} style={style}>
			▼
		</span>
	),
	Download: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="download" className={className} style={style}>
			⬇
		</span>
	),
	ChevronUp: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-up" className={className} style={style}>
			▲
		</span>
	),
	Folder: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-icon" className={className} style={style}>
			📁
		</span>
	),
	FolderInput: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-input-icon" className={className} style={style}>
			📥
		</span>
	),
	FolderUp: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-up-icon" className={className} style={style}>
			⬆️
		</span>
	),
	RefreshCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="refresh-icon" className={className} style={style}>
			🔄
		</span>
	),
	Check: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="check-icon" className={className} style={style}>
			✓
		</span>
	),
	Eye: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="eye-icon" className={className} style={style}>
			👁
		</span>
	),
	EyeOff: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="eye-off-icon" className={className} style={style}>
			👁‍🗨
		</span>
	),
	GitGraph: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="gitgraph-icon" className={className} style={style}>
			📊
		</span>
	),
	Target: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="target-icon" className={className} style={style}>
			🎯
		</span>
	),
	Copy: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="copy-icon" className={className} style={style}>
			📋
		</span>
	),
	ExternalLink: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="external-link-icon" className={className} style={style}>
			🔗
		</span>
	),
	FolderOpen: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-open-icon" className={className} style={style}>
			📂
		</span>
	),
	FileText: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="filetext-icon" className={className} style={style}>
			📄
		</span>
	),
	Server: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="server-icon" className={className} style={style}>
			🖥️
		</span>
	),
	GitBranch: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="gitbranch-icon" className={className} style={style}>
			🌿
		</span>
	),
	Clock: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="clock-icon" className={className} style={style}>
			🕐
		</span>
	),
	RotateCw: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="rotatecw-icon" className={className} style={style}>
			🔃
		</span>
	),
	Edit2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="edit2-icon" className={className} style={style}>
			✏️
		</span>
	),
	Globe: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="globe-icon" className={className} style={style}>
			🌐
		</span>
	),
	Trash2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="trash2-icon" className={className} style={style}>
			🗑️
		</span>
	),
	AlertTriangle: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="alert-triangle-icon" className={className} style={style}>
			⚠️
		</span>
	),
	X: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="x-icon" className={className} style={style}>
			✕
		</span>
	),
	Loader2: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="loader2-icon" className={className} style={style}>
			⏳
		</span>
	),
	Search: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="search-icon" className={className} style={style}>
			🔍
		</span>
	),
	FilePlus: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="file-plus-icon" className={className} style={style}>
			➕
		</span>
	),
	FolderPlus: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-plus-icon" className={className} style={style}>
			📁
		</span>
	),
	Files: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="files-icon" className={className} style={style}>
			🗂️
		</span>
	),
}));

// Mock @tanstack/react-virtual for virtualization
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, i) => ({
				index: i,
				start: i * 28,
				size: 28,
				key: i,
			})),
		getTotalSize: () => count * 28,
		measure: vi.fn(),
		scrollToOffset: vi.fn(),
		scrollToIndex: vi.fn(),
	}),
}));

// Mock createPortal
vi.mock('react-dom', async () => {
	const actual = await vi.importActual('react-dom');
	return {
		...actual,
		createPortal: (children: React.ReactNode) => children,
	};
});

// Mock LayerStackContext
const mockRegisterLayer = vi.fn(() => 'layer-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock getFileIcon
vi.mock('../../../renderer/utils/theme', () => ({
	getFileIcon: (type: string | undefined, theme: Theme) => {
		if (type === 'added') return <span data-testid="added-icon">+</span>;
		if (type === 'modified') return <span data-testid="modified-icon">~</span>;
		if (type === 'deleted') return <span data-testid="deleted-icon">-</span>;
		return <span data-testid="file-icon">📄</span>;
	},
	getExplorerFileIcon: (
		name: string,
		_theme: Theme,
		type?: string,
		iconTheme: 'default' | 'rich' = 'default'
	) => {
		if (type === 'added') return <span data-testid="added-icon">+</span>;
		if (type === 'modified') return <span data-testid="modified-icon">~</span>;
		if (type === 'deleted') return <span data-testid="deleted-icon">-</span>;
		void name;
		return (
			<span data-testid={iconTheme === 'rich' ? 'rich-file-icon' : 'file-icon'}>
				{iconTheme === 'rich' ? '🧩' : '📄'}
			</span>
		);
	},
	getExplorerFolderIcon: (
		_name: string,
		_isExpanded: boolean,
		_theme: Theme,
		iconTheme: 'default' | 'rich' = 'default'
	) => <span data-testid={iconTheme === 'rich' ? 'rich-folder-icon' : 'folder-icon'}>📁</span>,
}));

// Mock MODAL_PRIORITIES
vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		FILE_TREE_FILTER: 50,
	},
}));

// Mock useClickOutside - stores the callback for testing
let clickOutsideCallback: (() => void) | null = null;
vi.mock('../../../renderer/hooks/ui/useClickOutside', () => ({
	useClickOutside: (_ref: unknown, callback: () => void, enabled: boolean) => {
		if (enabled) {
			clickOutsideCallback = callback;
		} else {
			clickOutsideCallback = null;
		}
	},
}));

// Mock GitStatusContext so we can inject fileChanges for the active session
// (FileExplorerPanel reads from useGitDetail for #611 git change indicators).
let mockFileChanges: { path: string; status: string }[] = [];
vi.mock('../../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({
		getFileDetails: () => ({
			fileChanges: mockFileChanges.map((c) => ({
				path: c.path,
				status: c.status,
				additions: 0,
				deletions: 0,
				modified: c.status.includes('M'),
			})),
			totalAdditions: 0,
			totalDeletions: 0,
			modifiedCount: 0,
		}),
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
	}),
}));

// Create mock theme

const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({
		cwd: '/Users/test/project',
		fullPath: '/Users/test/project',
		projectRoot: '/Users/test/project',
		aiPid: 1234,
		terminalPid: 5678,
		isGitRepo: true,
		fileTreeAutoRefreshInterval: 0,
		...overrides,
	});

// Create mock file tree
const mockFileTree = [
	{
		name: 'src',
		type: 'folder' as const,
		children: [
			{
				name: 'index.ts',
				type: 'file' as const,
			},
			{
				name: 'utils',
				type: 'folder' as const,
				children: [
					{
						name: 'helpers.ts',
						type: 'file' as const,
					},
				],
			},
		],
	},
	{
		name: 'package.json',
		type: 'file' as const,
	},
	{
		name: 'README.md',
		type: 'file' as const,
	},
	{
		name: 'index.html',
		type: 'file' as const,
	},
];

describe('FileExplorerPanel', () => {
	let defaultProps: React.ComponentProps<typeof FileExplorerPanel>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockFileChanges = [];

		// Force non-compact toolbar so RefreshCw icon renders. Default
		// rightPanelWidth (384) is below RIGHT_PANEL_COMPACT_THRESHOLD (420),
		// which would hide the icon and break tests that assert on it.
		const { useSettingsStore } = await import('../../../renderer/stores/settingsStore');
		useSettingsStore.setState({ rightPanelWidth: 500 });

		defaultProps = {
			session: createMockSession(),
			theme: mockTheme,
			fileTreeFilter: '',
			setFileTreeFilter: vi.fn(),
			fileTreeFilterOpen: false,
			setFileTreeFilterOpen: vi.fn(),
			filteredFileTree: mockFileTree,
			selectedFileIndex: 0,
			setSelectedFileIndex: vi.fn(),
			activeFocus: 'main',
			activeRightTab: 'files',
			setActiveFocus: vi.fn(),
			fileTreeContainerRef: React.createRef<HTMLDivElement>(),
			fileTreeFilterInputRef: React.createRef<HTMLInputElement>(),
			toggleFolder: vi.fn(),
			toggleFolderRecursive: vi.fn(),
			handleFileClick: vi.fn().mockResolvedValue(undefined),
			expandAllFolders: vi.fn(),
			collapseAllFolders: vi.fn(),
			updateSessionWorkingDirectory: vi.fn().mockResolvedValue(undefined),
			refreshFileTree: vi.fn().mockResolvedValue({ totalChanges: 0 }),
			setSessions: vi.fn(),
			onAutoRefreshChange: vi.fn(),
			onShowFlash: vi.fn(),
			showHiddenFiles: false,
			fileExplorerIconTheme: 'default',
			setShowHiddenFiles: vi.fn(),
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Initial Render', () => {
		it('renders without crashing', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			expect(container).toBeTruthy();
		});

		it('displays the current working directory in header', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByTitle('/Users/test/project')).toBeInTheDocument();
		});

		it('displays file tree content', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByText('src')).toBeInTheDocument();
			expect(screen.getByText('package.json')).toBeInTheDocument();
		});

		it('applies theme background color to header', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const header = container.querySelector('.sticky');
			expect(header).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});
	});

	describe('Files Pane icon themes', () => {
		it('renders default theme icons when fileExplorerIconTheme is default', () => {
			render(<FileExplorerPanel {...defaultProps} />);

			expect(screen.getAllByTestId('file-icon').length).toBeGreaterThan(0);
			expect(screen.queryByTestId('rich-file-icon')).not.toBeInTheDocument();
		});

		it('renders rich theme icons when fileExplorerIconTheme is rich', () => {
			render(<FileExplorerPanel {...defaultProps} fileExplorerIconTheme="rich" />);

			expect(screen.getAllByTestId('rich-file-icon').length).toBeGreaterThan(0);
		});
	});

	describe('File Tree Filter', () => {
		it('does not show filter input when closed', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.queryByPlaceholderText('Filter files...')).not.toBeInTheDocument();
		});

		it('shows filter input when fileTreeFilterOpen is true', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);
			expect(screen.getByPlaceholderText('Filter files...')).toBeInTheDocument();
		});

		it('filter input has autoFocus', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);
			const input = screen.getByPlaceholderText('Filter files...');
			// autoFocus is a React prop that becomes autofocus attribute in HTML
			expect(input).toHaveFocus();
		});

		it('displays current filter value', () => {
			render(
				<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} fileTreeFilter="test" />
			);
			expect(screen.getByDisplayValue('test')).toBeInTheDocument();
		});

		it('calls setFileTreeFilter on input change', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);
			const input = screen.getByPlaceholderText('Filter files...');
			fireEvent.change(input, { target: { value: 'search' } });
			expect(defaultProps.setFileTreeFilter).toHaveBeenCalledWith('search');
		});

		it('registers layer when filter is open', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);
			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'overlay',
					priority: 50,
					blocksLowerLayers: false,
					capturesFocus: true,
					focusTrap: 'none',
					allowClickOutside: true,
					ariaLabel: 'File Tree Filter',
				})
			);
		});

		it('unregisters layer when filter is closed', () => {
			const { rerender } = render(
				<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />
			);
			expect(mockRegisterLayer).toHaveBeenCalled();

			rerender(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={false} />);
			expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-123');
		});

		it('updates layer handler when filter dependencies change', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);
			expect(mockUpdateLayerHandler).toHaveBeenCalled();
		});

		it('shows no results message when filter has no matches', () => {
			render(
				<FileExplorerPanel {...defaultProps} fileTreeFilter="nonexistent" filteredFileTree={[]} />
			);
			expect(screen.getByText('No files match your search')).toBeInTheDocument();
		});

		it('applies accent color border to filter input', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);
			const input = screen.getByPlaceholderText('Filter files...');
			expect(input).toHaveStyle({ borderColor: mockTheme.colors.accent });
		});
	});

	describe('Header Controls', () => {
		it('renders refresh button', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();
		});

		it('renders expand all button with correct title', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByTitle('Expand all folders')).toBeInTheDocument();
		});

		it('renders collapse all button with correct title', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByTitle('Collapse all folders')).toBeInTheDocument();
		});

		it('calls expandAllFolders when expand button is clicked', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const expandButton = screen.getByTitle('Expand all folders');
			fireEvent.click(expandButton);
			expect(defaultProps.expandAllFolders).toHaveBeenCalledWith(
				'session-1',
				expect.any(Object),
				expect.any(Function)
			);
		});

		it('calls collapseAllFolders when collapse button is clicked', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const collapseButton = screen.getByTitle('Collapse all folders');
			fireEvent.click(collapseButton);
			expect(defaultProps.collapseAllFolders).toHaveBeenCalledWith(
				'session-1',
				expect.any(Function)
			);
		});
	});

	describe('Find Button (#759)', () => {
		it('opens the filter input when clicked while closed', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={false} />);
			fireEvent.click(screen.getByText('Find'));
			expect(defaultProps.setFileTreeFilterOpen).toHaveBeenCalledWith(true);
		});

		it('closes the filter input when clicked while open and empty', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} fileTreeFilter="" />);
			fireEvent.click(screen.getByText('Find'));
			expect(defaultProps.setFileTreeFilterOpen).toHaveBeenCalledWith(false);
		});

		it('does not close the filter input when it has a query', () => {
			render(
				<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} fileTreeFilter="src" />
			);
			fireEvent.click(screen.getByText('Find'));
			expect(defaultProps.setFileTreeFilterOpen).not.toHaveBeenCalledWith(false);
		});
	});

	describe('Dotfiles Toggle (#757)', () => {
		it('keeps .maestro visible when showHiddenFiles is false (other dotfiles still hidden)', () => {
			// Invariant: `.maestro` is the project's Maestro workspace and must
			// never be hidden by the dotfiles toggle. Other dotfiles (e.g. `.git`)
			// are still filtered out. See FileExplorerPanel.filterHiddenFiles.
			const treeWithMaestro = [
				{ name: '.maestro', type: 'folder' as const, children: [] },
				{ name: '.git', type: 'folder' as const, children: [] },
				{ name: 'src', type: 'folder' as const, children: [] },
			];
			render(
				<FileExplorerPanel
					{...defaultProps}
					showHiddenFiles={false}
					filteredFileTree={treeWithMaestro}
				/>
			);
			expect(screen.getByText('.maestro')).toBeInTheDocument();
			expect(screen.queryByText('.git')).not.toBeInTheDocument();
			expect(screen.getByText('src')).toBeInTheDocument();
		});

		it('shows .maestro when showHiddenFiles is true', () => {
			const treeWithMaestro = [
				{ name: '.maestro', type: 'folder' as const, children: [] },
				{ name: 'src', type: 'folder' as const, children: [] },
			];
			render(
				<FileExplorerPanel
					{...defaultProps}
					showHiddenFiles={true}
					filteredFileTree={treeWithMaestro}
				/>
			);
			expect(screen.getByText('.maestro')).toBeInTheDocument();
			expect(screen.getByText('src')).toBeInTheDocument();
		});

		it('renders the toggle button labeled ".files"', () => {
			render(<FileExplorerPanel {...defaultProps} showHiddenFiles={false} />);
			expect(screen.getByText('.files')).toBeInTheDocument();
			expect(screen.getByTitle('Show dotfiles')).toBeInTheDocument();
		});

		it('exposes a "Hide dotfiles" tooltip while dotfiles are shown', () => {
			render(<FileExplorerPanel {...defaultProps} showHiddenFiles={true} />);
			expect(screen.getByText('.files')).toBeInTheDocument();
			expect(screen.getByTitle('Hide dotfiles')).toBeInTheDocument();
		});

		it('toggles showHiddenFiles when clicked', () => {
			render(<FileExplorerPanel {...defaultProps} showHiddenFiles={false} />);
			fireEvent.click(screen.getByText('.files'));
			expect(defaultProps.setShowHiddenFiles).toHaveBeenCalledWith(true);
		});

		it('hides the .files toggle when dotfilesToggleHidden setting is true', async () => {
			const { useSettingsStore } = await import('../../../renderer/stores/settingsStore');
			const prev = useSettingsStore.getState().dotfilesToggleHidden;
			useSettingsStore.setState({ dotfilesToggleHidden: true });
			try {
				render(<FileExplorerPanel {...defaultProps} showHiddenFiles={false} />);
				expect(screen.queryByText('.files')).not.toBeInTheDocument();
				expect(screen.queryByTitle('Show dotfiles')).not.toBeInTheDocument();
			} finally {
				useSettingsStore.setState({ dotfilesToggleHidden: prev });
			}
		});
	});

	describe('Refresh Button', () => {
		it('shows default title when no auto-refresh', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByTitle('Refresh file tree')).toBeInTheDocument();
		});

		it('shows auto-refresh title when interval is set', () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 20 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			expect(screen.getByTitle('Auto-refresh every 20s')).toBeInTheDocument();
		});

		it('applies accent color when auto-refresh is active', () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 20 });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const refreshButton = container.querySelector('[title="Auto-refresh every 20s"]');
			expect(refreshButton).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('calls refreshFileTree when clicked', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');
			fireEvent.click(refreshButton);
			expect(defaultProps.refreshFileTree).toHaveBeenCalledWith('session-1');
		});

		it('shows flash notification on refresh with 0 changes', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			await act(async () => {
				fireEvent.click(refreshButton);
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('No changes detected');
		});

		it('shows flash notification with change count on refresh', async () => {
			(defaultProps.refreshFileTree as ReturnType<typeof vi.fn>).mockResolvedValue({
				totalChanges: 5,
			});
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			await act(async () => {
				fireEvent.click(refreshButton);
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Detected 5 changes');
		});

		it('shows singular form for 1 change', async () => {
			(defaultProps.refreshFileTree as ReturnType<typeof vi.fn>).mockResolvedValue({
				totalChanges: 1,
			});
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			await act(async () => {
				fireEvent.click(refreshButton);
				await vi.advanceTimersByTimeAsync(0);
			});

			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Detected 1 change');
		});

		it('adds spin animation class when refreshing', async () => {
			let resolveRefresh: (value: any) => void;
			(defaultProps.refreshFileTree as ReturnType<typeof vi.fn>).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveRefresh = resolve;
					})
			);

			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			await act(async () => {
				fireEvent.click(refreshButton);
			});

			// During refresh, icon should spin
			const refreshIcon = screen.getByTestId('refresh-icon');
			expect(refreshIcon.className).toContain('animate-spin');

			// Resolve and wait for animation timeout
			await act(async () => {
				resolveRefresh!({ totalChanges: 0 });
				await vi.advanceTimersByTimeAsync(500);
			});
		});
	});

	describe('Auto-refresh Overlay', () => {
		it('shows overlay on hover after delay', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);

			// Overlay not visible yet
			expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();

			// Wait for hover delay
			act(() => {
				vi.advanceTimersByTime(400);
			});

			expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
		});

		it('does not show overlay if mouse leaves before delay', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);

			act(() => {
				vi.advanceTimersByTime(200);
			});

			fireEvent.mouseLeave(refreshButton);

			act(() => {
				vi.advanceTimersByTime(200);
			});

			expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();
		});

		it('displays all auto-refresh options', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			expect(screen.getByText('Every 5 seconds')).toBeInTheDocument();
			expect(screen.getByText('Every 20 seconds')).toBeInTheDocument();
			expect(screen.getByText('Every 60 seconds')).toBeInTheDocument();
			expect(screen.getByText('Every 3 minutes')).toBeInTheDocument();
		});

		it('shows check icon for currently selected interval', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 20 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			const refreshButton = screen.getByTitle('Auto-refresh every 20s');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			expect(screen.getByTestId('check-icon')).toBeInTheDocument();
		});

		it('calls onAutoRefreshChange when option is selected', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const option = screen.getByText('Every 5 seconds');
			fireEvent.click(option);

			expect(defaultProps.onAutoRefreshChange).toHaveBeenCalledWith(5);
		});

		it('closes overlay after selecting option', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const option = screen.getByText('Every 5 seconds');
			fireEvent.click(option);

			// Overlay should close after selection
			expect(screen.queryByText('Every 20 seconds')).not.toBeInTheDocument();
		});

		it('shows disable option when auto-refresh is active', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 20 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			const refreshButton = screen.getByTitle('Auto-refresh every 20s');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			expect(screen.getByText('Disable auto-refresh')).toBeInTheDocument();
		});

		it('does not show disable option when auto-refresh is inactive', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			expect(screen.queryByText('Disable auto-refresh')).not.toBeInTheDocument();
		});

		it('calls onAutoRefreshChange with 0 to disable', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 20 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			const refreshButton = screen.getByTitle('Auto-refresh every 20s');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const disableOption = screen.getByText('Disable auto-refresh');
			fireEvent.click(disableOption);

			expect(defaultProps.onAutoRefreshChange).toHaveBeenCalledWith(0);
		});

		it('keeps overlay open when mouse enters overlay', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			// Leave button
			fireEvent.mouseLeave(refreshButton);

			// Enter overlay before close delay
			const overlay = screen.getByText('Auto-refresh').closest('div');
			fireEvent.mouseEnter(overlay!);

			act(() => {
				vi.advanceTimersByTime(200);
			});

			// Overlay should still be visible
			expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
		});

		it('closes overlay when mouse leaves overlay', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const overlay = screen.getByText('Auto-refresh').closest('.fixed');
			fireEvent.mouseEnter(overlay!);
			fireEvent.mouseLeave(overlay!);

			expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();
		});
	});

	describe('Auto-refresh Timer', () => {
		it('starts timer when interval is set', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 5 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(defaultProps.refreshFileTree).not.toHaveBeenCalled();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});

			expect(defaultProps.refreshFileTree).toHaveBeenCalledWith('session-1');
		});

		it('shows brief spin animation during auto-refresh', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 5 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});

			// Icon should be spinning after auto-refresh fires
			const refreshIcon = screen.getByTestId('refresh-icon');
			expect(refreshIcon.className).toContain('animate-spin');

			// After 500ms the spin stops
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});
			expect(refreshIcon.className).not.toContain('animate-spin');
		});

		it('calls refresh at interval repeatedly', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 5 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(15000);
			});

			expect(defaultProps.refreshFileTree).toHaveBeenCalledTimes(3);
		});

		it('does not start timer when interval is 0', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 0 });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(60000);
			});

			expect(defaultProps.refreshFileTree).not.toHaveBeenCalled();
		});

		it('skips auto-refresh when previous call is still in flight', async () => {
			let resolveRefresh: () => void;
			const slowRefresh = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveRefresh = resolve;
					})
			);
			const session = createMockSession({ fileTreeAutoRefreshInterval: 1 });
			render(
				<FileExplorerPanel {...defaultProps} session={session} refreshFileTree={slowRefresh} />
			);

			// First interval fires, refresh starts but doesn't resolve
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(slowRefresh).toHaveBeenCalledTimes(1);

			// Second interval fires while first is still in flight — should be skipped
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(slowRefresh).toHaveBeenCalledTimes(1);

			// Resolve the first call and let spin timeout clear
			await act(async () => {
				resolveRefresh!();
				await vi.advanceTimersByTimeAsync(500);
			});

			// Third interval fires — should proceed now
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});
			expect(slowRefresh).toHaveBeenCalledTimes(2);
		});

		it('handles auto-refresh errors gracefully', async () => {
			const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const failingRefresh = vi.fn().mockRejectedValue(new Error('network failure'));
			const session = createMockSession({ fileTreeAutoRefreshInterval: 5 });
			render(
				<FileExplorerPanel {...defaultProps} session={session} refreshFileTree={failingRefresh} />
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});

			expect(failingRefresh).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledWith(
				'[FileExplorer] Auto-refresh failed:',
				undefined,
				expect.any(Error)
			);

			// Spin timeout should still clear, allowing the next refresh to fire
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});
			expect(failingRefresh).toHaveBeenCalledTimes(2);

			errorSpy.mockRestore();
		});

		it('clears timer on unmount', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 5 });
			const { unmount } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			unmount();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(10000);
			});

			// No calls after unmount
			expect(defaultProps.refreshFileTree).not.toHaveBeenCalled();
		});

		it('restarts timer when interval changes', async () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: 60 });
			const { rerender } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(30000);
			});

			expect(defaultProps.refreshFileTree).not.toHaveBeenCalled();

			// Change interval
			const newSession = createMockSession({ fileTreeAutoRefreshInterval: 5 });
			rerender(<FileExplorerPanel {...defaultProps} session={newSession} />);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(5000);
			});

			expect(defaultProps.refreshFileTree).toHaveBeenCalledTimes(1);
		});
	});

	describe('File Tree Rendering', () => {
		it('renders folders with folder icon', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const folderIcons = screen.getAllByTestId('folder-icon');
			expect(folderIcons.length).toBeGreaterThan(0);
		});

		it('renders files with file icon', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const fileIcons = screen.getAllByTestId('file-icon');
			expect(fileIcons.length).toBeGreaterThan(0);
		});

		it('renders collapsed folders with ChevronRight', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getAllByTestId('chevron-right').length).toBeGreaterThan(0);
		});

		it('renders expanded folders with ChevronDown', () => {
			const session = createMockSession({
				fileExplorerExpanded: ['src', 'src/utils'],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			expect(screen.getAllByTestId('chevron-down').length).toBeGreaterThan(0);
		});

		it('renders children when folder is expanded', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			expect(screen.getByText('index.ts')).toBeInTheDocument();
			expect(screen.getByText('utils')).toBeInTheDocument();
		});

		it('does not render children when folder is collapsed', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			// index.ts is inside src, which is collapsed by default
			expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
		});

		it('applies indentation to nested items via paddingLeft', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			// Virtualized tree uses paddingLeft for indentation: 8 + depth * 20
			// index.ts is at depth 1, so paddingLeft = 8 + 1*20 = 28px
			const nestedItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.ts')
			);
			expect(nestedItem).toHaveStyle({ paddingLeft: '28px' });
		});

		it('displays file name with truncate class', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const truncateSpans = container.querySelectorAll('.truncate');
			expect(truncateSpans.length).toBeGreaterThan(0);
		});

		it('renders the full file name as visible text', () => {
			// The name is rendered as the HoverTooltip trigger's text content
			// (the tooltip reveals it on hover only when truncated), so it replaces
			// the old native title= attribute.
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByText('src')).toBeInTheDocument();
			expect(screen.getByText('package.json')).toBeInTheDocument();
		});

		it('deduplicates NFD/NFC sibling entries rendering only one row', () => {
			const nfcName = 'caf\u00e9.txt'.normalize('NFC');
			const nfdName = 'caf\u00e9.txt'.normalize('NFD');

			const treeWithDupes = [
				{ name: nfcName, type: 'file' as const },
				{ name: nfdName, type: 'file' as const }, // same visual name, different Unicode form
				{ name: 'other.txt', type: 'file' as const },
			];

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			render(<FileExplorerPanel {...defaultProps} filteredFileTree={treeWithDupes} />);

			// Should only render 2 rows (deduplicated café.txt + other.txt), not 3
			const items = screen.getAllByText(nfcName);
			expect(items).toHaveLength(1);
			expect(screen.getByText('other.txt')).toBeInTheDocument();

			consoleSpy.mockRestore();
		});
	});

	describe('File and Folder Clicks', () => {
		it('calls toggleFolder when clicking a folder', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const srcFolder = screen.getByText('src');
			fireEvent.click(srcFolder);

			expect(defaultProps.toggleFolder).toHaveBeenCalledWith(
				'src',
				'session-1',
				expect.any(Function)
			);
			expect(defaultProps.toggleFolderRecursive).not.toHaveBeenCalled();
		});

		it('calls toggleFolderRecursive on Alt+click of a folder', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const srcFolder = screen.getByText('src');
			fireEvent.click(srcFolder, { altKey: true });

			expect(defaultProps.toggleFolderRecursive).toHaveBeenCalledWith(
				'src',
				'session-1',
				expect.any(Function)
			);
			expect(defaultProps.toggleFolder).not.toHaveBeenCalled();
		});

		it('sets selectedFileIndex and activeFocus when clicking a file', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const file = screen.getByText('package.json');
			fireEvent.click(file);

			expect(defaultProps.setSelectedFileIndex).toHaveBeenCalled();
			expect(defaultProps.setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('sets selectedFileIndex and activeFocus when clicking a folder (#768)', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const folder = screen.getByText('src');
			fireEvent.click(folder);

			expect(defaultProps.setSelectedFileIndex).toHaveBeenCalled();
			expect(defaultProps.setActiveFocus).toHaveBeenCalledWith('right');
			expect(defaultProps.toggleFolder).toHaveBeenCalled();
		});

		it('does not change focus when clicking a folder while filtering', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilter="src" />);
			const folder = screen.getByText('src');
			fireEvent.click(folder);

			expect(defaultProps.setSelectedFileIndex).toHaveBeenCalled();
			expect(defaultProps.setActiveFocus).not.toHaveBeenCalled();
		});

		it('calls handleFileClick on double-click of file', async () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			const file = screen.getByText('index.ts');

			fireEvent.doubleClick(file);

			expect(defaultProps.handleFileClick).toHaveBeenCalled();
		});

		it('does not call handleFileClick on double-click of folder', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const folder = screen.getByText('src');

			fireEvent.doubleClick(folder);

			expect(defaultProps.handleFileClick).not.toHaveBeenCalled();
		});
	});

	describe('Selected and Keyboard Selected States', () => {
		it('applies selected style when file tab is active', () => {
			// File selection highlighting now uses active file tab (session.activeFileTabId)
			// Create a session with an active file tab that matches the file path
			const sessionWithFileTab = createMockSession({
				activeFileTabId: 'file-tab-1',
				filePreviewTabs: [
					{
						id: 'file-tab-1',
						path: '/Users/test/project/package.json',
						name: 'package',
						extension: '.json',
						content: '{}',
						scrollTop: 0,
						searchQuery: '',
						editMode: false,
						editContent: undefined,
						isLoading: false,
						lastModified: Date.now(),
						sshRemoteId: undefined,
					},
				],
			});
			const props = {
				...defaultProps,
				activeSession: sessionWithFileTab,
			};
			const { container } = render(<FileExplorerPanel {...props} />);
			const selectedItem = container.querySelector('[class*="bg-white/10"]');
			expect(selectedItem).toBeInTheDocument();
		});

		it('applies keyboard selected style when focused', () => {
			const props = {
				...defaultProps,
				activeFocus: 'right',
				activeRightTab: 'files',
				selectedFileIndex: 0,
			};
			const { container } = render(<FileExplorerPanel {...props} />);
			const keyboardSelectedItem = container.querySelector('[data-file-index="0"]');
			expect(keyboardSelectedItem).toHaveStyle({
				borderLeftColor: mockTheme.colors.accent,
				backgroundColor: mockTheme.colors.bgActivity,
			});
		});

		it('does not apply keyboard selected style when not focused', () => {
			const props = {
				...defaultProps,
				activeFocus: 'main',
				activeRightTab: 'files',
				selectedFileIndex: 0,
			};
			const { container } = render(<FileExplorerPanel {...props} />);
			const item = container.querySelector('[data-file-index="0"]');
			// When not focused, should not have accent color (uses transparent which may not be in computed style)
			expect(item).not.toHaveStyle({ borderLeftColor: mockTheme.colors.accent });
		});

		it('does not apply keyboard selected style when on different tab', () => {
			const props = {
				...defaultProps,
				activeFocus: 'right',
				activeRightTab: 'history',
				selectedFileIndex: 0,
			};
			const { container } = render(<FileExplorerPanel {...props} />);
			const item = container.querySelector('[data-file-index="0"]');
			// When on different tab, should not have accent color
			expect(item).not.toHaveStyle({ borderLeftColor: mockTheme.colors.accent });
		});
	});

	describe('Changed Files Display', () => {
		const findRowFor = (container: HTMLElement, label: string) =>
			Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes(label)
			) as HTMLElement | undefined;
		const findIndicator = (row: HTMLElement | undefined) =>
			row?.querySelector('[data-testid="git-change-indicator"]') as HTMLElement | undefined;

		it('renders a change indicator for modified files (trimmed porcelain "M")', () => {
			// `useGitStatusPolling` stores trimmed status codes, so production
			// values look like `"M"` rather than `" M"`. We match that here.
			mockFileChanges = [{ path: 'package.json', status: 'M' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const indicator = findIndicator(findRowFor(container, 'package.json'));
			expect(indicator).toBeDefined();
			expect(indicator).toHaveAttribute('data-change-type', 'modified');
			expect(indicator).toHaveStyle({ backgroundColor: mockTheme.colors.warning });
		});

		it('renders a change indicator for added files (untracked "??")', () => {
			mockFileChanges = [{ path: 'package.json', status: '??' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const indicator = findIndicator(findRowFor(container, 'package.json'));
			expect(indicator).toHaveAttribute('data-change-type', 'added');
			expect(indicator).toHaveStyle({ backgroundColor: mockTheme.colors.success });
		});

		it('renders a change indicator for deleted files (trimmed porcelain "D")', () => {
			mockFileChanges = [{ path: 'package.json', status: 'D' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const indicator = findIndicator(findRowFor(container, 'package.json'));
			expect(indicator).toHaveAttribute('data-change-type', 'deleted');
			expect(indicator).toHaveStyle({ backgroundColor: mockTheme.colors.error });
		});

		it('matches the full relative path, not a substring of the file name (#611)', () => {
			// File "package.json" should NOT light up when a different file under
			// src/ happens to contain "package" in its full path.
			mockFileChanges = [{ path: 'src/package-loader.ts', status: 'M' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			expect(findIndicator(findRowFor(container, 'package.json'))).toBeNull();
		});

		it('highlights ancestor folders containing changed descendants', () => {
			// Need to expand src/ so its descendants render; otherwise only the
			// folder row appears.
			const expandedSession = createMockSession({
				fileExplorerExpanded: ['src', 'src/utils'],
			});
			mockFileChanges = [{ path: 'src/utils/helpers.ts', status: 'M' }];
			const { container } = render(
				<FileExplorerPanel {...defaultProps} session={expandedSession} />
			);

			// The src/ folder row shows the descendant-style indicator
			const srcIndicator = findIndicator(findRowFor(container, 'src'));
			expect(srcIndicator).toBeDefined();
			expect(srcIndicator).toHaveAttribute('data-change-type', 'descendant');

			// The leaf file itself shows the modified-type indicator
			const helpersIndicator = findIndicator(findRowFor(container, 'helpers.ts'));
			expect(helpersIndicator).toHaveAttribute('data-change-type', 'modified');
		});

		it('does not tint the file icon (icons stay consistent regardless of state)', () => {
			// Per #611 follow-up, the icon should not change for added/modified/deleted.
			mockFileChanges = [{ path: 'package.json', status: 'M' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			// The mocked icon distinguishes types via test ids ('added-icon',
			// 'modified-icon', 'deleted-icon'); the plain 'file-icon' is the
			// untinted form. Asserting on it pins down that we no longer pass
			// the change type into getExplorerFileIcon.
			expect(container.querySelector('[data-testid="modified-icon"]')).toBeNull();
			expect(container.querySelector('[data-testid="file-icon"]')).not.toBeNull();
		});

		it('applies bold font to changed file names', () => {
			mockFileChanges = [{ path: 'package.json', status: 'M' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const boldItems = container.querySelectorAll('.font-medium');
			expect(boldItems.length).toBeGreaterThan(0);
		});

		it('applies textMain color to changed file rows', () => {
			mockFileChanges = [{ path: 'package.json', status: 'M' }];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const row = findRowFor(container, 'package.json');
			expect(row).toHaveStyle({ color: mockTheme.colors.textMain });
		});

		it('uses the colorblind-safe palette when colorBlindMode is enabled', async () => {
			const { useSettingsStore } = await import('../../../renderer/stores/settingsStore');
			useSettingsStore.setState({ rightPanelWidth: 500, colorBlindMode: true });

			mockFileChanges = [
				{ path: 'package.json', status: 'M' },
				{ path: 'README.md', status: '??' },
			];
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			// Modified → orange (#EE7733), Added → teal (#009988)
			expect(findIndicator(findRowFor(container, 'package.json'))).toHaveStyle({
				backgroundColor: '#EE7733',
			});
			expect(findIndicator(findRowFor(container, 'README.md'))).toHaveStyle({
				backgroundColor: '#009988',
			});

			// Restore default for subsequent tests.
			useSettingsStore.setState({ colorBlindMode: false });
		});
	});

	describe('Error State', () => {
		it('displays error message when fileTreeError is set', () => {
			const session = createMockSession({
				fileTreeError: 'Directory not found',
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('Directory not found')).toBeInTheDocument();
		});

		it('shows Retry Connection button on error', () => {
			const session = createMockSession({
				fileTreeError: 'Permission denied',
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('Retry Connection')).toBeInTheDocument();
		});

		it('calls refreshFileTree when Retry Connection is clicked', () => {
			const session = createMockSession({
				fileTreeError: 'Permission denied',
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			const button = screen.getByText('Retry Connection');
			fireEvent.click(button);

			expect(defaultProps.refreshFileTree).toHaveBeenCalledWith('session-1');
		});

		it('applies error color to error message', () => {
			const session = createMockSession({
				fileTreeError: 'Error message',
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			const errorDiv = container.querySelector('[class*="text-center"]');
			expect(errorDiv).toHaveStyle({ color: mockTheme.colors.error });
		});

		it('does not show file tree when error is present', () => {
			const session = createMockSession({
				fileTreeError: 'Error message',
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.queryByText('src')).not.toBeInTheDocument();
			expect(screen.queryByText('package.json')).not.toBeInTheDocument();
		});
	});

	describe('Empty State', () => {
		it('shows loading message when fileTreeLoading is true', () => {
			const session = createMockSession({ fileTree: [], fileTreeLoading: true });
			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.getByText('Loading files...')).toBeInTheDocument();
		});

		it('hides Stop loading when cancelFileTreeLoad is not provided', () => {
			const session = createMockSession({ fileTree: [], fileTreeLoading: true });
			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.queryByText('Stop loading')).not.toBeInTheDocument();
		});

		it('hides Stop loading for local sessions even when cancelFileTreeLoad is provided', () => {
			const session = createMockSession({ fileTree: [], fileTreeLoading: true });
			render(
				<FileExplorerPanel
					{...defaultProps}
					session={session}
					filteredFileTree={[]}
					cancelFileTreeLoad={vi.fn()}
				/>
			);

			expect(screen.queryByText('Stop loading')).not.toBeInTheDocument();
		});

		it('invokes cancelFileTreeLoad with session id when Stop loading clicked on SSH session', () => {
			const session = createMockSession({
				id: 'session-xyz',
				fileTree: [],
				fileTreeLoading: true,
				sshRemoteId: 'remote-1',
			});
			const cancelFileTreeLoad = vi.fn();
			render(
				<FileExplorerPanel
					{...defaultProps}
					session={session}
					filteredFileTree={[]}
					cancelFileTreeLoad={cancelFileTreeLoad}
				/>
			);

			fireEvent.click(screen.getByText('Stop loading'));
			expect(cancelFileTreeLoad).toHaveBeenCalledWith('session-xyz');
		});

		it('shows no files found when fileTree is empty and not loading', () => {
			const session = createMockSession({ fileTree: [], fileTreeLoading: false });
			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.getByText('No files found')).toBeInTheDocument();
		});

		it('shows no files found when fileTree is null and not loading', () => {
			const session = createMockSession({ fileTree: undefined as any, fileTreeLoading: false });
			render(
				<FileExplorerPanel
					{...defaultProps}
					session={session}
					filteredFileTree={undefined as any}
				/>
			);

			expect(screen.getByText('No files found')).toBeInTheDocument();
		});
	});

	describe('Portal Overlay Position', () => {
		it('calculates overlay position from button rect', async () => {
			// Mock getBoundingClientRect
			const mockRect = {
				top: 100,
				left: 200,
				bottom: 130,
				right: 230,
				width: 30,
				height: 30,
				x: 200,
				y: 100,
				toJSON: () => {},
			};

			vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(mockRect);

			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const overlay = screen.getByText('Auto-refresh').closest('.fixed');
			expect(overlay).toHaveStyle({
				top: '134px', // bottom + 4
				left: '230px', // right
			});
		});
	});

	describe('Theme Styling', () => {
		it('applies bgSidebar to overlay background', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const overlay = screen.getByText('Auto-refresh').closest('.fixed');
			expect(overlay).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('applies border color to overlay', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const overlay = screen.getByText('Auto-refresh').closest('.fixed');
			expect(overlay).toHaveStyle({ borderColor: mockTheme.colors.border });
		});

		it('applies bgActivity to overlay header', async () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const header = screen.getByText('Auto-refresh');
			expect(header).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
		});

		it('applies textDim to unchanged file names', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			// First item should be src (unchanged folder)
			const item = container.querySelector('[data-file-index="0"]');
			expect(item).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('Nested File Tree', () => {
		it('renders deeply nested structure when all expanded', () => {
			const session = createMockSession({
				fileExplorerExpanded: ['src', 'src/utils'],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('src')).toBeInTheDocument();
			expect(screen.getByText('index.ts')).toBeInTheDocument();
			expect(screen.getByText('utils')).toBeInTheDocument();
			expect(screen.getByText('helpers.ts')).toBeInTheDocument();
		});

		it('tracks global index correctly through nested items', () => {
			const session = createMockSession({
				fileExplorerExpanded: ['src', 'src/utils'],
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			// Check indices are sequential
			const items = container.querySelectorAll('[data-file-index]');
			const indices = Array.from(items).map((el) =>
				parseInt(el.getAttribute('data-file-index')!, 10)
			);

			// Should be sequential: 0, 1, 2, 3, 4...
			for (let i = 0; i < indices.length; i++) {
				expect(indices[i]).toBe(i);
			}
		});

		it('correctly builds full paths for nested items', () => {
			const session = createMockSession({
				fileExplorerExpanded: ['src', 'src/utils'],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			// Double-click helpers.ts to verify path building
			const helpersFile = screen.getByText('helpers.ts');
			fireEvent.doubleClick(helpersFile);

			expect(defaultProps.handleFileClick).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'helpers.ts' }),
				'src/utils/helpers.ts',
				expect.any(Object)
			);
		});
	});

	// LOCKED VISUAL INVARIANTS — DO NOT RELAX WITHOUT EXPLICIT REQUEST.
	// Alignment rules (see FileExplorerPanel.tsx TreeRow):
	//   BASE_PAD = 8, INDENT_STEP = 20 (= chevron width 12 + flex gap 8)
	//   Row padding-left:  BASE_PAD + depth * INDENT_STEP
	//   Indent guide left: 12 + i * INDENT_STEP   for i in [0, depth)
	// Derived alignment guarantees:
	//   1. Root files (depth 0) align with root folder chevrons at X = 8.
	//   2. File icon at depth N+1 aligns with parent folder icon at depth N,
	//      because folder_icon_X(N) = pad(N) + chevron(12) + gap(8) = pad(N+1).
	//   3. Sibling rows at the same depth share identical padding-left.
	describe('Indent Alignment (locked invariants)', () => {
		const BASE_PAD = 8;
		const INDENT_STEP = 20;
		const CHEVRON_PLUS_GAP = 20; // w-3 (12) + gap-2 (8) — must equal INDENT_STEP
		const expectedPad = (depth: number) => `${BASE_PAD + depth * INDENT_STEP}px`;

		const getRowByText = (container: HTMLElement, text: string) =>
			Array.from(container.querySelectorAll<HTMLElement>('[data-file-index]')).find((el) =>
				el.textContent?.includes(text)
			);

		it('root folder row has padding-left = 8px', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const row = getRowByText(container, 'src');
			expect(row).toHaveStyle({ paddingLeft: expectedPad(0) });
			expect(row).toHaveStyle({ paddingLeft: '8px' });
		});

		it('root file row has padding-left = 8px (aligned with root folder chevron)', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const row = getRowByText(container, 'package.json');
			expect(row).toHaveStyle({ paddingLeft: expectedPad(0) });
			expect(row).toHaveStyle({ paddingLeft: '8px' });
		});

		it('depth-1 folder row has padding-left = 28px', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const row = getRowByText(container, 'utils');
			expect(row).toHaveStyle({ paddingLeft: expectedPad(1) });
			expect(row).toHaveStyle({ paddingLeft: '28px' });
		});

		it('depth-1 file row has padding-left = 28px (same column as sibling folder)', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const row = getRowByText(container, 'index.ts');
			expect(row).toHaveStyle({ paddingLeft: expectedPad(1) });
			expect(row).toHaveStyle({ paddingLeft: '28px' });
		});

		it('depth-2 file row has padding-left = 48px', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src', 'src/utils'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const row = getRowByText(container, 'helpers.ts');
			expect(row).toHaveStyle({ paddingLeft: expectedPad(2) });
			expect(row).toHaveStyle({ paddingLeft: '48px' });
		});

		it('file icon at depth N+1 aligns with parent folder icon at depth N', () => {
			// Core parent-child alignment invariant.
			// folder_icon_X(N) = pad(N) + chevron_width + gap
			//                 = 8 + 20N + 20 = 28 + 20N
			// file_pad(N+1)   = 8 + 20(N+1) = 28 + 20N  ✓
			const session = createMockSession({ fileExplorerExpanded: ['src', 'src/utils'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			const parentFolder = getRowByText(container, 'utils'); // depth 1
			const childFile = getRowByText(container, 'helpers.ts'); // depth 2

			const parentPad = parseFloat(parentFolder!.style.paddingLeft);
			const childPad = parseFloat(childFile!.style.paddingLeft);

			// Parent folder's icon column == parent pad + chevron + gap
			// Child file's icon column == child pad
			// These must be equal.
			expect(childPad).toBe(parentPad + CHEVRON_PLUS_GAP);
		});

		it('indent step equals chevron width + gap (required for parent-child alignment)', () => {
			// If this fails, the parent-child alignment invariant above breaks.
			expect(INDENT_STEP).toBe(CHEVRON_PLUS_GAP);
		});

		it('renders one indent guide per depth level, spaced by INDENT_STEP', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src', 'src/utils'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			// helpers.ts at depth 2 should have 2 guides at left = 12 and 12 + 20 = 32
			const row = getRowByText(container, 'helpers.ts');
			const guides = row!.querySelectorAll<HTMLElement>('div.absolute.w-px');
			expect(guides).toHaveLength(2);
			expect(guides[0]).toHaveStyle({ left: '12px' });
			expect(guides[1]).toHaveStyle({ left: `${12 + INDENT_STEP}px` });
			expect(guides[1]).toHaveStyle({ left: '32px' });
		});

		it('root rows render zero indent guides', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const row = getRowByText(container, 'package.json');
			const guides = row!.querySelectorAll('div.absolute.w-px');
			expect(guides).toHaveLength(0);
		});

		it('sibling folder and file at same depth share identical padding-left', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const folder = getRowByText(container, 'utils'); // depth 1 folder
			const file = getRowByText(container, 'index.ts'); // depth 1 file
			expect(folder!.style.paddingLeft).toBe(file!.style.paddingLeft);
		});
	});

	describe('Folder Toggle Path Building', () => {
		it('builds correct path for root-level folders', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const srcFolder = screen.getByText('src');
			fireEvent.click(srcFolder);

			expect(defaultProps.toggleFolder).toHaveBeenCalledWith(
				'src',
				'session-1',
				expect.any(Function)
			);
		});

		it('builds correct path for nested folders', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			const utilsFolder = screen.getByText('utils');
			fireEvent.click(utilsFolder);

			expect(defaultProps.toggleFolder).toHaveBeenCalledWith(
				'src/utils',
				'session-1',
				expect.any(Function)
			);
		});
	});

	describe('Edge Cases', () => {
		it('handles undefined fileExplorerExpanded', () => {
			const session = createMockSession({ fileExplorerExpanded: undefined as any });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			// Should render without crashing
			expect(screen.getByText('src')).toBeInTheDocument();
		});

		it('handles missing fileChanges from git context', () => {
			mockFileChanges = [];
			const session = createMockSession();
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			// No indicators should render when there are no changes.
			expect(container.querySelector('[data-testid="git-change-indicator"]')).toBeNull();
			expect(container).toBeTruthy();
		});

		it('handles empty filteredFileTree', () => {
			const session = createMockSession({ fileTree: [], fileTreeLoading: false });
			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);
			expect(screen.getByText('No files found')).toBeInTheDocument();
		});

		it('handles no active file tab', () => {
			// When no file tab is active (session.activeFileTabId is null), files should still render
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByText('src')).toBeInTheDocument();
		});

		it('handles very long projectRoot path', () => {
			const longPath = '/Users/test/very/long/path/to/project/that/is/really/deep';
			const session = createMockSession({ projectRoot: longPath });
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			// FileExplorerPanel header uses projectRoot for the title attribute
			expect(screen.getByTitle(longPath)).toBeInTheDocument();
		});

		it('handles special characters in file names', () => {
			const specialFileTree = [
				{ name: 'file with spaces.ts', type: 'file' as const },
				{ name: 'file-with-dashes.ts', type: 'file' as const },
				{ name: 'file_with_underscores.ts', type: 'file' as const },
			];
			render(<FileExplorerPanel {...defaultProps} filteredFileTree={specialFileTree} />);

			expect(screen.getByText('file with spaces.ts')).toBeInTheDocument();
			expect(screen.getByText('file-with-dashes.ts')).toBeInTheDocument();
			expect(screen.getByText('file_with_underscores.ts')).toBeInTheDocument();
		});
	});

	describe('Optional Props', () => {
		it('works without onAutoRefreshChange', () => {
			const props = { ...defaultProps };
			delete props.onAutoRefreshChange;

			render(<FileExplorerPanel {...props} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			fireEvent.mouseEnter(refreshButton);
			act(() => {
				vi.advanceTimersByTime(400);
			});

			const option = screen.getByText('Every 5 seconds');
			// Should not throw
			fireEvent.click(option);
		});

		it('works without onShowFlash', async () => {
			const props = { ...defaultProps };
			delete props.onShowFlash;

			render(<FileExplorerPanel {...props} />);
			const refreshButton = screen.getByTitle('Refresh file tree');

			// Should not throw
			await act(async () => {
				fireEvent.click(refreshButton);
				await vi.advanceTimersByTimeAsync(0);
			});
		});

		it('works without refs', () => {
			const props = {
				...defaultProps,
				fileTreeContainerRef: undefined,
				fileTreeFilterInputRef: undefined,
			};

			render(<FileExplorerPanel {...props} />);
			expect(screen.getByText('src')).toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('uses button elements for interactive controls', () => {
			render(<FileExplorerPanel {...defaultProps} />);

			const buttons = screen.getAllByRole('button');
			expect(buttons.length).toBeGreaterThan(0);
		});

		it('has title attributes for screen readers', () => {
			render(<FileExplorerPanel {...defaultProps} />);

			expect(screen.getByTitle('Refresh file tree')).toBeInTheDocument();
			expect(screen.getByTitle('Expand all folders')).toBeInTheDocument();
			expect(screen.getByTitle('Collapse all folders')).toBeInTheDocument();
		});

		it('uses input type text for filter', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);

			const input = screen.getByPlaceholderText('Filter files...');
			expect(input).toHaveAttribute('type', 'text');
		});

		it('has ariaLabel on layer registration', () => {
			render(<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} />);

			expect(mockRegisterLayer).toHaveBeenCalledWith(
				expect.objectContaining({ ariaLabel: 'File Tree Filter' })
			);
		});
	});

	describe('Virtualization', () => {
		it('renders items with absolute positioning', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const items = container.querySelectorAll('[data-file-index]');
			items.forEach((item) => {
				expect(item).toHaveClass('absolute');
			});
		});

		it('applies transform translateY for virtual positioning', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const firstItem = container.querySelector('[data-file-index="0"]');
			expect(firstItem).toHaveStyle({ transform: 'translateY(0px)' });
		});

		it('renders indent guides for nested items', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			// index.ts is at depth 1, should have 1 indent guide
			const nestedItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.ts')
			);
			const indentGuides = nestedItem?.querySelectorAll('.w-px');
			expect(indentGuides?.length).toBe(1);
		});

		it('renders multiple indent guides for deeply nested items', () => {
			const session = createMockSession({ fileExplorerExpanded: ['src', 'src/utils'] });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			// helpers.ts is at depth 2, should have 2 indent guides
			const deepItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('helpers.ts')
			);
			const indentGuides = deepItem?.querySelectorAll('.w-px');
			expect(indentGuides?.length).toBe(2);
		});

		it('uses fixed row height of 28px', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const items = container.querySelectorAll('[data-file-index]');
			items.forEach((item) => {
				expect(item).toHaveStyle({ height: '28px' });
			});
		});
	});

	describe('Drag-to-move', () => {
		// Builds a real DataTransfer-like object so we can read what the source set
		// during onDragStart and inject what we want for onDragOver / onDrop.
		function makeDataTransfer(initial: Record<string, string> = {}) {
			const data: Record<string, string> = { ...initial };
			return {
				data,
				setData: vi.fn((type: string, value: string) => {
					data[type] = value;
				}),
				getData: vi.fn((type: string) => data[type] ?? ''),
				get types() {
					return Object.keys(data);
				},
				dropEffect: 'none',
				effectAllowed: 'none',
				files: { length: 0 } as unknown as FileList,
			};
		}

		// Render the panel with a fileTree where 'src' is expanded so the inner
		// 'utils' folder is mounted as a drop target.
		function renderWithExpanded(overrides: Partial<Session> = {}) {
			const props = {
				...defaultProps,
				session: createMockSession({
					fileExplorerExpanded: ['src'],
					fileTree: mockFileTree,
					...overrides,
				}),
				filteredFileTree: mockFileTree,
			};
			return render(<FileExplorerPanel {...props} />);
		}

		function getRow(container: HTMLElement, name: string): HTMLElement {
			const row = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes(name)
			) as HTMLElement | undefined;
			if (!row) throw new Error(`row not found: ${name}`);
			return row;
		}

		it('writes the relative path under the custom MIME type on drag start', () => {
			const { container } = renderWithExpanded();
			const row = getRow(container, 'package.json');
			const dt = makeDataTransfer();
			fireEvent.dragStart(row, { dataTransfer: dt });
			expect(dt.data['application/x-maestro-file-path']).toBe('package.json');
			expect(dt.effectAllowed).toBe('copyMove');
		});

		it('shows the move-to-root receptacle only while a row drag is active', () => {
			const { container, queryByText } = renderWithExpanded();
			// Hidden before any drag begins.
			expect(queryByText('Drop here to move to root')).toBeNull();

			const row = getRow(container, 'index.ts');
			// The flag flip is deferred a tick (so it doesn't reflow during
			// dragstart and abort the Chromium drag), so advance timers to mount it.
			act(() => {
				fireEvent.dragStart(row, { dataTransfer: makeDataTransfer() });
				vi.advanceTimersByTime(0);
			});
			expect(queryByText('Drop here to move to root')).not.toBeNull();

			// dragend tears it back down (drop happened off-target or was cancelled).
			fireEvent.dragEnd(row, { dataTransfer: makeDataTransfer() });
			expect(queryByText('Drop here to move to root')).toBeNull();
		});

		it('moves a nested file to the root via the move-to-root receptacle', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };
			const onShowFlash = vi.fn();

			const { container, getByText } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
					filteredFileTree={mockFileTree}
					refreshFileTree={vi.fn().mockResolvedValue({ totalChanges: 1 })}
					onShowFlash={onShowFlash}
				/>
			);

			// Drag the nested src/index.ts so the receptacle mounts (deferred a tick).
			const nestedRow = getRow(container, 'index.ts');
			act(() => {
				fireEvent.dragStart(nestedRow, { dataTransfer: makeDataTransfer() });
				vi.advanceTimersByTime(0);
			});

			const receptacle = getByText('Drop here to move to root');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'src/index.ts' });
			await act(async () => {
				fireEvent.drop(receptacle, { dataTransfer: dt });
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/src/index.ts',
				'/Users/test/project/index.ts',
				undefined
			);
			expect(onShowFlash).toHaveBeenCalledWith('Moved "index.ts"');
		});

		it('suppresses the move-to-root receptacle when dragging a file already at root', () => {
			const { container, queryByText } = renderWithExpanded();
			// package.json lives at the workspace root, so there's nowhere to move
			// it - the receptacle must not appear even after the deferred tick.
			const rootRow = getRow(container, 'package.json');
			act(() => {
				fireEvent.dragStart(rootRow, { dataTransfer: makeDataTransfer() });
				vi.advanceTimersByTime(0);
			});
			expect(queryByText('Drop here to move to root')).toBeNull();
		});

		it('moves a nested file to the root by dropping on the path row', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };
			const onShowFlash = vi.fn();

			const { container, getByText } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
					filteredFileTree={mockFileTree}
					refreshFileTree={vi.fn().mockResolvedValue({ totalChanges: 1 })}
					onShowFlash={onShowFlash}
				/>
			);

			// Drag the nested src/index.ts, then drop onto the path display (which
			// points at the root working directory).
			const nestedRow = getRow(container, 'index.ts');
			act(() => {
				fireEvent.dragStart(nestedRow, { dataTransfer: makeDataTransfer() });
			});

			const pathTarget = getByText('/Users/test/project');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'src/index.ts' });
			await act(async () => {
				fireEvent.drop(pathTarget, { dataTransfer: dt });
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/src/index.ts',
				'/Users/test/project/index.ts',
				undefined
			);
			expect(onShowFlash).toHaveBeenCalledWith('Moved "index.ts"');
		});

		it('moves a root file into a folder via fs.rename with absolute paths', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const refreshFileTree = vi.fn().mockResolvedValue({ totalChanges: 1 });
			const onShowFlash = vi.fn();
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
					filteredFileTree={mockFileTree}
					refreshFileTree={refreshFileTree}
					onShowFlash={onShowFlash}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'package.json' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/package.json',
				'/Users/test/project/src/package.json',
				undefined
			);
			expect(refreshFileTree).toHaveBeenCalled();
			expect(onShowFlash).toHaveBeenCalledWith('Moved "package.json"');
		});

		it('expands the destination folder after a successful move', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };
			const setSessions = vi.fn();

			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					setSessions={setSessions}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
					filteredFileTree={mockFileTree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'package.json' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
				await Promise.resolve();
			});

			// One of the setSessions calls should be the expander adding 'src'.
			const updaters = setSessions.mock.calls
				.map((c) => c[0])
				.filter((fn) => typeof fn === 'function');
			const expanded = updaters.some((fn) => {
				const result = fn([{ id: defaultProps.session.id, fileExplorerExpanded: [] } as Session]);
				return (result[0].fileExplorerExpanded ?? []).includes('src');
			});
			expect(expanded).toBe(true);
		});

		it('passes sshRemoteId through to fs.rename for remote sessions', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({
						fileExplorerExpanded: ['src'],
						fileTree: mockFileTree,
						sshRemoteId: 'remote-42',
					})}
					filteredFileTree={mockFileTree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'README.md' });
			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/README.md',
				'/Users/test/project/src/README.md',
				'remote-42'
			);
		});

		it('rejects dropping a folder into itself', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const { container } = renderWithExpanded();
			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'src' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(rename).not.toHaveBeenCalled();
		});

		it('rejects dropping a folder into one of its own descendants', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const { container } = renderWithExpanded();
			const utilsRow = getRow(container, 'utils');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'src' });

			await act(async () => {
				fireEvent.drop(utilsRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(rename).not.toHaveBeenCalled();
		});

		it('skips moves where source already lives directly in the destination folder', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const { container } = renderWithExpanded();
			const srcRow = getRow(container, 'src');
			// index.ts is already inside src/, dropping it onto src/ is a no-op.
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'src/index.ts' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(rename).not.toHaveBeenCalled();
		});

		it('opens the name-conflict modal when the destination already has the file', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			// Tree where both root and src/ contain index.ts so a move triggers conflict.
			const conflictTree = [
				{ name: 'index.ts', type: 'file' as const },
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'index.ts', type: 'file' as const }],
				},
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({
						fileExplorerExpanded: ['src'],
						fileTree: conflictTree,
					})}
					filteredFileTree={conflictTree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'index.ts' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(rename).not.toHaveBeenCalled();
			expect(screen.getByText('Name conflict')).toBeInTheDocument();
			// Auto-rename preview shows the next free name ("index (2).ts").
			expect(screen.getByText(/Rename to "index \(2\)\.ts"/)).toBeInTheDocument();
		});

		it('auto-rename move uses the suffixed name', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };
			const onShowFlash = vi.fn();

			const conflictTree = [
				{ name: 'index.ts', type: 'file' as const },
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'index.ts', type: 'file' as const }],
				},
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({
						fileExplorerExpanded: ['src'],
						fileTree: conflictTree,
					})}
					filteredFileTree={conflictTree}
					onShowFlash={onShowFlash}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'index.ts' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			const autoRenameButton = screen
				.getByText(/Rename to "index \(2\)\.ts"/)
				.closest('button') as HTMLButtonElement;
			await act(async () => {
				fireEvent.click(autoRenameButton);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/index.ts',
				'/Users/test/project/src/index (2).ts',
				undefined
			);
			expect(onShowFlash).toHaveBeenCalledWith('Moved "index (2).ts"');
		});

		it('overwrite deletes the existing destination before renaming', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			const deleteFn = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename, delete: deleteFn } };

			const conflictTree = [
				{ name: 'index.ts', type: 'file' as const },
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'index.ts', type: 'file' as const }],
				},
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({
						fileExplorerExpanded: ['src'],
						fileTree: conflictTree,
					})}
					filteredFileTree={conflictTree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'index.ts' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			const overwriteButton = screen.getByText('Overwrite existing').closest('button')!;
			await act(async () => {
				fireEvent.click(overwriteButton);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(deleteFn).toHaveBeenCalledWith(
				'/Users/test/project/src/index.ts',
				expect.objectContaining({ recursive: true })
			);
			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/index.ts',
				'/Users/test/project/src/index.ts',
				undefined
			);
		});

		it('cancel closes the conflict modal without calling fs', async () => {
			const rename = vi.fn();
			const deleteFn = vi.fn();
			(window as any).maestro = { fs: { rename, delete: deleteFn } };

			const conflictTree = [
				{ name: 'index.ts', type: 'file' as const },
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'index.ts', type: 'file' as const }],
				},
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({
						fileExplorerExpanded: ['src'],
						fileTree: conflictTree,
					})}
					filteredFileTree={conflictTree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'index.ts' });

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(screen.getByText('Name conflict')).toBeInTheDocument();
			// The conflict modal has its own Cancel option (matching button label).
			const cancelButtons = screen.getAllByText('Cancel');
			fireEvent.click(cancelButtons[cancelButtons.length - 1]);

			expect(screen.queryByText('Name conflict')).not.toBeInTheDocument();
			expect(rename).not.toHaveBeenCalled();
			expect(deleteFn).not.toHaveBeenCalled();
		});

		it('does not register drop handlers on file rows', () => {
			const rename = vi.fn();
			(window as any).maestro = { fs: { rename } };
			const { container } = renderWithExpanded();
			const fileRow = getRow(container, 'package.json');
			const dt = makeDataTransfer({ 'application/x-maestro-file-path': 'README.md' });
			fireEvent.drop(fileRow, { dataTransfer: dt });
			expect(rename).not.toHaveBeenCalled();
		});

		it('drags a single path when no multi-selection is active', () => {
			const { container } = renderWithExpanded();
			const row = getRow(container, 'package.json');
			const dt = makeDataTransfer();
			fireEvent.dragStart(row, { dataTransfer: dt });
			expect(dt.data['application/x-maestro-file-path']).toBe('package.json');
			expect(dt.data['application/x-maestro-file-paths']).toBeUndefined();
		});

		it('drags all selected paths when the dragged row is in the multi-selection', () => {
			// Use a controlled wrapper so setSelectedFileIndex actually moves the
			// anchor between clicks — the default vi.fn() prop doesn't propagate.
			const Controlled = () => {
				const [idx, setIdx] = React.useState(0);
				return (
					<FileExplorerPanel
						{...defaultProps}
						session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
						filteredFileTree={mockFileTree}
						selectedFileIndex={idx}
						setSelectedFileIndex={(v) =>
							setIdx((prev) => (typeof v === 'function' ? (v as (p: number) => number)(prev) : v))
						}
					/>
				);
			};
			const { container } = render(<Controlled />);
			const pkgRow = getRow(container, 'package.json');
			const readmeRow = getRow(container, 'README.md');

			// Build a 2-row selection via plain-click then Cmd+click.
			fireEvent.click(pkgRow);
			fireEvent.click(readmeRow, { metaKey: true });

			const dt = makeDataTransfer();
			fireEvent.dragStart(readmeRow, { dataTransfer: dt });

			expect(dt.data['application/x-maestro-file-path']).toBe('README.md');
			const multi = JSON.parse(dt.data['application/x-maestro-file-paths']);
			expect(multi).toEqual(expect.arrayContaining(['package.json', 'README.md']));
			expect(multi).toHaveLength(2);
		});

		it('dragging an unselected row clears the multi-selection and drags only that row', () => {
			const Controlled = () => {
				const [idx, setIdx] = React.useState(0);
				return (
					<FileExplorerPanel
						{...defaultProps}
						session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
						filteredFileTree={mockFileTree}
						selectedFileIndex={idx}
						setSelectedFileIndex={(v) =>
							setIdx((prev) => (typeof v === 'function' ? (v as (p: number) => number)(prev) : v))
						}
					/>
				);
			};
			const { container } = render(<Controlled />);
			const pkgRow = getRow(container, 'package.json');
			const readmeRow = getRow(container, 'README.md');
			const htmlRow = getRow(container, 'index.html');

			fireEvent.click(pkgRow);
			fireEvent.click(readmeRow, { metaKey: true });

			// Drag an unselected row — should not pull in the multi-selection.
			const dt = makeDataTransfer();
			fireEvent.dragStart(htmlRow, { dataTransfer: dt });
			expect(dt.data['application/x-maestro-file-path']).toBe('index.html');
			expect(dt.data['application/x-maestro-file-paths']).toBeUndefined();
		});

		it('moves every path in a multi-source drop', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
					filteredFileTree={mockFileTree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({
				'application/x-maestro-file-paths': JSON.stringify(['package.json', 'README.md']),
				'application/x-maestro-file-path': 'package.json',
			});

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledTimes(2);
			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/package.json',
				'/Users/test/project/src/package.json',
				undefined
			);
			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/README.md',
				'/Users/test/project/src/README.md',
				undefined
			);
		});

		it('multi-source drop opens the batched conflict modal when some destinations exist', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			// Tree where src/ already contains README.md so dropping [package.json,
			// README.md] onto src/ conflicts on README.md only.
			const tree = [
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'README.md', type: 'file' as const }],
				},
				{ name: 'package.json', type: 'file' as const },
				{ name: 'README.md', type: 'file' as const },
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: tree })}
					filteredFileTree={tree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({
				'application/x-maestro-file-paths': JSON.stringify(['package.json', 'README.md']),
				'application/x-maestro-file-path': 'package.json',
			});

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			expect(rename).not.toHaveBeenCalled();
			// Multi-conflict title includes the count.
			expect(screen.getByText(/Name conflicts \(1\)/)).toBeInTheDocument();
			// "Skip conflicts" option is available when there are non-conflicting moves.
			expect(screen.getByText(/Skip conflicts, move 1 other/)).toBeInTheDocument();
		});

		it('batched auto-rename moves both conflicting and non-conflicting items', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { rename } };

			const tree = [
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'README.md', type: 'file' as const }],
				},
				{ name: 'package.json', type: 'file' as const },
				{ name: 'README.md', type: 'file' as const },
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: tree })}
					filteredFileTree={tree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({
				'application/x-maestro-file-paths': JSON.stringify(['package.json', 'README.md']),
				'application/x-maestro-file-path': 'package.json',
			});

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			const autoRenameButton = screen
				.getByText(/Auto-rename 1 conflicting item/)
				.closest('button') as HTMLButtonElement;
			await act(async () => {
				fireEvent.click(autoRenameButton);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/package.json',
				'/Users/test/project/src/package.json',
				undefined
			);
			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/README.md',
				'/Users/test/project/src/README (2).md',
				undefined
			);
		});

		it('batched skip-conflicts moves only the non-conflicting items', async () => {
			const rename = vi.fn().mockResolvedValue({ success: true });
			const deleteFn = vi.fn();
			(window as any).maestro = { fs: { rename, delete: deleteFn } };

			const tree = [
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'README.md', type: 'file' as const }],
				},
				{ name: 'package.json', type: 'file' as const },
				{ name: 'README.md', type: 'file' as const },
			];
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: tree })}
					filteredFileTree={tree}
				/>
			);

			const srcRow = getRow(container, 'src');
			const dt = makeDataTransfer({
				'application/x-maestro-file-paths': JSON.stringify(['package.json', 'README.md']),
				'application/x-maestro-file-path': 'package.json',
			});

			await act(async () => {
				fireEvent.drop(srcRow, { dataTransfer: dt });
				await Promise.resolve();
			});

			const skipButton = screen
				.getByText(/Skip conflicts, move 1 other/)
				.closest('button') as HTMLButtonElement;
			await act(async () => {
				fireEvent.click(skipButton);
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(rename).toHaveBeenCalledTimes(1);
			expect(rename).toHaveBeenCalledWith(
				'/Users/test/project/package.json',
				'/Users/test/project/src/package.json',
				undefined
			);
			expect(deleteFn).not.toHaveBeenCalled();
		});
	});

	describe('Multi-selection', () => {
		function getRowByLabel(container: HTMLElement, name: string): HTMLElement {
			const row = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes(name)
			) as HTMLElement | undefined;
			if (!row) throw new Error(`row not found: ${name}`);
			return row;
		}

		it('Cmd+click on a folder toggles selection without expanding the folder', () => {
			const setSelectedFileIndex = vi.fn();
			const toggleFolder = vi.fn();
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					setSelectedFileIndex={setSelectedFileIndex}
					toggleFolder={toggleFolder}
				/>
			);

			const srcRow = getRowByLabel(container, 'src');
			fireEvent.click(srcRow, { metaKey: true });

			expect(setSelectedFileIndex).toHaveBeenCalled();
			expect(toggleFolder).not.toHaveBeenCalled();
		});

		it('Shift+click selects the range from the anchor to the clicked row', () => {
			// selectedFileIndex prop is the keyboard-nav anchor used by shift-click.
			// Anchor at index 0 (src), shift-click on index 3 (index.html) should
			// select all four rows so a subsequent drag carries all of them.
			const { container } = render(<FileExplorerPanel {...defaultProps} selectedFileIndex={0} />);

			const htmlRow = getRowByLabel(container, 'index.html');
			fireEvent.click(htmlRow, { shiftKey: true });

			// Drag from an end of the range — payload should include the full range.
			const dt = (function makeDt() {
				const data: Record<string, string> = {};
				return {
					data,
					setData: (k: string, v: string) => {
						data[k] = v;
					},
					getData: (k: string) => data[k] ?? '',
					get types() {
						return Object.keys(data);
					},
					dropEffect: 'none',
					effectAllowed: 'none',
					files: { length: 0 } as unknown as FileList,
				};
			})();
			fireEvent.dragStart(htmlRow, { dataTransfer: dt });
			const multi = JSON.parse(dt.data['application/x-maestro-file-paths']);
			// Selection should include the rows from index 0..3 (src, package.json,
			// README.md, index.html) — the actual order isn't significant, only the
			// set membership.
			expect(multi).toEqual(
				expect.arrayContaining(['src', 'package.json', 'README.md', 'index.html'])
			);
			expect(multi).toHaveLength(4);
		});

		it('successive shift-clicks pivot from the original anchor (Finder semantics)', () => {
			// Plain-click A, then shift-click J (range A..J), then shift-click F.
			// Finder: second shift-click shrinks to A..F because the anchor stays
			// at A; it does NOT pivot from J.
			const Controlled = () => {
				const [idx, setIdx] = React.useState(0);
				return (
					<FileExplorerPanel
						{...defaultProps}
						session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
						filteredFileTree={mockFileTree}
						selectedFileIndex={idx}
						setSelectedFileIndex={(v) =>
							setIdx((prev) => (typeof v === 'function' ? (v as (p: number) => number)(prev) : v))
						}
					/>
				);
			};
			const { container } = render(<Controlled />);
			// mockFileTree with only 'src' expanded ('utils' collapsed) flattens to:
			//   0: src   1: src/index.ts   2: src/utils
			//   3: package.json   4: README.md   5: index.html
			const srcRow = getRowByLabel(container, 'src');
			const htmlRow = getRowByLabel(container, 'index.html');
			const pkgRow = getRowByLabel(container, 'package.json');

			fireEvent.click(srcRow); // anchor = 0
			fireEvent.click(htmlRow, { shiftKey: true }); // range 0..5
			fireEvent.click(pkgRow, { shiftKey: true }); // should be 0..3, not 3..5

			// Drag from pkgRow — payload should reflect 0..3 (4 rows).
			const dt = (function makeDt() {
				const data: Record<string, string> = {};
				return {
					data,
					setData: (k: string, v: string) => {
						data[k] = v;
					},
					getData: (k: string) => data[k] ?? '',
					get types() {
						return Object.keys(data);
					},
					dropEffect: 'none',
					effectAllowed: 'none',
					files: { length: 0 } as unknown as FileList,
				};
			})();
			fireEvent.dragStart(pkgRow, { dataTransfer: dt });
			const multi = JSON.parse(dt.data['application/x-maestro-file-paths']);
			expect(multi).toEqual(
				expect.arrayContaining(['src', 'src/index.ts', 'src/utils', 'package.json'])
			);
			expect(multi).toHaveLength(4);
			// index.html and README.md should NOT be in the selection any more —
			// they would be if the anchor had moved to htmlRow on the first
			// shift-click.
			expect(multi).not.toContain('index.html');
			expect(multi).not.toContain('README.md');
		});

		it('plain click collapses an active multi-selection back to a single row', () => {
			const Controlled = () => {
				const [idx, setIdx] = React.useState(0);
				return (
					<FileExplorerPanel
						{...defaultProps}
						session={createMockSession({ fileExplorerExpanded: ['src'], fileTree: mockFileTree })}
						filteredFileTree={mockFileTree}
						selectedFileIndex={idx}
						setSelectedFileIndex={(v) =>
							setIdx((prev) => (typeof v === 'function' ? (v as (p: number) => number)(prev) : v))
						}
					/>
				);
			};
			const { container } = render(<Controlled />);
			const pkgRow = getRowByLabel(container, 'package.json');
			const readmeRow = getRowByLabel(container, 'README.md');
			const htmlRow = getRowByLabel(container, 'index.html');

			fireEvent.click(pkgRow);
			fireEvent.click(readmeRow, { metaKey: true });
			// Plain click on a third row — multi-selection should be cleared.
			fireEvent.click(htmlRow);

			// A drag from package.json should now carry only package.json (no multi).
			const dt = (function makeDt() {
				const data: Record<string, string> = {};
				return {
					data,
					setData: (k: string, v: string) => {
						data[k] = v;
					},
					getData: (k: string) => data[k] ?? '',
					get types() {
						return Object.keys(data);
					},
					dropEffect: 'none',
					effectAllowed: 'none',
					files: { length: 0 } as unknown as FileList,
				};
			})();
			fireEvent.dragStart(pkgRow, { dataTransfer: dt });
			expect(dt.data['application/x-maestro-file-paths']).toBeUndefined();
		});
	});

	describe('Context Menu', () => {
		it('shows context menu on right-click', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			expect(fileItem).toBeTruthy();

			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Copy Path')).toBeInTheDocument();
			expect(screen.getByText(/Reveal in (Finder|Explorer|File Manager)/)).toBeInTheDocument();
		});

		it('updates selection to right-clicked item when opening context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			// package.json is at index 1 (after src at index 0)
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			const fileIndex = parseInt(fileItem!.getAttribute('data-file-index')!, 10);

			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			// Should update selection to the right-clicked item
			expect(defaultProps.setSelectedFileIndex).toHaveBeenCalledWith(fileIndex);
		});

		it('shows Document Graph option only for markdown files', () => {
			const onFocusFileInGraph = vi.fn();
			const { container } = render(
				<FileExplorerPanel {...defaultProps} onFocusFileInGraph={onFocusFileInGraph} />
			);

			// Right-click on markdown file - should show Document Graph
			const mdFile = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('README.md')
			);
			fireEvent.contextMenu(mdFile!, { clientX: 100, clientY: 200 });
			expect(screen.getByText('Document Graph')).toBeInTheDocument();
		});

		it('does not show Document Graph option for non-markdown files', () => {
			const onFocusFileInGraph = vi.fn();
			const { container } = render(
				<FileExplorerPanel {...defaultProps} onFocusFileInGraph={onFocusFileInGraph} />
			);

			// Right-click on non-markdown file - should not show Document Graph
			const jsonFile = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(jsonFile!, { clientX: 100, clientY: 200 });
			expect(screen.queryByText('Document Graph')).not.toBeInTheDocument();
		});

		it('calls onFocusFileInGraph with relative path when clicked', () => {
			const onFocusFileInGraph = vi.fn();
			const { container } = render(
				<FileExplorerPanel {...defaultProps} onFocusFileInGraph={onFocusFileInGraph} />
			);

			const mdFile = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('README.md')
			);
			fireEvent.contextMenu(mdFile!, { clientX: 100, clientY: 200 });

			const focusButton = screen.getByText('Document Graph');
			fireEvent.click(focusButton);

			expect(onFocusFileInGraph).toHaveBeenCalledWith('README.md');
		});

		it('copies path to clipboard when Copy Path is clicked', async () => {
			const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
			Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, writable: true });

			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const copyButton = screen.getByText('Copy Path');
			fireEvent.click(copyButton);

			expect(mockClipboard.writeText).toHaveBeenCalledWith('/Users/test/project/package.json');
		});

		it('closes context menu on Escape key', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Copy Path')).toBeInTheDocument();

			// Press Escape
			fireEvent.keyDown(window, { key: 'Escape' });
			act(() => {
				vi.runAllTimers();
			});

			expect(screen.queryByText('Copy Path')).not.toBeInTheDocument();
		});

		it('registers useClickOutside callback when context menu is open', () => {
			// Reset the callback tracker
			clickOutsideCallback = null;

			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			// Initially no callback registered
			expect(clickOutsideCallback).toBeNull();

			// Open context menu
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			// Callback should now be registered
			expect(clickOutsideCallback).toBeInstanceOf(Function);
		});

		it('shows Rename option in context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Rename')).toBeInTheDocument();
		});

		it('shows Delete option in context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Delete')).toBeInTheDocument();
		});

		it('opens rename modal when Rename is clicked', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const renameButton = screen.getByText('Rename');
			fireEvent.click(renameButton);

			// Modal title is now "Rename File" (capital F)
			expect(screen.getByText('Rename File')).toBeInTheDocument();
			expect(screen.getByDisplayValue('package.json')).toBeInTheDocument();
		});

		it('opens delete modal when Delete is clicked', async () => {
			// Mock countItems for the delete modal
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const deleteButton = screen.getByText('Delete');
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			// Modal now uses "Delete File" title
			expect(screen.getByText('Delete File')).toBeInTheDocument();
			// Check that the modal shows the file name in the confirmation message
			expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
		});

		it('closes rename modal when clicking Cancel', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const renameButton = screen.getByText('Rename');
			fireEvent.click(renameButton);

			// Modal title is now "Rename File" (capital F)
			expect(screen.getByText('Rename File')).toBeInTheDocument();

			// Click Cancel to close the modal
			// (Escape key handling is done via layer stack which requires more complex mocking)
			const cancelButton = screen.getByText('Cancel');
			fireEvent.click(cancelButton);

			expect(screen.queryByText('Rename File')).not.toBeInTheDocument();
		});

		it('shows "New File" option on folder context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			expect(screen.getByText('New File')).toBeInTheDocument();
		});

		it('does not show "New File" option on file context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			expect(screen.queryByText('New File')).not.toBeInTheDocument();
		});

		it('shows "Preview All Files in Folder" option on folder context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			// src recursively holds index.ts + utils/helpers.ts -> 2 previewable.
			expect(screen.getByText('Preview All 2 Files in Folder')).toBeInTheDocument();
		});

		it('does not show "Preview All Files in Folder" option on file context menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			expect(screen.queryByText(/Preview All .* in Folder/)).not.toBeInTheDocument();
		});

		it('opens every previewable file under a folder recursively when clicked', async () => {
			const handleFileClick = vi.fn().mockResolvedValue(undefined);
			const onShowFlash = vi.fn();
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					handleFileClick={handleFileClick}
					onShowFlash={onShowFlash}
				/>
			);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });

			await act(async () => {
				fireEvent.click(screen.getByText('Preview All 2 Files in Folder'));
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			});

			// Recurses into subfolders: src/index.ts and src/utils/helpers.ts
			expect(handleFileClick).toHaveBeenCalledTimes(2);
			const paths = handleFileClick.mock.calls.map((c) => c[1]);
			expect(paths).toContain('src/index.ts');
			expect(paths).toContain('src/utils/helpers.ts');
			expect(onShowFlash).toHaveBeenCalledWith('Opened 2 files from "src"');
		});

		it('creates a new file inside the right-clicked folder', async () => {
			const writeFile = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { writeFile } };
			const refreshFileTree = vi.fn().mockResolvedValue({ totalChanges: 1 });
			const onShowFlash = vi.fn();

			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					refreshFileTree={refreshFileTree}
					onShowFlash={onShowFlash}
				/>
			);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('New File'));

			const input = screen.getByPlaceholderText('Enter file name...') as HTMLInputElement;
			fireEvent.change(input, { target: { value: 'newthing.ts' } });

			await act(async () => {
				fireEvent.click(screen.getByText('Create'));
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(writeFile).toHaveBeenCalledWith('/Users/test/project/src/newthing.ts', '', undefined);
			expect(refreshFileTree).toHaveBeenCalled();
			expect(onShowFlash).toHaveBeenCalledWith('Created "newthing.ts"');
		});

		it('expands the parent folder after creating a new file in it', async () => {
			const writeFile = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { writeFile } };
			const setSessions = vi.fn();

			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					setSessions={setSessions}
					session={createMockSession({ fileExplorerExpanded: [] })}
				/>
			);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('New File'));

			const input = screen.getByPlaceholderText('Enter file name...') as HTMLInputElement;
			fireEvent.change(input, { target: { value: 'newthing.ts' } });

			await act(async () => {
				fireEvent.click(screen.getByText('Create'));
				await Promise.resolve();
				await Promise.resolve();
			});

			// setSessions is called with an updater that adds 'src' to expanded list.
			const updater = setSessions.mock.calls
				.map((c) => c[0])
				.find((fn) => typeof fn === 'function');
			expect(updater).toBeDefined();
			const result = updater([
				{ id: defaultProps.session.id, fileExplorerExpanded: [] } as Session,
			]);
			expect(result[0].fileExplorerExpanded).toContain('src');
		});

		it('rejects new file name with slashes', async () => {
			const writeFile = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { writeFile } };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('New File'));

			const input = screen.getByPlaceholderText('Enter file name...') as HTMLInputElement;
			fireEvent.change(input, { target: { value: 'nested/foo.ts' } });

			await act(async () => {
				fireEvent.click(screen.getByText('Create'));
				await Promise.resolve();
			});

			expect(writeFile).not.toHaveBeenCalled();
			expect(screen.getByText('Name cannot contain slashes')).toBeInTheDocument();
		});

		it('rejects new file name that already exists in the folder', async () => {
			const writeFile = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { writeFile } };

			// session.fileTree is the source of truth for the duplicate check, not
			// filteredFileTree — pass it in explicitly so src/index.ts is known.
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ fileTree: mockFileTree })}
				/>
			);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('New File'));

			const input = screen.getByPlaceholderText('Enter file name...') as HTMLInputElement;
			fireEvent.change(input, { target: { value: 'index.ts' } });

			await act(async () => {
				fireEvent.click(screen.getByText('Create'));
				await Promise.resolve();
			});

			expect(writeFile).not.toHaveBeenCalled();
			expect(screen.getByText('"index.ts" already exists in this folder')).toBeInTheDocument();
		});

		it('passes sshRemoteId to writeFile for remote sessions', async () => {
			const writeFile = vi.fn().mockResolvedValue({ success: true });
			(window as any).maestro = { fs: { writeFile } };

			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={createMockSession({ sshRemoteId: 'remote-42' })}
				/>
			);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('New File'));

			const input = screen.getByPlaceholderText('Enter file name...') as HTMLInputElement;
			fireEvent.change(input, { target: { value: 'foo.ts' } });

			await act(async () => {
				fireEvent.click(screen.getByText('Create'));
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(writeFile).toHaveBeenCalledWith('/Users/test/project/src/foo.ts', '', 'remote-42');
		});

		it('shows Open in Default App option for files', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Open in Default App')).toBeInTheDocument();
		});

		it('does not show Open in Default App option for folders', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Open in Default App')).not.toBeInTheDocument();
		});

		it('calls shell.showItemInFolder with full path when Reveal in Finder is clicked', () => {
			const mockShell = { showItemInFolder: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', shell: mockShell };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const revealButton = screen.getByText('Reveal in Finder');
			fireEvent.click(revealButton);

			expect(mockShell.showItemInFolder).toHaveBeenCalledWith('/Users/test/project/package.json');
		});

		it('calls shell.showItemInFolder with folder path when Reveal in Finder is clicked on folder', () => {
			const mockShell = { showItemInFolder: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', shell: mockShell };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });

			const revealButton = screen.getByText('Reveal in Finder');
			fireEvent.click(revealButton);

			expect(mockShell.showItemInFolder).toHaveBeenCalledWith('/Users/test/project/src');
		});

		it('calls shell.openPath with full file path when Open in Default App is clicked', () => {
			const mockShell = { openPath: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', shell: mockShell };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const openButton = screen.getByText('Open in Default App');
			fireEvent.click(openButton);

			expect(mockShell.openPath).toHaveBeenCalledWith('/Users/test/project/package.json');
		});

		it('shows Open in Maestro Browser option for HTML files when onOpenBrowserTabAt is provided', () => {
			const onOpenBrowserTabAt = vi.fn();
			const { container } = render(
				<FileExplorerPanel {...defaultProps} onOpenBrowserTabAt={onOpenBrowserTabAt} />
			);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.html')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Open in Maestro Browser')).toBeInTheDocument();
		});

		it('does not show Open in Maestro Browser option for non-HTML files', () => {
			const onOpenBrowserTabAt = vi.fn();
			const { container } = render(
				<FileExplorerPanel {...defaultProps} onOpenBrowserTabAt={onOpenBrowserTabAt} />
			);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Open in Maestro Browser')).not.toBeInTheDocument();
		});

		it('does not show Open in Maestro Browser option when handler is missing', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.html')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Open in Maestro Browser')).not.toBeInTheDocument();
		});

		it('calls onOpenBrowserTabAt with a file:// URL when Open in Maestro Browser is clicked', () => {
			const onOpenBrowserTabAt = vi.fn();
			const { container } = render(
				<FileExplorerPanel {...defaultProps} onOpenBrowserTabAt={onOpenBrowserTabAt} />
			);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.html')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			fireEvent.click(screen.getByText('Open in Maestro Browser'));

			expect(onOpenBrowserTabAt).toHaveBeenCalledWith('file:///Users/test/project/index.html', {
				title: 'index.html',
			});
		});

		it('does not show Open in Maestro Browser option for SSH sessions', () => {
			const sshSession = createMockSession({
				sshRemoteId: 'ssh-remote-123',
			});
			const onOpenBrowserTabAt = vi.fn();
			const { container } = render(
				<FileExplorerPanel
					{...defaultProps}
					session={sshSession}
					onOpenBrowserTabAt={onOpenBrowserTabAt}
				/>
			);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.html')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Open in Maestro Browser')).not.toBeInTheDocument();
		});

		it('does not show Open in Default App option for SSH sessions', () => {
			const sshSession = createMockSession({
				sshRemoteId: 'ssh-remote-123',
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={sshSession} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Open in Default App')).not.toBeInTheDocument();
		});

		it('does not show Open in Default App option for sessions with SSH remote config', () => {
			const sshSession = createMockSession({
				sessionSshRemoteConfig: { remoteId: 'ssh-config-456', enabled: true },
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={sshSession} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Open in Default App')).not.toBeInTheDocument();
		});

		it('does not show Reveal in Finder option for SSH sessions', () => {
			const sshSession = createMockSession({
				sshRemoteId: 'ssh-remote-123',
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={sshSession} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Reveal in Finder')).not.toBeInTheDocument();
		});

		it('does not show Reveal in Finder option for sessions with SSH remote config', () => {
			const sshSession = createMockSession({
				sessionSshRemoteConfig: { remoteId: 'ssh-config-456', enabled: true },
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={sshSession} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Reveal in Finder')).not.toBeInTheDocument();
		});

		it('shows folder delete warning with item count', async () => {
			// Mock countItems for the delete modal
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 5, folderCount: 2 }),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });

			const deleteButton = screen.getByText('Delete');
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			// Modal now uses "Delete Folder" title
			expect(screen.getByText('Delete Folder')).toBeInTheDocument();
			expect(screen.getByText(/5 files/)).toBeInTheDocument();
			expect(screen.getByText(/2 subfolders/)).toBeInTheDocument();
		});

		it('renders Cancel button in delete modal', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			const deleteButton = screen.getByText('Delete');
			await act(async () => {
				fireEvent.click(deleteButton);
			});

			// Verify modal renders with Cancel button
			// Focus behavior with requestAnimationFrame is tested elsewhere
			const cancelButton = screen.getByText('Cancel');
			expect(cancelButton).toBeInTheDocument();
		});

		it('does not attach a window keydown listener until the menu is opened', () => {
			const spies = spyOnListeners(window);
			render(<FileExplorerPanel {...defaultProps} />);
			const keydownAdds = spies.addSpy.mock.calls.filter(([t]) => t === 'keydown');
			expect(keydownAdds).toHaveLength(0);
			spies.restore();
		});

		it('closes the context menu on Escape', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			expect(screen.getByText('Copy Path')).toBeInTheDocument();

			fireEvent.keyDown(window, { key: 'Escape' });
			expect(screen.queryByText('Copy Path')).not.toBeInTheDocument();
		});

		it('removes its keydown listener after the menu closes (no leak)', () => {
			const spies = spyOnListeners(window);
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			fireEvent.keyDown(window, { key: 'Escape' });
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});

		it('removes its keydown listener on unmount with menu open (no leak)', () => {
			const spies = spyOnListeners(window);
			const { container, unmount } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});
});
