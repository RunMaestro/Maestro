import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	DocumentEditor,
	MarkdownImage,
	openDocumentPreviewExternalLink,
} from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

vi.mock('../../../../../renderer/components/Wizard/shared/DocumentSelector', () => ({
	DocumentSelector: ({
		selectedIndex,
		onSelect,
		disabled,
		isOpen,
		onOpenChange,
	}: {
		selectedIndex: number;
		onSelect: (index: number) => void;
		disabled?: boolean;
		isOpen?: boolean;
		onOpenChange?: (open: boolean) => void;
	}) => (
		<div data-testid="document-selector">
			Selected {selectedIndex}
			<button type="button" disabled={disabled} onClick={() => onSelect(1)}>
				Choose second document
			</button>
			<button type="button" onClick={() => onOpenChange?.(!isOpen)}>
				Toggle documents
			</button>
		</div>
	),
}));

vi.mock('../../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

const mockTheme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		textMain: '#f5f5f5',
		textDim: '#9a9a9a',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		border: '#303030',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as const;

const defaultProps = {
	content: 'Hello `code sample` [example link](https://example.com) world',
	onContentChange: vi.fn(),
	mode: 'preview' as const,
	onModeChange: vi.fn(),
	folderPath: '/tmp/autorun',
	selectedFile: 'draft',
	attachments: [],
	onAddAttachment: vi.fn(),
	onRemoveAttachment: vi.fn(),
	theme: mockTheme,
	isLocked: false,
	textareaRef: { current: null },
	previewRef: { current: null },
	documents: [{ filename: 'draft.md', content: '# Draft', taskCount: 1 }],
	selectedDocIndex: 0,
	onDocumentSelect: vi.fn(),
	statsText: '1 task ready to run',
};

function renderEditor(overrides: Partial<typeof defaultProps> = {}) {
	const props = {
		...defaultProps,
		onContentChange: vi.fn(),
		onModeChange: vi.fn(),
		onAddAttachment: vi.fn(),
		onRemoveAttachment: vi.fn(),
		onDocumentSelect: vi.fn(),
		textareaRef: { current: null as HTMLTextAreaElement | null },
		previewRef: { current: null as HTMLDivElement | null },
		...overrides,
	};

	render(<DocumentEditor {...props} />);

	return props;
}

function setSelection(element: HTMLTextAreaElement, start: number, end = start) {
	element.selectionStart = start;
	element.selectionEnd = end;
}

describe('DocumentEditor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ bionifyReadingMode: false });
		(window as any).maestro.autorun = {
			...(window as any).maestro.autorun,
			saveImage: vi
				.fn()
				.mockResolvedValue({ success: true, relativePath: 'images/draft-paste.png' }),
		};
		(window as any).maestro.fs = {
			...(window as any).maestro.fs,
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,local'),
		};
		(window as any).maestro.shell = {
			...(window as any).maestro.shell,
			openExternal: vi.fn(),
		};
	});

	it('applies reading mode in preview while leaving links and code untouched', () => {
		useSettingsStore.setState({ bionifyReadingMode: true });

		renderEditor();

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(screen.getByText('code sample')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'example link' })).toBeInTheDocument();
		expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
	});

	it('renders header controls, document selector callbacks, and edit/locked edit behavior', () => {
		const unlockedProps = renderEditor({ mode: 'preview' });

		fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
		expect(unlockedProps.onModeChange).toHaveBeenCalledWith('edit');

		cleanup();

		const props = renderEditor({
			isLocked: true,
			isDropdownOpen: false,
			onDropdownOpenChange: vi.fn(),
		});

		expect(screen.getByTestId('document-selector')).toHaveTextContent('Selected 0');
		expect(screen.getByText('1 task ready to run')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Choose second document' }));
		expect(props.onDocumentSelect).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Toggle documents' }));
		expect(props.onDropdownOpenChange).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
		expect(props.onModeChange).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /^Preview$/ }));
		expect(props.onModeChange).toHaveBeenCalledWith('preview');
	});

	it('renders compact controls when the header is hidden', () => {
		const props = renderEditor({ showHeader: false, mode: 'preview' });

		expect(screen.queryByTestId('document-selector')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
		expect(props.onModeChange).toHaveBeenCalledWith('edit');

		cleanup();

		const editProps = renderEditor({ showHeader: false, mode: 'edit' });
		fireEvent.click(screen.getByRole('button', { name: /^Preview$/ }));
		expect(editProps.onModeChange).toHaveBeenCalledWith('preview');
	});

	it('edits textarea content and handles keyboard shortcuts for tabs, mode switching, and checkboxes', () => {
		vi.useFakeTimers();
		const props = renderEditor({ mode: 'edit', content: 'abc' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const setSelectionRange = vi.spyOn(textarea, 'setSelectionRange');

		fireEvent.change(textarea, { target: { value: 'changed' } });
		expect(props.onContentChange).toHaveBeenCalledWith('changed');

		setSelection(textarea, 1, 2);
		fireEvent.keyDown(textarea, { key: 'Tab' });
		expect(props.onContentChange).toHaveBeenCalledWith('a\tc');

		fireEvent.keyDown(textarea, { key: 'e', metaKey: true });
		expect(props.onModeChange).toHaveBeenCalledWith('preview');

		setSelection(textarea, 3);
		fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true });
		expect(props.onContentChange).toHaveBeenCalledWith('abc\n- [ ] ');
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(setSelectionRange).toHaveBeenCalledWith(10, 10);

		cleanup();

		const emptyLineProps = renderEditor({ mode: 'edit', content: 'abc\n' });
		const emptyLineTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(emptyLineTextarea, 'abc\n'.length);
		fireEvent.keyDown(emptyLineTextarea, { key: 'l', metaKey: true });
		expect(emptyLineProps.onContentChange).toHaveBeenCalledWith('abc\n- [ ] ');
		vi.useRealTimers();
	});

	it('continues task and unordered lists on Enter', () => {
		vi.useFakeTimers();
		const taskProps = renderEditor({ mode: 'edit', content: '- [x] done' });
		const taskTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const taskSetSelectionRange = vi.spyOn(taskTextarea, 'setSelectionRange');
		setSelection(taskTextarea, '- [x] done'.length);
		fireEvent.keyDown(taskTextarea, { key: 'Enter' });
		expect(taskProps.onContentChange).toHaveBeenCalledWith('- [x] done\n- [ ] ');
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(taskSetSelectionRange).toHaveBeenCalledWith(
			'- [x] done\n- [ ] '.length,
			'- [x] done\n- [ ] '.length
		);

		cleanup();

		const bulletProps = renderEditor({ mode: 'edit', content: '  * item' });
		const bulletTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const bulletSetSelectionRange = vi.spyOn(bulletTextarea, 'setSelectionRange');
		setSelection(bulletTextarea, '  * item'.length);
		fireEvent.keyDown(bulletTextarea, { key: 'Enter' });
		expect(bulletProps.onContentChange).toHaveBeenCalledWith('  * item\n  * ');
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(bulletSetSelectionRange).toHaveBeenCalledWith(
			'  * item\n  * '.length,
			'  * item\n  * '.length
		);
		vi.useRealTimers();
	});

	it('trims pasted text but ignores locked paste and unchanged text', () => {
		const props = renderEditor({ mode: 'edit', content: 'hello world' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, 6, 11);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => '  pasted  ',
			},
		});

		expect(props.onContentChange).toHaveBeenCalledWith('hello pasted');

		const lockedProps = renderEditor({ mode: 'edit', isLocked: true });
		const lockedTextarea = screen.getAllByPlaceholderText(
			'Your task document will appear here...'
		)[1] as HTMLTextAreaElement;
		fireEvent.paste(lockedTextarea, {
			clipboardData: { items: [], getData: () => '  ignored  ' },
		});
		expect(lockedProps.onContentChange).not.toHaveBeenCalled();
	});

	it('ignores empty and already-trimmed text pastes', () => {
		const props = renderEditor({ mode: 'edit', content: 'hello' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => '',
			},
		});
		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => 'plain',
			},
		});

		expect(props.onContentChange).not.toHaveBeenCalled();
	});

	it('ignores paste events without clipboard items or required image context', () => {
		const props = renderEditor({ mode: 'edit' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;

		fireEvent.paste(textarea, {
			clipboardData: {
				getData: () => 'ignored',
			},
		});
		expect(props.onContentChange).not.toHaveBeenCalled();

		cleanup();

		const missingContextProps = renderEditor({
			mode: 'edit',
			folderPath: '',
			selectedFile: '',
		});
		const missingContextTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		fireEvent.paste(missingContextTextarea, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => new File(['image'], 'paste.png') }],
				getData: () => '',
			},
		});
		expect(missingContextProps.onAddAttachment).not.toHaveBeenCalled();
		expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
	});

	it('saves pasted images as attachments and inserts markdown at the cursor', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,abc123' } });
			}
		}
		vi.stubGlobal('FileReader', MockFileReader);

		const props = renderEditor({ mode: 'edit', content: 'Before\nAfter' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const setSelectionRange = vi.spyOn(textarea, 'setSelectionRange');
		const focus = vi.spyOn(textarea, 'focus');
		setSelection(textarea, 'Before'.length);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/png',
						getAsFile: () => new File(['image'], 'paste.png', { type: 'image/png' }),
					},
				],
				getData: () => '',
			},
		});

		await waitFor(() => {
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/tmp/autorun',
				'draft',
				'abc123',
				'png'
			);
			expect(props.onAddAttachment).toHaveBeenCalledWith(
				'images/draft-paste.png',
				'data:image/png;base64,abc123'
			);
		});
		expect(props.onContentChange).toHaveBeenCalledWith(
			'Before\n![draft-paste.png](images/draft-paste.png)\nAfter'
		);
		const cursorAfterImage = 'Before\n![draft-paste.png](images/draft-paste.png)'.length;
		await waitFor(() => {
			expect(setSelectionRange).toHaveBeenCalledWith(cursorAfterImage, cursorAfterImage);
			expect(focus).toHaveBeenCalled();
		});

		vi.unstubAllGlobals();
	});

	it('skips pasted images that cannot provide a file or reader result', async () => {
		class EmptyFileReader {
			onload: ((event: { target: { result: string | null } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: null } });
			}
		}
		vi.stubGlobal('FileReader', EmptyFileReader);

		const props = renderEditor({ mode: 'edit' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => null }],
				getData: () => '',
			},
		});
		expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [{ type: 'image/jpeg', getAsFile: () => new File(['image'], 'paste.jpg') }],
				getData: () => '',
			},
		});
		await waitFor(() => {
			expect(props.onAddAttachment).not.toHaveBeenCalled();
		});
		expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});

	it('adds a newline suffix when inserting a pasted image before inline text', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/jpeg;base64,jpegdata' } });
			}
		}
		vi.stubGlobal('FileReader', MockFileReader);

		const props = renderEditor({ mode: 'edit', content: 'BeforeAfter' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, 'Before'.length);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/jpeg',
						getAsFile: () => new File(['image'], 'paste.jpg', { type: 'image/jpeg' }),
					},
				],
				getData: () => '',
			},
		});

		await waitFor(() => {
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/tmp/autorun',
				'draft',
				'jpegdata',
				'jpeg'
			);
		});
		expect(props.onContentChange).toHaveBeenCalledWith(
			'Before\n![draft-paste.png](images/draft-paste.png)\nAfter'
		);

		vi.unstubAllGlobals();
	});

	it('handles mixed clipboard items, failed image saves, and empty image extensions', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/;base64,fallback' } });
			}
		}
		vi.stubGlobal('FileReader', MockFileReader);
		vi.mocked(window.maestro.autorun.saveImage)
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true, relativePath: 'images/' });

		const props = renderEditor({ mode: 'edit', content: 'After' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, 0);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{ type: 'text/plain', getAsFile: () => null },
					{
						type: 'image/',
						getAsFile: () => new File(['image'], 'paste', { type: 'image/' }),
					},
				],
				getData: () => '',
			},
		});
		await waitFor(() => {
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/tmp/autorun',
				'draft',
				'data:image/;base64,fallback',
				'png'
			);
		});
		expect(props.onAddAttachment).not.toHaveBeenCalled();

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/',
						getAsFile: () => new File(['image'], 'paste', { type: 'image/' }),
					},
				],
				getData: () => '',
			},
		});

		await waitFor(() => {
			expect(props.onAddAttachment).toHaveBeenCalledWith('images/', 'data:image/;base64,fallback');
		});
		expect(props.onContentChange).toHaveBeenLastCalledWith('![images/](images/)\nAfter');

		vi.unstubAllGlobals();
	});

	it('skips pasted image insertion when the textarea unmounts before save completes', async () => {
		let triggerLoad: (() => void) | undefined;
		class DelayedFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				triggerLoad = () => {
					this.onload?.({ target: { result: 'data:image/png;base64,late' } });
				};
			}
		}
		vi.stubGlobal('FileReader', DelayedFileReader);
		vi.mocked(window.maestro.autorun.saveImage).mockResolvedValue({
			success: true,
			relativePath: 'images/late.png',
		});

		const props = renderEditor({ mode: 'edit', content: 'Before' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, 0);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/png',
						getAsFile: () => new File(['image'], 'late.png', { type: 'image/png' }),
					},
				],
				getData: () => '',
			},
		});
		cleanup();
		triggerLoad?.();

		await waitFor(() => {
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/tmp/autorun',
				'draft',
				'late',
				'png'
			);
		});
		expect(props.onContentChange).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});

	it('does not fail when delayed cursor placement runs after unmount', () => {
		vi.useFakeTimers();
		const props = renderEditor({ mode: 'edit', content: '- [ ] task' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, '- [ ] task'.length);

		fireEvent.keyDown(textarea, { key: 'Enter' });
		cleanup();

		expect(() => {
			vi.runOnlyPendingTimers();
		}).not.toThrow();
		expect(props.onContentChange).toHaveBeenCalledWith('- [ ] task\n- [ ] ');
		vi.useRealTimers();
	});

	it('does not fail when task insertion cursor placement runs after unmount', () => {
		vi.useFakeTimers();
		const props = renderEditor({ mode: 'edit', content: 'abc' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, 3);

		fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
		cleanup();

		expect(() => {
			vi.runOnlyPendingTimers();
		}).not.toThrow();
		expect(props.onContentChange).toHaveBeenCalledWith('abc\n- [ ] ');
		vi.useRealTimers();
	});

	it('does not fail when unordered list cursor placement runs after unmount', () => {
		vi.useFakeTimers();
		const props = renderEditor({ mode: 'edit', content: '- item' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, '- item'.length);

		fireEvent.keyDown(textarea, { key: 'Enter' });
		cleanup();

		expect(() => {
			vi.runOnlyPendingTimers();
		}).not.toThrow();
		expect(props.onContentChange).toHaveBeenCalledWith('- item\n- ');
		vi.useRealTimers();
	});

	it('lets Enter fall through on normal lines and ignores unrelated edit shortcuts', () => {
		const props = renderEditor({ mode: 'edit', content: 'plain line' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(textarea, 'plain line'.length);

		fireEvent.keyDown(textarea, { key: 'Enter' });
		fireEvent.keyDown(textarea, { key: 'x', metaKey: true });

		expect(props.onContentChange).not.toHaveBeenCalled();
		expect(props.onModeChange).not.toHaveBeenCalled();
	});

	it('renders and collapses attached image previews in edit mode', () => {
		const props = renderEditor({
			mode: 'edit',
			attachments: [{ filename: 'diagram.png', dataUrl: 'data:image/png;base64,diagram' }],
		});

		expect(screen.getByText('Attached Images (1)')).toBeInTheDocument();
		expect(screen.getByAltText('diagram.png')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Remove image'));
		expect(props.onRemoveAttachment).toHaveBeenCalledWith('diagram.png');

		fireEvent.click(screen.getByText('Attached Images (1)'));
		expect(screen.queryByAltText('diagram.png')).not.toBeInTheDocument();
	});

	it('switches from preview to edit with keyboard shortcut and opens external preview links', () => {
		const props = renderEditor({
			content: '[docs](https://example.com) [local](#section)',
			mode: 'preview',
		});

		const preview = document.querySelector('.doc-editor') as HTMLElement;
		fireEvent.keyDown(preview, { key: 'e', metaKey: true });
		expect(props.onModeChange).toHaveBeenCalledWith('edit');

		fireEvent.click(screen.getByRole('link', { name: 'docs' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com');
		fireEvent.click(screen.getByRole('link', { name: 'local' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledTimes(1);
	});

	it('keeps file URLs out of preview external-link handling', () => {
		openDocumentPreviewExternalLink('file:///tmp/notes.md');

		expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();
	});

	it('ignores unrelated preview shortcut and shows empty preview fallback', () => {
		const props = renderEditor({
			content: '',
			mode: 'preview',
		});

		const preview = document.querySelector('.doc-editor') as HTMLElement;
		fireEvent.keyDown(preview, { key: 'x', metaKey: true });

		expect(props.onModeChange).not.toHaveBeenCalled();
		expect(screen.getByText('No content yet.')).toBeInTheDocument();
	});

	it('renders locked edit-mode header controls as disabled', () => {
		const props = renderEditor({
			isLocked: true,
			mode: 'edit',
		});

		fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));

		expect(props.onModeChange).not.toHaveBeenCalledWith('edit');
		expect(screen.getByRole('button', { name: /^Edit$/ })).toBeDisabled();
	});

	it('renders active edit header controls and supports Ctrl+E from preview', () => {
		const editProps = renderEditor({ mode: 'edit' });

		expect(screen.getByRole('button', { name: /^Edit$/ })).toHaveClass('font-semibold');

		cleanup();

		const previewProps = renderEditor({ mode: 'preview' });
		const preview = document.querySelector('.doc-editor') as HTMLElement;
		fireEvent.keyDown(preview, { key: 'e', ctrlKey: true });

		expect(previewProps.onModeChange).toHaveBeenCalledWith('edit');
		expect(editProps.onModeChange).not.toHaveBeenCalled();
	});

	it('renders locked compact edit controls as disabled', () => {
		const props = renderEditor({
			showHeader: false,
			isLocked: true,
			mode: 'edit',
		});

		const editButton = screen.getByRole('button', { name: /^Edit$/ });
		expect(editButton).toHaveClass('opacity-50');
		expect(editButton).toBeDisabled();

		fireEvent.click(editButton);
		expect(props.onModeChange).not.toHaveBeenCalled();
	});

	it('renders preview images and mermaid blocks through markdown component seams', async () => {
		renderEditor({
			content: '![Diagram](images/diagram.png)\n\n```mermaid\ngraph TD\n```',
			mode: 'preview',
		});

		expect(await screen.findByAltText('Diagram')).toHaveAttribute(
			'src',
			'data:image/png;base64,local'
		);
		expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent('graph TD');
	});

	it('renders markdown images from local, data, remote, missing, invalid, and failed sources', async () => {
		const { rerender } = render(
			<MarkdownImage
				src="images/paste.png"
				alt="Local paste"
				folderPath="/tmp/docs"
				theme={mockTheme}
			/>
		);

		await waitFor(() => {
			expect(screen.getByAltText('Local paste')).toHaveAttribute(
				'src',
				'data:image/png;base64,local'
			);
		});
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/tmp/docs/images/paste.png');

		rerender(<MarkdownImage src="data:image/png;base64,direct" alt="Direct" theme={mockTheme} />);
		await waitFor(() => {
			expect(screen.getByAltText('Direct')).toHaveAttribute('src', 'data:image/png;base64,direct');
		});

		cleanup();
		const emptyAltView = render(
			<MarkdownImage src="data:image/png;base64,no-alt" theme={mockTheme} />
		);
		await waitFor(() => {
			expect(emptyAltView.container.querySelector('img')).toHaveAttribute('alt', '');
		});

		cleanup();
		render(<MarkdownImage src="relative.png" alt="Missing" theme={mockTheme} />);
		await waitFor(() => {
			expect(screen.queryByAltText('Missing')).not.toBeInTheDocument();
		});

		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('not-a-data-url');
		cleanup();
		render(
			<MarkdownImage
				src="images/invalid.png"
				alt="Invalid"
				folderPath="/tmp/docs"
				theme={mockTheme}
			/>
		);
		await waitFor(() => {
			expect(screen.queryByAltText('Invalid')).not.toBeInTheDocument();
		});

		cleanup();
		render(<MarkdownImage theme={mockTheme} />);
		await waitFor(() => {
			expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
		});

		vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(new Error('disk denied'));
		cleanup();
		render(
			<MarkdownImage src="images/fails.png" alt="Fails" folderPath="/tmp/docs" theme={mockTheme} />
		);
		await waitFor(() => {
			expect(screen.queryByAltText('Fails')).not.toBeInTheDocument();
		});
	});
});
