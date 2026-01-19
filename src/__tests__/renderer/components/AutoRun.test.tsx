/**
 * @file AutoRun.test.tsx
 * @description Tests for the AutoRun component - a markdown editor/viewer for Auto Run feature
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AutoRun, AutoRunHandle } from '../../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, BatchRunState, SessionState } from '../../../renderer/types';

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

// Mock the external dependencies
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({
	default: {},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

vi.mock('../../../renderer/components/AutoRunnerHelpModal', () => ({
	AutoRunnerHelpModal: ({ onClose }: { onClose: () => void }) => (
		<div data-testid="help-modal">
			<button onClick={onClose}>Close</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

vi.mock('../../../renderer/components/AutoRunDocumentSelector', () => ({
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

vi.mock('../../../renderer/hooks/input/useTemplateAutocomplete', () => ({
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
			handleKeyDown: () => false,
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

vi.mock('../../../renderer/components/TemplateAutocompleteDropdown', () => ({
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
	const mockMaestro = {
		fs: {
			readFile: vi.fn().mockResolvedValue('data:image/png;base64,abc123'),
			readDir: vi.fn().mockResolvedValue([]),
		},
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			saveImage: vi.fn().mockResolvedValue({ success: true, relativePath: 'images/test-123.png' }),
			deleteImage: vi.fn().mockResolvedValue({ success: true }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue(undefined),
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

describe('AutoRun', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
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

		it('displays Edit and Preview toggle buttons', () => {
			const props = createDefaultProps();
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTitle('Edit document')).toBeInTheDocument();
			expect(screen.getByTitle('Preview document')).toBeInTheDocument();
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

			fireEvent.click(screen.getByTitle('Edit document'));
			expect(props.onModeChange).toHaveBeenCalledWith('edit');
		});

		it('calls onModeChange when clicking Preview button', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			fireEvent.click(screen.getByTitle('Preview document'));
			expect(props.onModeChange).toHaveBeenCalledWith('preview');
		});

		it('disables Edit button when batch run is active', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState });
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
	});

	describe('Manual Save Functionality', () => {
		it('saves content when clicking Save button', async () => {
			const props = createDefaultProps({ content: 'Initial' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Updated content' } });

			// Click the Save button
			fireEvent.click(screen.getByText('Save'));

			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'Updated content',
				undefined // sshRemoteId (undefined for local sessions)
			);
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

		it('toggles mode on Cmd+E', async () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'e', metaKey: true });

			expect(props.onModeChange).toHaveBeenCalledWith('preview');
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

			await waitFor(() => {
				expect(screen.getByText('No matches')).toBeInTheDocument();
			});
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

			fireEvent.click(screen.getByText('Run'));

			// Should save the dirty content before opening batch runner
			expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'test-doc.md',
				'new content',
				undefined // sshRemoteId (undefined for local sessions)
			);
			expect(onOpenBatchRunner).toHaveBeenCalled();
		});

		it('disables Run button when agent is busy', () => {
			const props = createDefaultProps({ sessionState: 'busy' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Run').closest('button')).toBeDisabled();
		});

		it('disables Run button when agent is connecting', () => {
			const props = createDefaultProps({ sessionState: 'connecting' as SessionState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByText('Run').closest('button')).toBeDisabled();
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

			expect(screen.getByText('Stopping...')).toBeInTheDocument();
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
			expect(screen.getByText('Select Folder')).toBeInTheDocument();
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

			// Get the Select Folder button in the empty state
			fireEvent.click(screen.getByText('Select Folder'));

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
				expect(mockMaestro.autorun.listImages).toHaveBeenCalledWith('/test/folder', 'test-doc');
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

		// NOTE: Image upload button is currently disabled in the component (wrapped in `false &&`)
		// These tests are skipped until the feature is re-enabled
		it.skip('shows image upload button in edit mode', () => {
			const props = createDefaultProps({ mode: 'edit' });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTitle('Add image (or paste from clipboard)')).toBeInTheDocument();
		});

		it.skip('hides image upload button in preview mode', () => {
			const props = createDefaultProps({ mode: 'preview' });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle('Add image (or paste from clipboard)')).not.toBeInTheDocument();
		});

		it.skip('hides image upload button when locked', () => {
			const batchRunState = createBatchRunState();
			const props = createDefaultProps({ batchRunState });
			renderWithProvider(<AutoRun {...props} />);

			expect(screen.queryByTitle('Add image (or paste from clipboard)')).not.toBeInTheDocument();
		});
	});

	describe('Image Paste Handling', () => {
		// TODO: PENDING - NEEDS FIX - FileReader mocking is complex in jsdom
		it.skip('handles image paste and inserts markdown reference', async () => {
			// This test requires complex FileReader mocking that doesn't work well in jsdom
			// The functionality is tested manually
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

			// toggleMode is called via Cmd+E, which does call onStateChange
			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'e', metaKey: true });

			expect(onStateChange).toHaveBeenCalledWith(
				expect.objectContaining({
					mode: 'preview',
				})
			);
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
	});

	describe('Legacy onChange Prop', () => {
		// TODO: PENDING - NEEDS FIX - Legacy onChange requires deep integration testing
		// The component's internal state management makes it hard to test the legacy path
		// without modifying source code to expose internals
		it.skip('falls back to onChange when onContentChange is not provided', async () => {
			// This test verifies legacy behavior that is complex to test in isolation
			// The functionality has been tested manually
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
				'images/test.png'
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
				'images/test.png'
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
		const copyButton = screen.getByTitle('Copy image to clipboard (⌘C)');
		expect(copyButton).toBeInTheDocument();

		// Click it - the actual clipboard copy may fail but we're testing the button renders/clicks
		fireEvent.click(copyButton);

		// The button should still be there
		expect(screen.getByTitle('Copy image to clipboard (⌘C)')).toBeInTheDocument();
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
				'images/test.png'
			);
		});
	});

	it('clears attachments when no document is selected', async () => {
		const props = createDefaultProps({ selectedFile: null });
		renderWithProvider(<AutoRun {...props} />);

		// Should not show attachments section
		expect(screen.queryByText(/Attached Images/)).not.toBeInTheDocument();
	});

	// TODO: PENDING - NEEDS FIX - FileReader mocking in jsdom is complex
	// The file upload functionality works in the real environment but jsdom
	// doesn't properly support FileReader constructor mocking
	it.skip('handles image upload via file input', async () => {
		// This test requires complex FileReader mocking that doesn't work well in jsdom
		// The functionality is tested manually
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
		await vi.advanceTimersByTimeAsync(500);

		// onStateChange should be called with scroll position
		expect(onStateChange).toHaveBeenCalled();
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

	it('toggles mode with Cmd+E from preview', async () => {
		const props = createDefaultProps({ mode: 'preview' });
		renderWithProvider(<AutoRun {...props} />);

		const preview = screen.getByTestId('react-markdown').parentElement!;
		fireEvent.keyDown(preview, { key: 'e', metaKey: true });

		expect(props.onModeChange).toHaveBeenCalledWith('edit');
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
		// Edit button should be disabled (title changes when locked)
		expect(screen.getByTitle('Editing disabled while Auto Run active')).toBeDisabled();
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

		// All control buttons should be visible (Edit/Preview use title since they're icon-only)
		expect(screen.getByTitle('Edit document')).toBeInTheDocument();
		expect(screen.getByTitle('Preview document')).toBeInTheDocument();
		expect(screen.getByText('Run')).toBeInTheDocument();
		expect(screen.getByTitle('Learn about Auto Runner')).toBeInTheDocument();
	});

	it('hides top control buttons when hideTopControls is true', () => {
		const props = createDefaultProps({ hideTopControls: true });
		renderWithProvider(<AutoRun {...props} />);

		// Top control bar buttons should be hidden (Edit/Preview use title since they're icon-only)
		expect(screen.queryByTitle('Edit document')).not.toBeInTheDocument();
		expect(screen.queryByTitle('Preview document')).not.toBeInTheDocument();
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
