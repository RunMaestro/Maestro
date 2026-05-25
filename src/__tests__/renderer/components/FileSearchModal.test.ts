/**
 * @file FileSearchModal.test.ts
 * @description Tests for FileSearchModal helper logic and user-visible modal behavior
 *
 * Covers the visible-files-vs-all-files filtering logic:
 * - Full flattening (no expandedSet) returns all previewable files
 * - Expanded set filtering only returns files in expanded folders
 * - Non-previewable files are excluded in both modes
 * - Nested folder expansion requires all ancestor folders to be expanded
 * - Modal search, keyboard selection, and layer-stack Escape behavior work
 */

import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	FileSearchModal,
	flattenPreviewableFiles,
} from '../../../renderer/components/FileSearchModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';

// Reusable test tree:
// src/
//   components/
//     App.tsx
//     Modal.tsx
//   utils/
//     helpers.ts
//   index.ts
// docs/
//   README.md
// package.json
// image.png
// binary.exe  (not previewable)
const testTree: FileNode[] = [
	{
		name: 'src',
		type: 'folder',
		children: [
			{
				name: 'components',
				type: 'folder',
				children: [
					{ name: 'App.tsx', type: 'file' },
					{ name: 'Modal.tsx', type: 'file' },
				],
			},
			{
				name: 'utils',
				type: 'folder',
				children: [{ name: 'helpers.ts', type: 'file' }],
			},
			{ name: 'index.ts', type: 'file' },
		],
	},
	{
		name: 'docs',
		type: 'folder',
		children: [{ name: 'README.md', type: 'file' }],
	},
	{ name: 'package.json', type: 'file' },
	{ name: 'image.png', type: 'file' },
	{ name: 'binary.exe', type: 'file' },
];

const interactiveTree: FileNode[] = [
	{
		name: 'src',
		type: 'folder',
		children: [
			{
				name: 'components',
				type: 'folder',
				children: [
					{ name: 'App.tsx', type: 'file' },
					{ name: 'Modal.tsx', type: 'file' },
				],
			},
			{
				name: 'utils',
				type: 'folder',
				children: [{ name: 'helpers.ts', type: 'file' }],
			},
			{ name: 'index.ts', type: 'file' },
		],
	},
	{
		name: 'docs',
		type: 'folder',
		children: [
			{ name: 'README.md', type: 'file' },
			{ name: 'guide.pdf', type: 'file' },
		],
	},
	{ name: 'package.json', type: 'file' },
	{ name: 'image.png', type: 'file' },
	{ name: 'Makefile', type: 'file' },
	{ name: '.env', type: 'file' },
	{ name: 'archive.zip', type: 'file' },
];

const mockTheme: Theme = {
	id: 'custom',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		border: '#303030',
		textMain: '#f8f8f8',
		textDim: '#a0a0a0',
		accent: '#4f8cff',
		accentDim: '#4f8cff33',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#3fb950',
		warning: '#d29922',
		error: '#f85149',
	},
};

type FileSearchModalProps = React.ComponentProps<typeof FileSearchModal>;

const makeProps = (overrides: Partial<FileSearchModalProps> = {}): FileSearchModalProps => ({
	theme: mockTheme,
	fileTree: interactiveTree,
	expandedFolders: ['src'],
	shortcut: { id: 'file-search', label: 'File Search', keys: ['Meta', 'P'] },
	onFileSelect: vi.fn(),
	onClose: vi.fn(),
	...overrides,
});

const renderModal = (overrides: Partial<FileSearchModalProps> = {}) => {
	const props = makeProps(overrides);
	const result = render(
		React.createElement(LayerStackProvider, null, React.createElement(FileSearchModal, props))
	);

	return { ...result, props };
};

