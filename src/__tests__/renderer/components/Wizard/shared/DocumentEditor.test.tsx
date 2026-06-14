import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentEditor } from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../../../renderer/utils/sentry', () => sentryMocks);

vi.mock('../../../../../renderer/components/Wizard/shared/DocumentSelector', () => ({
	DocumentSelector: ({ selectedIndex }: { selectedIndex: number }) => (
		<div data-testid="document-selector">Selected {selectedIndex}</div>
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

function createProps(overrides: Partial<React.ComponentProps<typeof DocumentEditor>> = {}) {
	return {
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
		textareaRef: React.createRef<HTMLTextAreaElement>(),
		previewRef: React.createRef<HTMLDivElement>(),
		documents: [{ filename: 'draft.md', content: '# Draft', taskCount: 1 }],
		selectedDocIndex: 0,
		onDocumentSelect: vi.fn(),
		statsText: '1 task ready to run',
		...overrides,
	};
}

describe('DocumentEditor', () => {
	beforeEach(() => {
		useSettingsStore.setState({ bionifyReadingMode: false });
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('applies reading mode in preview while leaving links and code untouched', () => {
		useSettingsStore.setState({ bionifyReadingMode: true });
		const props = createProps();

		render(<DocumentEditor {...props} />);

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(screen.getByText('code sample')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'example link' })).toBeInTheDocument();
		expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
	});

	it('renders the selector, stats, and edit controls in the shared header', () => {
		render(<DocumentEditor {...createProps()} />);

		expect(screen.getByTestId('document-selector')).toHaveTextContent('Selected 0');
		expect(screen.getByText('1 task ready to run')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
	});

	it('updates content from the textarea and respects locked editing', () => {
		const unlockedProps = createProps({ mode: 'edit' });
		render(<DocumentEditor {...unlockedProps} />);

		fireEvent.change(screen.getByRole('textbox'), { target: { value: '# Changed' } });
		expect(unlockedProps.onContentChange).toHaveBeenCalledWith('# Changed');

		const lockedProps = createProps({ mode: 'edit', isLocked: true });
		render(<DocumentEditor {...lockedProps} />);
		const textareas = screen.getAllByRole('textbox');
		fireEvent.change(textareas[1], { target: { value: '# Ignored' } });
		expect(lockedProps.onContentChange).not.toHaveBeenCalled();
	});

	it('routes edit and preview button clicks through mode changes', () => {
		const props = createProps({ mode: 'preview' });
		render(<DocumentEditor {...props} />);

		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(props.onModeChange).toHaveBeenCalledWith('edit');

		fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
		expect(props.onModeChange).toHaveBeenCalledWith('preview');
	});

	it('handles textarea keyboard commands for tab, checkboxes, lists, and mode toggle', () => {
		const props = createProps({ mode: 'edit', content: '- [ ] First' });
		render(<DocumentEditor {...props} />);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

		textarea.setSelectionRange(5, 5);
		fireEvent.keyDown(textarea, { key: 'Tab' });
		expect(props.onContentChange).toHaveBeenCalledWith('- [ ]\t First');

		textarea.setSelectionRange(props.content.length, props.content.length);
		fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true });
		expect(props.onContentChange).toHaveBeenCalledWith('- [ ] First\n- [ ] ');

		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(props.onContentChange).toHaveBeenCalledWith('- [ ] First\n- [ ] ');

		fireEvent.keyDown(textarea, { key: 'e', ctrlKey: true });
		expect(props.onModeChange).toHaveBeenCalledWith('preview');
	});

	it('handles the preview keyboard shortcut back to edit mode', () => {
		const props = createProps({ mode: 'preview' });
		const { container } = render(<DocumentEditor {...props} />);
		const preview = container.querySelector('.doc-editor') as HTMLElement;

		fireEvent.keyDown(preview, { key: 'e', ctrlKey: true });

		expect(props.onModeChange).toHaveBeenCalledWith('edit');
	});

	it('renders, collapses, and removes attachments in edit mode', () => {
		const props = createProps({
			mode: 'edit',
			attachments: [{ filename: 'images/a.png', dataUrl: 'data:image/png;base64,abc' }],
		});
		render(<DocumentEditor {...props} />);

		expect(screen.getByAltText('images/a.png')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Attached Images/i }));
		expect(screen.queryByAltText('images/a.png')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Attached Images/i }));
		fireEvent.click(screen.getByTitle('Remove image'));
		expect(props.onRemoveAttachment).toHaveBeenCalledWith('images/a.png');
	});

	it('trims whitespace-only text paste changes at the cursor', () => {
		const props = createProps({ mode: 'edit', content: 'Hello world' });
		render(<DocumentEditor {...props} />);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		textarea.setSelectionRange(6, 11);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => '  Maestro  ',
			},
		});

		expect(props.onContentChange).toHaveBeenCalledWith('Hello Maestro');
	});

	it('saves pasted images, adds an attachment, and inserts markdown', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;

			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,abc' } });
			}
		}

		vi.stubGlobal('FileReader', MockFileReader);
		vi.mocked(window.maestro.autorun.saveImage).mockResolvedValueOnce({
			success: true,
			relativePath: 'images/draft-1.png',
		});

		const props = createProps({ mode: 'edit', content: '# Hi' });
		render(<DocumentEditor {...props} />);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		textarea.setSelectionRange(4, 4);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/png',
						getAsFile: () => new File(['image'], 'clip.png', { type: 'image/png' }),
					},
				],
				getData: () => '',
			},
		});

		await waitFor(() => {
			expect(window.maestro.autorun.saveImage).toHaveBeenCalledWith(
				'/tmp/autorun',
				'draft',
				'abc',
				'png'
			);
		});
		expect(props.onAddAttachment).toHaveBeenCalledWith('draft-1.png', 'data:image/png;base64,abc');
		expect(props.onContentChange).toHaveBeenCalledWith('# Hi\n![draft-1.png](images/draft-1.png)');
	});

	it('reports pasted image save failures without changing editor content', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			onerror: (() => void) | null = null;

			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,abc' } });
			}
		}

		vi.stubGlobal('FileReader', MockFileReader);
		vi.mocked(window.maestro.autorun.saveImage).mockResolvedValueOnce({
			success: false,
			error: 'disk full',
		});

		const props = createProps({ mode: 'edit', content: '# Hi' });
		render(<DocumentEditor {...props} />);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		textarea.setSelectionRange(4, 4);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/png',
						getAsFile: () => new File(['image'], 'clip.png', { type: 'image/png' }),
					},
				],
				getData: () => '',
			},
		});

		await waitFor(() => {
			expect(sentryMocks.captureMessage).toHaveBeenCalledWith(
				'Pasted image save failed',
				expect.objectContaining({
					extra: expect.objectContaining({ selectedFile: 'draft', error: 'disk full' }),
				})
			);
		});
		expect(sentryMocks.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'disk full' }),
			expect.any(Object)
		);
		expect(props.onAddAttachment).not.toHaveBeenCalled();
		expect(props.onContentChange).not.toHaveBeenCalled();
	});

	it('inserts pasted image markdown into the latest textarea value after async save', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;

			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,abc' } });
			}
		}

		let resolveSave: (
			value: Awaited<ReturnType<typeof window.maestro.autorun.saveImage>>
		) => void = () => {};
		vi.stubGlobal('FileReader', MockFileReader);
		vi.mocked(window.maestro.autorun.saveImage).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSave = resolve;
			})
		);

		const props = createProps({ mode: 'edit', content: '# Hi' });
		render(<DocumentEditor {...props} />);
		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		textarea.setSelectionRange(4, 4);

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [
					{
						type: 'image/png',
						getAsFile: () => new File(['image'], 'clip.png', { type: 'image/png' }),
					},
				],
				getData: () => '',
			},
		});

		textarea.value = '# Hi\nStill typing';

		await act(async () => {
			resolveSave({ success: true, relativePath: 'images/draft-1.png' });
		});

		await waitFor(() => {
			expect(props.onContentChange).toHaveBeenCalledWith(
				'# Hi\n![draft-1.png](images/draft-1.png)\nStill typing'
			);
		});
	});
});
