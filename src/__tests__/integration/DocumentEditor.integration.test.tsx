import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DocumentEditor,
	MarkdownImage,
} from '../../renderer/components/Wizard/shared/DocumentEditor';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import type { GeneratedDocument } from '../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../renderer/types';

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

const theme: Theme = {
	id: 'document-editor-integration',
	name: 'Document Editor Integration',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#0f172a',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		accentDim: '#1d4ed8',
		accentForeground: '#ffffff',
		border: '#374151',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#dc2626',
	},
};

const documents: GeneratedDocument[] = [
	{ filename: 'Phase-01-Setup.md', content: '# Setup', taskCount: 1 },
	{ filename: 'Phase-02-Build.md', content: '# Build', taskCount: 2 },
];

function renderEditor(overrides: Partial<React.ComponentProps<typeof DocumentEditor>> = {}) {
	const props: React.ComponentProps<typeof DocumentEditor> = {
		content: 'Hello [docs](https://example.com)\n\n![Local](images/local.png)',
		onContentChange: vi.fn(),
		mode: 'preview',
		onModeChange: vi.fn(),
		folderPath: '/tmp/autorun',
		selectedFile: 'Phase-01-Setup',
		attachments: [],
		onAddAttachment: vi.fn(),
		onRemoveAttachment: vi.fn(),
		theme,
		isLocked: false,
		textareaRef: React.createRef<HTMLTextAreaElement>(),
		previewRef: React.createRef<HTMLDivElement>(),
		documents,
		selectedDocIndex: 0,
		onDocumentSelect: vi.fn(),
		statsText: '3 tasks ready to run',
		...overrides,
	};

	const result = render(<DocumentEditor {...props} />);
	return { ...result, props };
}

function setSelection(textarea: HTMLTextAreaElement, start: number, end = start) {
	textarea.selectionStart = start;
	textarea.selectionEnd = end;
}

