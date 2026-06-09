import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FileExplorerPanel } from '../../../renderer/components/FileExplorerPanel';
import type { Session, Theme } from '../../../renderer/types';

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
}));

// Mock @tanstack/react-virtual for virtualization
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({
		count,
		getScrollElement,
		estimateSize,
	}: {
		count: number;
		getScrollElement?: () => Element | null;
		estimateSize?: () => number;
	}) => {
		getScrollElement?.();
		const rowHeight = estimateSize?.() ?? 28;

		return {
			getVirtualItems: () =>
				Array.from({ length: count }, (_, i) => ({
					index: i,
					start: i * rowHeight,
					size: rowHeight,
					key: i,
				})),
			getTotalSize: () => count * rowHeight,
		};
	},
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

// Create mock theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#2d2d2d',
		bgActivity: '#3d3d3d',
		bgInput: '#404040',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#4a9eff',
		border: '#404040',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
		info: '#2196f3',
		scrollbarThumb: '#666666',
	},
};

// Create mock session
const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/Users/test/project',
	projectRoot: '/Users/test/project',
	fullPath: '/Users/test/project',
	aiPid: 1234,
	terminalPid: 5678,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	changedFiles: [],
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
];

describe('FileExplorerPanel', () => {
	let defaultProps: React.ComponentProps<typeof FileExplorerPanel>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

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

		it('clears the filter through the registered layer escape handler', () => {
			render(
				<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} fileTreeFilter="package" />
			);

			const layerConfig = mockRegisterLayer.mock.calls[0][0];
			layerConfig.onEscape();

			expect(defaultProps.setFileTreeFilterOpen).toHaveBeenCalledWith(false);
			expect(defaultProps.setFileTreeFilter).toHaveBeenCalledWith('');
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

		it('clears the filter through the updated layer handler', () => {
			render(
				<FileExplorerPanel {...defaultProps} fileTreeFilterOpen={true} fileTreeFilter="src" />
			);

			const updatedHandler = mockUpdateLayerHandler.mock.calls[0][1];
			updatedHandler();

			expect(defaultProps.setFileTreeFilterOpen).toHaveBeenCalledWith(false);
			expect(defaultProps.setFileTreeFilter).toHaveBeenCalledWith('');
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

		it('toggles hidden files and keeps .maestro visible by default', () => {
			const treeWithHiddenFiles = [
				{ name: '.env', type: 'file' as const },
				{ name: '.maestro', type: 'folder' as const, children: [] },
				{ name: 'visible.ts', type: 'file' as const },
			];

			render(<FileExplorerPanel {...defaultProps} filteredFileTree={treeWithHiddenFiles} />);

			expect(screen.queryByText('.env')).not.toBeInTheDocument();
			expect(screen.getByText('.maestro')).toBeInTheDocument();
			expect(screen.getByText('visible.ts')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Show dotfiles'));

			expect(defaultProps.setShowHiddenFiles).toHaveBeenCalledWith(true);
		});

		it('shows hidden files when enabled', () => {
			const treeWithHiddenFiles = [
				{ name: '.env', type: 'file' as const },
				{ name: 'visible.ts', type: 'file' as const },
			];

			render(
				<FileExplorerPanel
					{...defaultProps}
					filteredFileTree={treeWithHiddenFiles}
					showHiddenFiles={true}
				/>
			);

			expect(screen.getByTitle('Hide dotfiles')).toBeInTheDocument();
			expect(screen.getByText('.env')).toBeInTheDocument();
		});

		it('treats a missing filtered tree as empty', () => {
			render(<FileExplorerPanel {...defaultProps} filteredFileTree={null as any} />);

			expect(screen.getByText('No files found')).toBeInTheDocument();
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

		it('uses the default auto-refresh interval for unmigrated sessions', () => {
			const session = createMockSession({ fileTreeAutoRefreshInterval: undefined });
			render(<FileExplorerPanel {...defaultProps} session={session} />);
			expect(screen.getByTitle('Auto-refresh every 180s')).toBeInTheDocument();
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

		it('copies the project root when the header path is double-clicked', () => {
			const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
			Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, writable: true });

			render(<FileExplorerPanel {...defaultProps} />);

			fireEvent.doubleClick(screen.getByTitle('/Users/test/project'));

			expect(mockClipboard.writeText).toHaveBeenCalledWith('/Users/test/project');
			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Path copied to clipboard');
		});

		it('opens the last document graph from the header shortcut', () => {
			const onOpenLastDocumentGraph = vi.fn();
			render(
				<FileExplorerPanel
					{...defaultProps}
					lastGraphFocusFile="README.md"
					onOpenLastDocumentGraph={onOpenLastDocumentGraph}
				/>
			);

			fireEvent.click(screen.getByTitle('Open Last Document Graph'));

			expect(onOpenLastDocumentGraph).toHaveBeenCalledTimes(1);
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
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
			// Virtualized tree uses paddingLeft for indentation
			// index.ts is a file at depth 1, so paddingLeft = 8 + max(0, 1-1)*16 = 8px
			// (files use depth-1 to align icons with parent folder icons)
			const nestedItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('index.ts')
			);
			expect(nestedItem).toHaveStyle({ paddingLeft: '8px' });
		});

		it('displays file name with truncate class', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const truncateSpans = container.querySelectorAll('.truncate');
			expect(truncateSpans.length).toBeGreaterThan(0);
		});

		it('sets title attribute with full file name', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			expect(screen.getByTitle('src')).toBeInTheDocument();
			expect(screen.getByTitle('package.json')).toBeInTheDocument();
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
			const items = screen.getAllByTitle(nfcName);
			expect(items).toHaveLength(1);
			expect(screen.getByText('other.txt')).toBeInTheDocument();

			consoleSpy.mockRestore();
		});

		it('skips duplicate full paths that would collide after flattening', () => {
			const treeWithDuplicatePaths = [
				{ name: 'src/index.ts', type: 'file' as const },
				{
					name: 'src',
					type: 'folder' as const,
					children: [{ name: 'index.ts', type: 'file' as const }],
				},
			];
			const session = createMockSession({ fileExplorerExpanded: ['src'] });
			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			render(
				<FileExplorerPanel
					{...defaultProps}
					session={session}
					filteredFileTree={treeWithDuplicatePaths}
				/>
			);

			expect(consoleSpy).toHaveBeenCalledWith(
				'[FileExplorer] Duplicate path skipped:',
				'src/index.ts'
			);
			expect(screen.getByText('src/index.ts')).toBeInTheDocument();
			expect(screen.queryByText('index.ts')).not.toBeInTheDocument();

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
		});

		it('sets selectedFileIndex and activeFocus when clicking a file', () => {
			render(<FileExplorerPanel {...defaultProps} />);
			const file = screen.getByText('package.json');
			fireEvent.click(file);

			expect(defaultProps.setSelectedFileIndex).toHaveBeenCalled();
			expect(defaultProps.setActiveFocus).toHaveBeenCalledWith('right');
		});

		it('keeps filter input focus when clicking a file while filtering', () => {
			const { container } = render(
				<FileExplorerPanel {...defaultProps} fileTreeFilter="package" />
			);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			const mouseDown = new MouseEvent('mousedown', {
				bubbles: true,
				cancelable: true,
			});

			fileItem!.dispatchEvent(mouseDown);

			expect(mouseDown.defaultPrevented).toBe(true);
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
				session: sessionWithFileTab,
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
		it('displays change badge for modified files', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'modified' }],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('modified')).toBeInTheDocument();
		});

		it('displays change badge for added files', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'added' }],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('added')).toBeInTheDocument();
		});

		it('displays change badge for deleted files', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'deleted' }],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('deleted')).toBeInTheDocument();
		});

		it('applies success color to added badge', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'added' }],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			const badge = screen.getByText('added');
			expect(badge).toHaveStyle({ color: mockTheme.colors.success });
		});

		it('applies warning color to modified badge', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'modified' }],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			const badge = screen.getByText('modified');
			expect(badge).toHaveStyle({ color: mockTheme.colors.warning });
		});

		it('applies error color to deleted badge', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'deleted' }],
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			const badge = screen.getByText('deleted');
			expect(badge).toHaveStyle({ color: mockTheme.colors.error });
		});

		it('applies bold font to changed file names', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'modified' }],
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			const boldItems = container.querySelectorAll('.font-medium');
			expect(boldItems.length).toBeGreaterThan(0);
		});

		it('applies textMain color to changed file names', () => {
			const session = createMockSession({
				changedFiles: [{ path: '/Users/test/project/package.json', type: 'modified' }],
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			// Find item with package.json
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			expect(fileItem).toHaveStyle({ color: mockTheme.colors.textMain });
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

		it('lets terminal sessions choose a new directory after file tree errors', () => {
			const session = createMockSession({
				toolType: 'terminal',
				fileTreeError: 'Permission denied',
			});
			render(<FileExplorerPanel {...defaultProps} session={session} />);

			fireEvent.click(screen.getByText('Select New Directory'));

			expect(defaultProps.updateSessionWorkingDirectory).toHaveBeenCalledWith(
				'session-1',
				expect.any(Function)
			);
			expect(screen.queryByText('Retry Connection')).not.toBeInTheDocument();
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

		it('shows retry countdown and clears scheduled retry when retry now is clicked', async () => {
			const retryAt = Date.now() + 5000;
			const session = createMockSession({
				fileTreeError: 'SSH connection failed',
				fileTreeRetryAt: retryAt,
			});

			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('Retrying in 5s...')).toBeInTheDocument();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1000);
			});

			expect(screen.getByText('Retrying in 4s...')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Retry Now'));

			expect(defaultProps.setSessions).toHaveBeenCalledWith(expect.any(Function));
			const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
				sessions: Session[]
			) => Session[];
			expect(updateSessions([session])[0].fileTreeRetryAt).toBeUndefined();
		});
	});

	describe('Empty State', () => {
		it('shows loading message when fileTreeLoading is true', () => {
			const session = createMockSession({ fileTree: [], fileTreeLoading: true });
			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.getByText('Loading files...')).toBeInTheDocument();
		});

		it('shows remote loading progress counters and current folder', () => {
			const session = createMockSession({
				fileTree: [],
				fileTreeLoading: true,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				fileTreeLoadingProgress: {
					directoriesScanned: 12,
					filesFound: 3456,
					currentDirectory: '/remote/workspace/src',
				},
			});

			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.getByText('Loading remote files...')).toBeInTheDocument();
			expect(screen.getByText('3,456')).toBeInTheDocument();
			expect(screen.getByText('12')).toBeInTheDocument();
			expect(screen.getByText('scanning: src/')).toHaveAttribute('title', '/remote/workspace/src');
		});

		it('shows root folder fallback and hides zero progress counters', () => {
			const session = createMockSession({
				fileTree: [],
				fileTreeLoading: true,
				fileTreeLoadingProgress: {
					directoriesScanned: 0,
					filesFound: 0,
					currentDirectory: '/',
				},
			});

			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.getByText('Loading files...')).toBeInTheDocument();
			expect(screen.queryByText('files in')).not.toBeInTheDocument();
			expect(screen.getByText('scanning: //')).toHaveAttribute('title', '/');
		});

		it('hides progress counters when loading progress is unavailable', () => {
			const session = createMockSession({
				fileTree: [],
				fileTreeLoading: true,
				fileTreeLoadingProgress: undefined,
			});

			render(<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={[]} />);

			expect(screen.getByText('Loading files...')).toBeInTheDocument();
			expect(screen.queryByText('files in')).not.toBeInTheDocument();
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

		it('formats zero-byte singular status bar values', () => {
			const session = createMockSession({
				fileTreeStats: {
					fileCount: 1,
					folderCount: 1,
					totalSize: 0,
					lastUpdated: '2024-01-01T00:00:00.000Z',
				},
			});

			render(<FileExplorerPanel {...defaultProps} session={session} />);

			expect(screen.getByText('0 B')).toBeInTheDocument();
			expect(screen.getByText('file,')).toBeInTheDocument();
			expect(screen.getByText('folder')).toBeInTheDocument();
			expect(screen.queryByText('files,')).not.toBeInTheDocument();
			expect(screen.queryByText('folders')).not.toBeInTheDocument();
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

		it('handles undefined changedFiles', () => {
			const session = createMockSession({ changedFiles: undefined as any });
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);

			// Should render without crashing (fixed with optional chaining at line 201)
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

		it('previews a file from the context menu and closes the menu', () => {
			const { container } = render(<FileExplorerPanel {...defaultProps} />);

			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

			fireEvent.click(screen.getByText('Preview'));

			expect(defaultProps.handleFileClick).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'package.json', type: 'file' }),
				'package.json',
				defaultProps.session
			);
			expect(screen.queryByText('Preview')).not.toBeInTheDocument();
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

		it('closes context menu when the click-outside callback runs', () => {
			clickOutsideCallback = null;
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			expect(screen.getByText('Copy Path')).toBeInTheDocument();

			act(() => {
				clickOutsideCallback?.();
			});

			expect(screen.queryByText('Copy Path')).not.toBeInTheDocument();
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

		it('selects the filename stem when opening file rename', () => {
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
				callback(0);
				return 1;
			});
			const setSelectionRangeSpy = vi.spyOn(HTMLInputElement.prototype, 'setSelectionRange');

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			expect(setSelectionRangeSpy).toHaveBeenCalledWith(0, 'package'.length);

			setSelectionRangeSpy.mockRestore();
			rafSpy.mockRestore();
		});

		it('selects the full folder name when opening folder rename', () => {
			const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
				callback(0);
				return 1;
			});
			const selectSpy = vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(() => {});

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			expect(selectSpy).toHaveBeenCalled();

			selectSpy.mockRestore();
			rafSpy.mockRestore();
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

		it('keeps rename modal open without filesystem changes when the new name is blank', async () => {
			const mockFs = { rename: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			fireEvent.change(screen.getByDisplayValue('package.json'), {
				target: { value: '   ' },
			});
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
			});

			expect(mockFs.rename).not.toHaveBeenCalled();
			expect(screen.getByText('Rename File')).toBeInTheDocument();
		});

		it('disables rename submission when the name is unchanged', () => {
			const mockFs = { rename: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			const input = screen.getByDisplayValue('package.json');
			const renameButton = screen.getByRole('button', { name: 'Rename' });
			expect(renameButton).toBeDisabled();

			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockFs.rename).not.toHaveBeenCalled();
			expect(screen.getByText('Rename File')).toBeInTheDocument();
		});

		it('shows rename validation errors for invalid names', async () => {
			const mockFs = { rename: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			fireEvent.change(screen.getByDisplayValue('package.json'), {
				target: { value: 'bad/name.json' },
			});
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
			});

			expect(screen.getByText('Name cannot contain slashes')).toBeInTheDocument();
			expect(mockFs.rename).not.toHaveBeenCalled();
		});

		it('shows rename filesystem failures without closing the modal', async () => {
			const mockFs = { rename: vi.fn().mockRejectedValue(new Error('permission denied')) };
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			fireEvent.change(screen.getByDisplayValue('package.json'), {
				target: { value: 'package-renamed.json' },
			});
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
				await Promise.resolve();
			});

			expect(mockFs.rename).toHaveBeenCalledWith(
				'/Users/test/project/package.json',
				'/Users/test/project/package-renamed.json',
				undefined
			);
			expect(screen.getByText('permission denied')).toBeInTheDocument();
			expect(screen.getByText('Rename File')).toBeInTheDocument();
		});

		it('renames folders, updates expanded paths, and reports success', async () => {
			const mockFs = { rename: vi.fn().mockResolvedValue(undefined) };
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const session = createMockSession({
				fileExplorerExpanded: ['src', 'src/utils', 'docs'],
				fileTree: mockFileTree,
			});
			const unrelatedSession = createMockSession({
				id: 'other-session',
				fileExplorerExpanded: ['unrelated'],
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			fireEvent.click(screen.getByText('Rename'));

			fireEvent.change(screen.getByDisplayValue('src'), { target: { value: 'lib' } });
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
				await Promise.resolve();
			});

			expect(mockFs.rename).toHaveBeenCalledWith(
				'/Users/test/project/src',
				'/Users/test/project/lib',
				undefined
			);

			const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
				sessions: Session[]
			) => Session[];
			const [updatedSession, untouchedSession] = updateSessions([session, unrelatedSession]);
			expect(updatedSession.fileTree?.[0].name).toBe('lib');
			expect(updatedSession.fileExplorerExpanded).toEqual(['lib', 'lib/utils', 'docs']);
			expect(untouchedSession).toBe(unrelatedSession);
			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Renamed to "lib"');
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

		it('shows singular folder delete warning text', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 1, folderCount: 1 }),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };

			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });

			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			expect(screen.getByText(/1 file/)).toBeInTheDocument();
			expect(screen.getByText(/1 subfolder/)).toBeInTheDocument();
		});

		it('deletes folders, updates stats and expanded paths, and reports success', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 2, folderCount: 1 }),
				delete: vi.fn().mockResolvedValue(undefined),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const session = createMockSession({
				fileTree: mockFileTree,
				fileExplorerExpanded: ['src', 'src/utils'],
				fileTreeStats: { fileCount: 4, folderCount: 2, lastUpdated: '2024-01-01T00:00:00.000Z' },
			});
			const unrelatedSession = createMockSession({
				id: 'other-session',
				fileTreeStats: { fileCount: 99, folderCount: 9, lastUpdated: '2024-01-01T00:00:00.000Z' },
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('src')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			expect(mockFs.delete).toHaveBeenCalledWith('/Users/test/project/src', {
				sshRemoteId: undefined,
			});

			const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
				sessions: Session[]
			) => Session[];
			const [untouchedSession, updatedSession] = updateSessions([unrelatedSession, session]);
			expect(untouchedSession).toBe(unrelatedSession);
			expect(updatedSession.fileTree?.map((node) => node.name)).toEqual([
				'package.json',
				'README.md',
			]);
			expect(updatedSession.fileTreeStats).toEqual({
				fileCount: 2,
				folderCount: 0,
				lastUpdated: '2024-01-01T00:00:00.000Z',
			});
			expect(updatedSession.fileExplorerExpanded).toEqual([]);
			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Deleted "src"');
		});

		it('deletes files, updates stats, and keeps expanded folders', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
				delete: vi.fn().mockResolvedValue(undefined),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const session = createMockSession({
				fileTree: mockFileTree,
				fileExplorerExpanded: ['src'],
				fileTreeStats: { fileCount: 4, folderCount: 2, lastUpdated: '2024-01-01T00:00:00.000Z' },
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			expect(mockFs.delete).toHaveBeenCalledWith('/Users/test/project/package.json', {
				sshRemoteId: undefined,
			});

			const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
				sessions: Session[]
			) => Session[];
			const [updatedSession] = updateSessions([session]);
			expect(updatedSession.fileTree?.map((node) => node.name)).toEqual(['src', 'README.md']);
			expect(updatedSession.fileTreeStats).toEqual({
				fileCount: 3,
				folderCount: 2,
				lastUpdated: '2024-01-01T00:00:00.000Z',
			});
			expect(updatedSession.fileExplorerExpanded).toEqual(['src']);
			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Deleted "package.json"');
		});

		it('deletes files when tree stats and expanded folders are missing', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
				delete: vi.fn().mockResolvedValue(undefined),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const session = createMockSession({
				fileTree: mockFileTree,
				fileTreeStats: undefined,
				fileExplorerExpanded: undefined as any,
			});
			const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('README.md')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
				sessions: Session[]
			) => Session[];
			const [updatedSession] = updateSessions([session]);
			expect(updatedSession.fileTreeStats).toBeUndefined();
			expect(updatedSession.fileExplorerExpanded).toBeUndefined();
			expect(updatedSession.fileTree?.map((node) => node.name)).toEqual(['src', 'package.json']);
		});

		it('deletes empty folders without child counts', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
				delete: vi.fn().mockResolvedValue(undefined),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const emptyFolderTree = [
				{
					name: 'empty',
					type: 'folder' as const,
				},
				{
					name: 'keep.ts',
					type: 'file' as const,
				},
			];
			const session = createMockSession({
				fileTree: emptyFolderTree,
				fileTreeStats: { fileCount: 1, folderCount: 1, lastUpdated: '2024-01-01T00:00:00.000Z' },
				fileExplorerExpanded: undefined as any,
			});
			const { container } = render(
				<FileExplorerPanel {...defaultProps} session={session} filteredFileTree={emptyFolderTree} />
			);
			const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('empty')
			);
			fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
				sessions: Session[]
			) => Session[];
			const [updatedSession] = updateSessions([session]);
			expect(updatedSession.fileTreeStats).toMatchObject({ fileCount: 1, folderCount: 0 });
			expect(updatedSession.fileExplorerExpanded).toEqual([]);
		});

		it('reports non-Error delete failures as unknown errors', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
				delete: vi.fn().mockRejectedValue('denied'),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Delete failed: Unknown error');
		});

		it('keeps the delete modal open when close is clicked while deletion is pending', async () => {
			let resolveDelete: () => void = () => {};
			const deletePromise = new Promise<void>((resolve) => {
				resolveDelete = resolve;
			});
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
				delete: vi.fn().mockReturnValue(deletePromise),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			expect(screen.getByRole('button', { name: 'Deleting...' })).toBeDisabled();
			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(screen.getByText('Delete File')).toBeInTheDocument();

			await act(async () => {
				resolveDelete();
				await deletePromise;
			});
		});

		it('reports delete failures and closes the busy state', async () => {
			const mockFs = {
				countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
				delete: vi.fn().mockRejectedValue(new Error('permission denied')),
			};
			(window as any).maestro = { platform: 'darwin', fs: mockFs };
			const { container } = render(<FileExplorerPanel {...defaultProps} />);
			const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
				el.textContent?.includes('package.json')
			);
			fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
			await act(async () => {
				fireEvent.click(screen.getByText('Delete'));
			});

			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
				await Promise.resolve();
			});

			expect(defaultProps.onShowFlash).toHaveBeenCalledWith('Delete failed: permission denied');
			expect(screen.getByRole('button', { name: 'Delete' })).not.toBeDisabled();
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

			fireEvent.click(cancelButton);
			expect(screen.queryByText('Delete File')).not.toBeInTheDocument();
		});

		describe('branch completion coverage', () => {
			it('handles rename selection after the rename modal has unmounted', () => {
				let frameCallback: FrameRequestCallback | null = null;
				const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
					frameCallback = callback;
					return 1;
				});

				const { container } = render(<FileExplorerPanel {...defaultProps} />);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);
				fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
				fireEvent.click(screen.getByText('Rename'));
				fireEvent.click(screen.getByText('Cancel'));

				expect(() => frameCallback?.(0)).not.toThrow();
				rafSpy.mockRestore();
			});

			it('renames files and leaves expanded folders unchanged', async () => {
				const mockFs = { rename: vi.fn().mockResolvedValue(undefined) };
				(window as any).maestro = { platform: 'darwin', fs: mockFs };
				const session = createMockSession({
					fileTree: mockFileTree,
					fileExplorerExpanded: ['src'],
				});
				const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);
				fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
				fireEvent.click(screen.getByText('Rename'));

				fireEvent.change(screen.getByDisplayValue('package.json'), {
					target: { value: 'package-new.json' },
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
					await Promise.resolve();
				});

				const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
					sessions: Session[]
				) => Session[];
				const [updatedSession] = updateSessions([session]);
				expect(updatedSession.fileTree?.map((node) => node.name)).toEqual([
					'src',
					'package-new.json',
					'README.md',
				]);
				expect(updatedSession.fileExplorerExpanded).toEqual(['src']);
			});

			it('renames folders when expanded paths are missing', async () => {
				const mockFs = { rename: vi.fn().mockResolvedValue(undefined) };
				(window as any).maestro = { platform: 'darwin', fs: mockFs };
				const session = createMockSession({
					fileTree: mockFileTree,
					fileExplorerExpanded: undefined as any,
				});
				const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
				const folderItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('src')
				);
				fireEvent.contextMenu(folderItem!, { clientX: 100, clientY: 200 });
				fireEvent.click(screen.getByText('Rename'));

				fireEvent.change(screen.getByDisplayValue('src'), { target: { value: 'lib' } });
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
					await Promise.resolve();
				});

				const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
					sessions: Session[]
				) => Session[];
				const [updatedSession] = updateSessions([session]);
				expect(updatedSession.fileTree?.[0].name).toBe('lib');
				expect(updatedSession.fileExplorerExpanded).toEqual([]);
			});

			it('reports non-Error rename failures with the fallback message', async () => {
				const mockFs = { rename: vi.fn().mockRejectedValue('bad') };
				(window as any).maestro = { platform: 'darwin', fs: mockFs };
				const { container } = render(<FileExplorerPanel {...defaultProps} />);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);
				fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
				fireEvent.click(screen.getByText('Rename'));

				fireEvent.change(screen.getByDisplayValue('package.json'), {
					target: { value: 'package-renamed.json' },
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
					await Promise.resolve();
				});

				expect(screen.getByText('Rename failed')).toBeInTheDocument();
			});

			it('uses empty trees for rename and delete local updates when session fileTree is missing', async () => {
				const mockFs = {
					rename: vi.fn().mockResolvedValue(undefined),
					countItems: vi.fn().mockResolvedValue({ fileCount: 0, folderCount: 0 }),
					delete: vi.fn().mockResolvedValue(undefined),
				};
				(window as any).maestro = { platform: 'darwin', fs: mockFs };
				const session = createMockSession({ fileTree: undefined as any });
				const { container } = render(<FileExplorerPanel {...defaultProps} session={session} />);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);

				fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
				fireEvent.click(screen.getByText('Rename'));
				fireEvent.change(screen.getByDisplayValue('package.json'), {
					target: { value: 'package-renamed.json' },
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
					await Promise.resolve();
				});

				let updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
					sessions: Session[]
				) => Session[];
				expect(updateSessions([session])[0].fileTree).toEqual([]);

				fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });
				await act(async () => {
					fireEvent.click(screen.getByText('Delete'));
				});
				await act(async () => {
					fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
					await Promise.resolve();
				});

				updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[1][0] as (
					sessions: Session[]
				) => Session[];
				expect(updateSessions([session])[0].fileTree).toEqual([]);
			});

			it('renders SSH remote host details in the header', () => {
				const session = createMockSession({
					sshRemote: { id: 'remote-1', name: 'Prod', host: 'prod.example.com' } as any,
				});

				render(<FileExplorerPanel {...defaultProps} session={session} />);

				expect(screen.getByTitle('SSH: Prod (prod.example.com)')).toBeInTheDocument();
				expect(screen.getByTitle('prod.example.com:/Users/test/project')).toBeInTheDocument();
			});

			it('retry-now clears only the active session retry marker', () => {
				const retryAt = Date.now() + 5000;
				const session = createMockSession({ fileTreeError: 'Failed', fileTreeRetryAt: retryAt });
				const otherSession = createMockSession({
					id: 'other-session',
					fileTreeRetryAt: retryAt,
				});
				render(<FileExplorerPanel {...defaultProps} session={session} />);

				fireEvent.click(screen.getByText('Retry Now'));

				const updateSessions = vi.mocked(defaultProps.setSessions).mock.calls[0][0] as (
					sessions: Session[]
				) => Session[];
				const [updatedSession, untouchedSession] = updateSessions([session, otherSession]);
				expect(updatedSession.fileTreeRetryAt).toBeUndefined();
				expect(untouchedSession.fileTreeRetryAt).toBe(retryAt);
			});

			it('keeps context menu open on non-Escape keys', () => {
				const { container } = render(<FileExplorerPanel {...defaultProps} />);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);
				fireEvent.contextMenu(fileItem!, { clientX: 100, clientY: 200 });

				fireEvent.keyDown(window, { key: 'Enter' });

				expect(screen.getByText('Rename')).toBeInTheDocument();
			});

			it('does not prevent mouse down or move focus when no file filter is active', () => {
				const { container } = render(<FileExplorerPanel {...defaultProps} />);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);
				const preventDefault = vi.fn();

				fireEvent.mouseDown(fileItem!, { preventDefault });
				fireEvent.click(fileItem!);

				expect(preventDefault).not.toHaveBeenCalled();
				expect(defaultProps.setActiveFocus).toHaveBeenCalledWith('right');
			});

			it('does not move focus when selecting a file while filtered', () => {
				const { container } = render(
					<FileExplorerPanel {...defaultProps} fileTreeFilter="package" />
				);
				const fileItem = Array.from(container.querySelectorAll('[data-file-index]')).find((el) =>
					el.textContent?.includes('package.json')
				);

				fireEvent.click(fileItem!);

				expect(defaultProps.setSelectedFileIndex).toHaveBeenCalled();
				expect(defaultProps.setActiveFocus).not.toHaveBeenCalled();
			});

			it('covers refresh overlay timer paths around hover and unmount', () => {
				const { unmount } = render(<FileExplorerPanel {...defaultProps} />);
				const refreshButton = screen.getByTitle('Refresh file tree');

				fireEvent.mouseEnter(refreshButton);
				fireEvent.mouseLeave(refreshButton);
				act(() => {
					vi.advanceTimersByTime(100);
				});

				fireEvent.mouseEnter(refreshButton);
				act(() => {
					vi.advanceTimersByTime(450);
				});
				expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
				fireEvent.mouseLeave(refreshButton);
				fireEvent.mouseEnter(screen.getByText('Auto-refresh'));
				act(() => {
					vi.advanceTimersByTime(100);
				});
				expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
				fireEvent.mouseLeave(screen.getByText('Auto-refresh'));
				act(() => {
					vi.advanceTimersByTime(100);
				});
				expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();

				fireEvent.mouseEnter(refreshButton);
				unmount();
				expect(() => {
					act(() => {
						vi.advanceTimersByTime(450);
					});
				}).not.toThrow();
			});
		});
	});
});
