import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	FileSearchModal,
	flattenPreviewableFiles,
} from '../../renderer/components/FileSearchModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';
import type { FileNode } from '../../renderer/types/fileTree';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const fileTree: FileNode[] = [
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
	{ name: 'empty-folder', type: 'folder' },
	{ name: 'package.json', type: 'file' },
	{ name: 'image.png', type: 'file' },
	{ name: 'Makefile', type: 'file' },
	{ name: '.env', type: 'file' },
	{ name: 'archive.zip', type: 'file' },
];

type FileSearchModalProps = ComponentProps<typeof FileSearchModal>;

function createProps(overrides: Partial<FileSearchModalProps> = {}): FileSearchModalProps {
	return {
		theme,
		fileTree,
		expandedFolders: ['src'],
		shortcut: { id: 'fuzzyFileSearch', label: 'Fuzzy File Search', keys: ['Meta', 'G'] },
		onFileSelect: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
}

function renderModal(overrides: Partial<FileSearchModalProps> = {}) {
	const props = createProps(overrides);
	const result = render(
		<LayerStackProvider>
			<FileSearchModal {...props} />
		</LayerStackProvider>
	);

	return { ...result, props };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

describe('FileSearchModal integration', () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.useRealTimers();
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	it('flattens previewable files while respecting expanded folder visibility', () => {
		const allFiles = flattenPreviewableFiles(fileTree);
		expect(allFiles.map((file) => file.fullPath)).toEqual([
			'src/components/App.tsx',
			'src/components/Modal.tsx',
			'src/utils/helpers.ts',
			'src/index.ts',
			'docs/README.md',
			'docs/guide.pdf',
			'package.json',
			'image.png',
			'Makefile',
			'.env',
		]);
		expect(allFiles.find((file) => file.fullPath === 'src/components/App.tsx')?.depth).toBe(2);
		expect(allFiles.find((file) => file.fullPath === 'src/index.ts')?.depth).toBe(1);
		expect(allFiles.find((file) => file.fullPath === 'package.json')?.depth).toBe(0);

		const visibleFiles = flattenPreviewableFiles(fileTree, '', 0, new Set(['src']));
		expect(visibleFiles.map((file) => file.fullPath)).toEqual([
			'src/index.ts',
			'package.json',
			'image.png',
			'Makefile',
			'.env',
		]);

		const expandedNested = flattenPreviewableFiles(
			fileTree,
			'',
			0,
			new Set(['src', 'src/components', 'docs'])
		);
		expect(expandedNested.map((file) => file.fullPath)).toContain('src/components/App.tsx');
		expect(expandedNested.map((file) => file.fullPath)).toContain('docs/guide.pdf');
		expect(expandedNested.map((file) => file.fullPath)).not.toContain('src/utils/helpers.ts');

		expect(
			flattenPreviewableFiles([
				{ name: '.', type: 'file' },
				{ name: '', type: 'file' },
				{ name: 'program.exe', type: 'file' },
				{ name: 'diagram.svg', type: 'file' },
			]).map((file) => file.fullPath)
		).toEqual(['.', 'diagram.svg']);
	});

	it('switches between visible and all files, filters fuzzy results, and renders empty states', async () => {
		renderModal();

		expect(screen.getByRole('dialog', { name: 'Fuzzy File Search' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Visible Files (5)' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'All Files (10)' })).toBeInTheDocument();
		expect(await screen.findByText('index.ts')).toBeInTheDocument();
		expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'All Files (10)' }));

		expect(screen.getByText('App.tsx')).toBeInTheDocument();
		expect(screen.getByText('guide.pdf')).toBeInTheDocument();
		expect(screen.queryByText('archive.zip')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Visible Files (5)' }));
		expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'All Files (10)' }));

		fireEvent.change(screen.getByPlaceholderText('Search files...'), {
			target: { value: 'cmpapp' },
		});
		expect(screen.getByText('App.tsx')).toBeInTheDocument();
		expect(screen.getByText('src/components')).toBeInTheDocument();
		expect(screen.queryByText('helpers.ts')).not.toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search files...'), {
			target: { value: 'readme' },
		});
		expect(screen.getByText('README.md')).toBeInTheDocument();
		expect(screen.getByText('docs')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search files...'), {
			target: { value: 'no-match' },
		});
		expect(screen.getByText('No files match your search')).toBeInTheDocument();

		cleanup();
		renderModal({
			fileTree: [
				{ name: 'binary.exe', type: 'file' },
				{ name: 'archive.zip', type: 'file' },
			],
			expandedFolders: undefined,
		});
		expect(screen.getByText('No files to search')).toBeInTheDocument();
		expect(screen.getByText('0 files')).toBeInTheDocument();

		cleanup();
		renderModal({ expandedFolders: undefined, shortcut: undefined });
		expect(screen.getByRole('button', { name: 'Visible Files (10)' })).toBeInTheDocument();
		expect(await screen.findByText('helpers.ts')).toBeInTheDocument();
	});

	it('selects files through click, keyboard navigation, tab mode switching, and visible number shortcuts', async () => {
		const { props } = renderModal();

		fireEvent.click(await screen.findByRole('button', { name: /package\.json/ }));
		expect(props.onFileSelect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'package.json', fullPath: 'package.json' })
		);
		expect(props.onClose).toHaveBeenCalledOnce();

		cleanup();
		const keyboard = renderModal();
		const keyboardInput = screen.getByPlaceholderText('Search files...');
		expect(screen.queryByText('helpers.ts')).not.toBeInTheDocument();
		fireEvent.keyDown(keyboardInput, { key: 'Tab' });
		expect(await screen.findByText('helpers.ts')).toBeInTheDocument();
		fireEvent.keyDown(keyboardInput, { key: 'Tab' });
		expect(screen.queryByText('helpers.ts')).not.toBeInTheDocument();
		fireEvent.keyDown(keyboardInput, { key: 'Tab' });
		fireEvent.change(keyboardInput, { target: { value: 'ts' } });
		fireEvent.keyDown(keyboardInput, { key: 'ArrowDown' });
		fireEvent.keyDown(keyboardInput, { key: 'ArrowUp' });
		fireEvent.keyDown(keyboardInput, { key: 'ArrowDown' });
		fireEvent.keyDown(keyboardInput, { key: 'Enter' });
		expect(keyboard.props.onFileSelect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'index.ts', fullPath: 'src/index.ts' })
		);
		expect(keyboard.props.onClose).toHaveBeenCalledOnce();

		cleanup();
		const numberedTree = Array.from({ length: 12 }, (_, index): FileNode => {
			const padded = String(index).padStart(2, '0');
			return { name: `file-${padded}.md`, type: 'file' };
		});
		const numbered = renderModal({
			fileTree: numberedTree,
			expandedFolders: undefined,
			shortcut: undefined,
		});
		const scrollContainer = numbered.container.querySelector('.overflow-y-auto') as HTMLElement;
		const numberedInput = screen.getByPlaceholderText('Search files...');
		scrollContainer.scrollTop = 80;
		fireEvent.scroll(scrollContainer);
		fireEvent.keyDown(numberedInput, { key: '1', metaKey: true });
		expect(numbered.props.onFileSelect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'file-02.md', fullPath: 'file-02.md' })
		);

		cleanup();
		const ignored = renderModal();
		const ignoredInput = screen.getByPlaceholderText('Search files...');
		fireEvent.keyDown(ignoredInput, { key: 'x' });
		fireEvent.keyDown(ignoredInput, { key: '0', metaKey: true });
		fireEvent.change(ignoredInput, { target: { value: 'no-match' } });
		fireEvent.keyDown(ignoredInput, { key: 'Enter' });
		expect(ignored.props.onFileSelect).not.toHaveBeenCalled();
		expect(ignored.props.onClose).not.toHaveBeenCalled();
	});

	it('focuses the search field, keeps Escape wired to the latest close callback, and cleans up the layer', async () => {
		const firstClose = vi.fn();
		const latestClose = vi.fn();
		const props = createProps({ onClose: firstClose });
		const { rerender, unmount } = render(
			<LayerStackProvider>
				<FileSearchModal {...props} />
			</LayerStackProvider>
		);

		const input = screen.getByPlaceholderText('Search files...');
		await waitFor(() => expect(document.activeElement).toBe(input));

		rerender(
			<LayerStackProvider>
				<FileSearchModal {...props} onClose={latestClose} />
			</LayerStackProvider>
		);

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(latestClose).toHaveBeenCalledOnce());
		expect(firstClose).not.toHaveBeenCalled();

		unmount();
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
	});
});