describe('DocumentEditor integration', () => {
	beforeEach(() => {
		useSettingsStore.setState({ bionifyReadingMode: false });
		window.maestro.fs.readFile = vi.fn().mockResolvedValue('data:image/png;base64,local');
		window.maestro.shell.openExternal = vi.fn().mockResolvedValue(undefined);
		(window.maestro.autorun as unknown as { saveImage: ReturnType<typeof vi.fn> }).saveImage = vi
			.fn()
			.mockResolvedValue({
				success: true,
				relativePath: 'images/Phase-01-Setup-paste.png',
			});
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('renders preview markdown, real document selection, and external link routing', async () => {
		useSettingsStore.setState({ bionifyReadingMode: true });
		const { props } = renderEditor({
			content:
				'Hello world [docs](https://example.com)\n\n![Local](images/local.png)\n\n```mermaid\ngraph TD\nA-->B\n```',
		});

		expect(screen.getByText('3 tasks ready to run')).toBeInTheDocument();
		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(await screen.findByTestId('mermaid-renderer')).toHaveTextContent('graph TD');
		expect(await screen.findByAltText('Local')).toHaveAttribute(
			'src',
			'data:image/png;base64,local'
		);
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/tmp/autorun/images/local.png');

		fireEvent.click(screen.getByRole('link', { name: 'docs' }));
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Phase-01-Setup.md' }));
		fireEvent.click(screen.getByRole('button', { name: 'Phase-02-Build.md' }));
		expect(props.onDocumentSelect).toHaveBeenCalledWith(1);

		fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
		expect(props.onModeChange).toHaveBeenCalledWith('edit');

		fireEvent.click(screen.getByRole('button', { name: /^Preview$/ }));
		expect(props.onModeChange).toHaveBeenCalledWith('preview');

		const preview = document.querySelector('.doc-editor') as HTMLElement;
		fireEvent.keyDown(preview, { key: 'e', ctrlKey: true });
		expect(props.onModeChange).toHaveBeenCalledWith('edit');
	});

	it('handles edit mode changes, shortcuts, and list continuations', async () => {
		const { props } = renderEditor({ mode: 'edit', content: 'abc' });
		const textarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;

		fireEvent.change(textarea, { target: { value: 'changed' } });
		expect(props.onContentChange).toHaveBeenCalledWith('changed');

		setSelection(textarea, 1, 2);
		fireEvent.keyDown(textarea, { key: 'Tab' });
		expect(props.onContentChange).toHaveBeenCalledWith('a\tc');

		fireEvent.keyDown(textarea, { key: 'e', metaKey: true });
		expect(props.onModeChange).toHaveBeenCalledWith('preview');

		const checkboxSetSelection = vi.spyOn(textarea, 'setSelectionRange');
		setSelection(textarea, 3);
		fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true });
		expect(props.onContentChange).toHaveBeenCalledWith('abc\n- [ ] ');
		await waitFor(() => expect(checkboxSetSelection).toHaveBeenCalledWith(10, 10));

		vi.mocked(props.onContentChange).mockClear();
		checkboxSetSelection.mockClear();
		setSelection(textarea, 0);
		fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true });
		expect(props.onContentChange).toHaveBeenCalledWith('- [ ] abc');
		await waitFor(() => expect(checkboxSetSelection).toHaveBeenCalledWith(6, 6));

		cleanup();

		const task = renderEditor({ mode: 'edit', content: '- [x] done' });
		const taskTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const taskSetSelection = vi.spyOn(taskTextarea, 'setSelectionRange');
		setSelection(taskTextarea, '- [x] done'.length);
		fireEvent.keyDown(taskTextarea, { key: 'Enter' });
		expect(task.props.onContentChange).toHaveBeenCalledWith('- [x] done\n- [ ] ');
		await waitFor(() =>
			expect(taskSetSelection).toHaveBeenCalledWith(
				'- [x] done\n- [ ] '.length,
				'- [x] done\n- [ ] '.length
			)
		);

		cleanup();

		const bullet = renderEditor({ mode: 'edit', content: '  * item' });
		const bulletTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const bulletSetSelection = vi.spyOn(bulletTextarea, 'setSelectionRange');
		setSelection(bulletTextarea, '  * item'.length);
		fireEvent.keyDown(bulletTextarea, { key: 'Enter' });
		expect(bullet.props.onContentChange).toHaveBeenCalledWith('  * item\n  * ');
		await waitFor(() =>
			expect(bulletSetSelection).toHaveBeenCalledWith(
				'  * item\n  * '.length,
				'  * item\n  * '.length
			)
		);
	});

	it('handles text and image paste paths through the Auto Run image bridge', async () => {
		const { props } = renderEditor({ mode: 'edit', content: 'hello world' });
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

		cleanup();

		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,abc123' } });
			}
		}
		vi.stubGlobal('FileReader', MockFileReader);

		const image = renderEditor({ mode: 'edit', content: 'Before\nAfter' });
		const imageTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const setSelectionRange = vi.spyOn(imageTextarea, 'setSelectionRange');
		const focus = vi.spyOn(imageTextarea, 'focus');
		setSelection(imageTextarea, 'Before'.length);

		fireEvent.paste(imageTextarea, {
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
				'Phase-01-Setup',
				'abc123',
				'png'
			);
			expect(image.props.onAddAttachment).toHaveBeenCalledWith(
				'Phase-01-Setup-paste.png',
				'data:image/png;base64,abc123'
			);
		});
		expect(image.props.onContentChange).toHaveBeenCalledWith(
			'Before\n![Phase-01-Setup-paste.png](images/Phase-01-Setup-paste.png)\nAfter'
		);
		const cursorAfterImage = 'Before\n![Phase-01-Setup-paste.png](images/Phase-01-Setup-paste.png)'
			.length;
		await waitFor(() => {
			expect(setSelectionRange).toHaveBeenCalledWith(cursorAfterImage, cursorAfterImage);
			expect(focus).toHaveBeenCalled();
		});

		cleanup();

		const suffix = renderEditor({ mode: 'edit', content: 'Before After' });
		const suffixTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		setSelection(suffixTextarea, 'Before'.length);
		fireEvent.paste(suffixTextarea, {
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
		await waitFor(() =>
			expect(suffix.props.onContentChange).toHaveBeenCalledWith(
				'Before\n![Phase-01-Setup-paste.png](images/Phase-01-Setup-paste.png)\n After'
			)
		);
	});

	it('ignores paste work when locked or clipboard image context is incomplete', async () => {
		const locked = renderEditor({ mode: 'edit', isLocked: true, content: 'locked' });
		const lockedTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		fireEvent.paste(lockedTextarea, {
			clipboardData: {
				items: [],
				getData: () => '  ignored  ',
			},
		});
		expect(locked.props.onContentChange).not.toHaveBeenCalled();

		cleanup();

		const noItems = renderEditor({ mode: 'edit', content: 'unchanged' });
		const noItemsTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		fireEvent.paste(noItemsTextarea, {
			clipboardData: {
				getData: () => '  ignored  ',
			},
		});
		expect(noItems.props.onContentChange).not.toHaveBeenCalled();

		cleanup();

		const missingContext = renderEditor({
			mode: 'edit',
			content: 'image',
			folderPath: '',
			selectedFile: '',
		});
		const missingContextTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		const getAsFile = vi.fn();
		fireEvent.paste(missingContextTextarea, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile }],
				getData: () => '',
			},
		});
		expect(getAsFile).not.toHaveBeenCalled();
		expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();

		cleanup();

		const noFile = renderEditor({ mode: 'edit', content: 'image' });
		const noFileTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		fireEvent.paste(noFileTextarea, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => null }],
				getData: () => '',
			},
		});
		expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();

		cleanup();

		class EmptyFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: '' } });
			}
		}
		vi.stubGlobal('FileReader', EmptyFileReader);

		const emptyData = renderEditor({ mode: 'edit', content: 'image' });
		const emptyDataTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		fireEvent.paste(emptyDataTextarea, {
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
		await waitFor(() => expect(emptyData.props.onContentChange).not.toHaveBeenCalled());
		expect(window.maestro.autorun.saveImage).not.toHaveBeenCalled();
	});

	it('covers attachments, compact mode, locked mode, and image fallbacks', async () => {
		const attachments = renderEditor({
			mode: 'edit',
			attachments: [{ filename: 'diagram.png', dataUrl: 'data:image/png;base64,diagram' }],
		});

		expect(screen.getByText('Attached Images (1)')).toBeInTheDocument();
		expect(screen.getByAltText('diagram.png')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Remove image'));
		expect(attachments.props.onRemoveAttachment).toHaveBeenCalledWith('diagram.png');
		fireEvent.click(screen.getByText('Attached Images (1)'));
		expect(screen.queryByAltText('diagram.png')).not.toBeInTheDocument();

		cleanup();

		const compact = renderEditor({ mode: 'preview', showHeader: false });
		expect(screen.queryByText('3 tasks ready to run')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
		expect(compact.props.onModeChange).toHaveBeenCalledWith('edit');

		cleanup();

		const compactEdit = renderEditor({ mode: 'edit', showHeader: false });
		fireEvent.click(screen.getByRole('button', { name: /^Preview$/ }));
		expect(compactEdit.props.onModeChange).toHaveBeenCalledWith('preview');

		cleanup();

		const locked = renderEditor({ mode: 'edit', isLocked: true });
		const lockedTextarea = screen.getByPlaceholderText(
			'Your task document will appear here...'
		) as HTMLTextAreaElement;
		fireEvent.change(lockedTextarea, { target: { value: 'blocked' } });
		fireEvent.keyDown(lockedTextarea, { key: 'Tab' });
		expect(locked.props.onContentChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /^Edit$/ })).toBeDisabled();

		cleanup();

		render(<MarkdownImage src="data:image/png;base64,direct" alt="Direct" theme={theme} />);
		expect(await screen.findByAltText('Direct')).toHaveAttribute(
			'src',
			'data:image/png;base64,direct'
		);

		cleanup();

		render(<MarkdownImage theme={theme} />);
		await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());

		cleanup();

		render(<MarkdownImage src="relative.png" alt="Missing" theme={theme} />);
		await waitFor(() => expect(screen.queryByAltText('Missing')).not.toBeInTheDocument());

		cleanup();

		window.maestro.fs.readFile = vi.fn().mockResolvedValue('not-a-data-url');
		render(
			<MarkdownImage src="images/bad.png" alt="Invalid" folderPath="/tmp/docs" theme={theme} />
		);
		await waitFor(() => expect(screen.queryByAltText('Invalid')).not.toBeInTheDocument());

		cleanup();

		window.maestro.fs.readFile = vi.fn().mockRejectedValue(new Error('disk denied'));
		render(
			<MarkdownImage src="images/fail.png" alt="Failure" folderPath="/tmp/docs" theme={theme} />
		);
		await waitFor(() => expect(screen.queryByAltText('Failure')).not.toBeInTheDocument());
	});
});
