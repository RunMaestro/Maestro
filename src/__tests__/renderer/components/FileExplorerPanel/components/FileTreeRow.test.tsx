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

const makeItem = (
	node: FileNode,
	depth = 0,
	overrides: Partial<FlattenedNode> = {}
): FlattenedNode => ({
	node,
	path: node.name,
	depth,
	globalIndex: 0,
	isLastChild: false,
	// Every ancestor column continues by default, matching a row in the middle
	// of a tree. Connector tests override this.
	ancestorGuideMask: depth > 1 ? (1 << (depth - 1)) - 1 : 0,
	...overrides,
});

const virtualRow = { index: 0, start: 0, size: 28 };

const getHighlight = (container: HTMLElement) =>
	container.querySelector('[data-testid="file-tree-row-highlight"]') as HTMLElement;

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
	fileTreeBranchConnectors: false,
	fileTreeFilter: '',
	htmlDoubleClickOpensInBrowser: false,
	sshRemoteId: undefined,
	lastClickedUnderFilterRef: { current: null as string | null },
	setActiveFocus: vi.fn(),
	handleRowSelectionClick: vi.fn(),
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

	it('reserves the chevron slot on file rows so sibling icons share a column', () => {
		render(<FileTreeRow {...defaultProps} />);
		expect(screen.getByTestId('file-tree-chevron-spacer')).toHaveClass('w-3');
	});

	it('does not render a chevron spacer on folder rows', () => {
		render(<FileTreeRow {...defaultProps} item={makeItem(folderNode)} />);
		expect(screen.queryByTestId('file-tree-chevron-spacer')).toBeNull();
	});

	it('generates indent guides for nested nodes', () => {
		const { container } = render(<FileTreeRow {...defaultProps} item={makeItem(fileNode, 2)} />);
		const guides = container.querySelectorAll('.absolute.top-0.bottom-0.w-px');
		expect(guides).toHaveLength(2);
	});

	describe('branch connectors (Settings > Display, default off)', () => {
		const connectorProps = { ...defaultProps, fileTreeBranchConnectors: true };

		it('draws no connector on a depth-0 row', () => {
			const { container } = render(
				<FileTreeRow {...connectorProps} item={makeItem(fileNode, 0)} />
			);
			expect(container.querySelector('[data-testid="file-tree-connector-stem"]')).toBeNull();
			expect(container.querySelector('[data-testid="file-tree-connector-arm"]')).toBeNull();
		});

		it("puts the elbow on the row's own parent column, one indent step left of its icon", () => {
			const { container } = render(
				<FileTreeRow {...connectorProps} item={makeItem(fileNode, 2)} />
			);
			const arm = container.querySelector<HTMLElement>('[data-testid="file-tree-connector-arm"]')!;
			const stem = container.querySelector<HTMLElement>(
				'[data-testid="file-tree-connector-stem"]'
			)!;
			// GUIDE_OFFSET 12 + (depth - 1) * INDENT_STEP 20
			expect(arm.style.left).toBe('32px');
			expect(stem.style.left).toBe('32px');
		});

		it('runs the elbow stem full height when the row has a following sibling', () => {
			const { container } = render(
				<FileTreeRow {...connectorProps} item={makeItem(fileNode, 1, { isLastChild: false })} />
			);
			const stem = container.querySelector<HTMLElement>(
				'[data-testid="file-tree-connector-stem"]'
			)!;
			expect(stem.className).toContain('bottom-0');
			expect(stem.className).not.toContain('h-1/2');
		});

		it("stops the elbow stem at the elbow on a folder's last child", () => {
			const { container } = render(
				<FileTreeRow {...connectorProps} item={makeItem(fileNode, 1, { isLastChild: true })} />
			);
			const stem = container.querySelector<HTMLElement>(
				'[data-testid="file-tree-connector-stem"]'
			)!;
			expect(stem.className).toContain('h-1/2');
			expect(stem.className).not.toContain('bottom-0');
		});

		it('only draws pass-through guides for ancestors the mask keeps alive', () => {
			// depth 3, so pass-through columns are 0 and 1; only column 0 is set.
			const { container } = render(
				<FileTreeRow {...connectorProps} item={makeItem(fileNode, 3, { ancestorGuideMask: 0b1 })} />
			);
			const guides = container.querySelectorAll<HTMLElement>(
				'[data-testid="file-tree-indent-guide"]'
			);
			expect(Array.from(guides).map((g) => g.style.left)).toEqual(['12px']);
		});

		it('draws every ancestor column full height when connectors are off', () => {
			const { container } = render(
				<FileTreeRow {...defaultProps} item={makeItem(fileNode, 3, { ancestorGuideMask: 0 })} />
			);
			const guides = container.querySelectorAll<HTMLElement>(
				'[data-testid="file-tree-indent-guide"]'
			);
			expect(Array.from(guides).map((g) => g.style.left)).toEqual(['12px', '32px', '52px']);
			expect(container.querySelector('[data-testid="file-tree-connector-stem"]')).toBeNull();
		});
	});

	it('starts the row highlight right of its nearest ancestor guide', () => {
		const item = makeItem(fileNode, 2, { path: 'a/b/App.tsx' });
		const { container } = render(<FileTreeRow {...defaultProps} item={item} />);
		const guides = container.querySelectorAll<HTMLElement>('.absolute.top-0.bottom-0.w-px');
		const lastGuideRight = parseFloat(guides[guides.length - 1].style.left) + 1;
		expect(parseFloat(getHighlight(container).style.left)).toBeGreaterThan(lastGuideRight);
	});

	it('applies drop-target highlight styles when dragOverFolder matches', () => {
		const { container } = render(
			<FileTreeRow {...defaultProps} item={makeItem(folderNode)} dragOverFolder="src" />
		);
		expect(getHighlight(container).style.outline).toContain('dashed');
	});

	it('highlights a child file row as part of the drop group when dragOverFolder matches its parent', () => {
		// Dropping anywhere in an expanded folder's list of files should land in
		// that folder, so the child rows light up alongside the folder header.
		const nested = makeItem({ name: 'App.tsx', type: 'file' }, 1, {
			path: 'src/App.tsx',
			globalIndex: 1,
		});
		const { container } = render(
			<FileTreeRow {...defaultProps} item={nested} dragOverFolder="src" />
		);
		const highlight = getHighlight(container);
		expect(highlight.style.backgroundColor).toBeTruthy();
		expect(highlight.style.borderLeftColor).not.toBe('transparent');
		// Only the folder header gets the dashed box, not the child file rows.
		expect(highlight.style.outline).not.toContain('dashed');
		// The group starts at the destination folder's indent (depth 0), so the
		// header and its files still read as one block.
		expect(highlight.style.left).toBe('0px');
	});

	it("routes a drop on a child file row into that file's parent folder", () => {
		const handleFolderDrop = vi.fn();
		const nested = makeItem({ name: 'App.tsx', type: 'file' }, 1, {
			path: 'src/App.tsx',
			globalIndex: 1,
		});
		const { container } = render(
			<FileTreeRow {...defaultProps} item={nested} handleFolderDrop={handleFolderDrop} />
		);
		fireEvent.drop(container.firstElementChild!);
		expect(handleFolderDrop).toHaveBeenCalledWith(expect.anything(), 'src');
	});

	it('does not highlight a child file row whose parent does not match dragOverFolder', () => {
		const nested = makeItem({ name: 'App.tsx', type: 'file' }, 1, {
			path: 'src/App.tsx',
			globalIndex: 1,
		});
		const { container } = render(
			<FileTreeRow {...defaultProps} item={nested} dragOverFolder="docs" />
		);
		expect(getHighlight(container).style.borderLeftColor).toBe('transparent');
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

	it('applies keyboard-selected background when globalIndex matches selectedFileIndex', () => {
		const item = makeItem(fileNode, 0, { globalIndex: 3 });
		const { container } = render(
			<FileTreeRow
				{...defaultProps}
				item={item}
				selectedFileIndex={3}
				activeFocus="right"
				activeRightTab="files"
			/>
		);
		expect(getHighlight(container).style.backgroundColor).toBeTruthy();
	});

	it('shows multi-selected accent border for rows in selectedPaths', () => {
		const { container } = render(
			<FileTreeRow {...defaultProps} selectedPaths={new Set(['App.tsx'])} />
		);
		const highlight = getHighlight(container);
		// jsdom converts hex colors to rgb notation
		expect(highlight.style.borderLeftColor).toBeTruthy();
		expect(highlight.style.borderLeftColor).not.toBe('transparent');
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
