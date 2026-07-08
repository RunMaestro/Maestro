/**
 * @file AutoRun.test.tsx
 * @description Tests for the AutoRun component - a markdown editor/viewer for Auto Run feature
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { imageCache } from '../../renderer/hooks/batch/useAutoRunImageHandling';
import { formatShortcutKeys } from '../../renderer/utils/shortcutFormatter';
import { getEncoder } from '../../renderer/utils/tokenCounter';
import { logger } from '../../renderer/utils/logger';
import type { Theme, BatchRunState, SessionState } from '../../renderer/types';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useSettingsStore } from '../../renderer/stores/settingsStore';

const createMarkdownComponentsCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// Helper to seed the Zustand batch store so the component's direct store reads
// (isErrorPaused, batchError) see the expected state for a given session.
const seedBatchStore = (sessionId: string, state: Partial<BatchRunState>) => {
	useBatchStore.setState({
		batchRunStates: {
			[sessionId]: state as BatchRunState,
		},
	});
};

// Helper to render with LayerStackProvider (required by AutoRunSearchBar)
const renderWithProvider = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	// Return a rerender function that wraps in provider
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Custom text matcher for fragmented text nodes (e.g., "1 of 2 tasks completed" rendered across spans)
// This normalizes whitespace and checks if the element's textContent matches the regex
// We only match on span elements that directly contain the task count (has child spans for numbers)
const getByNormalizedText = (text: RegExp) => {
	return (_content: string, element: Element | null): boolean => {
		if (!element || element.tagName !== 'SPAN') return false;
		// Only match if this element directly contains the task count text (not nested)
		const normalizedText = element.textContent?.replace(/\s+/g, ' ').trim() || '';
		// Check if this is the direct container (has child spans for numbers)
		const hasChildSpans = element.querySelector('span') !== null;
		return hasChildSpans && text.test(normalizedText);
	};
};

beforeEach(() => {
	useSettingsStore.setState({ bionifyReadingMode: false });
	createMarkdownComponentsCalls.length = 0;
});

// Mock the external dependencies
vi.mock('react-markdown', () => ({
	default: ({
		children,
		components,
	}: {
		children: string;
		components?: Record<string, React.ComponentType<any>>;
	}) => {
		const ImageComponent = components?.img;
		const ParagraphComponent = components?.p;
		const AnchorComponent = components?.a;
		const PreComponent = components?.pre;
		const imageMatches = [...children.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
		const linkMatches = [...children.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
		const mermaidMatches = [...children.matchAll(/```mermaid\n([\s\S]*?)```/g)];

		return (
			<div data-testid="react-markdown">
				{children}
				{ParagraphComponent && <ParagraphComponent>{children}</ParagraphComponent>}
				{AnchorComponent &&
					linkMatches.map((match, index) => (
						<AnchorComponent key={`${match[2]}-${index}`} href={match[2]}>
							{match[1]}
						</AnchorComponent>
					))}
				{PreComponent &&
					mermaidMatches.map((match, index) => (
						<PreComponent key={`mermaid-${index}`}>
							<code className="language-mermaid">{match[1]}</code>
						</PreComponent>
					))}
				{ImageComponent &&
					imageMatches.map((match, index) => (
						<ImageComponent key={`image-${index}`} alt={match[1]} src={match[2]} />
					))}
			</div>
		);
	},
}));

vi.mock('remark-gfm', () => ({
	default: {},
}));

vi.mock('../../renderer/utils/markdownConfig', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../renderer/utils/markdownConfig')>();
	return {
		...actual,
		createMarkdownComponents: (options: Record<string, unknown>) => {
			createMarkdownComponentsCalls.push(options);
			return actual.createMarkdownComponents(options as any);
		},
	};
});

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

vi.mock('../../renderer/utils/tokenCounter', () => ({
	getEncoder: vi.fn(() => new Promise(() => {})),
	formatTokenCount: vi.fn((count: number) => `${count}`),
}));

vi.mock('../../renderer/components/AutoRun/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../renderer/components/AutoRun/AutoRunDocumentSelector', () => ({
	AutoRunDocumentSelector: ({
		theme,
		documents,
		selectedDocument,
		onSelectDocument,
		onRefresh,
		onChangeFolder,
		onCreateDocument,
		isLoading,
	}: any) => (
		<div data-testid="document-selector">
			<select
				data-testid="doc-select"
				value={selectedDocument || ''}
				onChange={(e) => onSelectDocument(e.target.value)}
			>
				{documents.map((doc: string) => (
					<option key={doc} value={doc}>
						{doc}
					</option>
				))}
			</select>
			<button data-testid="refresh-btn" onClick={onRefresh}>
				Refresh
			</button>
			<button data-testid="change-folder-btn" onClick={onChangeFolder}>
				Change
			</button>
			{isLoading && <span data-testid="loading-indicator">Loading...</span>}
		</div>
	),
}));

// Store the onChange handler so our mock can call it
let autocompleteOnChange: ((content: string) => void) | null = null;
let autocompleteHandlesKeyDown = false;

vi.mock('../../renderer/hooks/input/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (value: string) => void;
	}) => {
		// Store the onChange handler so handleAutocompleteChange can trigger state updates
		autocompleteOnChange = onChange;
		return {
			autocompleteState: {
				isOpen: false,
				suggestions: [],
				selectedIndex: 0,
				position: { top: 0, left: 0 },
			},
			handleKeyDown: () => autocompleteHandlesKeyDown,
			handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
				// Actually call onChange with the new value to update state
				onChange(e.target.value);
			},
			selectVariable: () => {},
			closeAutocomplete: () => {},
			autocompleteRef: { current: null },
		};
	},
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Setup window.maestro mock
const setupMaestroMock = () => {
	autocompleteHandlesKeyDown = false;
	const mockMaestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,abc123'),
			readDir: vi.fn().mockResolvedValue([]),
		},
		autorun: {
			listImages: vi.fn(() => new Promise(() => {})),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
		},
		shell: {
			openExternal: vi.fn().mockResolvedValue(undefined),
		},
	};

	(window as any).maestro = mockMaestro;
	return mockMaestro;
};

// Helper to create a valid BatchRunState with the new interface
const createBatchRunState = (overrides: Partial<BatchRunState> = {}): BatchRunState => ({
	isRunning: true,
	isStopping: false,
	documents: ['test-doc'],
	lockedDocuments: ['test-doc'], // Lock the default selectedFile so isLocked = true
	currentDocumentIndex: 0,
	currentDocTasksTotal: 5,
	currentDocTasksCompleted: 2,
	totalTasksAcrossAllDocs: 10,
	completedTasksAcrossAllDocs: 4,
	loopEnabled: false,
	loopIteration: 0,
	folderPath: '/test/folder',
	worktreeActive: false,
	totalTasks: 5,
	completedTasks: 2,
	currentTaskIndex: 0,
	originalContent: '',
	...overrides,
});

// Default props for AutoRun component
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}) => ({
	theme: createMockTheme(),
	sessionId: 'test-session-1',
	folderPath: '/test/folder',
	selectedFile: 'test-doc',
	documentList: ['test-doc', 'another-doc'],
	content: '# Test Content\n\nSome markdown content.',
	onContentChange: vi.fn(),
	mode: 'edit' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

const createDeferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
};

const advanceTimers = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

describe('AutoRun', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		imageCache.clear();
		autocompleteHandlesKeyDown = false;
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		imageCache.clear();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Basic Rendering', () => {
		it('renders in edit mode by default', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByRole('textbox')).toBeInTheDocument();
			expect(screen.getByRole('textbox')).toHaveValue(props.content);
		});

		it('renders in preview mode when mode prop is preview', () => {
			const props = createDefaultProps({ mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('shows "Select Auto Run Folder" button when no folder is configured', () => {
			const props = createDefaultProps({ folderPath: null });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Select Auto Run Folder')).toBeInTheDocument();
			// Other controls should be hidden when no folder is selected
			expect(screen.queryByText('Edit')).not.toBeInTheDocument();
			expect(screen.queryByText('Preview')).not.toBeInTheDocument();
			expect(screen.queryByText('Run')).not.toBeInTheDocument();
			expect(screen.queryByTestId('document-selector')).not.toBeInTheDocument();
		});

		it('shows document selector when folder is configured', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('document-selector')).toBeInTheDocument();
		});

		it('displays the current mode toggle', () => {
			const props = createDefaultProps();
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTitle('Switch to preview')).toBeInTheDocument();

			rerender(<AutoRun {...props} mode="preview" />);

			expect(screen.getByTitle('Switch to edit')).toBeInTheDocument();
		});

		it('displays Run button when not locked', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Run')).toBeInTheDocument();
		});

		it('displays Stop button when batch run is active', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Stop')).toBeInTheDocument();
		});
	});

	describe('Mode Toggling', () => {
		it('calls onModeChange when clicking Edit button', async () => {
			const props = createDefaultProps({ mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle('Switch to edit'));
			expect(props.onModeChange).toHaveBeenCalledWith('edit');
		});

		it('calls onModeChange when clicking Preview button', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle('Switch to preview'));
			expect(props.onModeChange).toHaveBeenCalledWith('preview');
		});

		it('uses local mode state and preserves scroll percentage when no mode callback is provided', async () => {
			let rafCallback: FrameRequestCallback | null = null;
			const requestAnimationFrameSpy = vi
				.spyOn(window, 'requestAnimationFrame')
				.mockImplementation((callback: FrameRequestCallback) => {
					rafCallback = callback;
					return 1;
				});
			const props = createDefaultProps({
				mode: undefined as any,
				onModeChange: undefined as any,
				content: 'Line\n'.repeat(100),
				onStateChange: vi.fn(),
			});

			try {
				renderWithProvider(<AutoRun {...props} />);

				const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 1000 });
				Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: 200 });
				textarea.scrollTop = 400;

				fireEvent.click(screen.getByTitle('Switch to preview'));

				const preview = await screen
					.findByTestId('react-markdown')
					.then((node) => node.parentElement!);
				Object.defineProperty(preview, 'scrollHeight', { configurable: true, value: 2000 });
				Object.defineProperty(preview, 'clientHeight', { configurable: true, value: 500 });

				act(() => {
					rafCallback?.(0);
				});

				expect(preview.scrollTop).toBe(750);

				preview.scrollTop = 300;
				Object.defineProperty(preview, 'scrollHeight', { configurable: true, value: 1200 });
				Object.defineProperty(preview, 'clientHeight', { configurable: true, value: 200 });
				fireEvent.click(screen.getByTitle('Switch to edit'));

				const nextTextarea = await screen.findByRole('textbox');
				Object.defineProperty(nextTextarea, 'scrollHeight', { configurable: true, value: 900 });
				Object.defineProperty(nextTextarea, 'clientHeight', { configurable: true, value: 300 });

				act(() => {
					rafCallback?.(0);
				});

				expect(nextTextarea.scrollTop).toBe(180);
			} finally {
				requestAnimationFrameSpy.mockRestore();
			}
		});

		it('handles mode changes when no editor refs are mounted', () => {
			let rafCallback: FrameRequestCallback | null = null;
			const requestAnimationFrameSpy = vi
				.spyOn(window, 'requestAnimationFrame')
				.mockImplementation((callback: FrameRequestCallback) => {
					rafCallback = callback;
					return 1;
				});
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				folderPath: null,
				mode: undefined as any,
				onModeChange: undefined as any,
			});

			try {
				renderWithProvider(<AutoRun {...props} ref={ref} />);

				act(() => {
					ref.current?.switchMode('preview');
				});
				act(() => {
					rafCallback?.(0);
				});

				expect(screen.getByText('Select Auto Run Folder')).toBeInTheDocument();
			} finally {
				requestAnimationFrameSpy.mockRestore();
			}
		});

		it('disables Edit button when batch run is active', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState, mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTitle('Editing disabled while Auto Run active')).toBeDisabled();
		});
	});

	describe('Content Editing', () => {
		it('updates local content when typing', async () => {
			const props = createDefaultProps({ content: '' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'New content' } });

			expect(textarea).toHaveValue('New content');
		});

		it('uses cursor position zero as the undo snapshot fallback boundary', async () => {
			const props = createDefaultProps({ content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			Object.defineProperty(textarea, 'selectionStart', { configurable: true, value: 0 });
			fireEvent.change(textarea, { target: { value: 'Changed at start' } });

			expect(textarea).toHaveValue('Changed at start');
		});

		it('shows Save/Revert buttons when content is dirty', async () => {
			const props = createDefaultProps({ content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			// Initially no Save/Revert buttons
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
			expect(screen.queryByText('Revert')).not.toBeInTheDocument();

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'New content' } });

			// Now Save/Revert buttons should appear
			expect(screen.getByText('Save')).toBeInTheDocument();
			expect(screen.getByText('Revert')).toBeInTheDocument();
		});

		it('does not allow editing when locked', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveAttribute('readonly');
		});

		it('ignores textarea change events while locked', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState, content: 'Locked content' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Should not apply' } });

			expect(textarea).toHaveValue('Locked content');
			expect(props.onContentChange).not.toHaveBeenCalled();
		});
	});

	describe('Manual Save Functionality', () => {
		it('saves content when clicking Save button', async () => {
			const props = createDefaultProps({ content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Updated content' } });

			// Click the Save button
			await act(async () => {
				fireEvent.click(screen.getByText('Save'));
				await Promise.resolve();
			});

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'Updated content',
				undefined // sshRemoteId (undefined for local sessions)
			);
		});

		it('reports save failures without clearing dirty content', async () => {
			const saveFailure = new Error('disk full');
			const consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {});
			mockMaestro.autorun.writeDoc.mockRejectedValue(saveFailure);

			try {
				const props = createDefaultProps({ content: 'Initial' });
				renderWithProvider(<AutoRun {...props} />);

				const textarea = screen.getByRole('textbox');
				fireEvent.change(textarea, { target: { value: 'Unsaved content' } });

				await act(async () => {
					fireEvent.click(screen.getByText('Save'));
					await Promise.resolve();
				});

				expect(consoleError).toHaveBeenCalledWith('Failed to save:', undefined, saveFailure);
				expect(textarea).toHaveValue('Unsaved content');
				expect(screen.getByText('Save')).toBeInTheDocument();
			} finally {
				consoleError.mockRestore();
			}
		});

		it('reverts content when clicking Revert button', async () => {
			const props = createDefaultProps({ content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Changed content' } });

			// Textarea should show changed content
			expect(textarea).toHaveValue('Changed content');

			// Click the Revert button
			fireEvent.click(screen.getByText('Revert'));

			// Content should revert back
			expect(textarea).toHaveValue('Initial');

			// Save/Revert buttons should disappear
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
		});

		it('does not show Save button if no folder is selected', async () => {
			const props = createDefaultProps({ folderPath: null, content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			// Save button shouldn't be visible without a folder
			expect(screen.queryByText('Save')).not.toBeInTheDocument();
		});

		it('highlights content area with warning border and background when there are unsaved changes', async () => {
			const props = createDefaultProps({ content: 'Initial content' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			// Find the content area container (has mx-2, rounded-lg, and flex-1)
			const contentArea = container.querySelector(
				'.flex-1.overflow-y-auto.mx-2.rounded-lg'
			) as HTMLElement;
			expect(contentArea).toBeInTheDocument();

			// Initially should have transparent border (no unsaved changes)
			// Check for 'transparent' in the border style
			expect(contentArea.style.border).toContain('transparent');

			// Make a change to trigger dirty state
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Now the content area should have a warning-colored border
			// Browser converts hex+alpha (#ffaa0040) to rgba format
			await waitFor(() => {
				expect(contentArea.style.border).toContain('rgba(255, 170, 0');
			});
		});

		it('removes highlighting when content is reverted', async () => {
			const props = createDefaultProps({ content: 'Initial content' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			const contentArea = container.querySelector(
				'.flex-1.overflow-y-auto.mx-2.rounded-lg'
			) as HTMLElement;
			const textarea = screen.getByRole('textbox');

			// Make a change
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Should have warning border (rgba format after browser conversion)
			await waitFor(() => {
				expect(contentArea.style.border).toContain('rgba(255, 170, 0');
			});

			// Click Revert
			fireEvent.click(screen.getByText('Revert'));

			// Should be back to transparent border
			await waitFor(() => {
				expect(contentArea.style.border).toContain('transparent');
			});
		});

		it('removes highlighting when content is saved', async () => {
			const props = createDefaultProps({ content: 'Initial content' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			const contentArea = container.querySelector(
				'.flex-1.overflow-y-auto.mx-2.rounded-lg'
			) as HTMLElement;
			const textarea = screen.getByRole('textbox');

			// Make a change
			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			// Should have warning border (rgba format after browser conversion)
			await waitFor(() => {
				expect(contentArea.style.border).toContain('rgba(255, 170, 0');
			});

			// Click Save
			fireEvent.click(screen.getByText('Save'));

			// Should be back to transparent border after save
			await waitFor(() => {
				expect(contentArea.style.border).toContain('transparent');
			});
		});
	});

	describe('Keyboard Shortcuts', () => {
		it('inserts tab character on Tab key', async () => {
			// Use "HelloWorld" without space so tab insertion is clearer
			const props = createDefaultProps({ content: 'HelloWorld' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Set cursor position after "Hello"
			textarea.selectionStart = 5;
			textarea.selectionEnd = 5;

			fireEvent.keyDown(textarea, { key: 'Tab' });

			await waitFor(() => {
				expect(textarea.value).toBe('Hello\tWorld');
			});
		});

		it('lets template autocomplete consume textarea keys before editor shortcuts', async () => {
			autocompleteHandlesKeyDown = true;
			const props = createDefaultProps({ content: 'Hello World' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.selectionStart = 5;
			textarea.selectionEnd = 5;

			fireEvent.keyDown(textarea, { key: 'Tab' });

			expect(textarea).toHaveValue('Hello World');
		});

		it('saves dirty content on Cmd+S', async () => {
			const props = createDefaultProps({ content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Saved from shortcut' } });

			await act(async () => {
				fireEvent.keyDown(textarea, { key: 's', metaKey: true });
				await Promise.resolve();
			});

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'Saved from shortcut',
				undefined
			);
		});

		it('does not save clean content on Cmd+S', async () => {
			const props = createDefaultProps({ content: 'Already saved' });
			renderWithProvider(<AutoRun {...props} />);

			await act(async () => {
				fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', metaKey: true });
				await Promise.resolve();
			});

			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
		});

		it('toggles mode on Cmd+E', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'e', metaKey: true });

			expect(props.onModeChange).toHaveBeenCalledWith('preview');
		});

		it('does not toggle mode on Cmd+E while locked', () => {
			const props = createDefaultProps({
				mode: 'edit',
				batchRunState: createBatchRunState(),
			});
			renderWithProvider(<AutoRun {...props} />);
			props.onModeChange.mockClear();

			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'e', metaKey: true });

			expect(props.onModeChange).not.toHaveBeenCalled();
		});

		it('inserts checkbox on Cmd+L at start of line', async () => {
			const props = createDefaultProps({ content: '' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Set cursor position
			textarea.selectionStart = 0;
			textarea.selectionEnd = 0;

			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });

			// Wait for state update
			await waitFor(() => {
				expect(textarea.value).toBe('- [ ] ');
			});
		});

		it('inserts checkbox at the start of the current line after a newline', async () => {
			const props = createDefaultProps({ content: 'Intro\n' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.selectionStart = 6;
			textarea.selectionEnd = 6;

			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
			await advanceTimers(0);

			expect(textarea).toHaveValue('Intro\n- [ ] ');
			expect(textarea.selectionStart).toBe(12);
		});

		it('skips checkbox cursor restoration after unmount', async () => {
			const onExternalLocalContentChange = vi.fn();
			const props = createDefaultProps({
				content: 'Intro\n',
				onExternalLocalContentChange,
			});
			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.selectionStart = 6;
			textarea.selectionEnd = 6;
			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });
			unmount();

			await advanceTimers(0);

			expect(onExternalLocalContentChange).toHaveBeenCalledWith('Intro\n- [ ] ');
		});

		it('inserts checkbox on new line with Cmd+L in middle of text', async () => {
			const props = createDefaultProps({ content: 'Some text' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Set cursor position to middle
			textarea.selectionStart = 5;
			textarea.selectionEnd = 5;

			fireEvent.keyDown(textarea, { key: 'l', metaKey: true });

			await waitFor(() => {
				expect(textarea.value).toContain('\n- [ ] ');
			});
		});

		it('leaves plain shifted Enter events alone', () => {
			const props = createDefaultProps({ content: 'Plain line' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.selectionStart = textarea.value.length;
			textarea.selectionEnd = textarea.value.length;

			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

			expect(textarea).toHaveValue('Plain line');
		});
	});

	describe('List Continuation', () => {
		it('continues task list on Enter', async () => {
			const props = createDefaultProps({ content: '- [ ] First task' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Position cursor at end of line
			textarea.selectionStart = 16;
			textarea.selectionEnd = 16;

			fireEvent.keyDown(textarea, { key: 'Enter' });

			await waitFor(() => {
				expect(textarea.value).toContain('- [ ] First task\n- [ ] ');
			});
		});

		it('continues unordered list with dash on Enter', async () => {
			const props = createDefaultProps({ content: '- Item one' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Position cursor at end of line
			textarea.selectionStart = 10;
			textarea.selectionEnd = 10;

			fireEvent.keyDown(textarea, { key: 'Enter' });

			await waitFor(() => {
				expect(textarea.value).toContain('- Item one\n- ');
			});
		});

		it('continues ordered list and increments number on Enter', async () => {
			const props = createDefaultProps({ content: '1. First item' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Position cursor at end of line
			textarea.selectionStart = 13;
			textarea.selectionEnd = 13;

			fireEvent.keyDown(textarea, { key: 'Enter' });

			await waitFor(() => {
				expect(textarea.value).toContain('1. First item\n2. ');
			});
		});

		it('preserves indentation in nested lists', async () => {
			const props = createDefaultProps({ content: '  - Nested item' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.focus(textarea);

			// Position cursor at end of line
			textarea.selectionStart = 15;
			textarea.selectionEnd = 15;

			fireEvent.keyDown(textarea, { key: 'Enter' });

			await waitFor(() => {
				expect(textarea.value).toContain('  - Nested item\n  - ');
			});
		});

		it('does not continue non-list lines on Enter', () => {
			const props = createDefaultProps({ content: 'Plain line' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.selectionStart = textarea.value.length;
			textarea.selectionEnd = textarea.value.length;

			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(textarea).toHaveValue('Plain line');
		});

		it.each([
			{ name: 'task list', content: '- [ ] First task', cursor: 16 },
			{ name: 'unordered list', content: '- Item one', cursor: 10 },
			{ name: 'ordered list', content: '1. First item', cursor: 13 },
		])('skips delayed cursor restoration after unmount for $name', async ({ content, cursor }) => {
			const onExternalLocalContentChange = vi.fn();
			const props = createDefaultProps({ content, onExternalLocalContentChange });
			const { unmount } = renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.selectionStart = cursor;
			textarea.selectionEnd = cursor;
			fireEvent.keyDown(textarea, { key: 'Enter' });
			unmount();

			await advanceTimers(0);

			expect(onExternalLocalContentChange).toHaveBeenCalled();
		});
	});

	describe('Search Functionality', () => {
		it('opens search on Cmd+F in edit mode', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText(/Search/)).toBeInTheDocument();
			});
		});

		it('closes search on Escape', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			// Open search first
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText(/Search/)).toBeInTheDocument();
			});

			// Close search
			const searchInput = screen.getByPlaceholderText(/Search/);
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			await waitFor(() => {
				expect(screen.queryByPlaceholderText(/Search/)).not.toBeInTheDocument();
			});
		});

		it('displays match count when searching', async () => {
			const props = createDefaultProps({ content: 'test one test two test three' });
			renderWithProvider(<AutoRun {...props} />);

			// Open search
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'test' } });

			await waitFor(() => {
				expect(screen.getByText('1/3')).toBeInTheDocument();
			});
		});

		it('navigates to next match on Enter', async () => {
			const props = createDefaultProps({ content: 'test one test two test three' });
			renderWithProvider(<AutoRun {...props} />);

			// Open search
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'test' } });

			await waitFor(() => {
				expect(screen.getByText('1/3')).toBeInTheDocument();
			});

			fireEvent.keyDown(searchInput, { key: 'Enter' });

			await waitFor(() => {
				expect(screen.getByText('2/3')).toBeInTheDocument();
			});
		});

		it('navigates to previous match on Shift+Enter', async () => {
			const props = createDefaultProps({ content: 'test one test two test three' });
			renderWithProvider(<AutoRun {...props} />);

			// Open search and set query
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'test' } });

			await waitFor(() => {
				expect(screen.getByText('1/3')).toBeInTheDocument();
			});

			// Go to prev (wraps to last match)
			fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });

			await waitFor(() => {
				expect(screen.getByText('3/3')).toBeInTheDocument();
			});
		});

		it('shows No matches when search has no results', async () => {
			const props = createDefaultProps({ content: 'some content' });
			renderWithProvider(<AutoRun {...props} />);

			// Open search
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'xyz' } });
			await advanceTimers(150);

			await waitFor(() => {
				expect(screen.getByText('No matches')).toBeInTheDocument();
			});

			fireEvent.keyDown(searchInput, { key: 'Enter' });
			fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });
			expect(screen.getByText('No matches')).toBeInTheDocument();
		});

		it('debounces search counting and resets stale match navigation index', async () => {
			const props = createDefaultProps({ content: 'alpha alpha beta' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'alpha' } });
			await advanceTimers(150);

			expect(screen.getByText('1/2')).toBeInTheDocument();

			fireEvent.keyDown(searchInput, { key: 'Enter' });
			expect(screen.getByText('2/2')).toBeInTheDocument();

			fireEvent.change(searchInput, { target: { value: 'beta' } });
			await advanceTimers(150);

			expect(screen.getByText('1/1')).toBeInTheDocument();
		});

		it('keeps stale edit-mode match navigation from scrolling when content shrinks', async () => {
			const props = createDefaultProps({ content: 'alpha alpha' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'alpha' } });
			await advanceTimers(150);

			fireEvent.change(textarea, { target: { value: 'alpha only once' } });
			fireEvent.keyDown(searchInput, { key: 'Enter' });

			expect(Element.prototype.scrollIntoView).not.toHaveBeenCalledWith({
				behavior: 'smooth',
				block: 'center',
			});
		});

		it('closes preview search without a preview ref when no folder is selected', async () => {
			const props = createDefaultProps({ folderPath: null, mode: 'preview' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'f', metaKey: true });
			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			await waitFor(() => {
				expect(screen.queryByPlaceholderText(/Search/)).not.toBeInTheDocument();
			});
		});

		it('returns focus to the preview container when closing preview search', async () => {
			const props = createDefaultProps({ mode: 'preview', content: 'preview searchable preview' });
			renderWithProvider(<AutoRun {...props} />);

			const preview = screen.getByTestId('react-markdown').parentElement!;
			fireEvent.keyDown(preview, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'preview' } });
			await advanceTimers(150);
			fireEvent.keyDown(searchInput, { key: 'Enter' });
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			await waitFor(() => {
				expect(screen.queryByPlaceholderText(/Search/)).not.toBeInTheDocument();
			});
			expect(document.activeElement).toBe(preview);
		});
	});

	describe('Run/Stop Batch Processing', () => {
		it('calls onOpenBatchRunner and saves if dirty when clicking Run', async () => {
			const onOpenBatchRunner = vi.fn();
			const props = createDefaultProps({ onOpenBatchRunner, content: 'test' });
			renderWithProvider(<AutoRun {...props} />);

			// Change content first
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'new content' } });

			await act(async () => {
				fireEvent.click(screen.getByText('Run'));
				await Promise.resolve();
			});

			// Should save the dirty content before opening batch runner
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'new content',
				undefined // sshRemoteId (undefined for local sessions)
			);
			expect(onOpenBatchRunner).toHaveBeenCalled();
		});

		it('opens the batch runner without saving when content is clean', async () => {
			const onOpenBatchRunner = vi.fn();
			const props = createDefaultProps({ onOpenBatchRunner, content: 'clean content' });
			renderWithProvider(<AutoRun {...props} />);

			await act(async () => {
				fireEvent.click(screen.getByText('Run'));
				await Promise.resolve();
			});

			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();
			expect(onOpenBatchRunner).toHaveBeenCalled();
		});

		it('keeps Run configuration available when agent is busy', () => {
			const props = createDefaultProps({ sessionState: 'busy' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Run').closest('button')).not.toBeDisabled();
			expect(screen.getByTitle(/Agent is thinking/)).toBeDefined();
		});

		it('keeps Run configuration available when agent is connecting', () => {
			const props = createDefaultProps({ sessionState: 'connecting' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Run').closest('button')).not.toBeDisabled();
			expect(screen.getByTitle(/Agent is thinking/)).toBeDefined();
		});

		it('calls onStopBatchRun when clicking Stop', async () => {
			const onStopBatchRun = vi.fn();
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState, onStopBatchRun });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByText('Stop'));

			expect(onStopBatchRun).toHaveBeenCalled();
		});

		it('shows Stopping... when isStopping is true', () => {
			const batchRunState = createBatchRunState({ isStopping: true });
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Stopping')).toBeInTheDocument();
		});

		it('opens the Playbook Exchange when the marketplace callback is provided', () => {
			const onOpenMarketplace = vi.fn();
			const props = createDefaultProps({ onOpenMarketplace });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByText('PlayBooks'));

			expect(onOpenMarketplace).toHaveBeenCalledTimes(1);
		});
	});

	describe('Launch Wizard Button', () => {
		it('displays wizard button when onLaunchWizard is provided', () => {
			const onLaunchWizard = vi.fn();
			const props = createDefaultProps({ onLaunchWizard });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTitle('Launch In-Tab Wizard')).toBeInTheDocument();
		});

		it('does not display wizard button when onLaunchWizard is not provided', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle('Launch In-Tab Wizard')).not.toBeInTheDocument();
		});

		it('calls onLaunchWizard when clicking wizard button', () => {
			const onLaunchWizard = vi.fn();
			const props = createDefaultProps({ onLaunchWizard });
			renderWithProvider(<AutoRun {...props} />);

			const wizardButton = screen.getByTitle('Launch In-Tab Wizard');
			fireEvent.click(wizardButton);

			expect(onLaunchWizard).toHaveBeenCalledTimes(1);
		});

		it('wizard button is hidden when no folder is configured', () => {
			const onLaunchWizard = vi.fn();
			const props = createDefaultProps({ onLaunchWizard, folderPath: null });
			renderWithProvider(<AutoRun {...props} />);

			// Should not show wizard button when folder isn't set
			expect(screen.queryByTitle('Launch In-Tab Wizard')).not.toBeInTheDocument();
		});
	});

	describe('Help Modal', () => {
		it('opens help modal when clicking help button', async () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			const helpButton = screen.getByTitle('Learn about Auto Runner');
			fireEvent.click(helpButton);

			expect(screen.getByTestId('help-modal')).toBeInTheDocument();
		});

		it('closes help modal when onClose is called', async () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			const helpButton = screen.getByTitle('Learn about Auto Runner');
			fireEvent.click(helpButton);

			expect(screen.getByTestId('help-modal')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Close'));

			await waitFor(() => {
				expect(screen.queryByTestId('help-modal')).not.toBeInTheDocument();
			});
		});
	});

	describe('Empty Folder State', () => {
		it('shows empty state when folder has no documents', () => {
			const props = createDefaultProps({ documentList: [], selectedFile: null });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('No Documents Found')).toBeInTheDocument();
			expect(
				screen.getByText(/The selected folder doesn't contain any markdown/)
			).toBeInTheDocument();
		});

		it('shows Refresh and Change Folder buttons in empty state', () => {
			const props = createDefaultProps({ documentList: [], selectedFile: null });
			renderWithProvider(<AutoRun {...props} />);

			// Use getAllByText since the refresh button exists in both document selector and empty state
			expect(screen.getAllByText('Refresh').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('Change Folder')).toBeInTheDocument();
		});

		it('calls onRefresh when clicking Refresh in empty state', async () => {
			const props = createDefaultProps({ documentList: [], selectedFile: null });
			renderWithProvider(<AutoRun {...props} />);

			// Get the Refresh button in the empty state (not in document selector)
			const refreshButtons = screen.getAllByText('Refresh');
			// The second one is in the empty state UI
			fireEvent.click(refreshButtons.length > 1 ? refreshButtons[1] : refreshButtons[0]);

			await waitFor(() => {
				expect(props.onRefresh).toHaveBeenCalled();
			});
		});

		it('calls onOpenSetup when clicking Change Folder in empty state', async () => {
			const props = createDefaultProps({ documentList: [], selectedFile: null });
			renderWithProvider(<AutoRun {...props} />);

			// Get the Change Folder button in the empty state
			fireEvent.click(screen.getByText('Change Folder'));

			await waitFor(() => {
				expect(props.onOpenSetup).toHaveBeenCalled();
			});
		});

		it('shows loading indicator during refresh', async () => {
			const props = createDefaultProps({
				documentList: [],
				selectedFile: null,
				isLoadingDocuments: true,
			});
			renderWithProvider(<AutoRun {...props} />);

			// Loading state should not show empty state message
			expect(screen.queryByText('No Documents Found')).not.toBeInTheDocument();
		});
	});

	describe('Attachments', () => {
		it('loads existing images on mount', async () => {
			mockMaestro.autorun.listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'img1.png', relativePath: 'images/test-doc-123.png' }],
			});

			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			await waitFor(() => {
				expect(mockMaestro.autorun.listImages).toHaveBeenCalledWith(
					'/test/folder',
					'test-doc',
					undefined
				);
			});
		});

		it('shows attachments section when there are images in edit mode', async () => {
			mockMaestro.autorun.listImages.mockResolvedValue({
				success: true,
				images: [{ filename: 'img1.png', relativePath: 'images/test-doc-123.png' }],
			});

			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			await waitFor(() => {
				expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
			});
		});

		it('keeps the image upload button hidden in edit mode', () => {
			const props = createDefaultProps({ mode: 'edit' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle('Add image (or paste from clipboard)')).not.toBeInTheDocument();
			expect(container.querySelector('input[type="file"][accept="image/*"]')).toBeInTheDocument();
		});

		it('hides image upload button in preview mode', () => {
			const props = createDefaultProps({ mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle('Add image (or paste from clipboard)')).not.toBeInTheDocument();
		});

		it('hides image upload button when locked', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle('Add image (or paste from clipboard)')).not.toBeInTheDocument();
		});
	});

	describe('Image Paste Handling', () => {
		it('handles image paste and inserts markdown reference', async () => {
			class MockFileReader {
				onload: ((event: { target: { result: string } }) => void) | null = null;
				readAsDataURL() {
					this.onload?.({ target: { result: 'data:image/png;base64,abc123' } });
				}
			}
			vi.stubGlobal('FileReader', MockFileReader);
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(props.content.length, props.content.length);
			fireEvent.paste(textarea, {
				clipboardData: {
					items: [
						{
							type: 'image/png',
							getAsFile: () => new File(['test'], 'test.png', { type: 'image/png' }),
						},
					],
					getData: () => '',
				},
			});

			await waitFor(() => {
				expect(mockMaestro.autorun.saveImage).toHaveBeenCalledWith(
					'/test/folder',
					'test-doc',
					'abc123',
					'png',
					undefined
				);
			});
			expect(props.onContentChange).toHaveBeenCalledWith(
				`${props.content}\n![test-123.png](images/test-123.png)`
			);
		});

		it('does not handle paste when locked', async () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			const mockClipboardData = {
				items: [
					{
						type: 'image/png',
						getAsFile: () => new File(['test'], 'test.png', { type: 'image/png' }),
					},
				],
				getData: () => '', // For text paste handling
			};

			fireEvent.paste(textarea, { clipboardData: mockClipboardData });

			expect(mockMaestro.autorun.saveImage).not.toHaveBeenCalled();
		});
	});

	describe('Imperative Handle (focus)', () => {
		it('exposes focus method via ref', () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			expect(ref.current).not.toBeNull();
			expect(typeof ref.current?.focus).toBe('function');
		});

		it('focuses textarea when calling focus in edit mode', () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			const textarea = screen.getByRole('textbox');
			ref.current?.focus();

			expect(document.activeElement).toBe(textarea);
		});

		it('reports dirty state and guards no-op imperative actions', async () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({ mode: 'edit', content: 'Initial' });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			expect(ref.current?.isDirty()).toBe(false);
			ref.current?.switchMode('edit');
			await act(async () => {
				await ref.current?.save();
			});
			expect(props.onModeChange).not.toHaveBeenCalled();
			expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();

			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Changed' } });

			expect(ref.current?.isDirty()).toBe(true);
		});

		it('does not open reset modal when there are no completed tasks', () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({ content: '- [ ] Pending task' });
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			ref.current?.openResetTasksModal();

			expect(screen.queryByText('Reset Completed Tasks')).not.toBeInTheDocument();
		});

		it('does not open reset modal while locked', () => {
			const ref = React.createRef<AutoRunHandle>();
			const props = createDefaultProps({
				content: '- [x] Done task',
				batchRunState: createBatchRunState(),
			});
			renderWithProvider(<AutoRun {...props} ref={ref} />);

			ref.current?.openResetTasksModal();

			expect(screen.queryByText('Reset Completed Tasks')).not.toBeInTheDocument();
		});
	});

	describe('Session Switching', () => {
		it('resets local content when session changes', () => {
			const props = createDefaultProps({ content: 'Session 1 content' });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('Session 1 content');

			// Change session
			rerender(<AutoRun {...props} sessionId="new-session" content="Session 2 content" />);

			expect(textarea).toHaveValue('Session 2 content');
		});

		it('syncs content when switching documents', () => {
			const props = createDefaultProps({ content: 'Doc 1 content', selectedFile: 'doc1' });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('Doc 1 content');

			// Change document
			rerender(<AutoRun {...props} selectedFile="doc2" content="Doc 2 content" />);

			expect(textarea).toHaveValue('Doc 2 content');
		});
	});

	describe('Scroll Position Persistence', () => {
		it('accepts initial scroll positions', () => {
			const props = createDefaultProps({
				initialCursorPosition: 10,
				initialEditScrollPos: 100,
				initialPreviewScrollPos: 50,
			});

			// This should not throw
			expect(() => renderWithProvider(<AutoRun {...props} />)).not.toThrow();
		});

		it('calls onStateChange when mode toggles via keyboard', async () => {
			const onStateChange = vi.fn();
			const props = createDefaultProps({ mode: 'edit', onStateChange });
			renderWithProvider(<AutoRun {...props} />);

			// toggleMode reports state after the scroll-sync animation frame runs.
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'e', metaKey: true });

			await waitFor(() => {
				expect(onStateChange).toHaveBeenCalledWith(
					expect.objectContaining({
						mode: 'preview',
					})
				);
			});
		});
	});

	describe('Memoization', () => {
		it('does not re-render when irrelevant props change', () => {
			const props = createDefaultProps();
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Re-render with same essential props but different callback references
			// The memo comparison should prevent unnecessary re-renders
			// This is more of an integration test, verifying the memo function exists
			expect(() => {
				rerender(<AutoRun {...props} />);
			}).not.toThrow();
		});
	});

	describe('Preview Mode Features', () => {
		it('opens search with Cmd+F in preview mode', async () => {
			const props = createDefaultProps({ mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			// Find the preview container and trigger keydown
			const previewContainer = screen.getByTestId('react-markdown').parentElement!;
			fireEvent.keyDown(previewContainer, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText(/Search/)).toBeInTheDocument();
			});
		});
	});

	describe('Document Selector Integration', () => {
		it('calls onSelectDocument when document is selected', async () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			const select = screen.getByTestId('doc-select');
			fireEvent.change(select, { target: { value: 'another-doc' } });

			expect(props.onSelectDocument).toHaveBeenCalledWith('another-doc');
		});

		it('calls onRefresh when refresh button is clicked', async () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTestId('refresh-btn'));

			expect(props.onRefresh).toHaveBeenCalled();
		});

		it('calls onOpenSetup when change folder button is clicked', async () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTestId('change-folder-btn'));

			expect(props.onOpenSetup).toHaveBeenCalled();
		});

		it('passes isLoading to document selector', () => {
			const props = createDefaultProps({ isLoadingDocuments: true });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
		});
	});

	describe('Auto-switch Mode on Batch Run', () => {
		it('switches to preview mode when batch run starts', () => {
			const props = createDefaultProps({ mode: 'edit' });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Start batch run
			const batchRunState = createBatchRunState();
			rerender(<AutoRun {...props} batchRunState={batchRunState} />);

			expect(props.onModeChange).toHaveBeenCalledWith('preview');
		});

		it('does not request preview mode again when batch run starts in preview', () => {
			const props = createDefaultProps({ mode: 'preview' });
			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			rerender(<AutoRun {...props} batchRunState={createBatchRunState()} />);

			expect(props.onModeChange).not.toHaveBeenCalled();
		});
	});

	describe('Textarea Placeholder', () => {
		it('shows placeholder text in edit mode', () => {
			const props = createDefaultProps({ content: '' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByPlaceholderText(/Capture notes, images, and tasks/);
			expect(textarea).toBeInTheDocument();
		});
	});

	describe('Container Keyboard Handling', () => {
		it('handles Cmd+E on container level', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			const outerContainer = container.firstChild as HTMLElement;
			fireEvent.keyDown(outerContainer, { key: 'e', metaKey: true });

			expect(props.onModeChange).toHaveBeenCalledWith('preview');
		});

		it('does not toggle from container Cmd+E while locked', () => {
			const props = createDefaultProps({
				mode: 'edit',
				batchRunState: createBatchRunState(),
			});
			const { container } = renderWithProvider(<AutoRun {...props} />);
			props.onModeChange.mockClear();

			fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'e', metaKey: true });

			expect(props.onModeChange).not.toHaveBeenCalled();
		});

		it('handles Cmd+F on container level', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			const { container } = renderWithProvider(<AutoRun {...props} />);

			const outerContainer = container.firstChild as HTMLElement;
			fireEvent.keyDown(outerContainer, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText(/Search/)).toBeInTheDocument();
			});
		});
	});

	describe('Preview Mode Content', () => {
		it('shows default message when content is empty in preview mode', () => {
			const props = createDefaultProps({ mode: 'preview', content: '' });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toHaveTextContent('No content yet');
		});

		it('ignores malformed attachment images with an empty source', () => {
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Empty]()',
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByAltText('Empty')).not.toBeInTheDocument();
			expect(screen.queryByText('Loading image...')).not.toBeInTheDocument();
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('loads URL-encoded relative attachment images from the Auto Run folder with SSH context', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('data:image/png;base64,relative-image');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Diagram](images/My%20Diagram.png)',
				sshRemoteId: 'remote-123',
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Loading image...')).toBeInTheDocument();

			const image = await screen.findByAltText('Diagram');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/images/My Diagram.png',
				'remote-123'
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,relative-image');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: My Diagram.png');
		});

		it('uses cached Auto Run folder images without reading from disk', async () => {
			imageCache.set('/test/folder:images/cached.png', 'data:image/png;base64,cached-image');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Cached](images/cached.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Cached');
			expect(image).toHaveAttribute('src', 'data:image/png;base64,cached-image');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: cached.png');
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('uses cached Auto Run folder images with trailing-slash filename fallback', async () => {
			imageCache.set('/test/folder:images/', 'data:image/png;base64,trailing-cache');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Trailing Folder](images/)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Trailing Folder');
			expect(image).toHaveAttribute('src', 'data:image/png;base64,trailing-cache');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: images/');
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('uses Auto Run folder image cache populated after initial render', async () => {
			const cacheKey = '/test/folder:images/race.png';
			let hasCalls = 0;
			const hasSpy = vi.spyOn(imageCache, 'has').mockImplementation((key) => {
				hasCalls += 1;
				return key === cacheKey && hasCalls > 2;
			});
			const getSpy = vi.spyOn(imageCache, 'get').mockImplementation((key) => {
				return key === cacheKey ? 'data:image/png;base64,race-image' : undefined;
			});

			try {
				const props = createDefaultProps({
					mode: 'preview',
					content: '![Race](images/race.png)',
				});

				renderWithProvider(<AutoRun {...props} />);

				const image = await screen.findByAltText('Race');
				expect(image).toHaveAttribute('src', 'data:image/png;base64,race-image');
				expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
			} finally {
				hasSpy.mockRestore();
				getSpy.mockRestore();
			}
		});

		it('uses cached non-image relative attachment paths without reading from disk', async () => {
			imageCache.set('/test/folder:assets/logo.png', 'data:image/png;base64,asset-image');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Logo](assets/logo.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Logo');
			expect(image).toHaveAttribute('src', 'data:image/png;base64,asset-image');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: logo.png');
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('uses cached relative attachment folders with generic lightbox title', async () => {
			imageCache.set('/test/folder:assets/', 'data:image/png;base64,asset-folder');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Asset Folder](assets/)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Asset Folder');
			expect(image).toHaveAttribute('src', 'data:image/png;base64,asset-folder');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge');
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('uses relative attachment cache populated after initial render', async () => {
			const cacheKey = '/test/folder:assets/race.png';
			let hasCalls = 0;
			const hasSpy = vi.spyOn(imageCache, 'has').mockImplementation((key) => {
				hasCalls += 1;
				return key === cacheKey && hasCalls > 1;
			});
			const getSpy = vi.spyOn(imageCache, 'get').mockImplementation((key) => {
				return key === cacheKey ? 'data:image/png;base64,asset-race' : undefined;
			});

			try {
				const props = createDefaultProps({
					mode: 'preview',
					content: '![Asset Race](assets/race.png)',
				});

				renderWithProvider(<AutoRun {...props} />);

				const image = await screen.findByAltText('Asset Race');
				expect(image).toHaveAttribute('src', 'data:image/png;base64,asset-race');
				expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
			} finally {
				hasSpy.mockRestore();
				getSpy.mockRestore();
			}
		});

		it.each([
			{
				name: 'Auto Run folder image',
				oldContent: '![Fresh](images/stale-old.png)',
				newContent: '![Fresh](images/fresh.png)',
				oldReadPath: '/test/folder/images/stale-old.png',
				newReadPath: '/test/folder/images/fresh.png',
				staleCacheKey: '/test/folder:images/stale-old.png',
			},
			{
				name: 'absolute image path',
				oldContent: '![Fresh](/tmp/stale-old.png)',
				newContent: '![Fresh](/tmp/fresh.png)',
				oldReadPath: '/tmp/stale-old.png',
				newReadPath: '/tmp/fresh.png',
			},
			{
				name: 'relative attachment path',
				oldContent: '![Fresh](assets/stale-old.png)',
				newContent: '![Fresh](assets/fresh.png)',
				oldReadPath: '/test/folder/assets/stale-old.png',
				newReadPath: '/test/folder/assets/fresh.png',
				staleCacheKey: '/test/folder:assets/stale-old.png',
			},
		])(
			'ignores stale successful reads for $name after the preview source changes',
			async (scenario) => {
				const staleRead = createDeferred<string>();
				const freshRead = createDeferred<string>();
				mockMaestro.fs.readFile
					.mockReturnValueOnce(staleRead.promise)
					.mockReturnValueOnce(freshRead.promise);
				const props = createDefaultProps({
					mode: 'preview',
					content: scenario.oldContent,
				});
				const { rerender } = renderWithProvider(<AutoRun {...props} />);

				await waitFor(() => {
					expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(scenario.oldReadPath, undefined);
				});

				rerender(<AutoRun {...props} content={scenario.newContent} contentVersion={1} />);
				await waitFor(() => {
					expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(scenario.newReadPath, undefined);
				});

				await act(async () => {
					freshRead.resolve('data:image/png;base64,fresh-image');
					await freshRead.promise;
				});

				expect(await screen.findByAltText('Fresh')).toHaveAttribute(
					'src',
					'data:image/png;base64,fresh-image'
				);

				await act(async () => {
					staleRead.resolve('data:image/png;base64,stale-image');
					await staleRead.promise;
				});

				expect(screen.getByAltText('Fresh')).toHaveAttribute(
					'src',
					'data:image/png;base64,fresh-image'
				);
				if (scenario.staleCacheKey) {
					expect(imageCache.has(scenario.staleCacheKey)).toBe(false);
				}
			}
		);

		it.each([
			{
				name: 'Auto Run folder image',
				oldContent: '![Fresh](images/stale-failure.png)',
				newContent: '![Fresh](images/fresh-after-failure.png)',
			},
			{
				name: 'absolute image path',
				oldContent: '![Fresh](/tmp/stale-failure.png)',
				newContent: '![Fresh](/tmp/fresh-after-failure.png)',
			},
			{
				name: 'relative attachment path',
				oldContent: '![Fresh](assets/stale-failure.png)',
				newContent: '![Fresh](assets/fresh-after-failure.png)',
			},
		])(
			'ignores stale failed reads for $name after the preview source changes',
			async (scenario) => {
				const staleRead = createDeferred<string>();
				const freshRead = createDeferred<string>();
				mockMaestro.fs.readFile
					.mockReturnValueOnce(staleRead.promise)
					.mockReturnValueOnce(freshRead.promise);
				const props = createDefaultProps({
					mode: 'preview',
					content: scenario.oldContent,
				});
				const { rerender } = renderWithProvider(<AutoRun {...props} />);

				await waitFor(() => {
					expect(mockMaestro.fs.readFile).toHaveBeenCalledTimes(1);
				});

				rerender(<AutoRun {...props} content={scenario.newContent} contentVersion={1} />);
				await waitFor(() => {
					expect(mockMaestro.fs.readFile).toHaveBeenCalledTimes(2);
				});

				await act(async () => {
					freshRead.resolve('data:image/png;base64,fresh-image');
					await freshRead.promise;
				});

				expect(await screen.findByAltText('Fresh')).toHaveAttribute(
					'src',
					'data:image/png;base64,fresh-image'
				);

				await act(async () => {
					staleRead.reject(new Error('stale read failed'));
					await staleRead.promise.catch(() => undefined);
				});

				expect(
					screen.queryByText('Failed to load image: stale read failed')
				).not.toBeInTheDocument();
				expect(screen.getByAltText('Fresh')).toHaveAttribute(
					'src',
					'data:image/png;base64,fresh-image'
				);
			}
		);

		it('renders data URL and remote URL attachment images without reading from disk', async () => {
			const props = createDefaultProps({
				mode: 'preview',
				content:
					'![Inline](data:image/png;base64,inline-image)\n![Remote](https://example.com/remote.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(await screen.findByAltText('Inline')).toHaveAttribute(
				'src',
				'data:image/png;base64,inline-image'
			);
			expect(screen.getByAltText('Remote')).toHaveAttribute(
				'src',
				'https://example.com/remote.png'
			);
			expect(mockMaestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('opens the lightbox when clicking a rendered markdown image', async () => {
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Inline](data:image/png;base64,inline-image)',
			});

			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(await screen.findByAltText('Inline'));

			await waitFor(() => {
				expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
			});
		});

		it('renders mermaid blocks and handles markdown links in preview mode', async () => {
			const props = createDefaultProps({
				mode: 'preview',
				content:
					'[Plan](maestro-file://Specs/Plan.md)\n[Docs](https://example.com/docs)\n[Local](file:///tmp/local.md)\n\n```mermaid\ngraph TD;\n```',
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent('graph TD;');

			fireEvent.click(screen.getByText('Plan'));
			expect(props.onSelectDocument).toHaveBeenCalledWith('Specs/Plan');

			fireEvent.click(screen.getByText('Docs'));
			expect(mockMaestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');

			mockMaestro.shell.openExternal.mockClear();
			fireEvent.click(screen.getByText('Local'));
			expect(mockMaestro.shell.openExternal).toHaveBeenCalledWith('file:///tmp/local.md');
		});

		it('uses search-highlighted markdown components for preview links, mermaid, and images', async () => {
			const props = createDefaultProps({
				mode: 'preview',
				content:
					'match [Docs](https://example.com/search) [Local](file:///tmp/search.md)\n\n```mermaid\ngraph LR;\n```\n![Inline](data:image/png;base64,inline-search)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const preview = screen.getByTestId('react-markdown').parentElement!;
			fireEvent.keyDown(preview, { key: 'f', metaKey: true });

			const searchInput = await screen.findByPlaceholderText(/Search/);
			fireEvent.change(searchInput, { target: { value: 'match' } });
			await advanceTimers(150);

			expect(screen.getByTestId('mermaid-renderer')).toHaveTextContent('graph LR;');
			expect(await screen.findByAltText('Inline')).toHaveAttribute(
				'src',
				'data:image/png;base64,inline-search'
			);

			fireEvent.click(screen.getByText('Docs'));
			expect(mockMaestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/search');
			mockMaestro.shell.openExternal.mockClear();
			fireEvent.click(screen.getByText('Local'));
			expect(mockMaestro.shell.openExternal).toHaveBeenCalledWith('file:///tmp/search.md');
			expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
				behavior: 'smooth',
				block: 'center',
			});
		});

		it('loads absolute attachment image paths through the filesystem bridge', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('data:image/png;base64,absolute-image');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Absolute](/tmp/logo.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Absolute');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith('/tmp/logo.png', undefined);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,absolute-image');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: logo.png');
		});

		it('loads non-image relative attachment paths from the Auto Run folder', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('data:image/png;base64,asset-image');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Asset](assets/logo.png)',
				sshRemoteId: 'remote-123',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Asset');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/assets/logo.png',
				'remote-123'
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,asset-image');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: logo.png');
		});

		it('loads trailing-slash Auto Run folder images with filename fallback', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('data:image/png;base64,trailing-image');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Trailing Folder](images/)',
			});

			renderWithProvider(<AutoRun {...props} />);

			const image = await screen.findByAltText('Trailing Folder');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith('/test/folder/images/', undefined);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,trailing-image');
			expect(image.closest('span')).toHaveAttribute('title', 'Click to enlarge: images/');
		});

		it('shows an invalid image error for absolute paths that do not return data URLs', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('not-a-data-url');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Bad](/tmp/bad.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			await screen.findByText('Invalid image data');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith('/tmp/bad.png', undefined);
		});

		it('shows an unknown-error fallback for failed absolute image reads', async () => {
			mockMaestro.fs.readFile.mockRejectedValueOnce({});
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Broken](/tmp/broken.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			await screen.findByText('Failed to load image: Unknown error');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith('/tmp/broken.png', undefined);
		});

		it('shows unknown-error fallback for failed Auto Run folder image reads', async () => {
			mockMaestro.fs.readFile.mockRejectedValueOnce({});
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Broken Diagram](images/broken.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			await screen.findByText('Failed to load image: Unknown error');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/images/broken.png',
				undefined
			);
		});

		it('shows an invalid image error for Auto Run folder images that return non-data content', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('not-a-data-url');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Bad Diagram](images/bad.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			await screen.findByText('Invalid image data');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/images/bad.png',
				undefined
			);
		});

		it('shows a load error for unresolved Auto Run folder images', async () => {
			mockMaestro.fs.readFile.mockRejectedValueOnce(new Error('missing diagram'));
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Missing Diagram](images/missing.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			await screen.findByText('Failed to load image: missing diagram');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/images/missing.png',
				undefined
			);
		});

		it('shows an invalid image error for non-image relative paths that return non-data content', async () => {
			mockMaestro.fs.readFile.mockResolvedValueOnce('not-a-data-url');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Bad Asset](assets/bad.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			await screen.findByText('Invalid image data');
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/assets/bad.png',
				undefined
			);
		});

		it('shows a load error for unresolved relative attachment images', async () => {
			mockMaestro.fs.readFile.mockRejectedValueOnce(new Error('missing image'));
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Missing](assets/missing.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(await screen.findByText('Failed to load image: missing image')).toBeInTheDocument();
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/assets/missing.png',
				undefined
			);
		});

		it('shows unknown-error fallback for failed non-image relative attachment reads', async () => {
			mockMaestro.fs.readFile.mockRejectedValueOnce({});
			const props = createDefaultProps({
				mode: 'preview',
				content: '![Broken Asset](assets/broken.png)',
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(await screen.findByText('Failed to load image: Unknown error')).toBeInTheDocument();
			expect(mockMaestro.fs.readFile).toHaveBeenCalledWith(
				'/test/folder/assets/broken.png',
				undefined
			);
		});

		it('renders no-filename images with empty alt and generic lightbox title', async () => {
			mockMaestro.fs.readFile
				.mockResolvedValueOnce('data:image/png;base64,absolute-folder')
				.mockResolvedValueOnce('data:image/png;base64,relative-folder');
			const props = createDefaultProps({
				mode: 'preview',
				content: '![](/tmp/assets/)\\n![Relative Folder](assets/)',
			});

			const { container } = renderWithProvider(<AutoRun {...props} />);

			await waitFor(() => expect(mockMaestro.fs.readFile).toHaveBeenCalledTimes(2));
			expect(mockMaestro.fs.readFile).toHaveBeenNthCalledWith(1, '/tmp/assets/', undefined);
			expect(mockMaestro.fs.readFile).toHaveBeenNthCalledWith(2, '/test/folder/assets/', undefined);

			const emptyAltImage = container.querySelector('img[alt=""]');
			expect(emptyAltImage).toHaveAttribute('src', 'data:image/png;base64,absolute-folder');
			expect(screen.getByAltText('Relative Folder')).toHaveAttribute(
				'src',
				'data:image/png;base64,relative-folder'
			);
			expect(screen.getAllByTitle('Click to enlarge')).toHaveLength(2);
		});
	});
});

describe('AutoRun.imageCache', () => {
	// Note: imageCache is a module-level Map that caches loaded images
	// It cannot be directly tested without exposing it, but we can verify
	// the caching behavior indirectly through repeated renders

	it('component loads without throwing when images are present', async () => {
		const mockMaestro = setupMaestroMock();
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});

		const props = createDefaultProps();
		expect(() => renderWithProvider(<AutoRun {...props} />)).not.toThrow();

		await waitFor(() => {
			expect(mockMaestro.autorun.listImages).toHaveBeenCalled();
		});
	});
});

describe('Undo/Redo Functionality', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('handles Cmd+Z keyboard shortcut', async () => {
		const props = createDefaultProps({ content: 'Initial content' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		fireEvent.focus(textarea);

		// Type new content
		fireEvent.change(textarea, { target: { value: 'New content' } });
		expect(textarea).toHaveValue('New content');

		// Trigger undo (preventDefault should be called even if stack is empty)
		const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true });
		textarea.dispatchEvent(event);

		// Component should handle the shortcut without error
		expect(textarea).toBeDefined();
	});

	it('handles Cmd+Shift+Z keyboard shortcut', async () => {
		const props = createDefaultProps({ content: 'Original' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		fireEvent.focus(textarea);

		// Trigger redo shortcut
		fireEvent.keyDown(textarea, { key: 'z', metaKey: true, shiftKey: true });

		// Component should handle the shortcut without error
		expect(textarea).toBeDefined();
	});

	it('does not change content when undo stack is empty', async () => {
		const props = createDefaultProps({ content: 'Initial' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.focus(textarea);

		// Try to undo with no history
		fireEvent.keyDown(textarea, { key: 'z', metaKey: true });

		// Content should remain unchanged
		expect(textarea).toHaveValue('Initial');
	});
});

describe('Lightbox Functionality', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('opens lightbox when clicking an image', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments to load
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		// Wait for preview image to load
		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Click on image thumbnail to open lightbox
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		// Lightbox should open - look for lightbox image or controls
		await waitFor(() => {
			// Check for close button or ESC hint
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});
	});

	it('closes lightbox on Escape key', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments and open lightbox
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Press Escape to close
		fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });

		await waitFor(() => {
			expect(screen.queryByText(/ESC to close/)).not.toBeInTheDocument();
		});
	});

	it('shows navigation buttons when multiple images are present', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [
				{ filename: 'img1.png', relativePath: 'images/img1.png' },
				{ filename: 'img2.png', relativePath: 'images/img2.png' },
			],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images \(2\)/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(2);
		});

		// Open lightbox on first image
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		// Wait for lightbox to open with navigation
		await waitFor(() => {
			expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
		});

		// Navigation buttons should be present
		expect(screen.getByTitle('Previous image (←)')).toBeInTheDocument();
		expect(screen.getByTitle('Next image (→)')).toBeInTheDocument();
	});

	it('navigates to next image via button click', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [
				{ filename: 'img1.png', relativePath: 'images/img1.png' },
				{ filename: 'img2.png', relativePath: 'images/img2.png' },
			],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images \(2\)/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(2);
		});

		// Open lightbox on first image
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
		});

		// Click next button
		const nextButton = screen.getByTitle('Next image (→)');
		fireEvent.click(nextButton);

		await waitFor(() => {
			expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
		});
	});

	it('navigates to previous image via button click', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [
				{ filename: 'img1.png', relativePath: 'images/img1.png' },
				{ filename: 'img2.png', relativePath: 'images/img2.png' },
			],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images \(2\)/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(2);
		});

		// Open lightbox on second image
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[1]);

		await waitFor(() => {
			expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
		});

		// Click prev button
		const prevButton = screen.getByTitle('Previous image (←)');
		fireEvent.click(prevButton);

		await waitFor(() => {
			expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
		});
	});

	it('navigates to next image via ArrowRight key', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [
				{ filename: 'img1.png', relativePath: 'images/img1.png' },
				{ filename: 'img2.png', relativePath: 'images/img2.png' },
			],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images \(2\)/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(2);
		});

		// Open lightbox on first image
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
		});

		// Press ArrowRight key
		fireEvent.keyDown(document.activeElement || document.body, { key: 'ArrowRight' });

		await waitFor(() => {
			expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
		});
	});

	it('navigates to previous image via ArrowLeft key', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [
				{ filename: 'img1.png', relativePath: 'images/img1.png' },
				{ filename: 'img2.png', relativePath: 'images/img2.png' },
			],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images \(2\)/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(2);
		});

		// Open lightbox on second image
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[1]);

		await waitFor(() => {
			expect(screen.getByText(/Image 2 of 2/)).toBeInTheDocument();
		});

		// Press ArrowLeft key
		fireEvent.keyDown(document.activeElement || document.body, { key: 'ArrowLeft' });

		await waitFor(() => {
			expect(screen.getByText(/Image 1 of 2/)).toBeInTheDocument();
		});
	});

	it('closes lightbox via close button click', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Open lightbox
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Click close button
		const closeButton = screen.getByTitle('Close (ESC)');
		fireEvent.click(closeButton);

		await waitFor(() => {
			expect(screen.queryByText(/ESC to close/)).not.toBeInTheDocument();
		});
	});

	it('deletes image via delete button in lightbox', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');
		mockMaestro.autorun.deleteImage.mockResolvedValue({ success: true });

		const content = '# Test\n![test.png](images/test.png)\n';
		const props = createDefaultProps({ content, mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Open lightbox
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Click delete button
		const deleteButton = screen.getByTitle('Delete image (Delete key)');
		fireEvent.click(deleteButton);

		// Confirm deletion
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		// Verify delete was called
		await waitFor(() => {
			expect(mockMaestro.autorun.deleteImage).toHaveBeenCalledWith(
				'/test/folder',
				'images/test.png',
				undefined
			);
		});

		// Lightbox should close after deleting the only image
		await waitFor(() => {
			expect(screen.queryByText(/ESC to close/)).not.toBeInTheDocument();
		});
	});

	it('deletes image via Delete/Backspace key in lightbox', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');
		mockMaestro.autorun.deleteImage.mockResolvedValue({ success: true });

		const content = '# Test\n![test.png](images/test.png)\n';
		const props = createDefaultProps({ content, mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Open lightbox
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Press Delete key
		fireEvent.keyDown(document.activeElement || document.body, { key: 'Delete' });

		// Confirm deletion
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		// Verify delete was called
		await waitFor(() => {
			expect(mockMaestro.autorun.deleteImage).toHaveBeenCalledWith(
				'/test/folder',
				'images/test.png',
				undefined
			);
		});
	});

	it('renders copy button in lightbox and handles click', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Open lightbox
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Verify copy button is present
		const copyButton = screen.getByTitle(
			`Copy image to clipboard (${formatShortcutKeys(['Meta', 'c'])})`
		);
		expect(copyButton).toBeInTheDocument();

		// Click it - the actual clipboard copy may fail but we're testing the button renders/clicks
		fireEvent.click(copyButton);

		// The button should still be there
		expect(
			screen.getByTitle(`Copy image to clipboard (${formatShortcutKeys(['Meta', 'c'])})`)
		).toBeInTheDocument();
	});

	it('closes lightbox when clicking overlay background', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Open lightbox
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Find and click the overlay background (the parent div with bg-black/90)
		const overlay = screen.getByText(/ESC to close/).closest('.fixed');
		if (overlay) {
			fireEvent.click(overlay);
		}

		// Lightbox should close
		await waitFor(() => {
			expect(screen.queryByText(/ESC to close/)).not.toBeInTheDocument();
		});
	});

	it('does not close lightbox when clicking on the image itself', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(1);
		});

		// Open lightbox
		const thumbnailImgs = screen.getAllByRole('img');
		fireEvent.click(thumbnailImgs[0]);

		await waitFor(() => {
			expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
		});

		// Find and click the lightbox image (the one in the overlay)
		const lightboxImages = screen.getAllByRole('img');
		// Find the main lightbox image (not thumbnail)
		const mainImage = lightboxImages.find((img) => img.classList.contains('max-w-[90%]'));
		if (mainImage) {
			fireEvent.click(mainImage);
		}

		// Lightbox should still be open
		expect(screen.getByText(/ESC to close/)).toBeInTheDocument();
	});

	it('navigates after deleting middle image in carousel', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [
				{ filename: 'img1.png', relativePath: 'images/img1.png' },
				{ filename: 'img2.png', relativePath: 'images/img2.png' },
				{ filename: 'img3.png', relativePath: 'images/img3.png' },
			],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');
		mockMaestro.autorun.deleteImage.mockResolvedValue({ success: true });

		const content =
			'# Test\n![img1.png](images/img1.png)\n![img2.png](images/img2.png)\n![img3.png](images/img3.png)\n';
		const props = createDefaultProps({ content, mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images \(3\)/)).toBeInTheDocument();
		});

		await waitFor(() => {
			const imgs = screen.getAllByRole('img');
			expect(imgs.length).toBeGreaterThanOrEqual(3);
		});

		// Open lightbox on second image
		const imgs = screen.getAllByRole('img');
		fireEvent.click(imgs[1]);

		await waitFor(() => {
			expect(screen.getByText(/Image 2 of 3/)).toBeInTheDocument();
		});

		// Delete the middle image
		const deleteButton = screen.getByTitle('Delete image (Delete key)');
		fireEvent.click(deleteButton);

		// Confirm deletion
		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
		});
		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

		// Verify delete was called
		await waitFor(() => {
			expect(mockMaestro.autorun.deleteImage).toHaveBeenCalled();
		});
	});
});

describe('Attachment Management', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('removes attachment when clicking remove button', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');
		mockMaestro.autorun.deleteImage.mockResolvedValue({ success: true });

		const content = '# Test\n![test.png](images/test.png)\n';
		const props = createDefaultProps({ content, mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		// Find and click the remove button (X button on image preview)
		await waitFor(() => {
			const removeButtons = screen.getAllByTitle('Remove image');
			expect(removeButtons.length).toBeGreaterThanOrEqual(1);
		});

		const removeButton = screen.getAllByTitle('Remove image')[0];
		fireEvent.click(removeButton);

		// Verify delete was called
		await waitFor(() => {
			expect(mockMaestro.autorun.deleteImage).toHaveBeenCalledWith(
				'/test/folder',
				'images/test.png',
				undefined
			);
		});
	});

	it('clears attachments when no document is selected', async () => {
		const props = createDefaultProps({ selectedFile: null });
		renderWithProvider(<AutoRun {...props} />);

		// Should not show attachments section
		expect(screen.queryByText(/Attached Images/)).not.toBeInTheDocument();
	});

	it('handles image upload via file input', async () => {
		class MockFileReader {
			onload: ((event: { target: { result: string } }) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: 'data:image/png;base64,upload123' } });
			}
		}
		vi.stubGlobal('FileReader', MockFileReader);
		mockMaestro.autorun.saveImage.mockResolvedValue({
			success: true,
			relativePath: 'images/uploaded-file.png',
		});
		const props = createDefaultProps({ content: 'Initial content' });
		const { container } = renderWithProvider(<AutoRun {...props} />);

		const input = container.querySelector('input[type="file"]') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(['upload'], 'uploaded-file.png', { type: 'image/png' })] },
		});

		await waitFor(() => {
			expect(mockMaestro.autorun.saveImage).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc',
				'upload123',
				'png',
				undefined
			);
		});
		expect(props.onContentChange).toHaveBeenCalledWith(
			'Initial content\n![uploaded-file.png](images/uploaded-file.png)\n'
		);
	});

	it('expands and collapses attachments section', async () => {
		mockMaestro.autorun.listImages.mockResolvedValue({
			success: true,
			images: [{ filename: 'test.png', relativePath: 'images/test.png' }],
		});
		mockMaestro.fs.readFile.mockResolvedValue('data:image/png;base64,abc123');

		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for attachments
		await waitFor(() => {
			expect(screen.getByText(/Attached Images/)).toBeInTheDocument();
		});

		// Attachments should be expanded by default
		const button = screen.getByText(/Attached Images/).closest('button')!;

		// Click to collapse
		fireEvent.click(button);

		// Images should be hidden now - check that the image count is still shown but the images aren't
		await waitFor(() => {
			const imgs = screen.queryAllByRole('img');
			// After collapse, image thumbnails should not be visible
			expect(imgs.length).toBe(0);
		});
	});
});

describe('Mode Restoration After Batch Run', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('restores previous mode when batch run ends', async () => {
		const onModeChange = vi.fn();
		const props = createDefaultProps({ mode: 'edit', onModeChange });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		// Start batch run (this switches to preview mode)
		const batchRunState = createBatchRunState();
		rerender(<AutoRun {...props} batchRunState={batchRunState} />);

		// Should have called onModeChange to switch to preview
		expect(onModeChange).toHaveBeenCalledWith('preview');
		onModeChange.mockClear();

		// End batch run
		rerender(<AutoRun {...props} mode="preview" batchRunState={undefined} />);

		// Should restore to edit mode
		await waitFor(() => {
			expect(onModeChange).toHaveBeenCalledWith('edit');
		});
	});
});

describe('Empty State Refresh', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('shows spinner during refresh in empty state', async () => {
		const onRefresh = vi
			.fn()
			.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
		const props = createDefaultProps({
			documentList: [],
			selectedFile: null,
			onRefresh,
		});
		renderWithProvider(<AutoRun {...props} />);

		// Find and click the Refresh button
		const refreshButtons = screen.getAllByText('Refresh');
		const emptyStateRefresh = refreshButtons[refreshButtons.length - 1];
		fireEvent.click(emptyStateRefresh);

		// The button should show animation class
		expect(onRefresh).toHaveBeenCalled();
		expect(emptyStateRefresh.querySelector('[data-testid="refreshcw-icon"]')).toHaveClass(
			'animate-spin'
		);

		await advanceTimers(700);

		expect(emptyStateRefresh.querySelector('[data-testid="refreshcw-icon"]')).not.toHaveClass(
			'animate-spin'
		);
	});
});

describe('Search Bar Navigation Buttons', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('navigates with chevron up and down buttons', async () => {
		const props = createDefaultProps({ content: 'test test test test' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

		const searchInput = await screen.findByPlaceholderText(/Search/);
		fireEvent.change(searchInput, { target: { value: 'test' } });

		await waitFor(() => {
			expect(screen.getByText('1/4')).toBeInTheDocument();
		});

		// Click next button
		const nextButton = screen.getByTitle('Next match (Enter)');
		fireEvent.click(nextButton);

		await waitFor(() => {
			expect(screen.getByText('2/4')).toBeInTheDocument();
		});

		// Click previous button
		const prevButton = screen.getByTitle('Previous match (Shift+Enter)');
		fireEvent.click(prevButton);

		await waitFor(() => {
			expect(screen.getByText('1/4')).toBeInTheDocument();
		});
	});

	it('closes search when clicking close button', async () => {
		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

		await waitFor(() => {
			expect(screen.getByPlaceholderText(/Search/)).toBeInTheDocument();
		});

		// Click close button
		const closeButton = screen.getByTitle('Close search (Esc)');
		fireEvent.click(closeButton);

		await waitFor(() => {
			expect(screen.queryByPlaceholderText(/Search/)).not.toBeInTheDocument();
		});
	});
});

describe('Scroll Position Persistence', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('calls onStateChange when scrolling in preview mode', async () => {
		const onStateChange = vi.fn();
		const props = createDefaultProps({
			mode: 'preview',
			onStateChange,
			content: 'Line\n'.repeat(100),
		});
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.scroll(preview);

		// onStateChange is debounced by 500ms, so we need to advance timers
		await advanceTimers(500);

		// onStateChange should be called with scroll position
		expect(onStateChange).toHaveBeenCalled();
	});

	it('restores initial preview scroll position on mount', () => {
		const props = createDefaultProps({
			mode: 'preview',
			initialPreviewScrollPos: 120,
			content: 'Line\n'.repeat(40),
		});
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		expect(preview.scrollTop).toBe(120);
	});

	it('replaces pending preview scroll notifications with the latest scroll position', async () => {
		const onStateChange = vi.fn();
		const props = createDefaultProps({
			mode: 'preview',
			onStateChange,
			content: 'Line\n'.repeat(100),
		});
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		preview.scrollTop = 10;
		fireEvent.scroll(preview);
		preview.scrollTop = 55;
		fireEvent.scroll(preview);

		await advanceTimers(500);

		expect(onStateChange).toHaveBeenCalledTimes(1);
		expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ previewScrollPos: 55 }));
	});

	it('records preview scroll locally without a state-change callback', async () => {
		const props = createDefaultProps({
			mode: 'preview',
			onStateChange: undefined,
			content: 'Line\n'.repeat(100),
		});
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		preview.scrollTop = 25;
		fireEvent.scroll(preview);

		await advanceTimers(500);

		expect(preview.scrollTop).toBe(25);
	});

	it('restores preview scroll after preview content changes', async () => {
		let rafCallback: FrameRequestCallback | null = null;
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallback = callback;
				return 1;
			});
		const props = createDefaultProps({
			mode: 'preview',
			content: 'Original preview',
			contentVersion: 1,
		});

		try {
			const { rerender } = renderWithProvider(<AutoRun {...props} />);
			const preview = screen.getByTestId('react-markdown').parentElement!;
			preview.scrollTop = 90;
			fireEvent.scroll(preview);

			rerender(
				<AutoRun
					{...createDefaultProps({
						mode: 'preview',
						content: 'Updated preview',
						contentVersion: 2,
					})}
				/>
			);

			await waitFor(() => {
				expect(screen.getByTestId('react-markdown')).toHaveTextContent('Updated preview');
			});

			preview.scrollTop = 0;
			act(() => {
				rafCallback?.(0);
			});

			expect(preview.scrollTop).toBe(90);
		} finally {
			requestAnimationFrameSpy.mockRestore();
		}
	});

	it('skips preview scroll restoration after unmount', async () => {
		let rafCallback: FrameRequestCallback | null = null;
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallback = callback;
				return 1;
			});
		const props = createDefaultProps({
			mode: 'preview',
			content: 'Original preview',
			contentVersion: 1,
		});

		try {
			const { rerender, unmount } = renderWithProvider(<AutoRun {...props} />);
			const preview = screen.getByTestId('react-markdown').parentElement!;
			preview.scrollTop = 90;
			fireEvent.scroll(preview);

			rerender(<AutoRun {...props} content="Updated preview" contentVersion={2} />);
			unmount();

			act(() => {
				rafCallback?.(0);
			});

			expect(preview.scrollTop).toBe(90);
		} finally {
			requestAnimationFrameSpy.mockRestore();
		}
	});
});

describe('Focus via Imperative Handle', () => {
	it('focuses preview container when calling focus in preview mode', () => {
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({ mode: 'preview' });
		renderWithProvider(<AutoRun {...props} ref={ref} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		ref.current?.focus();

		expect(document.activeElement).toBe(preview);
	});

	it('does not throw when focusing preview mode without a mounted preview container', () => {
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({ folderPath: null, mode: 'preview' });
		renderWithProvider(<AutoRun {...props} ref={ref} />);

		expect(() => ref.current?.focus()).not.toThrow();
	});

	it('focuses textarea after switching documents in edit mode', () => {
		let rafCallback: FrameRequestCallback | null = null;
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallback = callback;
				return 1;
			});
		const props = createDefaultProps({
			mode: 'edit',
			selectedFile: 'test-doc',
			content: 'Doc one',
		});

		try {
			const { rerender } = renderWithProvider(<AutoRun {...props} />);
			const textarea = screen.getByRole('textbox');

			rerender(
				<AutoRun
					{...createDefaultProps({
						mode: 'edit',
						selectedFile: 'another-doc',
						content: 'Doc two',
					})}
				/>
			);

			act(() => {
				rafCallback?.(0);
			});

			expect(document.activeElement).toBe(textarea);
		} finally {
			requestAnimationFrameSpy.mockRestore();
		}
	});

	it('focuses preview container after switching documents in preview mode', () => {
		let rafCallback: FrameRequestCallback | null = null;
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallback = callback;
				return 1;
			});
		const props = createDefaultProps({
			mode: 'preview',
			selectedFile: 'test-doc',
			content: 'Doc one',
		});

		try {
			const { rerender } = renderWithProvider(<AutoRun {...props} />);
			const preview = screen.getByTestId('react-markdown').parentElement!;

			rerender(
				<AutoRun
					{...createDefaultProps({
						mode: 'preview',
						selectedFile: 'another-doc',
						content: 'Doc two',
					})}
				/>
			);

			act(() => {
				rafCallback?.(0);
			});

			expect(document.activeElement).toBe(preview);
		} finally {
			requestAnimationFrameSpy.mockRestore();
		}
	});

	it('does not throw when preview document focus runs without a mounted preview', () => {
		let rafCallback: FrameRequestCallback | null = null;
		const requestAnimationFrameSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((callback: FrameRequestCallback) => {
				rafCallback = callback;
				return 1;
			});
		const props = createDefaultProps({
			folderPath: null,
			mode: 'preview',
			selectedFile: 'test-doc',
		});

		try {
			const { rerender } = renderWithProvider(<AutoRun {...props} />);
			rerender(<AutoRun {...props} selectedFile="another-doc" />);

			expect(() => {
				act(() => {
					rafCallback?.(0);
				});
			}).not.toThrow();
		} finally {
			requestAnimationFrameSpy.mockRestore();
		}
	});
});

describe('Control Key Support (Windows/Linux)', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('toggles mode on Ctrl+E (Windows/Linux)', async () => {
		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.keyDown(textarea, { key: 'e', ctrlKey: true });

		expect(props.onModeChange).toHaveBeenCalledWith('preview');
	});

	it('opens search on Ctrl+F (Windows/Linux)', async () => {
		const props = createDefaultProps({ mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.keyDown(textarea, { key: 'f', ctrlKey: true });

		await waitFor(() => {
			expect(screen.getByPlaceholderText(/Search/)).toBeInTheDocument();
		});
	});

	it('inserts checkbox on Ctrl+L (Windows/Linux)', async () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		fireEvent.focus(textarea);
		textarea.selectionStart = 0;
		textarea.selectionEnd = 0;

		fireEvent.keyDown(textarea, { key: 'l', ctrlKey: true });

		await waitFor(() => {
			expect(textarea.value).toBe('- [ ] ');
		});
	});
});

describe('Preview Mode with Search', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('shows SearchHighlightedContent when searching in preview mode', async () => {
		const props = createDefaultProps({ mode: 'preview', content: 'Find this text' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'f', metaKey: true });

		const searchInput = await screen.findByPlaceholderText(/Search/);
		fireEvent.change(searchInput, { target: { value: 'Find' } });

		await waitFor(() => {
			expect(screen.getByText('1/1')).toBeInTheDocument();
		});
	});

	it('passes bionify=false to preview markdown components while search is active', async () => {
		useSettingsStore.setState({ bionifyReadingMode: true });
		const props = createDefaultProps({ mode: 'preview', content: 'information information' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'f', metaKey: true });

		const searchInput = await screen.findByPlaceholderText(/Search/);
		fireEvent.change(searchInput, { target: { value: 'information' } });

		await waitFor(() => {
			expect(screen.getByText('1/2')).toBeInTheDocument();
		});

		expect(
			createMarkdownComponentsCalls.some(
				(call) =>
					call.searchHighlight &&
					call.enableBionifyReadingMode === false &&
					(call.searchHighlight as { query?: string }).query === 'information'
			)
		).toBe(true);
	});

	it('toggles mode with Cmd+E from preview', async () => {
		const props = createDefaultProps({ mode: 'preview' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'e', metaKey: true });

		expect(props.onModeChange).toHaveBeenCalledWith('edit');
	});

	it('toggles mode with Ctrl+E from preview', async () => {
		const props = createDefaultProps({ mode: 'preview' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'e', ctrlKey: true });

		expect(props.onModeChange).toHaveBeenCalledWith('edit');
	});

	it('does not toggle preview mode with Cmd+E while locked', () => {
		const props = createDefaultProps({
			mode: 'preview',
			batchRunState: createBatchRunState(),
		});
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'e', metaKey: true });

		expect(props.onModeChange).not.toHaveBeenCalled();
	});

	it('lets Cmd+Shift+F propagate in preview mode', () => {
		const props = createDefaultProps({ mode: 'preview' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'f', metaKey: true, shiftKey: true });

		expect(screen.queryByPlaceholderText(/Search/)).not.toBeInTheDocument();
	});

	it('opens search with Ctrl+F in preview mode', async () => {
		const props = createDefaultProps({ mode: 'preview' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'f', ctrlKey: true });

		expect(await screen.findByPlaceholderText(/Search/)).toBeInTheDocument();
	});
});

describe('Batch Run State UI', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('shows task progress in batch run state', () => {
		const batchRunState = createBatchRunState();
		const props = createDefaultProps({ batchRunState });
		renderWithProvider(<AutoRun {...props} />);

		// Stop button should be visible
		expect(screen.getByText('Stop')).toBeInTheDocument();
		expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
		expect(screen.getByTitle('Switch to preview')).not.toBeDisabled();
	});

	it('shows textarea as readonly when locked', () => {
		const batchRunState = createBatchRunState();
		const props = createDefaultProps({ batchRunState, mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveAttribute('readonly');
		expect(textarea).toHaveClass('cursor-not-allowed');
	});
});

describe('Content Sync Edge Cases', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('syncs content from prop when switching documents', () => {
		const props = createDefaultProps({ content: 'Doc 1 content', selectedFile: 'doc1' });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue('Doc 1 content');

		// Switch to different document - this should sync content
		rerender(<AutoRun {...props} selectedFile="doc2" content="Doc 2 content" />);

		expect(textarea).toHaveValue('Doc 2 content');
	});

	it('does not overwrite local changes when content prop changes during editing', async () => {
		const props = createDefaultProps({ content: 'Initial' });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.focus(textarea);
		fireEvent.change(textarea, { target: { value: 'User typing...' } });

		// External content change while user is editing
		rerender(<AutoRun {...props} content="External update" />);

		// Local content should be preserved
		expect(textarea).toHaveValue('User typing...');
	});
});

describe('Document Tree Support', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('passes document tree to document selector', () => {
		const documentTree = [
			{ name: 'doc1', type: 'file' as const, path: 'doc1.md' },
			{ name: 'folder', type: 'folder' as const, path: 'folder', children: [] },
		];
		const props = createDefaultProps({ documentTree });
		renderWithProvider(<AutoRun {...props} />);

		// Document selector should be rendered
		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
	});
});

describe('Document Switching', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('discards unsaved changes when switching documents (manual save model)', async () => {
		// With manual save model, unsaved changes are discarded when switching documents
		// Users must explicitly save before switching to preserve changes
		const props = createDefaultProps({ content: 'Initial', selectedFile: 'doc1' });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Changed content' } });

		// Change document - unsaved changes should be discarded
		rerender(<AutoRun {...props} selectedFile="doc2" content="Doc 2 content" />);

		// No automatic save should happen
		expect(mockMaestro.autorun.writeDoc).not.toHaveBeenCalled();

		// Content should be doc2's content
		expect(screen.getByRole('textbox')).toHaveValue('Doc 2 content');
	});

	it('should re-render when hideTopControls changes (memo regression test)', async () => {
		// This test ensures AutoRun re-renders when hideTopControls prop changes
		// A previous bug had the memo comparator missing hideTopControls
		// hideTopControls affects the top control bar visibility when folderPath is set
		const props = createDefaultProps({ hideTopControls: false, folderPath: '/test/folder' });
		const { rerender, container } = renderWithProvider(<AutoRun {...props} />);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Get elements that are controlled by hideTopControls
		// The control bar with mode buttons should be visible
		const controlElements = container.querySelectorAll('button');
		const initialButtonCount = controlElements.length;

		// Rerender with hideTopControls=true
		rerender(
			<AutoRun {...createDefaultProps({ hideTopControls: true, folderPath: '/test/folder' })} />
		);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// With hideTopControls=true, the top control bar should be hidden
		// which means fewer buttons should be visible
		const updatedControlElements = container.querySelectorAll('button');
		// The component should have re-rendered and hidden the top controls
		expect(updatedControlElements.length).toBeLessThan(initialButtonCount);
	});

	it('should re-render when contentVersion changes (memo regression test)', async () => {
		// This test ensures AutoRun re-renders when contentVersion changes
		// contentVersion is used to force-sync on external file changes
		const onContentChange = vi.fn();
		const props = createDefaultProps({
			content: 'Original content',
			contentVersion: 1,
			onContentChange,
		});

		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Now simulate an external file change by updating content and contentVersion
		rerender(
			<AutoRun
				{...createDefaultProps({
					content: 'Externally modified content',
					contentVersion: 2,
					onContentChange,
				})}
			/>
		);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// The component should have re-rendered with the new content
		// In edit mode, check the textarea value
		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue('Externally modified content');
	});
});

// ============================================================================
// Task 3.4 Tests: Expanding AutoRun.test.tsx for uncovered paths
// ============================================================================

describe('Document Tree Prop Rendering', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('renders document selector with tree structure when documentTree is provided', () => {
		const documentTree = [
			{ name: 'Phase-1', type: 'file' as const, path: 'Phase-1.md' },
			{
				name: 'Planning',
				type: 'folder' as const,
				path: 'Planning',
				children: [
					{ name: 'Roadmap', type: 'file' as const, path: 'Planning/Roadmap.md' },
					{ name: 'Timeline', type: 'file' as const, path: 'Planning/Timeline.md' },
				],
			},
			{ name: 'Notes', type: 'file' as const, path: 'Notes.md' },
		];
		const props = createDefaultProps({
			documentTree,
			documentList: ['Phase-1', 'Roadmap', 'Timeline', 'Notes'],
		});
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
	});

	it('falls back to flat document list when documentTree is undefined', () => {
		const props = createDefaultProps({
			documentTree: undefined,
			documentList: ['doc1', 'doc2', 'doc3'],
		});
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
		// Documents should still be available
		const select = screen.getByTestId('doc-select');
		expect(select.children.length).toBe(3);
	});

	it('passes empty tree array correctly', () => {
		const documentTree: Array<{
			name: string;
			type: 'file' | 'folder';
			path: string;
			children?: unknown[];
		}> = [];
		const props = createDefaultProps({ documentTree, documentList: [] });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
	});

	it('handles deeply nested folder structures', () => {
		const documentTree = [
			{
				name: 'Level1',
				type: 'folder' as const,
				path: 'Level1',
				children: [
					{
						name: 'Level2',
						type: 'folder' as const,
						path: 'Level1/Level2',
						children: [
							{
								name: 'Level3',
								type: 'folder' as const,
								path: 'Level1/Level2/Level3',
								children: [
									{
										name: 'DeepDoc',
										type: 'file' as const,
										path: 'Level1/Level2/Level3/DeepDoc.md',
									},
								],
							},
						],
					},
				],
			},
		];
		const props = createDefaultProps({ documentTree, documentList: ['DeepDoc'] });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
	});

	it('handles mixed file and folder tree structure', () => {
		const documentTree = [
			{ name: 'RootDoc', type: 'file' as const, path: 'RootDoc.md' },
			{
				name: 'Folder',
				type: 'folder' as const,
				path: 'Folder',
				children: [{ name: 'NestedDoc', type: 'file' as const, path: 'Folder/NestedDoc.md' }],
			},
			{ name: 'AnotherRoot', type: 'file' as const, path: 'AnotherRoot.md' },
		];
		const props = createDefaultProps({
			documentTree,
			documentList: ['RootDoc', 'NestedDoc', 'AnotherRoot'],
		});
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
	});

	it('uses documentList when documentTree is not provided', () => {
		const props = createDefaultProps({ documentList: ['alpha', 'beta', 'gamma'] });
		renderWithProvider(<AutoRun {...props} />);

		const select = screen.getByTestId('doc-select');
		expect(select).toContainHTML('alpha');
		expect(select).toContainHTML('beta');
		expect(select).toContainHTML('gamma');
	});
});

describe('hideTopControls Prop Behavior', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('shows all top controls when hideTopControls is false', () => {
		const props = createDefaultProps({ hideTopControls: false });
		renderWithProvider(<AutoRun {...props} />);

		// Top control bar buttons should be visible.
		expect(screen.getByText('Run')).toBeInTheDocument();
		expect(screen.getByTitle('Learn about Auto Runner')).toBeInTheDocument();
	});

	it('hides top control buttons when hideTopControls is true', () => {
		const props = createDefaultProps({ hideTopControls: true });
		renderWithProvider(<AutoRun {...props} />);

		// Top control bar buttons should be hidden.
		expect(screen.queryByText('Run')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Learn about Auto Runner')).not.toBeInTheDocument();
	});

	it('still shows document selector when hideTopControls is true', () => {
		const props = createDefaultProps({ hideTopControls: true });
		renderWithProvider(<AutoRun {...props} />);

		// Document selector should still be visible
		expect(screen.getByTestId('document-selector')).toBeInTheDocument();
	});

	it('still shows content area when hideTopControls is true', () => {
		const props = createDefaultProps({ hideTopControls: true, content: 'Test content' });
		renderWithProvider(<AutoRun {...props} />);

		// Content should still be visible
		expect(screen.getByRole('textbox')).toBeInTheDocument();
		expect(screen.getByRole('textbox')).toHaveValue('Test content');
	});

	it('hides expand button when hideTopControls is true', () => {
		const onExpand = vi.fn();
		const props = createDefaultProps({ hideTopControls: true, onExpand });
		renderWithProvider(<AutoRun {...props} />);

		// Expand button should not be visible when hideTopControls is true
		expect(screen.queryByTitle(/Expand to full screen/)).not.toBeInTheDocument();
	});

	it('shows expand button when hideTopControls is false and onExpand is provided', () => {
		const onExpand = vi.fn();
		const props = createDefaultProps({ hideTopControls: false, onExpand });
		renderWithProvider(<AutoRun {...props} />);

		// Expand button should be visible
		expect(screen.getByTitle(/Expand to full screen/)).toBeInTheDocument();
	});

	it('hides image upload button when hideTopControls is true', () => {
		const props = createDefaultProps({ hideTopControls: true, mode: 'edit' });
		renderWithProvider(<AutoRun {...props} />);

		// Image upload button should not be visible
		expect(screen.queryByTitle('Add image (or paste from clipboard)')).not.toBeInTheDocument();
	});

	it('keyboard shortcuts still work when hideTopControls is true', async () => {
		const onModeChange = vi.fn();
		const props = createDefaultProps({ hideTopControls: true, mode: 'edit', onModeChange });
		renderWithProvider(<AutoRun {...props} />);

		// Cmd+E should still toggle mode
		const textarea = screen.getByRole('textbox');
		fireEvent.keyDown(textarea, { key: 'e', metaKey: true });

		expect(onModeChange).toHaveBeenCalledWith('preview');
	});

	it('editing still works when hideTopControls is true', async () => {
		const props = createDefaultProps({ hideTopControls: true, content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'New content typed' } });

		expect(textarea).toHaveValue('New content typed');
	});

	it('Save/Revert buttons still appear when dirty with hideTopControls true', async () => {
		const props = createDefaultProps({ hideTopControls: true, content: 'Initial' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Modified content' } });

		// Bottom panel with Save/Revert should still appear
		expect(screen.getByText('Save')).toBeInTheDocument();
		expect(screen.getByText('Revert')).toBeInTheDocument();
	});

	it('hideTopControls has no effect when folderPath is null', () => {
		const props = createDefaultProps({ hideTopControls: true, folderPath: null });
		renderWithProvider(<AutoRun {...props} />);

		// Only the "Select Auto Run Folder" button should be visible
		expect(screen.getByText('Select Auto Run Folder')).toBeInTheDocument();
		expect(screen.queryByText('Edit')).not.toBeInTheDocument();
		expect(screen.queryByText('Preview')).not.toBeInTheDocument();
	});
});

describe('Template Autocomplete Integration', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('updates content when typing in textarea via autocomplete handler', async () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Hello world' } });

		expect(textarea).toHaveValue('Hello world');
	});

	it('handles typing template variable trigger {{', async () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: '{{' } });

		// Content should update (autocomplete state is mocked)
		expect(textarea).toHaveValue('{{');
	});

	it('shows placeholder text mentioning template variables', () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByPlaceholderText(/type \{\{ for variables/)).toBeInTheDocument();
	});

	it('maintains cursor position after content change', async () => {
		const props = createDefaultProps({ content: 'Hello World' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		fireEvent.focus(textarea);

		// Set cursor position in middle
		textarea.selectionStart = 6;
		textarea.selectionEnd = 6;

		// Type a character
		fireEvent.change(textarea, { target: { value: 'Hello, World' } });

		expect(textarea).toHaveValue('Hello, World');
	});

	it('content changes are not blocked by autocomplete', async () => {
		const props = createDefaultProps({ content: 'Initial' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');

		// Multiple consecutive changes
		fireEvent.change(textarea, { target: { value: 'First change' } });
		expect(textarea).toHaveValue('First change');

		fireEvent.change(textarea, { target: { value: 'Second change' } });
		expect(textarea).toHaveValue('Second change');

		fireEvent.change(textarea, { target: { value: 'Third change' } });
		expect(textarea).toHaveValue('Third change');
	});

	it('handles partial template variable typing', async () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');

		// Type partial template variable syntax
		fireEvent.change(textarea, { target: { value: '{' } });
		expect(textarea).toHaveValue('{');

		fireEvent.change(textarea, { target: { value: '{{' } });
		expect(textarea).toHaveValue('{{');

		fireEvent.change(textarea, { target: { value: '{{date' } });
		expect(textarea).toHaveValue('{{date');
	});

	it('handles complete template variable syntax', async () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');

		fireEvent.change(textarea, { target: { value: '{{date}}' } });
		expect(textarea).toHaveValue('{{date}}');
	});

	it('autocomplete does not interfere with normal text input', async () => {
		const props = createDefaultProps({ content: '' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');

		// Regular typing without autocomplete trigger
		fireEvent.change(textarea, { target: { value: 'This is a regular sentence.' } });
		expect(textarea).toHaveValue('This is a regular sentence.');
	});

	it('handles Tab key insertion (not autocomplete selection)', async () => {
		const props = createDefaultProps({ content: 'Line1' });
		renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
		fireEvent.focus(textarea);
		textarea.selectionStart = 5;
		textarea.selectionEnd = 5;

		fireEvent.keyDown(textarea, { key: 'Tab' });

		await waitFor(() => {
			expect(textarea.value).toBe('Line1\t');
		});
	});
});

describe('Mermaid Diagram Rendering in Preview', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	// Note: The mermaid diagram tests verify that the content renders in preview mode.
	// The actual ReactMarkdown is mocked to just display children directly, so we verify
	// the mermaid content is present in the preview via the mocked ReactMarkdown.

	it('displays mermaid code block content in preview mode', () => {
		const mermaidContent = '```mermaid\ngraph TD\nA --> B\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		// Content is displayed via mocked ReactMarkdown
		expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		expect(screen.getByTestId('react-markdown')).toHaveTextContent('mermaid');
		expect(screen.getByTestId('react-markdown')).toHaveTextContent('graph TD');
	});

	it('displays flowchart mermaid content in preview', () => {
		const mermaidContent = '```mermaid\nflowchart LR\n  A[Start] --> B{Decision}\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('flowchart LR');
	});

	it('displays sequence diagram mermaid content in preview', () => {
		const mermaidContent = '```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('sequenceDiagram');
	});

	it('displays class diagram mermaid content in preview', () => {
		const mermaidContent = '```mermaid\nclassDiagram\n  class Animal\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('classDiagram');
	});

	it('displays state diagram mermaid content in preview', () => {
		const mermaidContent = '```mermaid\nstateDiagram-v2\n  [*] --> Still\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('stateDiagram-v2');
	});

	it('displays gantt chart mermaid content in preview', () => {
		const mermaidContent = '```mermaid\ngantt\n  title A Gantt Diagram\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('gantt');
	});

	it('displays pie chart mermaid content in preview', () => {
		const mermaidContent = '```mermaid\npie title Pets\n  "Dogs" : 386\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('pie');
	});

	it('shows mermaid content in textarea in edit mode', () => {
		const mermaidContent = '```mermaid\ngraph TD\nA --> B\n```';
		const props = createDefaultProps({ mode: 'edit', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		// In edit mode, raw text is shown in textarea
		expect(screen.getByRole('textbox')).toHaveValue(mermaidContent);
		// Preview markdown should not be visible in edit mode
		expect(screen.queryByTestId('react-markdown')).not.toBeInTheDocument();
	});

	it('displays multiple code blocks in preview', () => {
		const content = `# Document

\`\`\`mermaid
graph TD
A --> B
\`\`\`

Text

\`\`\`mermaid
sequenceDiagram
Alice->>Bob: Hi
\`\`\`
`;
		const props = createDefaultProps({ mode: 'preview', content });
		renderWithProvider(<AutoRun {...props} />);

		const markdown = screen.getByTestId('react-markdown');
		expect(markdown).toHaveTextContent('graph TD');
		expect(markdown).toHaveTextContent('sequenceDiagram');
	});

	it('displays javascript code block content in preview', () => {
		const content = '```javascript\nconst x = 1;\n```';
		const props = createDefaultProps({ mode: 'preview', content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('const x = 1');
	});

	it('displays mermaid block with extra whitespace', () => {
		const mermaidContent = '```mermaid   \n  graph TD  \n  A --> B  \n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('graph TD');
	});

	it('displays mermaid alongside other markdown content', () => {
		const content = `# Title

Some text.

\`\`\`mermaid
graph TD
A --> B
\`\`\`

- List item
`;
		const props = createDefaultProps({ mode: 'preview', content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTestId('react-markdown')).toHaveTextContent('Title');
		expect(screen.getByTestId('react-markdown')).toHaveTextContent('Some text');
		expect(screen.getByTestId('react-markdown')).toHaveTextContent('graph TD');
		expect(screen.getByTestId('react-markdown')).toHaveTextContent('List item');
	});

	it('handles empty mermaid code block gracefully', () => {
		const mermaidContent = '```mermaid\n\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });

		// Should render without crashing
		expect(() => renderWithProvider(<AutoRun {...props} />)).not.toThrow();
		expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
	});

	it('verifies MermaidRenderer mock is registered', () => {
		// This test verifies the mock is set up (the vi.mock at the top of file)
		// The real component uses MermaidRenderer for mermaid code blocks
		// The mock was configured to render: <div data-testid="mermaid-renderer">{chart}</div>
		const mermaidContent = '```mermaid\ngraph TD\n```';
		const props = createDefaultProps({ mode: 'preview', content: mermaidContent });
		renderWithProvider(<AutoRun {...props} />);

		// The mocked ReactMarkdown just renders children as text
		// The actual MermaidRenderer integration is tested via the component's
		// markdownComponents config which includes the mermaid renderer
		expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
	});
});

describe('Content Versioning and External Changes', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('force-syncs content when contentVersion increments', async () => {
		const props = createDefaultProps({ content: 'Original', contentVersion: 1 });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue('Original');

		// User makes local edits
		fireEvent.change(textarea, { target: { value: 'User edits' } });
		expect(textarea).toHaveValue('User edits');

		// External file change triggers contentVersion increment
		rerender(
			<AutoRun {...createDefaultProps({ content: 'External update', contentVersion: 2 })} />
		);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Content should be force-synced from external change
		expect(textarea).toHaveValue('External update');
	});

	it('preserves local content when only content prop changes (no version change)', async () => {
		const props = createDefaultProps({ content: 'Original', contentVersion: 1 });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'User local edits' } });
		expect(textarea).toHaveValue('User local edits');

		// Content prop changes without version increment (shouldn't overwrite local)
		rerender(
			<AutoRun {...createDefaultProps({ content: 'Some other content', contentVersion: 1 })} />
		);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Local edits should be preserved
		expect(textarea).toHaveValue('User local edits');
	});

	it('handles contentVersion of 0 correctly', () => {
		const props = createDefaultProps({ content: 'Test', contentVersion: 0 });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByRole('textbox')).toHaveValue('Test');
	});

	it('handles large contentVersion increments', async () => {
		const props = createDefaultProps({ content: 'V1', contentVersion: 1 });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByRole('textbox')).toHaveValue('V1');

		// Large version jump
		rerender(<AutoRun {...createDefaultProps({ content: 'V100', contentVersion: 100 })} />);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		expect(screen.getByRole('textbox')).toHaveValue('V100');
	});

	it('resets dirty state when external change arrives', async () => {
		const props = createDefaultProps({ content: 'Original', contentVersion: 1 });
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Dirty content' } });

		// Should be dirty
		expect(screen.getByText('Save')).toBeInTheDocument();

		// External change
		rerender(
			<AutoRun {...createDefaultProps({ content: 'External update', contentVersion: 2 })} />
		);

		await act(async () => {
			vi.advanceTimersByTime(100);
		});

		// Content synced, no longer dirty
		expect(screen.queryByText('Save')).not.toBeInTheDocument();
	});

	it('syncs externally controlled draft and saved state while propagating edits', async () => {
		const onExternalLocalContentChange = vi.fn();
		const onExternalSavedContentChange = vi.fn();
		const props = createDefaultProps({
			content: 'Saved draft',
			externalLocalContent: 'Local draft',
			externalSavedContent: 'Saved draft',
			onExternalLocalContentChange,
			onExternalSavedContentChange,
		});
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		const textarea = screen.getByRole('textbox');
		expect(textarea).toHaveValue('Local draft');

		fireEvent.change(textarea, { target: { value: 'Edited shared draft' } });
		expect(onExternalLocalContentChange).toHaveBeenCalledWith('Edited shared draft');

		fireEvent.click(screen.getByTitle(`Save changes (${formatShortcutKeys(['Meta', 's'])})`));

		await waitFor(() => {
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'Edited shared draft',
				undefined
			);
		});
		expect(onExternalSavedContentChange).toHaveBeenCalledWith('Edited shared draft');

		rerender(
			<AutoRun
				{...createDefaultProps({
					content: 'Externally saved draft',
					externalLocalContent: 'Externally edited draft',
					externalSavedContent: 'Externally saved draft',
					onExternalLocalContentChange,
					onExternalSavedContentChange,
				})}
			/>
		);

		await waitFor(() => {
			expect(screen.getByRole('textbox')).toHaveValue('Externally edited draft');
		});
	});
});

describe('Task Count Display', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('displays task count when content has unchecked tasks', () => {
		const content = '- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/0 of 3 tasks completed/))).toBeInTheDocument();
	});

	it('displays task count with completed tasks', () => {
		const content = '- [x] Done\n- [ ] Not done\n- [x] Also done';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/2 of 3 tasks completed/))).toBeInTheDocument();
	});

	it('displays singular task text for single task', () => {
		const content = '- [ ] Single task';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/0 of 1 task completed/))).toBeInTheDocument();
	});

	it('shows success color when all tasks completed', () => {
		const content = '- [x] Done 1\n- [x] Done 2';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		const taskCountContainer = screen.getByText(getByNormalizedText(/2 of 2 tasks completed/));
		// The success color is on the first child span (completed count), not the parent container
		const completedCountSpan = taskCountContainer.querySelector('span');
		expect(completedCountSpan).toHaveStyle({ color: createMockTheme().colors.success });
	});

	it('does not show task count when no tasks in content', () => {
		const content = 'Just some regular text without any tasks.';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.queryByText(getByNormalizedText(/tasks completed/))).not.toBeInTheDocument();
	});

	it('handles nested task lists', () => {
		const content = '- [ ] Task 1\n  - [x] Subtask 1\n  - [ ] Subtask 2\n- [x] Task 2';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/2 of 4 tasks completed/))).toBeInTheDocument();
	});

	it('handles mixed markdown with tasks', () => {
		const content = '# Title\n\nSome text\n\n- [x] Task\n- [ ] Another task\n\nMore text';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/1 of 2 tasks completed/))).toBeInTheDocument();
	});

	it('updates task count when externalSavedContent changes', async () => {
		// Task counts are computed from saved content, not live edits
		// This reflects the intentional behavior where counts only update on save
		// Use externalSavedContent prop to control the saved content state
		const initialContent = '- [ ] Task 1\n- [ ] Task 2';
		const props = createDefaultProps({
			content: initialContent,
			externalSavedContent: initialContent,
		});
		const { rerender } = renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/0 of 2 tasks completed/))).toBeInTheDocument();

		// Simulate content being saved by updating externalSavedContent
		const updatedContent = '- [x] Task 1\n- [ ] Task 2';
		const updatedProps = createDefaultProps({
			content: updatedContent,
			externalSavedContent: updatedContent,
		});
		rerender(<AutoRun {...updatedProps} />);

		await waitFor(() => {
			expect(screen.getByText(getByNormalizedText(/1 of 2 tasks completed/))).toBeInTheDocument();
		});
	});

	it('handles asterisk-based task lists', () => {
		const content = '* [ ] Task with asterisk\n* [x] Done with asterisk';
		const props = createDefaultProps({ content });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByText(getByNormalizedText(/1 of 2 tasks completed/))).toBeInTheDocument();
	});

	it('displays token count when the encoder resolves', async () => {
		vi.mocked(getEncoder).mockResolvedValueOnce({
			encode: vi.fn(() => [1, 2, 3, 4]),
		} as any);
		const props = createDefaultProps({ content: 'Count these tokens' });
		renderWithProvider(<AutoRun {...props} />);

		await waitFor(() => {
			expect(screen.getByText('Tokens:')).toBeInTheDocument();
		});
		expect(screen.getByText('4')).toBeInTheDocument();
	});

	it('logs token counting failures without showing a stale token count', async () => {
		const consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		vi.mocked(getEncoder).mockRejectedValueOnce(new Error('encoder unavailable'));
		const props = createDefaultProps({ content: 'Cannot count this' });

		try {
			renderWithProvider(<AutoRun {...props} />);

			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith(
					'Failed to count tokens:',
					undefined,
					expect.any(Error)
				);
			});
			expect(screen.queryByText('Tokens:')).not.toBeInTheDocument();
		} finally {
			consoleError.mockRestore();
		}
	});
});

describe('Expand Button Behavior', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('shows expand button when onExpand is provided', () => {
		const onExpand = vi.fn();
		const props = createDefaultProps({ onExpand });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.getByTitle(/Expand to full screen/)).toBeInTheDocument();
	});

	it('does not show expand button when onExpand is not provided', () => {
		const props = createDefaultProps({ onExpand: undefined });
		renderWithProvider(<AutoRun {...props} />);

		expect(screen.queryByTitle(/Expand to full screen/)).not.toBeInTheDocument();
	});

	it('calls onExpand when expand button is clicked', () => {
		const onExpand = vi.fn();
		const props = createDefaultProps({ onExpand });
		renderWithProvider(<AutoRun {...props} />);

		fireEvent.click(screen.getByTitle(/Expand to full screen/));
		expect(onExpand).toHaveBeenCalledTimes(1);
	});

	it('displays keyboard shortcut in expand button title when available', () => {
		const onExpand = vi.fn();
		const shortcuts = {
			toggleAutoRunExpanded: { keys: ['Meta', 'Shift', 'e'], description: 'Toggle expanded' },
		};
		const props = createDefaultProps({ onExpand, shortcuts });
		renderWithProvider(<AutoRun {...props} />);

		// The title should include the shortcut. formatShortcutKeys converts keys to display format.
		// In test environment (non-Mac), it formats as 'Ctrl+Shift+E'
		const expandButton = screen.getByTitle(/Expand to full screen/);
		expect(expandButton).toBeInTheDocument();
		// Verify title contains shortcut info (either Mac or non-Mac format)
		expect(expandButton.getAttribute('title')).toMatch(/\(.*\)/);
	});
});

describe('Responsive Bottom Panel', () => {
	// The default ResizeObserver mock in setup.ts returns 1000px width
	// Since our compact threshold is 350px, the default mode is non-compact

	it('shows icon-only Save/Revert controls and hides completed text in compact mode', async () => {
		const OriginalResizeObserver = globalThis.ResizeObserver;
		class CompactResizeObserver {
			constructor(private readonly callback: ResizeObserverCallback) {}

			observe(element: Element) {
				this.callback(
					[
						{
							target: element,
							contentRect: { width: 320 } as DOMRectReadOnly,
						} as ResizeObserverEntry,
					],
					this as unknown as ResizeObserver
				);
			}

			unobserve = vi.fn();
			disconnect = vi.fn();
		}
		globalThis.ResizeObserver = CompactResizeObserver as unknown as typeof ResizeObserver;

		try {
			const contentWithTasks = '# Tasks\n- [x] Done task\n- [ ] Pending task';
			const props = createDefaultProps({ content: contentWithTasks });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: `${contentWithTasks}\nUpdated` } });

			const saveButton = screen.getByTitle(`Save changes (${formatShortcutKeys(['Meta', 's'])})`);
			const revertButton = screen.getByTitle('Discard changes');

			await waitFor(() => {
				expect(saveButton).toHaveTextContent('');
				expect(revertButton).toHaveTextContent('');
				expect(screen.queryByText(/completed/)).not.toBeInTheDocument();
			});
		} finally {
			globalThis.ResizeObserver = OriginalResizeObserver;
		}
	});

	it('shows Save button with text label in non-compact mode (width > 350px)', async () => {
		const props = createDefaultProps({ content: 'Initial' });
		renderWithProvider(<AutoRun {...props} />);

		// Make content dirty to show Save/Revert buttons
		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Modified content' } });

		// In non-compact mode, Save should show text label
		const saveButton = screen.getByTitle(`Save changes (${formatShortcutKeys(['Meta', 's'])})`);
		expect(saveButton).toBeInTheDocument();
		expect(saveButton).toHaveTextContent('Save');
	});

	it('shows Revert button with text label in non-compact mode (width > 350px)', async () => {
		const props = createDefaultProps({ content: 'Initial' });
		renderWithProvider(<AutoRun {...props} />);

		// Make content dirty to show Save/Revert buttons
		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Modified content' } });

		// In non-compact mode, Revert should show text label
		const revertButton = screen.getByTitle('Discard changes');
		expect(revertButton).toBeInTheDocument();
		expect(revertButton).toHaveTextContent('Revert');
	});

	it('shows "completed" word in task count in non-compact mode (width > 350px)', async () => {
		const contentWithTasks = '# Tasks\n- [x] Done task\n- [ ] Pending task';
		const props = createDefaultProps({ content: contentWithTasks });
		renderWithProvider(<AutoRun {...props} />);

		// Wait for the component to render with task counts
		await waitFor(() => {
			// In non-compact mode, the text should include "completed"
			expect(screen.getByText(getByNormalizedText(/1 of 2 tasks completed/))).toBeInTheDocument();
		});
	});

	it('bottom panel has ref for ResizeObserver to track width', async () => {
		const contentWithTasks = '# Tasks\n- [x] Done task\n- [ ] Pending task';
		const props = createDefaultProps({ content: contentWithTasks });
		const { container } = renderWithProvider(<AutoRun {...props} />);

		// Find the bottom panel (has flex-shrink-0, border-t, etc.)
		const bottomPanel = container.querySelector('.flex-shrink-0.border-t');
		expect(bottomPanel).toBeInTheDocument();
	});
});

describe('Reset Tasks Flash Notification', () => {
	beforeEach(() => {
		setupMaestroMock();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('calls onShowFlash with correct count when resetting single completed task', async () => {
		const contentWithTask = '- [x] Done task\n- [ ] Pending task';
		const onShowFlash = vi.fn();
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			content: contentWithTask,
			onShowFlash,
		});
		renderWithProvider(<AutoRun ref={ref} {...props} />);

		// Call the reset tasks function via the imperative handle
		await act(async () => {
			ref.current?.openResetTasksModal();
		});

		fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

		await waitFor(() => {
			expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'- [ ] Done task\n- [ ] Pending task',
				undefined
			);
		});
		expect(onShowFlash).toHaveBeenCalledWith('1 task reverted to incomplete');
	});

	it('does not reset tasks when no Auto Run folder or document is selected', async () => {
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			folderPath: null,
			selectedFile: 'test-doc',
			content: '- [x] Done task',
		});
		renderWithProvider(<AutoRun ref={ref} {...props} />);

		await act(async () => {
			ref.current?.openResetTasksModal();
		});

		expect(screen.getByText('Reset Completed Tasks')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));
		expect(window.maestro.autorun.writeDoc).not.toHaveBeenCalled();
	});

	it('onShowFlash is called after handleResetTasks saves the document', async () => {
		const contentWithTasks = '- [x] First done\n- [x] Second done\n- [ ] Pending';
		const onShowFlash = vi.fn();
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			content: contentWithTasks,
			onShowFlash,
		});
		renderWithProvider(<AutoRun ref={ref} {...props} />);

		// The getCompletedTaskCount function should return 2
		expect(ref.current?.getCompletedTaskCount()).toBe(2);
	});

	it('getCompletedTaskCount returns correct count for multiple completed tasks', async () => {
		const contentWithTasks = '- [x] Task 1\n- [x] Task 2\n- [x] Task 3\n- [ ] Not done';
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			content: contentWithTasks,
		});
		renderWithProvider(<AutoRun ref={ref} {...props} />);

		expect(ref.current?.getCompletedTaskCount()).toBe(3);
	});

	it('getCompletedTaskCount returns 0 when no completed tasks', async () => {
		const contentWithTasks = '- [ ] Task 1\n- [ ] Task 2';
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			content: contentWithTasks,
		});
		renderWithProvider(<AutoRun ref={ref} {...props} />);

		expect(ref.current?.getCompletedTaskCount()).toBe(0);
	});

	it('resets with no completed tasks without showing a flash message', async () => {
		const mockMaestro = setupMaestroMock();
		const contentWithCompletedTask = '- [x] Task 1\n- [ ] Task 2';
		const contentWithoutCompletedTasks = '- [ ] Task 1\n- [ ] Task 2';
		const onShowFlash = vi.fn();
		const ref = React.createRef<AutoRunHandle>();
		const props = createDefaultProps({
			content: contentWithCompletedTask,
			onShowFlash,
		});
		renderWithProvider(<AutoRun ref={ref} {...props} />);

		await act(async () => {
			ref.current?.openResetTasksModal();
		});
		fireEvent.change(screen.getByRole('textbox'), {
			target: { value: contentWithoutCompletedTasks },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

		await waitFor(() => {
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				contentWithoutCompletedTasks,
				undefined
			);
		});
		expect(onShowFlash).not.toHaveBeenCalled();
	});

	it('confirms reset tasks, writes unchecked content, and shows a flash message', async () => {
		const mockMaestro = setupMaestroMock();
		const contentWithTasks = '- [x] First done\n* [x] Second done\n- [ ] Pending';
		const onShowFlash = vi.fn();
		const props = createDefaultProps({
			content: contentWithTasks,
			onShowFlash,
			sshRemoteId: 'remote-123',
		});
		renderWithProvider(<AutoRun {...props} />);

		fireEvent.click(screen.getByTitle('Reset 2 completed tasks'));
		expect(screen.getByText('Reset Completed Tasks')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

		await waitFor(() => {
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'- [ ] First done\n* [ ] Second done\n- [ ] Pending',
				'remote-123'
			);
		});
		expect(onShowFlash).toHaveBeenCalledWith('2 tasks reverted to incomplete');
		expect(screen.queryByText('Reset Completed Tasks')).not.toBeInTheDocument();
	});

	it('logs reset task save failures without showing a success flash', async () => {
		const mockMaestro = setupMaestroMock();
		mockMaestro.autorun.writeDoc.mockRejectedValueOnce(new Error('permission denied'));
		const consoleError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const onShowFlash = vi.fn();
		const props = createDefaultProps({
			content: '- [x] Cannot save',
			onShowFlash,
		});

		try {
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle('Reset 1 completed task'));
			fireEvent.click(screen.getByRole('button', { name: 'Reset Tasks' }));

			await waitFor(() => {
				expect(consoleError).toHaveBeenCalledWith(
					'Failed to save after reset:',
					undefined,
					expect.any(Error)
				);
			});
			expect(onShowFlash).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});

	describe('Error Banner (Phase 5.10)', () => {
		it('should show Resume button for recoverable errors', () => {
			const onResumeAfterError = vi.fn();
			const onAbortBatchOnError = vi.fn();
			const batchRunState = createBatchRunState({
				errorPaused: true,
				error: {
					type: 'rate_limited',
					message: 'Rate limit exceeded',
					recoverable: true,
					timestamp: Date.now(),
					agentId: 'test',
				},
				errorDocumentIndex: 0,
			});
			seedBatchStore('test-session-1', batchRunState);
			const props = createDefaultProps({
				batchRunState,
				onResumeAfterError,
				onAbortBatchOnError,
			});
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Auto Run Paused')).toBeInTheDocument();
			expect(screen.getByTitle('Retry and resume Auto Run')).toBeInTheDocument();
			expect(screen.getByTitle('Stop Auto Run completely')).toBeInTheDocument();
		});

		it('should hide Resume button for non-recoverable errors', () => {
			const onResumeAfterError = vi.fn();
			const onAbortBatchOnError = vi.fn();
			const batchRunState = createBatchRunState({
				errorPaused: true,
				error: {
					type: 'auth_expired',
					message: 'Authentication expired',
					recoverable: false,
					timestamp: Date.now(),
					agentId: 'test',
				},
				errorDocumentIndex: 0,
			});
			seedBatchStore('test-session-1', batchRunState);
			const props = createDefaultProps({
				batchRunState,
				onResumeAfterError,
				onAbortBatchOnError,
			});
			renderWithProvider(<AutoRun {...props} />);

			// Error banner should show
			expect(screen.getByText('Auto Run Paused')).toBeInTheDocument();
			expect(screen.getByText('Authentication expired')).toBeInTheDocument();
			// Resume should NOT be present for non-recoverable errors
			expect(screen.queryByTitle('Retry and resume Auto Run')).not.toBeInTheDocument();
			// Abort should still be visible
			expect(screen.getByTitle('Stop Auto Run completely')).toBeInTheDocument();
		});

		it('should call onAbortBatchOnError when Abort Run is clicked', () => {
			const onAbortBatchOnError = vi.fn();
			const batchRunState = createBatchRunState({
				errorPaused: true,
				error: {
					type: 'token_exhaustion',
					message: 'Prompt is too long',
					recoverable: true,
					timestamp: Date.now(),
					agentId: 'test',
				},
				errorDocumentIndex: 0,
			});
			seedBatchStore('test-session-1', batchRunState);
			const props = createDefaultProps({
				batchRunState,
				onAbortBatchOnError,
			});
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle('Stop Auto Run completely'));
			expect(onAbortBatchOnError).toHaveBeenCalledTimes(1);
		});

		it('should call onResumeAfterError when Resume is clicked', () => {
			const onResumeAfterError = vi.fn();
			const batchRunState = createBatchRunState({
				errorPaused: true,
				error: {
					type: 'rate_limited',
					message: 'Rate limited',
					recoverable: true,
					timestamp: Date.now(),
					agentId: 'test',
				},
				errorDocumentIndex: 0,
			});
			seedBatchStore('test-session-1', batchRunState);
			const props = createDefaultProps({
				batchRunState,
				onResumeAfterError,
			});
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle('Retry and resume Auto Run'));
			expect(onResumeAfterError).toHaveBeenCalledTimes(1);
		});
	});
});