afterEach(() => {
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe('flattenPreviewableFiles', () => {
	it('returns all previewable files when no expandedSet is provided', () => {
		const result = flattenPreviewableFiles(testTree);
		const paths = result.map((f) => f.fullPath);

		expect(paths).toContain('src/components/App.tsx');
		expect(paths).toContain('src/components/Modal.tsx');
		expect(paths).toContain('src/utils/helpers.ts');
		expect(paths).toContain('src/index.ts');
		expect(paths).toContain('docs/README.md');
		expect(paths).toContain('package.json');
		expect(paths).toContain('image.png');
		// binary.exe is not previewable
		expect(paths).not.toContain('binary.exe');
		expect(result).toHaveLength(7);
	});

	it('excludes non-previewable files', () => {
		const tree: FileNode[] = [
			{ name: 'readme.md', type: 'file' },
			{ name: 'program.exe', type: 'file' },
			{ name: 'data.bin', type: 'file' },
			{ name: 'archive.tar.gz', type: 'file' },
		];
		const result = flattenPreviewableFiles(tree);
		expect(result).toHaveLength(1);
		expect(result[0].fullPath).toBe('readme.md');
	});

	it('returns only files in expanded folders when expandedSet is provided', () => {
		// Only src is expanded (not its subfolders)
		const expandedSet = new Set(['src']);
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const paths = result.map((f) => f.fullPath);

		// src/index.ts is directly in src (expanded)
		expect(paths).toContain('src/index.ts');
		// src/components/ and src/utils/ are not expanded, so their children are excluded
		expect(paths).not.toContain('src/components/App.tsx');
		expect(paths).not.toContain('src/utils/helpers.ts');
		// docs/ is not expanded
		expect(paths).not.toContain('docs/README.md');
		// Root-level files are always included (not inside any folder)
		expect(paths).toContain('package.json');
		expect(paths).toContain('image.png');
	});

	it('includes nested files when all ancestor folders are expanded', () => {
		const expandedSet = new Set(['src', 'src/components']);
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const paths = result.map((f) => f.fullPath);

		expect(paths).toContain('src/index.ts');
		expect(paths).toContain('src/components/App.tsx');
		expect(paths).toContain('src/components/Modal.tsx');
		// src/utils is not expanded
		expect(paths).not.toContain('src/utils/helpers.ts');
		// docs/ is not expanded
		expect(paths).not.toContain('docs/README.md');
	});

	it('returns only root-level files when expandedSet is empty', () => {
		const expandedSet = new Set<string>();
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const paths = result.map((f) => f.fullPath);

		// Only root-level previewable files
		expect(paths).toEqual(['package.json', 'image.png']);
	});

	it('returns all files when every folder is expanded', () => {
		const expandedSet = new Set(['src', 'src/components', 'src/utils', 'docs']);
		const result = flattenPreviewableFiles(testTree, '', 0, expandedSet);
		const noExpand = flattenPreviewableFiles(testTree);

		// Should match the no-expandedSet result
		expect(result.length).toBe(noExpand.length);
		expect(result.map((f) => f.fullPath).sort()).toEqual(noExpand.map((f) => f.fullPath).sort());
	});

	it('sets correct depth values', () => {
		const result = flattenPreviewableFiles(testTree);
		const appFile = result.find((f) => f.fullPath === 'src/components/App.tsx');
		const indexFile = result.find((f) => f.fullPath === 'src/index.ts');
		const rootFile = result.find((f) => f.fullPath === 'package.json');

		expect(rootFile?.depth).toBe(0);
		expect(indexFile?.depth).toBe(1);
		expect(appFile?.depth).toBe(2);
	});

	it('includes special text filenames, dotfiles, images, and externally-openable files', () => {
		const result = flattenPreviewableFiles([
			{ name: 'Makefile', type: 'file' },
			{ name: '.env', type: 'file' },
			{ name: 'diagram.svg', type: 'file' },
			{ name: 'report.pdf', type: 'file' },
			{ name: 'archive.zip', type: 'file' },
		]);

		expect(result.map((file) => file.fullPath)).toEqual([
			'Makefile',
			'.env',
			'diagram.svg',
			'report.pdf',
		]);
	});

	it('keeps malformed empty filenames out while accepting extensionless dotfiles', () => {
		const result = flattenPreviewableFiles([
			{ name: '.', type: 'file' },
			{ name: '', type: 'file' },
			{ name: 'README', type: 'file' },
		]);

		expect(result.map((file) => file.fullPath)).toEqual(['.']);
	});
});

describe('FileSearchModal', () => {
	it('focuses the search input shortly after mounting', () => {
		vi.useFakeTimers();
		renderModal();

		const input = screen.getByPlaceholderText('Search files...');

		act(() => {
			vi.advanceTimersByTime(50);
		});

		expect(document.activeElement).toBe(input);
	});

	it('renders extensionless dotfiles from malformed trees as selectable files', () => {
		renderModal({
			fileTree: [
				{ name: '.', type: 'file' },
				{ name: '', type: 'file' },
			],
			expandedFolders: undefined,
			shortcut: undefined,
		});

		expect(screen.getByText('.')).toBeInTheDocument();
		expect(screen.getByText('1 files')).toBeInTheDocument();
	});

	it('shows expanded visible files by default and can switch to all files', () => {
		renderModal();

		expect(screen.getByRole('dialog', { name: 'Fuzzy File Search' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Visible Files (5)' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'All Files (10)' })).toBeInTheDocument();
		expect(screen.getByText('index.ts')).toBeInTheDocument();
		expect(screen.getByText('src')).toBeInTheDocument();
		expect(screen.getByText('package.json')).toBeInTheDocument();
		expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'All Files (10)' }));

		expect(screen.getByText('App.tsx')).toBeInTheDocument();
		expect(screen.getAllByText('src/components')).toHaveLength(2);
		expect(screen.getByText('guide.pdf')).toBeInTheDocument();
		expect(screen.queryByText('archive.zip')).not.toBeInTheDocument();
	});

	it('can switch from all files back to visible files with the mode buttons', () => {
		renderModal();

		fireEvent.click(screen.getByRole('button', { name: 'All Files (10)' }));
		expect(screen.getByText('App.tsx')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Visible Files (5)' }));

		expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();
		expect(screen.getByText('index.ts')).toBeInTheDocument();
	});

	it('uses all files as visible files when expanded folders are not provided', () => {
		renderModal({ expandedFolders: undefined });

		expect(screen.getByRole('button', { name: 'Visible Files (10)' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'All Files (10)' })).toBeInTheDocument();
		expect(screen.getByText('helpers.ts')).toBeInTheDocument();
		expect(screen.getByText('src/utils')).toBeInTheDocument();
	});

	it('filters files with fuzzy matching across names and paths', () => {
		renderModal({ expandedFolders: undefined });

		const input = screen.getByPlaceholderText('Search files...');
		fireEvent.change(input, { target: { value: 'cmpapp' } });

		expect(screen.getByText('App.tsx')).toBeInTheDocument();
		expect(screen.getByText('src/components')).toBeInTheDocument();
		expect(screen.queryByText('helpers.ts')).not.toBeInTheDocument();

		fireEvent.change(input, { target: { value: '' } });
		fireEvent.change(input, { target: { value: 'zzzz' } });

		expect(screen.getByText('No files match your search')).toBeInTheDocument();
		expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();
	});

	it('renders the no-files empty state when the tree has no previewable files', () => {
		renderModal({
			fileTree: [
				{ name: 'binary.exe', type: 'file' },
				{ name: 'archive.zip', type: 'file' },
			],
			expandedFolders: undefined,
		});

		expect(screen.getByText('No files to search')).toBeInTheDocument();
		expect(screen.getByText('0 files')).toBeInTheDocument();
	});

	it('selects a file by click and closes the modal', () => {
		const { props } = renderModal();

		fireEvent.click(screen.getByRole('button', { name: /package\.json/ }));

		expect(props.onFileSelect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'package.json', fullPath: 'package.json' })
		);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('selects the highlighted search result with arrow keys and Enter', () => {
		const { props } = renderModal({ expandedFolders: undefined });
		const input = screen.getByPlaceholderText('Search files...');

		fireEvent.change(input, { target: { value: 'ts' } });
		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(props.onFileSelect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'index.ts', fullPath: 'src/index.ts' })
		);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('moves the highlighted item back up with ArrowUp before selecting', () => {
		const { props } = renderModal({ expandedFolders: undefined });
		const input = screen.getByPlaceholderText('Search files...');
		const sortedAllFiles = [...flattenPreviewableFiles(interactiveTree)].sort((a, b) =>
			a.fullPath.localeCompare(b.fullPath)
		);

		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(input, { key: 'ArrowUp' });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(props.onFileSelect).toHaveBeenCalledWith(sortedAllFiles[0]);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('switches view modes with Tab and uses Meta number shortcuts for quick selection', () => {
		const { props } = renderModal();
		const input = screen.getByPlaceholderText('Search files...');
		const sortedAllFiles = [...flattenPreviewableFiles(interactiveTree)].sort((a, b) =>
			a.fullPath.localeCompare(b.fullPath)
		);

		fireEvent.keyDown(input, { key: 'Tab' });
		expect(screen.getByText('helpers.ts')).toBeInTheDocument();

		fireEvent.keyDown(input, { key: '0', metaKey: true });

		expect(props.onFileSelect).toHaveBeenCalledWith(sortedAllFiles[9]);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('switches back to visible files when Tab is pressed from all-files mode', () => {
		renderModal();
		const input = screen.getByPlaceholderText('Search files...');

		fireEvent.keyDown(input, { key: 'Tab' });
		expect(screen.getByText('helpers.ts')).toBeInTheDocument();

		fireEvent.keyDown(input, { key: 'Tab' });

		expect(screen.queryByText('helpers.ts')).not.toBeInTheDocument();
		expect(screen.getByText('index.ts')).toBeInTheDocument();
	});

	it('uses scroll position when resolving Meta number shortcuts', () => {
		const fileTree = Array.from({ length: 12 }, (_, index): FileNode => {
			const padded = String(index).padStart(2, '0');
			return { name: `file-${padded}.md`, type: 'file' };
		});
		const { container, props } = renderModal({
			fileTree,
			expandedFolders: undefined,
			shortcut: undefined,
		});
		const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
		const input = screen.getByPlaceholderText('Search files...');

		scrollContainer.scrollTop = 80;
		fireEvent.scroll(scrollContainer);
		fireEvent.keyDown(input, { key: '1', metaKey: true });

		expect(props.onFileSelect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'file-02.md', fullPath: 'file-02.md' })
		);
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('ignores keyboard commands that cannot resolve to a file', () => {
		const { props } = renderModal();
		const input = screen.getByPlaceholderText('Search files...');

		fireEvent.keyDown(input, { key: 'x' });
		fireEvent.keyDown(input, { key: '0', metaKey: true });
		fireEvent.change(input, { target: { value: 'no-match' } });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(props.onFileSelect).not.toHaveBeenCalled();
		expect(props.onClose).not.toHaveBeenCalled();
	});

	it('closes via the latest Escape handler registered in the layer stack', async () => {
		const initialClose = vi.fn();
		const latestClose = vi.fn();
		const props = makeProps({ onClose: initialClose });
		const { rerender } = render(
			React.createElement(LayerStackProvider, null, React.createElement(FileSearchModal, props))
		);

		rerender(
			React.createElement(
				LayerStackProvider,
				null,
				React.createElement(FileSearchModal, { ...props, onClose: latestClose })
			)
		);

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(latestClose).toHaveBeenCalledOnce());
		expect(initialClose).not.toHaveBeenCalled();
	});
});
