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
	onPreviewFile: vi.fn(),
	onPreviewAllInFolder: vi.fn(),
	onPreviewMulti: vi.fn(),
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

	it('shows New File + Preview all + Copy Path + Reveal + Rename + Delete for a folder', () => {
		render(<FileTreeContextMenu {...defaultProps} contextMenu={makeContextMenu(folderNode)} />);
		expect(screen.getByText('New File')).toBeTruthy();
		expect(screen.getByText('New Folder')).toBeTruthy();
		// Count is recursive (index.ts + utils/helpers.ts) and pluralized.
		expect(screen.getByText('Preview All 2 Files in Folder')).toBeTruthy();
		expect(screen.getByText('Copy Path')).toBeTruthy();
		expect(screen.queryByText('Preview')).toBeNull();
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
});
