import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeContextMenu } from '../../../../../renderer/components/FileExplorerPanel/components/FileTreeContextMenu';
import type { ContextMenuState } from '../../../../../renderer/components/FileExplorerPanel/types';
import type { FileNode } from '../../../../../renderer/types/fileTree';

vi.mock('../../../../../renderer/utils/platformUtils', () => ({
	getRevealLabel: () => 'Reveal in Finder',
	getOpenInLabel: () => 'Open in Finder',
}));

vi.mock('../../../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

const theme = {
	colors: {
		bgSidebar: '#1a1a1a',
		border: '#333',
		textMain: '#fff',
		textDim: '#888',
		accent: '#7C3AED',
		error: '#ef4444',
	},
} as any;

const contextMenuPos = { top: 100, left: 200, ready: true };

const fileNode: FileNode = { name: 'App.tsx', type: 'file' };
const folderNode: FileNode = {
	name: 'src',
	type: 'folder',
	children: [
		{ name: 'index.ts', type: 'file' },
		{ name: 'utils', type: 'folder', children: [{ name: 'helpers.ts', type: 'file' }] },
	],
};
const emptyFolderNode: FileNode = { name: 'empty', type: 'folder', children: [] };
const htmlNode: FileNode = { name: 'index.html', type: 'file' };
const mediaNode: FileNode = { name: 'podcast.mp3', type: 'file' };
const mdNode: FileNode = { name: 'README.MD', type: 'file' };

const makeContextMenu = (node: FileNode): ContextMenuState => ({
	x: 100,
	y: 200,
	node,
	path: node.name,
});

const defaultProps = {
	theme,
	contextMenuRef: { current: null } as any,
	contextMenuPos,
	sshRemoteId: undefined,
	onFocusFileInGraph: vi.fn(),
	onOpenBrowserTabAt: vi.fn(),
	onCopyPath: vi.fn(),
	onCopyFileName: vi.fn(),
	onDownloadFile: vi.fn(),
	onOpenInDefaultApp: vi.fn(),
	onOpenInMaestroBrowser: vi.fn(),
	onOpenInExplorer: vi.fn(),
	onOpenNewFile: vi.fn(),
	onOpenNewFolder: vi.fn(),
	onNewAgentHere: vi.fn(),
	onPreviewFile: vi.fn(),
	onPreviewAllInFolder: vi.fn(),
	onStageForAutoRun: vi.fn(),
	onCompressFolder: vi.fn(),
	onPreviewMulti: vi.fn(),
	onQueueMedia: vi.fn(),
	onOpenInDefaultAppMulti: vi.fn(),
	onOpenDeleteMulti: vi.fn(),
	onFocusInGraph: vi.fn(),
	onOpenRename: vi.fn(),
	onOpenDelete: vi.fn(),
};

const origMaestro = (window as any).maestro;

describe('FileTreeContextMenu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = { platform: 'darwin' };
	});

	afterEach(() => {
		(window as any).maestro = origMaestro;
	});

	it('shows Preview + Open in Default App + Copy Path + Reveal + Rename + Delete for a file', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />);
		expect(screen.getByText('Preview')).toBeTruthy();
		expect(screen.getByText('Open in Default App')).toBeTruthy();
		expect(screen.getByText('Copy Path')).toBeTruthy();
		expect(screen.getByText('Reveal in Finder')).toBeTruthy();
		expect(screen.getByText('Rename')).toBeTruthy();
		expect(screen.getByText('Delete')).toBeTruthy();
	});

	// Right-clicking a top-level file is the only way to create a sibling in the
	// workspace root when the root has no folder to right-click.
	it('offers New File and New Folder on a file, creating alongside it', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />);
		fireEvent.click(screen.getByText('New File'));
		expect(defaultProps.onOpenNewFile).toHaveBeenCalled();
		fireEvent.click(screen.getByText('New Folder'));
		expect(defaultProps.onOpenNewFolder).toHaveBeenCalled();
	});

	it('offers New File and New Folder on the empty-space root menu', () => {
		render(
			<FileTreeContextMenu {...defaultProps} contextMenu={{ x: 10, y: 20, node: null, path: '' }} />
		);
		fireEvent.click(screen.getByText('New File'));
		expect(defaultProps.onOpenNewFile).toHaveBeenCalled();
		expect(screen.getByText('New Folder')).toBeTruthy();
		// Root menu has no target row, so nothing to rename or delete.
		expect(screen.queryByText('Rename')).toBeNull();
	});

	it('shows New File + Preview all + Copy Path + Reveal + Rename + Delete for a folder', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(folderNode)} />);
		expect(screen.getByText('New File')).toBeTruthy();
		expect(screen.getByText('New Folder')).toBeTruthy();
		// Count is recursive (index.ts + utils/helpers.ts) and pluralized.
		expect(screen.getByText('Preview All 2 Files in Folder')).toBeTruthy();
		expect(screen.getByText('Copy Path')).toBeTruthy();
		expect(screen.queryByText('Preview')).toBeNull();
	});

	it('shows New Agent Here for a folder and fires the callback', () => {
		const onNewAgentHere = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				onNewAgentHere={onNewAgentHere}
				contextMenu={makeContextMenu(folderNode)}
			/>
		);
		fireEvent.click(screen.getByText('New Agent Here'));
		expect(onNewAgentHere).toHaveBeenCalledTimes(1);
	});

	it('hides New Agent Here for files and for the empty-space root menu', () => {
		const { unmount } = render(
			<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />
		);
		expect(screen.queryByText('New Agent Here')).toBeNull();
		unmount();

		render(
			<FileTreeContextMenu {...defaultProps} contextMenu={{ x: 1, y: 2, node: null, path: '' }} />
		);
		expect(screen.queryByText('New Agent Here')).toBeNull();
	});

	it('hides New Agent Here over SSH, where the folder path is remote', () => {
		render(
			<FileTreeContextMenu
				{...defaultProps}
				sshRemoteId="remote-1"
				contextMenu={makeContextMenu(folderNode)}
			/>
		);
		expect(screen.queryByText('New Agent Here')).toBeNull();
		// The rest of the folder menu is unaffected.
		expect(screen.getByText('New Folder')).toBeTruthy();
	});

	it('offers Compress on a folder, including one with nothing to preview', () => {
		const { unmount } = render(
			<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(folderNode)} />
		);
		fireEvent.click(screen.getByText('Compress'));
		expect(defaultProps.onCompressFolder).toHaveBeenCalled();
		unmount();

		// An empty folder still zips - there is just nothing inside the archive.
		render(
			<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(emptyFolderNode)} />
		);
		expect(screen.getByText('Compress')).toBeTruthy();
	});

	it('does not offer Compress on a file', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />);
		expect(screen.queryByText('Compress')).toBeNull();
	});

	it('pluralizes the preview-all label to singular for one previewable file', () => {
		const singleFileFolder: FileNode = {
			name: 'docs',
			type: 'folder',
			children: [{ name: 'readme.md', type: 'file' }],
		};
		render(
			<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(singleFileFolder)} />
		);
		expect(screen.getByText('Preview All 1 File in Folder')).toBeTruthy();
	});

	it('hides the preview-all option for a folder with no previewable files', () => {
		render(
			<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(emptyFolderNode)} />
		);
		expect(screen.getByText('New File')).toBeTruthy();
		expect(screen.queryByText(/Preview All .* in Folder/)).toBeNull();
	});

	it('shows "Open in Maestro Browser" for HTML files (local only)', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(htmlNode)} />);
		expect(screen.getByText('Open in Maestro Browser')).toBeTruthy();
	});

	it('hides "Open in Maestro Browser" when sshRemoteId is set', () => {
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(htmlNode)}
				sshRemoteId="remote-1"
			/>
		);
		expect(screen.queryByText('Open in Maestro Browser')).toBeNull();
	});

	it('shows "Document Graph" for markdown files when callback is provided', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(mdNode)} />);
		expect(screen.getByText('Document Graph')).toBeTruthy();
	});

	it('hides "Document Graph" when onFocusFileInGraph is undefined', () => {
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(mdNode)}
				onFocusFileInGraph={undefined}
			/>
		);
		expect(screen.queryByText('Document Graph')).toBeNull();
	});

	it('calls onCopyPath when Copy Path is clicked', () => {
		const onCopyPath = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				onCopyPath={onCopyPath}
			/>
		);
		fireEvent.click(screen.getByText('Copy Path'));
		expect(onCopyPath).toHaveBeenCalledTimes(1);
	});

	it('calls onCopyFileName when Copy File Name is clicked', () => {
		const onCopyFileName = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				onCopyFileName={onCopyFileName}
			/>
		);
		fireEvent.click(screen.getByText('Copy File Name'));
		expect(onCopyFileName).toHaveBeenCalledTimes(1);
	});

	it('calls onOpenDelete when Delete is clicked', () => {
		const onOpenDelete = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				onOpenDelete={onOpenDelete}
			/>
		);
		fireEvent.click(screen.getByText('Delete'));
		expect(onOpenDelete).toHaveBeenCalledTimes(1);
	});

	it('calls onPreviewFile when Preview is clicked', () => {
		const onPreviewFile = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				onPreviewFile={onPreviewFile}
			/>
		);
		fireEvent.click(screen.getByText('Preview'));
		expect(onPreviewFile).toHaveBeenCalledTimes(1);
	});

	it('renders batch actions for a multi-selection context', () => {
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				isMultiSelectionContext
				selectedCount={3}
			/>
		);
		expect(screen.getByText('Preview 3 items')).toBeTruthy();
		expect(screen.getByText('Open 3 in Default App')).toBeTruthy();
		expect(screen.getByText('Delete 3 items')).toBeTruthy();
		expect(screen.queryByText('Rename')).toBeNull();
		expect(screen.queryByText('Copy Path')).toBeNull();
	});

	it('calls onOpenDeleteMulti from the batch menu', () => {
		const onOpenDeleteMulti = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				isMultiSelectionContext
				selectedCount={2}
				onOpenDeleteMulti={onOpenDeleteMulti}
			/>
		);
		fireEvent.click(screen.getByText('Delete 2 items'));
		expect(onOpenDeleteMulti).toHaveBeenCalledTimes(1);
	});

	it('hides Reveal and Open in Default App when sshRemoteId is set', () => {
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				sshRemoteId="remote-1"
			/>
		);
		expect(screen.queryByText('Reveal in Finder')).toBeNull();
		expect(screen.queryByText('Open in Default App')).toBeNull();
	});

	it('shows Download File only for remote files and calls onDownloadFile', () => {
		// Local file: no Download File option (the file is already on disk).
		const { unmount } = render(
			<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />
		);
		expect(screen.queryByText('Download File')).toBeNull();
		unmount();

		// Remote file: Download File appears and is wired to the handler.
		const onDownloadFile = vi.fn();
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				sshRemoteId="remote-1"
				onDownloadFile={onDownloadFile}
			/>
		);
		const downloadBtn = screen.getByText('Download File');
		expect(downloadBtn).toBeTruthy();
		fireEvent.click(downloadBtn);
		expect(onDownloadFile).toHaveBeenCalledTimes(1);
	});

	it('hides Download File for remote folders', () => {
		render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(folderNode)}
				sshRemoteId="remote-1"
			/>
		);
		expect(screen.queryByText('Download File')).toBeNull();
	});

	it('renders reveal action when the preload bridge is missing', () => {
		(window as any).maestro = undefined;
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />);
		expect(screen.getByText('Reveal in Finder')).toBeTruthy();
	});

	describe('media actions', () => {
		it('says Play rather than Preview, since media never becomes a tab', () => {
			render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(mediaNode)} />);
			expect(screen.getByText('Play')).toBeTruthy();
			expect(screen.queryByText('Preview')).toBeNull();
			expect(screen.getByText('Add to Play Queue')).toBeTruthy();
		});

		it('offers no playback actions for an ordinary file', () => {
			render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />);
			expect(screen.queryByText('Add to Play Queue')).toBeNull();
		});

		it('hides playback over SSH, where there is nothing to stream', () => {
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(mediaNode)}
					sshRemoteId="remote-1"
				/>
			);
			expect(screen.getByText('Preview')).toBeTruthy();
			expect(screen.queryByText('Add to Play Queue')).toBeNull();
		});

		it('counts the media in a multi-selection', () => {
			const onQueueMedia = vi.fn();
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(mediaNode)}
					isMultiSelectionContext
					selectedCount={5}
					selectedMediaCount={3}
					onQueueMedia={onQueueMedia}
				/>
			);
			fireEvent.click(screen.getByText('Add 3 to Play Queue'));
			expect(onQueueMedia).toHaveBeenCalled();
		});

		it('leaves the multi menu alone when nothing selected is playable', () => {
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(fileNode)}
					isMultiSelectionContext
					selectedCount={5}
					selectedMediaCount={0}
				/>
			);
			expect(screen.queryByText(/Add \d+ to Play Queue/)).toBeNull();
		});
	});

	it('applies opacity 0 when contextMenuPos.ready is false', () => {
		const { container } = render(
			<FileTreeContextMenu
				{...defaultProps}
				contextMenu={makeContextMenu(fileNode)}
				contextMenuPos={{ top: 0, left: 0, ready: false }}
			/>
		);
		const menu = document.body.querySelector('.fixed') as HTMLElement;
		expect(menu.style.opacity).toBe('0');
	});

	describe('Auto Run staging', () => {
		it('offers staging when the folder holds Auto Run documents', () => {
			const onStageForAutoRun = vi.fn();
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(folderNode)}
					autoRunStagedCount={11}
					onStageForAutoRun={onStageForAutoRun}
				/>
			);

			fireEvent.click(screen.getByText('Stage 11 Documents for Auto Run'));
			expect(onStageForAutoRun).toHaveBeenCalled();
		});

		it('uses the singular label for one document', () => {
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(folderNode)}
					autoRunStagedCount={1}
				/>
			);

			expect(screen.getByText('Stage Document for Auto Run')).toBeInTheDocument();
		});

		it('hides staging for a folder with no Auto Run documents', () => {
			render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(folderNode)} />);

			expect(screen.queryByText(/Stage .*for Auto Run/)).not.toBeInTheDocument();
		});

		it('offers staging on a single Auto Run document file', () => {
			const onStageForAutoRun = vi.fn();
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(mdNode)}
					autoRunStagedCount={1}
					onStageForAutoRun={onStageForAutoRun}
				/>
			);

			fireEvent.click(screen.getByText('Stage Document for Auto Run'));
			expect(onStageForAutoRun).toHaveBeenCalled();
		});

		it('hides staging on a file outside the Auto Run folder', () => {
			render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(fileNode)} />);

			expect(screen.queryByText(/Stage .*for Auto Run/)).not.toBeInTheDocument();
		});

		it('offers staging for a multi-selection of Auto Run documents', () => {
			const onStageForAutoRun = vi.fn();
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(mdNode)}
					isMultiSelectionContext
					selectedCount={5}
					autoRunStagedCount={5}
					onStageForAutoRun={onStageForAutoRun}
				/>
			);

			fireEvent.click(screen.getByText('Stage 5 Documents for Auto Run'));
			expect(onStageForAutoRun).toHaveBeenCalled();
		});

		it('hides staging for a multi-selection outside the Auto Run folder', () => {
			render(
				<FileTreeContextMenu
					{...defaultProps}
					contextMenu={makeContextMenu(fileNode)}
					isMultiSelectionContext
					selectedCount={5}
				/>
			);

			expect(screen.queryByText(/Stage .*for Auto Run/)).not.toBeInTheDocument();
		});
	});
});
