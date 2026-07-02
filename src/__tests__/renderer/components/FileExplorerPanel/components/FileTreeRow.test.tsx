import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeRow } from '../../../../../renderer/components/FileExplorerPanel/components/FileTreeRow';
import type { FlattenedNode } from '../../../../../renderer/components/FileExplorerPanel/types';
import type { FileNode } from '../../../../../renderer/types/fileTree';

vi.mock('../../../../../renderer/utils/theme', () => ({
	getExplorerFileIcon: (_name: string) => <span data-testid="file-icon" />,
	getExplorerFolderIcon: (_name: string, _expanded: boolean) => <span data-testid="folder-icon" />,
}));

vi.mock('../../../../../renderer/constants/colorblindPalettes', () => ({
	COLORBLIND_STATUS_COLORS: { success: '#00b48a', warning: '#e67e22', error: '#e74c3c' },
}));

const theme = {
	colors: {
		textMain: '#fff',
		textDim: '#888',
		accent: '#7C3AED',
		border: '#333',
		bgActivity: '#222',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as any;

const fileNode: FileNode = { name: 'App.tsx', type: 'file' };
const folderNode: FileNode = { name: 'src', type: 'folder', children: [] };

const makeItem = (node: FileNode, depth = 0): FlattenedNode => ({
	node,
	path: node.name,
	depth,
	globalIndex: 0,
});

const virtualRow = { index: 0, start: 0, size: 28 };

const session = {
	id: 'sess-1',
	fullPath: '/project',
	fileExplorerExpanded: [],
	activeFileTabId: null,
	filePreviewTabs: [],
} as any;

const defaultProps = {
	item: makeItem(fileNode),
	virtualRow,
	session,
	theme,
	activeFocus: 'right' as const,
	activeRightTab: 'files',
	selectedFileIndex: 0,
	changeMap: new Map<string, any>(),
	changedAncestors: new Set<string>(),
	colorBlindMode: false,
	dragOverFolder: null,
	selectedPaths: new Set<string>(),
	selectedPathsRef: { current: new Set<string>() },
	setSelectedPaths: vi.fn(),
	fileExplorerIconTheme: 'vscode' as any,
	fileTreeFilter: '',
	htmlDoubleClickOpensInBrowser: false,
	sshRemoteId: undefined,
	isTouchPointer: false,
	longPressTimerRef: { current: null as number | null },
	longPressFiredRef: { current: false },
	lastClickedUnderFilterRef: { current: null as string | null },
	setActiveFocus: vi.fn(),
	handleRowSelectionClick: vi.fn(),
	openContextMenuAt: vi.fn(),
	handleContextMenu: vi.fn(),
	handleFolderDragEnter: vi.fn(),
	handleFolderDragOver: vi.fn(),
	handleFolderDragLeave: vi.fn(),
	handleFolderDrop: vi.fn(),
	onInternalDragStart: vi.fn(),
	onInternalDragEnd: vi.fn(),
	onOsDragOut: vi.fn().mockReturnValue(false),
	toggleFolder: vi.fn(),
	toggleFolderRecursive: vi.fn(),
	setSessions: vi.fn(),
	handleFileClick: vi.fn().mockResolvedValue(undefined),
};

describe('FileTreeRow', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the file name', () => {
		render(<FileTreeRow {...defaultProps} />);
		expect(screen.getByText('App.tsx')).toBeTruthy();
	});

	it('renders a file icon for file nodes', () => {
		render(<FileTreeRow {...defaultProps} />);
		expect(screen.getByTestId('file-icon')).toBeTruthy();
	});

	it('renders a folder icon for folder nodes', () => {
		render(<FileTreeRow {...defaultProps} item={makeItem(folderNode)} />);
		expect(screen.getByTestId('folder-icon')).toBeTruthy();
	});

	it('renders a chevron for folder nodes', () => {
		const { container } = render(<FileTreeRow {...defaultProps} item={makeItem(folderNode)} />);
		// ChevronRight or ChevronDown SVG should be present
		const svgs = container.querySelectorAll('svg');
		expect(svgs.length).toBeGreaterThan(0);
	});

	it('generates indent guides for nested nodes', () => {
		const { container } = render(<FileTreeRow {...defaultProps} item={makeItem(fileNode, 2)} />);
		const guides = container.querySelectorAll('.absolute.top-0.bottom-0.w-px');
		expect(guides).toHaveLength(2);
	});

	it('applies drop-target highlight styles when dragOverFolder matches', () => {
		const { container } = render(
			<FileTreeRow {...defaultProps} item={makeItem(folderNode)} dragOverFolder="src" />
		);
		const row = container.firstElementChild as HTMLElement;
		expect(row.style.outline).toContain('dashed');
	});

	it('highlights a child file row as part of the drop group when dragOverFolder matches its parent', () => {
		// Dropping anywhere in an expanded folder's list of files should land in
		// that folder, so the child rows light up alongside the folder header.
		const nested: FlattenedNode = {
			node: { name: 'App.tsx', type: 'file' },
			path: 'src/App.tsx',
			depth: 1,
			globalIndex: 1,
		};
		const { container } = render(
			<FileTreeRow {...defaultProps} item={nested} dragOverFolder="src" />
		);
		const row = container.firstElementChild as HTMLElement;
		expect(row.style.backgroundColor).toBeTruthy();
		expect(row.style.borderLeftColor).not.toBe('transparent');
		// Only the folder header gets the dashed box, not the child file rows.
		expect(row.style.outline).not.toContain('dashed');
	});

	it("routes a drop on a child file row into that file's parent folder", () => {
		const handleFolderDrop = vi.fn();
		const nested: FlattenedNode = {
			node: { name: 'App.tsx', type: 'file' },
			path: 'src/App.tsx',
			depth: 1,
			globalIndex: 1,
		};
		const { container } = render(
			<FileTreeRow {...defaultProps} item={nested} handleFolderDrop={handleFolderDrop} />
		);
		fireEvent.drop(container.firstElementChild!);
		expect(handleFolderDrop).toHaveBeenCalledWith(expect.anything(), 'src');
	});

	it('does not highlight a child file row whose parent does not match dragOverFolder', () => {
		const nested: FlattenedNode = {
			node: { name: 'App.tsx', type: 'file' },
			path: 'src/App.tsx',
			depth: 1,
			globalIndex: 1,
		};
		const { container } = render(
			<FileTreeRow {...defaultProps} item={nested} dragOverFolder="docs" />
		);
		const row = container.firstElementChild as HTMLElement;
		expect(row.style.borderLeftColor).toBe('transparent');
	});

	it('shows git change indicator dot when file is changed', () => {
		const changeMap = new Map<string, any>([['App.tsx', 'modified']]);
		render(<FileTreeRow {...defaultProps} changeMap={changeMap} />);
		expect(screen.getByTestId('git-change-indicator')).toBeTruthy();
	});

	it('does not show git change indicator when file is unchanged', () => {
		render(<FileTreeRow {...defaultProps} changeMap={new Map()} />);
		expect(screen.queryByTestId('git-change-indicator')).toBeNull();
	});

	it('calls handleContextMenu on right-click', () => {
		const handleContextMenu = vi.fn();
		const { container } = render(
			<FileTreeRow {...defaultProps} handleContextMenu={handleContextMenu} />
		);
		fireEvent.contextMenu(container.firstElementChild!);
		expect(handleContextMenu).toHaveBeenCalled();
	});

	it('calls handleRowSelectionClick on plain click', () => {
		const handleRowSelectionClick = vi.fn();
		const { container } = render(
			<FileTreeRow {...defaultProps} handleRowSelectionClick={handleRowSelectionClick} />
		);
		fireEvent.click(container.firstElementChild!);
		expect(handleRowSelectionClick).toHaveBeenCalled();
	});

	it('opens files on a single tap for touch pointers', () => {
		const handleFileClick = vi.fn().mockResolvedValue(undefined);
		const { container } = render(
			<FileTreeRow {...defaultProps} isTouchPointer handleFileClick={handleFileClick} />
		);

		fireEvent.click(container.firstElementChild!);

		expect(handleFileClick).toHaveBeenCalledWith(fileNode, 'App.tsx', session);
	});

	it('opens the context menu on touch long press', () => {
		vi.useFakeTimers();
		const openContextMenuAt = vi.fn();
		const longPressTimerRef = { current: null as number | null };
		const longPressFiredRef = { current: false };
		const { container } = render(
			<FileTreeRow
				{...defaultProps}
				openContextMenuAt={openContextMenuAt}
				longPressTimerRef={longPressTimerRef}
				longPressFiredRef={longPressFiredRef}
			/>
		);

		fireEvent.touchStart(container.firstElementChild!, {
			touches: [{ clientX: 100, clientY: 200 }],
		});
		vi.advanceTimersByTime(500);

		expect(openContextMenuAt).toHaveBeenCalledWith(100, 200, fileNode, 'App.tsx', 0);
		expect(longPressFiredRef.current).toBe(true);
		vi.useRealTimers();
	});

	it('applies keyboard-selected background when globalIndex matches selectedFileIndex', () => {
		const item: FlattenedNode = { node: fileNode, path: 'App.tsx', depth: 0, globalIndex: 3 };
		const { container } = render(
			<FileTreeRow
				{...defaultProps}
				item={item}
				selectedFileIndex={3}
				activeFocus="right"
				activeRightTab="files"
			/>
		);
		const row = container.firstElementChild as HTMLElement;
		expect(row.style.backgroundColor).toBeTruthy();
	});

	it('shows multi-selected accent border for rows in selectedPaths', () => {
		const { container } = render(
			<FileTreeRow {...defaultProps} selectedPaths={new Set(['App.tsx'])} />
		);
		const row = container.firstElementChild as HTMLElement;
		// jsdom converts hex colors to rgb notation
		expect(row.style.borderLeftColor).toBeTruthy();
		expect(row.style.borderLeftColor).not.toBe('transparent');
	});

	it('uses colorblind palette colors when colorBlindMode is true', () => {
		const changeMap = new Map<string, any>([['App.tsx', 'added']]);
		const { container } = render(
			<FileTreeRow {...defaultProps} changeMap={changeMap} colorBlindMode={true} />
		);
		const dot = container.querySelector('[data-testid="git-change-indicator"]') as HTMLElement;
		// Colorblind success = #00b48a
		expect(dot.style.backgroundColor).toBe('rgb(0, 180, 138)');
	});
});
