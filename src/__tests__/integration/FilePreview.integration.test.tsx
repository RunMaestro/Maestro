import React, { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { FilePreview } from '../../renderer/components/FilePreview';
import {
	IMAGE_CACHE_TTL,
	imageCache,
} from '../../renderer/components/FilePreview/filePreviewUtils';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useCenterFlashStore } from '../../renderer/stores/centerFlashStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { getEncoder } from '../../renderer/utils/tokenCounter';
import { safeClipboardWrite, safeClipboardWriteImage } from '../../renderer/utils/clipboard';

const clipboardMocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
	safeClipboardWriteImage: vi.fn(),
}));

vi.mock('../../renderer/utils/clipboard', () => clipboardMocks);

vi.mock('../../renderer/utils/tokenCounter', () => ({
	getEncoder: vi.fn(),
	formatTokenCount: vi.fn((count: number) => `${count} tokens`),
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

const theme = {
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgActivity: '#181b20',
		bgSidebar: '#20242b',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		border: '#3f3f46',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const shortcuts = {
	toggleMarkdownMode: { keys: ['Meta', 'e'] },
	fuzzyFileSearch: { keys: ['Meta', 'p'] },
};

const originalClipboardItem = globalThis.ClipboardItem;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalScrollTo = Element.prototype.scrollTo;
const originalRangeGetBoundingClientRect = Range.prototype.getBoundingClientRect;
const originalRangeGetClientRects = Range.prototype.getClientRects;

function renderPreview(
	props: Partial<React.ComponentProps<typeof FilePreview>> = {},
	options: { initialEditMode?: boolean; uncontrolledEdit?: boolean } = {}
) {
	const file =
		'file' in props
			? props.file
			: {
					name: 'plan.md',
					path: '/repo/docs/plan.md',
					content: '# Plan\n\nShip the integration coverage tranche.',
				};

	function Harness() {
		const [markdownEditMode, setMarkdownEditMode] = useState(Boolean(options.initialEditMode));
		const [editContent, setEditContent] = useState(file?.content ?? '');
		const [previewTierOverride, setPreviewTierOverride] = useState<
			React.ComponentProps<typeof FilePreview>['previewTierOverride']
		>(props.previewTierOverride);

		return (
			<LayerStackProvider>
				<FilePreview
					file={file}
					onClose={vi.fn()}
					theme={theme}
					markdownEditMode={markdownEditMode}
					setMarkdownEditMode={setMarkdownEditMode}
					shortcuts={shortcuts}
					previewTierOverride={previewTierOverride}
					onPreviewTierChange={setPreviewTierOverride}
					{...(options.uncontrolledEdit
						? {}
						: {
								externalEditContent: editContent,
								onEditContentChange: setEditContent,
							})}
					isTabMode
					{...props}
				/>
			</LayerStackProvider>
		);
	}

	return render(<Harness />);
}

function getByExactTextContent(text: string) {
	return screen.getByText((_content, node) => node?.textContent === text);
}

async function flushPendingPromises() {
	await act(async () => {
		await Promise.resolve();
	});
}

function getEditorView(): EditorView {
	const editor = document.querySelector('.cm-editor');
	const view = editor ? EditorView.findFromDOM(editor as HTMLElement) : null;
	if (!view) {
		throw new Error('CodeMirror editor view was not mounted');
	}
	return view;
}

function setEditorContent(content: string) {
	const view = getEditorView();
	act(() => {
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: content },
		});
	});
}

function clearExpiredImageCacheForTesting(now: number) {
	for (const [key, value] of imageCache.entries()) {
		if (now - value.loadedAt > IMAGE_CACHE_TTL) {
			imageCache.delete(key);
		}
	}
}

describe('FilePreview integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getEncoder).mockResolvedValue({
			encode: vi.fn(() => [1, 2, 3, 4]),
		} as any);
		vi.mocked(safeClipboardWrite).mockResolvedValue(true);
		vi.mocked(safeClipboardWriteImage).mockResolvedValue(true);
		globalThis.ClipboardItem = class TestClipboardItem {
			constructor(public readonly items: Record<string, Blob>) {}
		} as unknown as typeof ClipboardItem;
		Element.prototype.scrollIntoView = vi.fn();
		Range.prototype.getBoundingClientRect = vi.fn(
			() =>
				({
					x: 0,
					y: 0,
					width: 0,
					height: 0,
					top: 0,
					right: 0,
					bottom: 0,
					left: 0,
					toJSON: () => ({}),
				}) as DOMRect
		);
		Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 2048,
			createdAt: '2026-05-01T10:00:00.000Z',
			modifiedAt: '2026-05-02T11:30:00.000Z',
		});
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('data:image/png;base64,local-diagram');
		useSettingsStore.setState({
			bionifyReadingMode: false,
			bionifyIntensity: 1,
			bionifyAlgorithm: '- 0 1 1 2 0.4',
			spellCheck: false,
		});
		useCenterFlashStore.getState().setActive(null);
		useNotificationStore.getState().clearToasts();
		clearExpiredImageCacheForTesting(Number.MAX_SAFE_INTEGER);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		if (originalClipboardItem) {
			globalThis.ClipboardItem = originalClipboardItem;
		} else {
			delete (globalThis as Partial<typeof globalThis>).ClipboardItem;
		}
		if (originalScrollIntoView) {
			Element.prototype.scrollIntoView = originalScrollIntoView;
		}
		if (originalScrollTo) {
			Element.prototype.scrollTo = originalScrollTo;
		} else {
			delete (Element.prototype as Partial<typeof Element.prototype>).scrollTo;
		}
		if (originalRangeGetBoundingClientRect) {
			Range.prototype.getBoundingClientRect = originalRangeGetBoundingClientRect;
		} else {
			delete (Range.prototype as Partial<typeof Range.prototype>).getBoundingClientRect;
		}
		if (originalRangeGetClientRects) {
			Range.prototype.getClientRects = originalRangeGetClientRects;
		} else {
			delete (Range.prototype as Partial<typeof Range.prototype>).getClientRects;
		}
		vi.restoreAllMocks();
	});

	it('renders markdown preview metadata and routes toolbar/link actions through IPC boundaries', async () => {
		const onFileClick = vi.fn();
		const onOpenInGraph = vi.fn();
		const onPublishGist = vi.fn();
		const file = {
			name: 'plan.md',
			path: '/repo/docs/plan.md',
			content: [
				'# Release Plan',
				'Read the [local notes](./notes.md), [disk note](file:///repo/docs/disk.md), and [public guide](https://example.com/guide).',
				'- [x] Draft integration tests',
				'- [ ] Run coverage',
				'- [ ] Send terse email',
				'![Local diagram](./images/flow.png)',
				'![Remote logo](https://example.com/remote.png)',
			].join('\n\n'),
		};

		renderPreview({
			file,
			onFileClick,
			onOpenInGraph,
			onPublishGist,
			ghCliAvailable: true,
		});

		expect(screen.getByText('plan.md')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Release Plan' })).toBeInTheDocument();

		await waitFor(() => expect(screen.getByText('2.0 KB')).toBeInTheDocument());
		expect(screen.getByText('4 tokens')).toBeInTheDocument();
		expect(getByExactTextContent('Tasks: 1 of 3')).toBeInTheDocument();
		await waitFor(() =>
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/repo/docs/images/flow.png',
				undefined
			)
		);
		expect(await screen.findByAltText('Local diagram')).toHaveAttribute(
			'src',
			'data:image/png;base64,local-diagram'
		);
		expect(screen.getByText('Remote image blocked')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('link', { name: 'local notes' }));
		expect(onFileClick).toHaveBeenCalledWith('./notes.md', { openInNewTab: false });

		fireEvent.click(screen.getByRole('link', { name: 'disk note' }));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/repo/docs/disk.md');

		fireEvent.click(screen.getByRole('link', { name: 'public guide' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/guide');

		fireEvent.click(screen.getByRole('button', { name: 'Show remote images' }));
		await waitFor(() =>
			expect(screen.getByAltText('Remote logo')).toHaveAttribute(
				'src',
				'https://example.com/remote.png'
			)
		);

		fireEvent.click(screen.getByRole('button', { name: 'Publish as GitHub Gist' }));
		expect(onPublishGist).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole('button', { name: 'View in Document Graph' }));
		expect(onOpenInGraph).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole('button', { name: 'Open in Default App' }));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/repo/docs/plan.md');

		fireEvent.click(screen.getByRole('button', { name: 'Copy full path to clipboard' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('/repo/docs/plan.md'));
		expect(useCenterFlashStore.getState().active?.message).toBe('File Path Copied');

		fireEvent.click(screen.getByRole('button', { name: 'Copy content to clipboard' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith(file.content));
		expect(useCenterFlashStore.getState().active?.message).toBe('Content Copied');
		cleanup();

		renderPreview({
			file,
			onPublishGist,
			ghCliAvailable: true,
			hasGist: true,
		});
		fireEvent.click(await screen.findByRole('button', { name: 'View published gist' }));
		expect(onPublishGist).toHaveBeenCalledTimes(2);
	});

	it('renders loaded markdown images and local image failure states', async () => {
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 0,
			createdAt: '2026-05-01T10:00:00.000Z',
			modifiedAt: '2026-05-02T11:30:00.000Z',
		});
		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (filePath) => {
			if (filePath === '/repo/docs/inline.png') return 'data:image/png;base64,aW5saW5l';
			if (filePath === '/repo/docs/bad.png') return 'plain text';
			if (filePath === '/repo/docs/missing.png') throw new Error('missing image');
			return 'data:image/png;base64,local-diagram';
		});
		const file = {
			name: 'images.md',
			path: '/repo/docs/images.md',
			content: [
				'# Images',
				'![Absolute](/repo/docs/absolute.png)',
				'![Bare](bare.png)',
				'![Inline](./inline.png)',
				'![Data URL](data:image/png;base64,ZGF0YQ==)',
				'![Bad](./bad.png)',
				'![Missing](./missing.png)',
				'<img alt="No source">',
			].join('\n\n'),
		};

		renderPreview({ file });

		await waitFor(() => expect(screen.getByText('0 B')).toBeInTheDocument());
		const inline = await screen.findByAltText('Inline');
		expect(inline).toHaveAttribute('src', 'data:image/png;base64,aW5saW5l');
		expect(await screen.findByAltText('Data URL')).toHaveAttribute(
			'src',
			'data:image/png;base64,ZGF0YQ=='
		);
		fireEvent.load(screen.getByAltText('Data URL'));
		clearExpiredImageCacheForTesting(Date.now());
		Object.defineProperty(inline, 'naturalWidth', { value: 320, configurable: true });
		Object.defineProperty(inline, 'naturalHeight', { value: 180, configurable: true });
		clearExpiredImageCacheForTesting(Number.MAX_SAFE_INTEGER);
		fireEvent.load(inline);
		clearExpiredImageCacheForTesting(Date.now());

		await waitFor(() => expect(screen.getByText('Invalid image data')).toBeInTheDocument());
		expect(screen.getByText('Failed to load image: missing image')).toBeInTheDocument();
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/docs/inline.png', undefined);
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/docs/bare.png', undefined);
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/docs/absolute.png', undefined);
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/docs/bad.png', undefined);
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/docs/missing.png', undefined);
	});

	it('saves edited text content from the controlled tab state', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const file = {
			name: 'notes.txt',
			path: '/repo/docs/notes.txt',
			content: 'alpha\nbeta',
		};

		renderPreview({ file, onSave }, { initialEditMode: true });

		expect(getEditorView().state.doc.toString()).toBe('alpha\nbeta');
		setEditorContent('alpha\nbeta\ngamma');

		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith('/repo/docs/notes.txt', 'alpha\nbeta\ngamma')
		);
		expect(useCenterFlashStore.getState().active?.message).toBe('File Saved');
	});

	it('handles editor keyboard save and search shortcuts', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const file = {
			name: 'draft.md',
			path: '/repo/docs/draft.md',
			content: ['line one', 'line two', 'line three', 'line four'].join('\n'),
		};

		const { container } = renderPreview({ file, onSave }, { initialEditMode: true });
		const editor = screen.getByRole('textbox');

		setEditorContent(`${file.content}\nline five`);
		await waitFor(() =>
			expect(getEditorView().state.doc.toString()).toBe(`${file.content}\nline five`)
		);
		fireEvent.keyDown(editor, { key: 's', metaKey: true });
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith('/repo/docs/draft.md', `${file.content}\nline five`)
		);
		setEditorContent(`${file.content}\nline five\nline six`);
		await waitFor(() =>
			expect(getEditorView().state.doc.toString()).toBe(`${file.content}\nline five\nline six`)
		);
		fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith(
				'/repo/docs/draft.md',
				`${file.content}\nline five\nline six`
			)
		);

		fireEvent.keyDown(container.firstElementChild!, { key: 'f', metaKey: true });
		const searchInput = await screen.findByPlaceholderText(/Search in file/);
		fireEvent.change(searchInput, { target: { value: 'line' } });
		await waitFor(() => expect(screen.getByText('1/6')).toBeInTheDocument());
		fireEvent.keyDown(searchInput, { key: 'Enter' });
		await waitFor(() => expect(screen.getByText('2/6')).toBeInTheDocument());
		fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });
		await waitFor(() => expect(screen.getByText('1/6')).toBeInTheDocument());
		fireEvent.keyDown(searchInput, { key: 'Enter' });
		await waitFor(() => expect(screen.getByText('2/6')).toBeInTheDocument());
		fireEvent.change(searchInput, { target: { value: 'line five' } });
		await waitFor(() => expect(screen.getByText('1/1')).toBeInTheDocument());
		fireEvent.change(searchInput, { target: { value: 'missing' } });
		await waitFor(() => expect(screen.getByText('No matches')).toBeInTheDocument());
		fireEvent.keyDown(searchInput, { key: 'Enter' });
		fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });
		fireEvent.keyDown(searchInput, { key: 'Escape' });
		expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
	});

	it('detects a newer file mtime and delegates reload to the parent', async () => {
		vi.useFakeTimers();
		const onReloadFile = vi.fn();
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 128,
			createdAt: '2026-05-01T10:00:00.000Z',
			modifiedAt: new Date(2000).toISOString(),
		});

		renderPreview({ lastModified: 1000, onReloadFile });

		expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(3000);
			await Promise.resolve();
		});
		expect(screen.getByText('File changed on disk.')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Dismiss'));
		expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(3000);
			await Promise.resolve();
		});
		expect(screen.getByText('File changed on disk.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
		expect(onReloadFile).toHaveBeenCalledOnce();
		expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();
		cleanup();

		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 128,
			createdAt: '2026-05-01T10:00:00.000Z',
			modifiedAt: new Date(500).toISOString(),
		});
		renderPreview({ lastModified: 1000 });

		await act(async () => {
			vi.advanceTimersByTime(3000);
			await Promise.resolve();
		});
		expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();
		cleanup();

		const unsavedReload = vi.fn();
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 128,
			createdAt: '2026-05-01T10:00:00.000Z',
			modifiedAt: new Date(2000).toISOString(),
		});
		renderPreview({ lastModified: 1000, onReloadFile: unsavedReload }, { initialEditMode: true });
		setEditorContent('# Unsaved before reload');

		await act(async () => {
			vi.advanceTimersByTime(3000);
			await Promise.resolve();
		});
		expect(
			screen.getByText(
				'File changed on disk. You have unsaved edits - reloading will discard them.'
			)
		).toBeInTheDocument();
	});

	it('renders image previews and copies image data through the clipboard blob boundary', async () => {
		const file = {
			name: 'diagram.png',
			path: '/repo/docs/diagram.png',
			content: 'data:image/png;base64,aW1hZ2U=',
		};

		const { container } = renderPreview({ file });

		expect(screen.getByAltText('diagram.png')).toHaveAttribute('src', file.content);
		fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }));

		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(file.content));
		expect(useCenterFlashStore.getState().active?.message).toBe('Image Copied');
		vi.mocked(safeClipboardWriteImage).mockClear();
		fireEvent.keyDown(container.firstElementChild!, { key: 'c', ctrlKey: true });
		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(file.content));
	});

	it('reports clipboard fallback failures for paths, text, and image data', async () => {
		vi.mocked(safeClipboardWrite).mockResolvedValue(false);
		const textFile = {
			name: 'copy-failure.txt',
			path: '/repo/docs/copy-failure.txt',
			content: 'copy failure content',
		};

		renderPreview({ file: textFile });

		fireEvent.click(screen.getByRole('button', { name: 'Copy full path to clipboard' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith(textFile.path));
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Failed to Copy Path');

		fireEvent.click(screen.getByRole('button', { name: 'Copy content to clipboard' }));
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith(textFile.content));
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Failed to Copy Content');
		cleanup();

		vi.mocked(safeClipboardWriteImage).mockResolvedValue(false);
		vi.mocked(safeClipboardWrite).mockResolvedValue(false);
		const imageFile = {
			name: 'chart.png',
			path: '/repo/docs/chart.png',
			content: 'data:image/png;base64,Y2hhcnQ=',
		};

		renderPreview({ file: imageFile });
		fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }));
		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(imageFile.content));
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Failed to Copy Image');
		cleanup();

		vi.mocked(safeClipboardWriteImage).mockResolvedValue(false);
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
		renderPreview({ file: imageFile });
		fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }));
		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(imageFile.content));
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Failed to Copy Image');
	});

	it('shows binary fallback UI and delegates opening to the shell bridge', async () => {
		const file = {
			name: 'archive.zip',
			path: '/repo/build/archive.zip',
			content: '\0\0binary-data',
		};

		renderPreview({ file });

		await waitFor(() => expect(screen.getByText('2.0 KB')).toBeInTheDocument());
		expect(screen.getByText('Binary File')).toBeInTheDocument();
		expect(screen.getByText('This file cannot be displayed as text.')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Open in Default App'));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/repo/build/archive.zip');
	});

	it('covers file-type, binary-character, local image, and edit-scroll fallbacks', async () => {
		const unknownExtFile = {
			name: 'snippet.foo',
			path: '/repo/docs/snippet.foo',
			content: 'alpha fallback language',
		};
		renderPreview({ file: unknownExtFile });
		expect(screen.getByText('snippet.foo')).toBeInTheDocument();
		expect(screen.getByText(/alpha fallback language/)).toBeInTheDocument();
		cleanup();

		const extensionlessFile = {
			name: 'Makefile',
			path: '/repo/Makefile',
			content: 'build:\n\techo ok',
		};
		renderPreview({ file: extensionlessFile });
		expect(screen.getByText('Makefile')).toBeInTheDocument();
		expect(screen.getByText(/echo ok/)).toBeInTheDocument();
		cleanup();

		renderPreview({
			file: {
				name: 'extended-control.txt',
				path: '/repo/extended-control.txt',
				content: `${String.fromCharCode(130).repeat(40)}plain text`,
			},
		});
		expect(screen.getByText('Binary File')).toBeInTheDocument();
		cleanup();

		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (filePath) => {
			if (filePath === '/repo/docs/no-alt.png') return 'data:image/png;base64,bm9hbHQ=';
			if (filePath === '/repo/docs/unknown-error.png') throw {};
			return 'data:image/png;base64,local-diagram';
		});
		const imageMarkdown = {
			name: 'image-fallbacks.md',
			path: '/repo/docs/image-fallbacks.md',
			content: ['<img src="./no-alt.png">', '![Broken](./unknown-error.png)'].join('\n\n'),
		};
		const imageRender = renderPreview({ file: imageMarkdown });

		await waitFor(() =>
			expect(imageRender.container.querySelector('img[alt=""]')).toHaveAttribute(
				'src',
				'data:image/png;base64,bm9hbHQ='
			)
		);
		expect(await screen.findByText('Failed to load image: Unknown error')).toBeInTheDocument();
		cleanup();

		const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 1;
		});
		const editFile = {
			name: 'unscrollable.txt',
			path: '/repo/docs/unscrollable.txt',
			content: 'one\ntwo',
		};
		const editRender = renderPreview({ file: editFile });
		await flushPendingPromises();
		const scroller = editRender.container.querySelector('.overflow-y-auto') as HTMLElement;
		Object.defineProperty(scroller, 'scrollHeight', { value: 100, configurable: true });
		Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
		Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
		fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
		expect(await screen.findByRole('textbox')).toHaveFocus();
		rafSpy.mockRestore();
	});

	it('coordinates markdown search, table of contents, navigation popovers, and bionify toggle', async () => {
		const onNavigateBack = vi.fn();
		const onNavigateForward = vi.fn();
		const onNavigateToIndex = vi.fn();
		const onOpenFuzzySearch = vi.fn();
		const onSearchQueryChange = vi.fn();
		const file = {
			name: 'guide.md',
			path: '/repo/docs/guide.md',
			content: [
				'# Alpha Guide',
				'==Solo==',
				'Alpha content with ==important== context.',
				'```md',
				'# Hidden In Fence',
				'```',
				'## Beta Section',
				'```mermaid',
				'graph TD; A-->B;',
				'```',
				'<details onToggle="bad"><summary>More</summary>Safe body</details>',
				'### Gamma Notes',
				'#### Delta Deep',
				'Beta content',
			].join('\n\n'),
		};

		const { container } = renderPreview({
			file,
			canGoBack: true,
			canGoForward: true,
			backHistory: [{ name: 'previous.md', path: '/repo/docs/previous.md' }],
			forwardHistory: [{ name: 'next.md', path: '/repo/docs/next.md' }],
			currentHistoryIndex: 1,
			onNavigateBack,
			onNavigateForward,
			onNavigateToIndex,
			onOpenFuzzySearch,
			onSearchQueryChange,
			initialSearchQuery: 'Alpha',
		});

		const searchInput = screen.getByPlaceholderText(/Search in file/);
		expect(searchInput).toHaveValue('Alpha');
		fireEvent.change(searchInput, { target: { value: 'Beta' } });
		expect(onSearchQueryChange).toHaveBeenCalledWith('Beta');
		fireEvent.keyDown(searchInput, { key: 'Enter' });
		await waitFor(() => expect(screen.getByText('2/2')).toBeInTheDocument());
		fireEvent.change(searchInput, { target: { value: 'Missing' } });
		await waitFor(() => expect(screen.getByText('No matches')).toBeInTheDocument());
		fireEvent.change(searchInput, { target: { value: 'Beta' } });
		expect(
			Array.from(container.querySelectorAll('mark')).some(
				(mark) => mark.textContent === 'important'
			)
		).toBe(true);
		expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent('graph TD; A-->B;');

		fireEvent.click(screen.getByTitle('Table of Contents'));
		expect(screen.getByText('Contents')).toBeInTheDocument();
		expect(screen.getByText('4 headings')).toBeInTheDocument();
		fireEvent.wheel(container.querySelector('.bottom-16') as HTMLElement);
		fireEvent.wheel(screen.getByTitle('Beta Section'));
		const originalQuerySelector = Element.prototype.querySelector;
		const headingTarget = document.createElement('h1');
		headingTarget.scrollIntoView = vi.fn();
		const querySelectorSpy = vi
			.spyOn(Element.prototype, 'querySelector')
			.mockImplementation(function querySelector(selector) {
				if (selector === '#alpha-guide') return headingTarget;
				return originalQuerySelector.call(this, selector);
			});
		fireEvent.click(screen.getByTitle('Alpha Guide'));
		expect(headingTarget.scrollIntoView).toHaveBeenCalledWith({
			behavior: 'smooth',
			block: 'start',
		});
		querySelectorSpy.mockRestore();
		const missingHeadingSpy = vi.spyOn(Element.prototype, 'querySelector').mockReturnValue(null);
		fireEvent.click(screen.getByTitle('Delta Deep'));
		expect(missingHeadingSpy).toHaveBeenCalled();
		missingHeadingSpy.mockRestore();
		Element.prototype.scrollTo = vi.fn();
		fireEvent.click(screen.getByTestId('toc-top-button'));
		fireEvent.click(screen.getByTestId('toc-bottom-button'));
		expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
		expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

		const backButton = screen.getByTitle(/Go back/);
		act(() => {
			fireEvent.mouseEnter(backButton.parentElement!);
		});
		const previous = await screen.findByText('previous.md');
		fireEvent.click(previous);
		expect(onNavigateToIndex).toHaveBeenCalledWith(0);
		fireEvent.mouseLeave(backButton.parentElement!);
		fireEvent.mouseEnter(backButton.parentElement!);

		fireEvent.click(backButton);
		expect(onNavigateBack).toHaveBeenCalledOnce();
		const forwardButton = screen.getByTitle(/Go forward/);
		act(() => {
			fireEvent.mouseEnter(forwardButton.parentElement!);
		});
		const next = await screen.findByText('next.md');
		fireEvent.click(next);
		expect(onNavigateToIndex).toHaveBeenCalledWith(2);
		fireEvent.mouseLeave(forwardButton.parentElement!);
		fireEvent.mouseEnter(forwardButton.parentElement!);
		fireEvent.click(forwardButton);
		expect(onNavigateForward).toHaveBeenCalledOnce();

		fireEvent.keyDown(container.firstElementChild!, { key: 'p', metaKey: true });
		expect(onOpenFuzzySearch).toHaveBeenCalledOnce();
	});

	it('renders disabled navigation button states without opening history popovers', async () => {
		const file = {
			name: 'disabled-nav.md',
			path: '/repo/docs/disabled-nav.md',
			content: '# Disabled Navigation',
		};

		const backDisabledRender = renderPreview({
			file,
			canGoBack: false,
			canGoForward: true,
			onNavigateBack: vi.fn(),
			forwardHistory: [{ name: 'next.md', path: '/repo/docs/next.md' }],
		});
		await flushPendingPromises();

		const disabledBack = screen.getByTitle(/Go back/);
		expect(disabledBack).toBeDisabled();
		fireEvent.mouseEnter(disabledBack.parentElement!);
		expect(screen.queryByText('next.md')).not.toBeInTheDocument();
		fireEvent.keyDown(backDisabledRender.container.firstElementChild!, {
			key: 'ArrowLeft',
			metaKey: true,
		});
		cleanup();

		const forwardDisabledRender = renderPreview({
			file,
			canGoBack: true,
			canGoForward: false,
			backHistory: [{ name: 'previous.md', path: '/repo/docs/previous.md' }],
			onNavigateForward: vi.fn(),
		});
		await flushPendingPromises();

		const disabledForward = screen.getByTitle(/Go forward/);
		expect(disabledForward).toBeDisabled();
		fireEvent.mouseEnter(disabledForward.parentElement!);
		expect(screen.queryByText('previous.md')).not.toBeInTheDocument();
		fireEvent.keyDown(forwardDisabledRender.container.firstElementChild!, {
			key: 'ArrowRight',
			metaKey: true,
		});
	});

	it('uses CSS custom highlights for markdown search when the browser API is available', async () => {
		const originalCSSDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
		const originalHighlightDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Highlight');
		const originalRangeRect = (Range.prototype as any).getBoundingClientRect;
		const originalElementRect = Element.prototype.getBoundingClientRect;
		const originalScrollTo = Element.prototype.scrollTo;
		const highlights = {
			set: vi.fn(),
			delete: vi.fn(),
		};

		Object.defineProperty(globalThis, 'CSS', {
			configurable: true,
			value: { highlights },
		});
		(globalThis as any).Highlight = class TestHighlight {
			constructor(public readonly ranges: Range[]) {}
		};
		(Range.prototype as any).getBoundingClientRect = vi.fn(() => ({
			top: 48,
			height: 12,
			left: 0,
			right: 80,
			bottom: 60,
			width: 80,
			x: 0,
			y: 48,
			toJSON: () => ({}),
		}));
		Element.prototype.getBoundingClientRect = vi.fn(() => ({
			top: 8,
			height: 120,
			left: 0,
			right: 600,
			bottom: 128,
			width: 600,
			x: 0,
			y: 8,
			toJSON: () => ({}),
		}));
		Element.prototype.scrollTo = vi.fn();

		try {
			const file = {
				name: 'search.md',
				path: '/repo/docs/search.md',
				content: ['# Alpha', 'Alpha beta alpha', '## Other'].join('\n\n'),
			};

			const { container } = renderPreview({ file, initialSearchQuery: 'Alpha' });

			await waitFor(() =>
				expect(highlights.set).toHaveBeenCalledWith('search-results', expect.anything())
			);
			expect(highlights.set).toHaveBeenCalledWith('search-current', expect.anything());
			expect(Element.prototype.scrollTo).toHaveBeenCalled();

			fireEvent.keyDown(container.firstElementChild!, { key: 'Escape' });
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
			expect(highlights.delete).toHaveBeenCalledWith('search-results');
			expect(highlights.delete).toHaveBeenCalledWith('search-current');
		} finally {
			cleanup();
			if (originalCSSDescriptor) {
				Object.defineProperty(globalThis, 'CSS', originalCSSDescriptor);
			} else {
				delete (globalThis as any).CSS;
			}
			if (originalHighlightDescriptor) {
				Object.defineProperty(globalThis, 'Highlight', originalHighlightDescriptor);
			} else {
				delete (globalThis as any).Highlight;
			}
			if (originalRangeRect) {
				(Range.prototype as any).getBoundingClientRect = originalRangeRect;
			} else {
				delete (Range.prototype as any).getBoundingClientRect;
			}
			Element.prototype.getBoundingClientRect = originalElementRect;
			if (originalScrollTo) {
				Element.prototype.scrollTo = originalScrollTo;
			} else {
				delete (Element.prototype as any).scrollTo;
			}
		}
	});

	it('uses the fast tier for very large source files and can force rich full content', async () => {
		const largeContent = `${'const value = 1;\n'.repeat(7000)}const sentinel = true;`;
		const file = {
			name: 'large.ts',
			path: '/repo/src/large.ts',
			content: largeContent,
		};

		renderPreview({ file });

		await waitFor(() => expect(screen.getByText('2.0 KB')).toBeInTheDocument());
		const tierButton = await screen.findByRole('button', { name: 'Auto · Fast preview' });
		expect(screen.queryByText(/Large file preview truncated/)).not.toBeInTheDocument();
		fireEvent.click(tierButton);
		fireEvent.click(screen.getByRole('menuitem', { name: /Rich/ }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Forced Rich preview' })).toBeInTheDocument()
		);
		expect(screen.getByText(/Large file preview truncated/)).toBeInTheDocument();
		expect(screen.queryByText(/sentinel/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Load full file' }));
		expect(screen.getByText(/sentinel/)).toBeInTheDocument();
	});

	it('routes code search and keyboard shortcuts through the focused preview container', async () => {
		const onNavigateBack = vi.fn();
		const onNavigateForward = vi.fn();
		const onOpenFuzzySearch = vi.fn();
		const onOpenInGraph = vi.fn();
		const onShortcutUsed = vi.fn();
		const file = {
			name: 'module.ts',
			path: '/repo/src/module.ts',
			content: 'const alpha = 1;\nconst beta = alpha + 1;\n',
		};

		const { container } = renderPreview({
			file,
			canGoBack: true,
			canGoForward: true,
			onNavigateBack,
			onNavigateForward,
			onOpenFuzzySearch,
			onOpenInGraph,
			onShortcutUsed,
			shortcuts: {
				...shortcuts,
				copyFilePath: { keys: ['Meta', 'y'] },
			},
		});
		const root = container.firstElementChild!;

		fireEvent.keyDown(root, { key: 'f', metaKey: true });
		fireEvent.change(screen.getByPlaceholderText(/Search in file/), {
			target: { value: 'alpha' },
		});
		await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Next match (Enter)'));
		await waitFor(() => expect(screen.getByText('2/2')).toBeInTheDocument());
		fireEvent.click(screen.getByTitle('Previous match (Shift+Enter)'));
		await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
		expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
		fireEvent.keyDown(screen.getByPlaceholderText(/Search in file/), { key: 'Enter' });
		await waitFor(() => expect(screen.getByText('2/2')).toBeInTheDocument());
		fireEvent.keyDown(screen.getByPlaceholderText(/Search in file/), {
			key: 'Enter',
			shiftKey: true,
		});
		await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
		fireEvent.keyDown(screen.getByPlaceholderText(/Search in file/), { key: 'Tab' });
		fireEvent.keyDown(screen.getByPlaceholderText(/Search in file/), { key: 'Escape' });
		expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();

		fireEvent.keyDown(root, { key: 'y', metaKey: true });
		await waitFor(() => expect(safeClipboardWrite).toHaveBeenCalledWith('/repo/src/module.ts'));
		expect(onShortcutUsed).toHaveBeenCalledWith('copyFilePath');

		fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });
		expect(onNavigateBack).toHaveBeenCalledOnce();
		expect(onShortcutUsed).toHaveBeenCalledWith('filePreviewBack');

		fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });
		expect(onNavigateForward).toHaveBeenCalledOnce();
		expect(onShortcutUsed).toHaveBeenCalledWith('filePreviewForward');

		fireEvent.keyDown(root, { key: 'p', metaKey: true });
		expect(onOpenFuzzySearch).toHaveBeenCalledOnce();

		fireEvent.keyDown(root, { key: 'g', metaKey: true, shiftKey: true });
		expect(onOpenInGraph).not.toHaveBeenCalled();
	});

	it('renders null, CSV, binary heuristics, scroll restore, and imperative focus edge cases', async () => {
		const previewRef = createRef<{ focus: () => void }>();
		const onScrollPositionChange = vi.fn();
		const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 1;
		});

		const nullRender = renderPreview({ file: null });
		expect(nullRender.container.firstChild).toBeNull();
		nullRender.unmount();

		const binaryFile = {
			name: 'payload.dat',
			path: '/repo/payload.dat',
			content: 'text\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008\u0009more text',
		};
		renderPreview({ file: binaryFile });
		expect(screen.getByText('Binary File')).toBeInTheDocument();
		cleanup();

		const csvFile = {
			name: 'report.tsv',
			path: '/repo/report.tsv',
			content: 'name\tcount\nalpha\t2\nbeta\t3\nalphabet\t5',
		};
		const { container } = renderPreview({
			file: csvFile,
			ref: previewRef,
			initialScrollTop: 42,
			onScrollPositionChange,
			initialSearchQuery: 'alpha',
		});

		expect(
			screen.getByText((_content, node) => node?.textContent === '2 of 3 rows match × 2 columns')
		).toBeInTheDocument();
		fireEvent.change(screen.getByPlaceholderText(/Search in file/), {
			target: { value: 'nomatch' },
		});
		await waitFor(() =>
			expect(
				screen.getByText((_content, node) => node?.textContent === '0 of 3 rows match × 2 columns')
			).toBeInTheDocument()
		);
		act(() => previewRef.current?.focus());
		expect(document.activeElement).toBe(container.firstElementChild);

		const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
		Object.defineProperty(scroller, 'scrollTop', { value: 64, writable: true, configurable: true });
		fireEvent.scroll(scroller);
		await waitFor(() => expect(onScrollPositionChange).toHaveBeenCalledWith(64));
		rafSpy.mockRestore();
		cleanup();

		const noScrollCallbackRender = renderPreview();
		await flushPendingPromises();
		const defaultScroller = noScrollCallbackRender.container.querySelector(
			'.overflow-y-auto'
		) as HTMLElement;
		Object.defineProperty(defaultScroller, 'scrollTop', {
			value: 24,
			writable: true,
			configurable: true,
		});
		act(() => {
			fireEvent.scroll(defaultScroller);
		});
	});

	it('handles save failures and confirms discarding overlay edits', async () => {
		const onClose = vi.fn();
		const onSave = vi.fn().mockRejectedValue(new Error('disk full'));
		const file = {
			name: 'notes.md',
			path: '/repo/docs/notes.md',
			content: '# Notes\n\nOriginal',
		};

		const { container } = renderPreview(
			{ file, isTabMode: false, onClose, onSave },
			{ initialEditMode: true }
		);

		setEditorContent('# Notes\n\nChanged');
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith('/repo/docs/notes.md', '# Notes\n\nChanged')
		);
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Save Failed');

		fireEvent.keyDown(container.firstElementChild!, { key: 'Escape' });
		expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Yes, Discard' }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('reports image copy failure when the image clipboard write fails', async () => {
		vi.mocked(safeClipboardWriteImage).mockResolvedValue(false);
		const file = {
			name: 'chart.png',
			path: '/repo/docs/chart.png',
			content: 'data:image/png;base64,Y2hhcnQ=',
		};

		const { container } = renderPreview({ file });

		fireEvent.keyDown(container.firstElementChild!, { key: 'c', metaKey: true });

		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(file.content));
		expect(useNotificationStore.getState().toasts.at(-1)?.title).toBe('Failed to Copy Image');
	});

	it('keeps readable text usable when file metadata and token counting fail', async () => {
		vi.mocked(window.maestro.fs.stat).mockRejectedValue(new Error('stat failed'));
		vi.mocked(getEncoder).mockRejectedValue(new Error('encoder failed'));
		const file = {
			name: 'README',
			path: '/repo/README',
			content: 'Readable project notes\nwith a second line',
		};

		renderPreview({ file });

		expect(screen.getByText(/Readable project notes/)).toBeInTheDocument();
		await waitFor(() =>
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/repo/README', undefined)
		);
		await waitFor(() => expect(getEncoder).toHaveBeenCalled());
		expect(screen.queryByText(/Size:/)).not.toBeInTheDocument();
	});

	it('resolves cached data-url and file-tree markdown images through renderer filesystem boundaries', async () => {
		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (filePath) => {
			if (filePath === '/repo/attachments/from-tree.png') {
				return 'data:image/png;base64,dHJlZQ==';
			}
			return 'data:image/png;base64,local-diagram';
		});
		const fileTree = [
			{
				name: 'attachments',
				type: 'folder' as const,
				children: [{ name: 'from-tree.png', type: 'file' as const }],
			},
		];
		const file = {
			name: 'tree.md',
			path: '/repo/docs/page.md',
			content: '![[from-tree.png|320]]',
		};

		renderPreview({ file, fileTree, cwd: 'docs/notes' });

		const treeImage = await screen.findByAltText('from-tree.png');
		expect(treeImage).toHaveAttribute('src', 'data:image/png;base64,dHJlZQ==');
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
			'/repo/attachments/from-tree.png',
			undefined
		);
		Object.defineProperty(treeImage, 'naturalWidth', { value: 640, configurable: true });
		Object.defineProperty(treeImage, 'naturalHeight', { value: 360, configurable: true });
		fireEvent.load(treeImage);

		cleanup();
		vi.mocked(window.maestro.fs.readFile).mockClear();
		renderPreview({ file, fileTree, cwd: 'docs/notes' });

		expect(await screen.findByAltText('from-tree.png')).toHaveAttribute(
			'src',
			'data:image/png;base64,dHJlZQ=='
		);
		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();

		cleanup();
		vi.mocked(window.maestro.fs.readFile).mockImplementation(async (filePath) => {
			if (filePath === '/repo/attachments/nested.png') {
				return 'data:image/png;base64,bmVzdGVk';
			}
			return 'data:image/png;base64,local-diagram';
		});
		const nestedTree = [
			{
				name: 'attachments',
				type: 'folder' as const,
				children: [{ name: 'nested.png', type: 'file' as const }],
			},
		];
		renderPreview({
			file: {
				name: 'nested.md',
				path: '/repo/docs/notes/nested.md',
				content: '![[nested.png]]',
			},
			fileTree: nestedTree,
			cwd: 'docs/notes',
		});
		expect(await screen.findByAltText('nested.png')).toHaveAttribute(
			'src',
			'data:image/png;base64,bmVzdGVk'
		);
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
			'/repo/attachments/nested.png',
			undefined
		);
	});

	it('falls back to copying image data when image fetch fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
		const file = {
			name: 'chart.png',
			path: '/repo/docs/chart.png',
			content: 'data:image/png;base64,Y2hhcnQ=',
		};

		renderPreview({ file });

		fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }));

		await waitFor(() => expect(safeClipboardWriteImage).toHaveBeenCalledWith(file.content));
		expect(useCenterFlashStore.getState().active?.message).toBe('Image Copied');
	});

	it('handles no-match search, empty CSS highlights, and Escape cleanup paths', async () => {
		const originalCSSDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
		const highlights = { set: vi.fn(), delete: vi.fn() };
		Object.defineProperty(globalThis, 'CSS', {
			configurable: true,
			value: { highlights },
		});

		try {
			const file = {
				name: 'empty-search.md',
				path: '/repo/docs/empty-search.md',
				content: '# Alpha\n\nAlpha content',
			};
			const { container } = renderPreview({ file, initialSearchQuery: 'missing' });

			await waitFor(() => expect(highlights.delete).toHaveBeenCalledWith('search-results'));
			expect(screen.getByText('No matches')).toBeInTheDocument();
			const searchInput = screen.getByPlaceholderText(/Search in file/);
			fireEvent.keyDown(searchInput, { key: 'Enter' });
			fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });

			fireEvent.keyDown(container.firstElementChild!, { key: 'Escape' });
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
			fireEvent.keyDown(container.firstElementChild!, { key: 'Escape' });
		} finally {
			if (originalCSSDescriptor) {
				Object.defineProperty(globalThis, 'CSS', originalCSSDescriptor);
			} else {
				delete (globalThis as any).CSS;
			}
		}
	});

	it('uses tab and layer Escape handlers for table of contents, search, and overlay close', async () => {
		const onClose = vi.fn();
		const file = {
			name: 'escape.md',
			path: '/repo/docs/escape.md',
			content: '# Alpha\n\n## Beta\n\n### Gamma',
		};

		const tabRender = renderPreview({ file });
		fireEvent.click(screen.getByTitle('Table of Contents'));
		expect(screen.getByText('Contents')).toBeInTheDocument();
		fireEvent.keyDown(tabRender.container.firstElementChild!, { key: 'Escape' });
		expect(screen.queryByText('Contents')).not.toBeInTheDocument();
		fireEvent.keyDown(tabRender.container.firstElementChild!, { key: 'f', metaKey: true });
		expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();
		fireEvent.keyDown(tabRender.container.firstElementChild!, { key: 'Escape' });
		expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
		fireEvent.keyDown(tabRender.container.firstElementChild!, { key: 'Escape' });
		tabRender.unmount();

		renderPreview({ file, isTabMode: false, onClose });
		fireEvent.click(screen.getByTitle('Table of Contents'));
		expect(screen.getByText('Contents')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(screen.queryByText('Contents')).not.toBeInTheDocument());
		fireEvent.keyDown(screen.getByText('escape.md').closest('.flex-col')!, {
			key: 'f',
			metaKey: true,
		});
		expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument()
		);
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('closes navigation popovers and table of contents from delayed pointer handlers', async () => {
		vi.useFakeTimers();
		const file = {
			name: 'pointer.md',
			path: '/repo/docs/pointer.md',
			content: '# Alpha\n\n## Beta',
		};

		renderPreview({
			file,
			canGoBack: true,
			canGoForward: true,
			backHistory: [{ name: 'back.md', path: '/repo/docs/back.md' }],
			forwardHistory: [{ name: 'forward.md', path: '/repo/docs/forward.md' }],
		});
		await flushPendingPromises();
		const backButton = screen.getByTitle(/Go back/);
		fireEvent.mouseEnter(backButton.parentElement!);
		expect(screen.getByText('back.md')).toBeInTheDocument();
		fireEvent.mouseLeave(backButton.parentElement!);
		act(() => vi.advanceTimersByTime(150));
		expect(screen.queryByText('back.md')).not.toBeInTheDocument();

		const forwardButton = screen.getByTitle(/Go forward/);
		fireEvent.mouseEnter(forwardButton.parentElement!);
		expect(screen.getByText('forward.md')).toBeInTheDocument();
		fireEvent.mouseLeave(forwardButton.parentElement!);
		act(() => vi.advanceTimersByTime(150));
		expect(screen.queryByText('forward.md')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Table of Contents'));
		act(() => vi.advanceTimersByTime(0));
		expect(screen.getByText('Contents')).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByText('Contents')).not.toBeInTheDocument();
		vi.useRealTimers();
	});

	it('covers preview keyboard scrolling, edit-mode shortcuts, and uncontrolled edit state', async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const onNavigateBack = vi.fn();
		const onNavigateForward = vi.fn();
		const onOpenFuzzySearch = vi.fn();
		const onOpenInGraph = vi.fn();
		const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
			cb(0);
			return 1;
		});
		const file = {
			name: 'keyboard.txt',
			path: '/repo/docs/keyboard.txt',
			content: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].join('\n'),
		};

		const { container } = renderPreview({
			file,
			onSave,
			canGoBack: true,
			canGoForward: true,
			onNavigateBack,
			onNavigateForward,
			onOpenFuzzySearch,
			shortcuts: { ...shortcuts, copyFilePath: { keys: ['Meta', 'y'] } },
		});
		await flushPendingPromises();
		const root = container.firstElementChild!;
		const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
		Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
		Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
		Object.defineProperty(scroller, 'scrollTop', { value: 80, writable: true, configurable: true });

		fireEvent.click(screen.getByRole('button', { name: 'Edit file' }));
		await screen.findByRole('textbox');
		fireEvent.keyDown(root, { key: 's', metaKey: true });
		expect(onSave).not.toHaveBeenCalled();
		setEditorContent(`${file.content}\nzeta`);
		fireEvent.keyDown(root, { key: 's', metaKey: true });
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith('/repo/docs/keyboard.txt', `${file.content}\nzeta`)
		);
		setEditorContent(`${file.content}\neta`);
		fireEvent.keyDown(root, { key: 's', ctrlKey: true });
		await waitFor(() =>
			expect(onSave).toHaveBeenCalledWith('/repo/docs/keyboard.txt', `${file.content}\neta`)
		);

		fireEvent.keyDown(root, { key: 'ArrowUp' });
		fireEvent.keyDown(root, { key: 'ArrowDown' });
		fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });
		fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });
		fireEvent.keyDown(root, { key: 'p', metaKey: true });
		expect(onNavigateBack).not.toHaveBeenCalled();
		expect(onNavigateForward).not.toHaveBeenCalled();
		expect(onOpenFuzzySearch).not.toHaveBeenCalled();

		fireEvent.keyDown(root, { key: 'e', metaKey: true });
		await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());

		fireEvent.keyDown(root, { key: 'f', ctrlKey: true });
		expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();
		fireEvent.keyDown(root, { key: 'Escape' });
		fireEvent.keyDown(root, { key: 'ArrowLeft', ctrlKey: true });
		expect(onNavigateBack).toHaveBeenCalledOnce();
		fireEvent.keyDown(root, { key: 'ArrowRight', ctrlKey: true });
		expect(onNavigateForward).toHaveBeenCalledOnce();

		fireEvent.keyDown(root, { key: 'ArrowUp', metaKey: true });
		expect(scroller.scrollTop).toBe(0);
		scroller.scrollTop = 80;
		fireEvent.keyDown(root, { key: 'ArrowUp', altKey: true });
		expect(scroller.scrollTop).toBe(-20);
		scroller.scrollTop = 80;
		fireEvent.keyDown(root, { key: 'ArrowUp' });
		expect(scroller.scrollTop).toBe(40);
		fireEvent.keyDown(root, { key: 'ArrowDown', metaKey: true });
		expect(scroller.scrollTop).toBe(500);
		scroller.scrollTop = 80;
		fireEvent.keyDown(root, { key: 'ArrowDown', altKey: true });
		expect(scroller.scrollTop).toBe(180);
		fireEvent.keyDown(root, { key: 'ArrowDown' });
		expect(scroller.scrollTop).toBe(220);

		cleanup();
		renderPreview(
			{
				file,
				shortcuts: {},
			},
			{ initialEditMode: true, uncontrolledEdit: true }
		);
		await flushPendingPromises();
		expect(getEditorView().state.doc.toString()).toBe(file.content);
		expect(screen.getByRole('button', { name: 'View file' })).toBeInTheDocument();

		cleanup();
		const markdownFile = {
			name: 'graph.md',
			path: '/repo/docs/graph.md',
			content: '# Graph',
		};
		const markdownRender = renderPreview({ file: markdownFile, onOpenInGraph });
		await flushPendingPromises();
		fireEvent.keyDown(markdownRender.container.firstElementChild!, {
			key: 'g',
			metaKey: true,
			shiftKey: true,
		});
		expect(onOpenInGraph).toHaveBeenCalledOnce();
		fireEvent.keyDown(markdownRender.container.firstElementChild!, {
			key: 'g',
			ctrlKey: true,
			shiftKey: true,
		});
		expect(onOpenInGraph).toHaveBeenCalledTimes(2);
		rafSpy.mockRestore();
	});

	it('covers binary heuristics, stat polling gaps, timer cleanup, and unsaved modal dismissal', async () => {
		renderPreview({ file: { name: 'empty.txt', path: '/repo/empty.txt', content: '' } });
		await flushPendingPromises();
		expect(screen.getByText('empty.txt')).toBeInTheDocument();
		cleanup();

		renderPreview({
			file: { name: 'bytes.txt', path: '/repo/bytes.txt', content: 'hello\0world' },
		});
		await flushPendingPromises();
		expect(screen.getByText('Binary File')).toBeInTheDocument();
		cleanup();

		renderPreview({
			file: {
				name: 'control.txt',
				path: '/repo/control.txt',
				content: `${String.fromCharCode(1).repeat(40)}plain text`,
			},
		});
		await flushPendingPromises();
		expect(screen.getByText('Binary File')).toBeInTheDocument();
		cleanup();

		vi.useFakeTimers();
		vi.mocked(window.maestro.fs.stat)
			.mockResolvedValueOnce({
				size: 1,
				createdAt: '2026-05-01T10:00:00.000Z',
				modifiedAt: '2026-05-02T11:30:00.000Z',
			})
			.mockResolvedValue({
				size: 1,
				createdAt: '2026-05-01T10:00:00.000Z',
				modifiedAt: undefined as unknown as string,
			});
		renderPreview({ lastModified: 1000 });
		await flushPendingPromises();
		await act(async () => {
			vi.advanceTimersByTime(3000);
			await Promise.resolve();
		});
		expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();
		cleanup();
		vi.useRealTimers();

		vi.useFakeTimers();
		renderPreview({
			file: { name: 'copy.txt', path: '/repo/copy.txt', content: 'copy me' },
		});
		await flushPendingPromises();
		fireEvent.click(screen.getByRole('button', { name: 'Copy content to clipboard' }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(useCenterFlashStore.getState().active?.message).toBe('Content Copied');
		act(() => vi.advanceTimersByTime(2000));
		expect(useCenterFlashStore.getState().active).toBeNull();
		cleanup();
		vi.useRealTimers();

		vi.useFakeTimers();
		const onScrollPositionChange = vi.fn();
		const scrollRender = renderPreview({ onScrollPositionChange });
		await flushPendingPromises();
		const scroller = scrollRender.container.querySelector('.overflow-y-auto') as HTMLElement;
		Object.defineProperty(scroller, 'scrollTop', { value: 32, writable: true, configurable: true });
		fireEvent.scroll(scroller);
		scroller.scrollTop = 64;
		fireEvent.scroll(scroller);
		scrollRender.unmount();
		act(() => vi.advanceTimersByTime(250));
		expect(onScrollPositionChange).not.toHaveBeenCalled();
		vi.useRealTimers();

		const onClose = vi.fn();
		const overlay = renderPreview(
			{
				file: { name: 'modal.md', path: '/repo/modal.md', content: '# Modal' },
				isTabMode: false,
				onClose,
			},
			{ initialEditMode: true }
		);
		await flushPendingPromises();
		setEditorContent('# Changed');
		fireEvent.keyDown(overlay.container.firstElementChild!, { key: 'Escape' });
		expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'No, Stay' }));
		expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
		fireEvent.keyDown(overlay.container.firstElementChild!, { key: 'Escape' });
		fireEvent.click(screen.getByLabelText('Close modal'));
		expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});
});
