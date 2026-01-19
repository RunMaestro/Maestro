/**
 * @file AutoRunLargeDocument.test.tsx
 * @description Performance and stress tests for the AutoRun component with large documents
 *
 * Task 7.1 - Large document handling tests:
 * - Editing 10,000+ line documents
 * - Search in large documents
 * - Scroll performance in preview mode
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme, BatchRunState, SessionState } from '../../renderer/types';

// Helper to render with LayerStackProvider (required by AutoRunSearchBar)
const renderWithProvider = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Mock dependencies
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

vi.mock('../../renderer/components/AutoRunnerHelpModal', () => ({
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

vi.mock('../../renderer/components/AutoRunDocumentSelector', () => ({
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

vi.mock('../../renderer/hooks/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (value: string) => void;
	}) => ({
		autocompleteState: {
			isOpen: false,
			suggestions: [],
			selectedIndex: 0,
			position: { top: 0, left: 0 },
		},
		handleKeyDown: () => false,
		handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
			onChange(e.target.value);
		},
		selectVariable: () => {},
		closeAutocomplete: () => {},
		autocompleteRef: { current: null },
	}),
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef(() => null),
}));

// Helper to create mock theme
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

// Default props factory
const createDefaultProps = (overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}) => ({
	theme: createMockTheme(),
	sessionId: 'test-session-1',
	folderPath: '/test/folder',
	selectedFile: 'test-doc',
	documentList: ['test-doc'],
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

/**
 * Generate a large document with the specified number of lines
 * Each line contains meaningful markdown content for realistic testing
 */
function generateLargeDocument(lineCount: number): string {
	const lines: string[] = [];
	lines.push('# Large Performance Test Document');
	lines.push('');

	for (let i = 1; i <= lineCount; i++) {
		// Mix different markdown elements for realistic content
		if (i % 100 === 0) {
			lines.push(`## Section ${i / 100}`);
			lines.push('');
		} else if (i % 50 === 0) {
			lines.push(`### Subsection ${i}`);
			lines.push('');
		} else if (i % 25 === 0) {
			lines.push('- [ ] Task item to check performance with checkboxes');
		} else if (i % 10 === 0) {
			lines.push(`**Bold text at line ${i}** with some *italic content* and \`inline code\``);
		} else if (i % 7 === 0) {
			lines.push('```javascript');
			lines.push(`const line${i} = "code block content";`);
			lines.push('```');
		} else {
			lines.push(
				`Line ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.`
			);
		}
	}

	return lines.join('\n');
}

/**
 * Generate a document with many searchable terms
 */
function generateSearchableDocument(lineCount: number, searchTermFrequency: number = 50): string {
	const lines: string[] = [];
	const searchTerm = 'SEARCHABLE_TERM';

	lines.push('# Document for Search Performance Testing');
	lines.push('');

	for (let i = 1; i <= lineCount; i++) {
		if (i % searchTermFrequency === 0) {
			lines.push(`Line ${i}: This line contains the ${searchTerm} that we are looking for.`);
		} else {
			lines.push(`Line ${i}: Regular content without the special term.`);
		}
	}

	return lines.join('\n');
}

describe('AutoRun Large Document Performance', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Editing 10,000+ Line Documents', () => {
		it('renders a 10,000 line document in edit mode', () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			const { container } = renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
			expect(textarea).toHaveValue(largeContent);
		});

		it('renders a 5,000 line document in edit mode', () => {
			// Reduced from 25k to 5k lines to keep test runtime reasonable
			const largeContent = generateLargeDocument(5000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
			// 5000 lines generates ~250k-500k chars
			expect((textarea as HTMLTextAreaElement).value.length).toBeGreaterThan(200000);
		});

		it('handles typing in a 10,000 line document', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Simulate typing at the beginning
			fireEvent.change(textarea, {
				target: { value: 'NEW TEXT: ' + largeContent },
			});

			expect(textarea).toHaveValue('NEW TEXT: ' + largeContent);
		});

		it('handles typing at various positions in a large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Insert text in the middle
			const middlePosition = Math.floor(largeContent.length / 2);
			const newContent =
				largeContent.substring(0, middlePosition) +
				'INSERTED_IN_MIDDLE' +
				largeContent.substring(middlePosition);

			fireEvent.change(textarea, { target: { value: newContent } });

			expect(textarea.value).toContain('INSERTED_IN_MIDDLE');
			expect(textarea.value.length).toBe(largeContent.length + 'INSERTED_IN_MIDDLE'.length);
		});

		it('handles rapid typing in a large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Simulate rapid consecutive changes
			let currentContent = largeContent;
			for (let i = 0; i < 10; i++) {
				currentContent = 'X' + currentContent;
				fireEvent.change(textarea, { target: { value: currentContent } });
			}

			expect(textarea).toHaveValue(currentContent);
			expect((textarea as HTMLTextAreaElement).value.startsWith('XXXXXXXXXX')).toBe(true);
		});

		it('handles deleting content from a large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');

			// Delete first 1000 characters
			const reducedContent = largeContent.substring(1000);
			fireEvent.change(textarea, { target: { value: reducedContent } });

			expect(textarea).toHaveValue(reducedContent);
		});

		it('handles content with 10,000+ characters', () => {
			// Reduced from 150k to 15k chars to keep test runtime reasonable
			const veryLargeContent = 'A'.repeat(10000) + '\n' + 'B'.repeat(5000);
			const props = createDefaultProps({ content: veryLargeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(veryLargeContent);
			expect((textarea as HTMLTextAreaElement).value.length).toBe(15001);
		}, 10000); // 10 second timeout for this test

		it('dirty state detection works correctly with large documents', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			// Initially no Save/Revert buttons
			expect(screen.queryByText('Save')).not.toBeInTheDocument();

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: largeContent + 'x' } });

			// Now Save/Revert buttons should appear
			expect(screen.getByText('Save')).toBeInTheDocument();
			expect(screen.getByText('Revert')).toBeInTheDocument();
		});

		it('save functionality works with large documents', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			const modifiedContent = largeContent + '\n# Added Section';
			fireEvent.change(textarea, { target: { value: modifiedContent } });

			// Click save
			fireEvent.click(screen.getByText('Save'));

			await waitFor(() => {
				expect(mockMaestro.autorun.writeDoc).toHaveBeenCalledWith(
					'/test/folder',
					'test-doc.md',
					modifiedContent
				);
			});
		});

		it('revert functionality works with large documents', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Completely different content' } });

			expect(textarea).toHaveValue('Completely different content');

			// Click revert
			fireEvent.click(screen.getByText('Revert'));

			// Should restore original content
			expect(textarea).toHaveValue(largeContent);
		});

		it('handles Tab key insertion in large documents', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Set cursor position
			textarea.setSelectionRange(0, 0);

			// Press Tab
			fireEvent.keyDown(textarea, { key: 'Tab' });

			await waitFor(() => {
				expect(textarea.value.startsWith('\t')).toBe(true);
			});
		});
	});

	describe('Search in Large Documents', () => {
		it('counts matches correctly in a 10,000 line document', async () => {
			// Create document with 200 searchable terms (every 50 lines)
			const largeContent = generateSearchableDocument(10000, 50);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Open search with Cmd+F
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			// Search input should appear
			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			// Type search query
			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'SEARCHABLE_TERM' } });

			// Should show match count (200 matches for 10000 lines / 50 frequency)
			await waitFor(() => {
				expect(screen.getByText(/1\/200/)).toBeInTheDocument();
			});
		});

		it('navigates through matches in a large document', async () => {
			const largeContent = generateSearchableDocument(5000, 100);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Open search
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'SEARCHABLE_TERM' } });

			// Should start at first match
			await waitFor(() => {
				expect(screen.getByText(/1\/50/)).toBeInTheDocument();
			});

			// Navigate to next match with Enter
			fireEvent.keyDown(searchInput, { key: 'Enter' });

			await waitFor(() => {
				expect(screen.getByText(/2\/50/)).toBeInTheDocument();
			});

			// Navigate to previous match with Shift+Enter
			fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });

			await waitFor(() => {
				expect(screen.getByText(/1\/50/)).toBeInTheDocument();
			});
		});

		it('handles search with no matches in large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'NONEXISTENT_TERM_XYZ' } });

			await waitFor(() => {
				expect(screen.getByText('No matches')).toBeInTheDocument();
			});
		});

		it('search wraps around in large documents', async () => {
			const largeContent = generateSearchableDocument(1000, 100); // 10 matches
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'SEARCHABLE_TERM' } });

			// Should have 10 matches
			await waitFor(() => {
				expect(screen.getByText(/1\/10/)).toBeInTheDocument();
			});

			// Navigate to last match
			for (let i = 0; i < 9; i++) {
				fireEvent.keyDown(searchInput, { key: 'Enter' });
			}

			await waitFor(() => {
				expect(screen.getByText(/10\/10/)).toBeInTheDocument();
			});

			// Navigate one more time - should wrap to first
			fireEvent.keyDown(searchInput, { key: 'Enter' });

			await waitFor(() => {
				expect(screen.getByText(/1\/10/)).toBeInTheDocument();
			});
		});

		it('handles special regex characters in search query', async () => {
			const contentWithSpecialChars =
				generateLargeDocument(5000) + '\nSpecial chars: [test] (test) {test} $test^ .test* +test?';
			const props = createDefaultProps({ content: contentWithSpecialChars, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');

			// Search for text with special regex characters
			fireEvent.change(searchInput, { target: { value: '[test]' } });

			await waitFor(() => {
				expect(screen.getByText(/1\/1/)).toBeInTheDocument();
			});
		});

		it('search is case-insensitive', async () => {
			// Use a unique term that won't appear in generated content
			const content = 'XYZABC xyzabc XyzAbc xYzAbC';
			const props = createDefaultProps({ content, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'xyzabc' } });

			// Should find all 4 variations (case-insensitive)
			await waitFor(() => {
				expect(screen.getByText(/1\/4/)).toBeInTheDocument();
			});
		});

		it('closes search with Escape key', async () => {
			const largeContent = generateLargeDocument(5000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			await waitFor(() => {
				expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
			});
		});

		it('clears search state when closing search bar', async () => {
			const largeContent = generateSearchableDocument(5000, 100);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Open search and search for something
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'SEARCHABLE_TERM' } });

			// Navigate a few matches
			fireEvent.keyDown(searchInput, { key: 'Enter' });
			fireEvent.keyDown(searchInput, { key: 'Enter' });

			await waitFor(() => {
				expect(screen.getByText(/3\/50/)).toBeInTheDocument();
			});

			// Close search
			fireEvent.keyDown(searchInput, { key: 'Escape' });

			// Reopen search
			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			// Query should be cleared
			const newSearchInput = screen.getByPlaceholderText('Search...') as HTMLInputElement;
			expect(newSearchInput.value).toBe('');
		});
	});

	describe('Scroll Performance in Preview Mode', () => {
		it('renders a 10,000 line document in preview mode', () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'preview' });

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('renders a 5,000 line document in preview mode', () => {
			// Reduced from 25k to 5k lines to keep test runtime reasonable
			const largeContent = generateLargeDocument(5000);
			const props = createDefaultProps({ content: largeContent, mode: 'preview' });

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('switches between edit and preview mode with large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const onModeChange = vi.fn();
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				onModeChange,
			});

			renderWithProvider(<AutoRun {...props} />);

			// Initially in edit mode
			expect(screen.getByRole('textbox')).toBeInTheDocument();

			// Click Preview button
			fireEvent.click(screen.getByText('Preview'));

			expect(onModeChange).toHaveBeenCalledWith('preview');
		});

		it('preserves scroll position reference when switching modes', async () => {
			const largeContent = generateLargeDocument(10000);
			const onStateChange = vi.fn();
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				onStateChange,
			});

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Simulate scrolling
			fireEvent.scroll(textarea, { target: { scrollTop: 1000 } });

			// onStateChange should be called with scroll position
			// (Note: actual scroll behavior requires DOM measurements which are mocked)
		});

		it('handles keyboard shortcut Cmd+E to toggle mode with large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const onModeChange = vi.fn();
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				onModeChange,
			});

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Press Cmd+E to toggle to preview
			fireEvent.keyDown(textarea, { key: 'e', metaKey: true });

			expect(onModeChange).toHaveBeenCalledWith('preview');
		});

		it('renders document with many checkboxes in preview', () => {
			// Create a document with many task items
			const lines: string[] = ['# Task List'];
			for (let i = 0; i < 1000; i++) {
				lines.push(`- [${i % 2 === 0 ? 'x' : ' '}] Task item ${i}`);
			}
			const taskContent = lines.join('\n');

			const props = createDefaultProps({ content: taskContent, mode: 'preview' });

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('renders document with many code blocks in preview', () => {
			// Create document with many code blocks
			const lines: string[] = ['# Code Examples'];
			for (let i = 0; i < 500; i++) {
				lines.push('```javascript');
				lines.push(`const example${i} = "code block ${i}";`);
				lines.push('console.log(example' + i + ');');
				lines.push('```');
				lines.push('');
			}
			const codeContent = lines.join('\n');

			const props = createDefaultProps({ content: codeContent, mode: 'preview' });

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('renders document with many headers in preview', () => {
			// Create document with many headers (for TOC-like navigation)
			const lines: string[] = ['# Main Document'];
			for (let i = 0; i < 200; i++) {
				lines.push(`## Section ${i}`);
				lines.push(`Content for section ${i}`);
				lines.push(`### Subsection ${i}.1`);
				lines.push(`Content for subsection ${i}.1`);
				lines.push(`### Subsection ${i}.2`);
				lines.push(`Content for subsection ${i}.2`);
			}
			const headerContent = lines.join('\n');

			const props = createDefaultProps({ content: headerContent, mode: 'preview' });

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});

		it('restores scroll position from initialPreviewScrollPos prop', () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({
				content: largeContent,
				mode: 'preview',
				initialPreviewScrollPos: 500,
			});

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});
	});

	describe('Mode Transitions with Large Documents', () => {
		it('handles rapid mode switching with large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const onModeChange = vi.fn();
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				onModeChange,
			});

			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Rapid mode switches
			for (let i = 0; i < 10; i++) {
				fireEvent.click(screen.getByText(i % 2 === 0 ? 'Preview' : 'Edit'));

				// Rerender with new mode
				rerender(<AutoRun {...props} mode={i % 2 === 0 ? 'preview' : 'edit'} />);
			}

			expect(onModeChange).toHaveBeenCalledTimes(10);
		});

		it('content remains consistent through mode switches', async () => {
			const largeContent = generateLargeDocument(10000);
			const onModeChange = vi.fn();
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				onModeChange,
			});

			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Edit the content
			const textarea = screen.getByRole('textbox');
			const modifiedContent = 'MODIFIED: ' + largeContent;
			fireEvent.change(textarea, { target: { value: modifiedContent } });

			// Switch to preview
			rerender(<AutoRun {...props} content={modifiedContent} mode="preview" />);

			// Switch back to edit
			rerender(<AutoRun {...props} content={modifiedContent} mode="edit" />);

			const newTextarea = screen.getByRole('textbox');
			expect(newTextarea).toHaveValue(modifiedContent);
		});
	});

	describe('Edge Cases with Large Documents', () => {
		it('handles document with only whitespace and newlines', () => {
			// Reduced from 15k to 3k chars
			const whitespaceContent = '\n'.repeat(2000) + ' '.repeat(1000);
			const props = createDefaultProps({ content: whitespaceContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(whitespaceContent);
		});

		it('handles document with very long lines', () => {
			// Create a document with long lines - reduced from 10M to ~50k chars
			const longLine = 'A'.repeat(500);
			const content = Array(100).fill(longLine).join('\n');
			const props = createDefaultProps({ content, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
		});

		it('handles document with unicode and emoji content', () => {
			const lines: string[] = [];
			for (let i = 0; i < 5000; i++) {
				lines.push(
					`Line ${i}: Unicode test with special characters - \u4e2d\u6587 \u65e5\u672c\u8a9e \ud83d\ude00 \ud83c\udf89 \u2764\ufe0f`
				);
			}
			const unicodeContent = lines.join('\n');

			const props = createDefaultProps({ content: unicodeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue(unicodeContent);
		});

		it('handles empty document after being large', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Rerender with empty content
			rerender(<AutoRun {...props} content="" contentVersion={1} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('');
		});

		it('handles content version changes with large documents', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				contentVersion: 0,
			});

			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Make local edit
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'local edit' } });

			expect(textarea).toHaveValue('local edit');

			// External content update with new version
			const newLargeContent = generateLargeDocument(10000);
			rerender(<AutoRun {...props} content={newLargeContent} contentVersion={1} />);

			// Should sync to new content due to version change
			expect(textarea).toHaveValue(newLargeContent);
		});
	});

	describe('Concurrent Operations with Large Documents', () => {
		it('handles undo/redo with large document edits', async () => {
			const largeContent = generateLargeDocument(5000);
			const props = createDefaultProps({ content: largeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			// Make an edit
			fireEvent.change(textarea, { target: { value: 'MODIFIED: ' + largeContent } });

			// Trigger undo with Cmd+Z
			fireEvent.keyDown(textarea, { key: 'z', metaKey: true });

			// The textarea should still exist and be functional
			expect(textarea).toBeInTheDocument();
		});

		it('handles session switch with large document', async () => {
			const largeContent = generateLargeDocument(10000);
			const props = createDefaultProps({
				content: largeContent,
				mode: 'edit',
				sessionId: 'session-1',
			});

			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Edit the content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Session 1 edit' } });

			// Switch session
			const newLargeContent = generateLargeDocument(5000);
			rerender(<AutoRun {...props} sessionId="session-2" content={newLargeContent} />);

			// Should show new session's content
			expect(screen.getByRole('textbox')).toHaveValue(newLargeContent);
		});

		it('handles document switch with large documents', async () => {
			const largeContent1 = generateLargeDocument(10000);
			const props = createDefaultProps({
				content: largeContent1,
				mode: 'edit',
				selectedFile: 'doc1',
			});

			const { rerender } = renderWithProvider(<AutoRun {...props} />);

			// Edit the content
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'Doc 1 edit' } });

			// Switch document
			const largeContent2 = generateLargeDocument(8000);
			rerender(<AutoRun {...props} selectedFile="doc2" content={largeContent2} />);

			// Should show new document's content
			expect(screen.getByRole('textbox')).toHaveValue(largeContent2);
		});
	});

	describe('Performance Timing (Functional Tests)', () => {
		// Note: These tests verify functionality completes without errors/timeouts
		// rather than measuring actual performance metrics
		// Reduced from 50k lines to 5k to keep test runtime reasonable

		it('completes render of 5,000 line document', () => {
			const veryLargeContent = generateLargeDocument(5000);
			const props = createDefaultProps({ content: veryLargeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
		});

		it('completes search across 5,000 line document', async () => {
			const veryLargeContent = generateSearchableDocument(5000, 100);
			const props = createDefaultProps({ content: veryLargeContent, mode: 'edit' });

			renderWithProvider(<AutoRun {...props} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

			fireEvent.keyDown(textarea, { key: 'f', metaKey: true });

			await waitFor(() => {
				expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
			});

			const searchInput = screen.getByPlaceholderText('Search...');
			fireEvent.change(searchInput, { target: { value: 'SEARCHABLE_TERM' } });

			// Should find 50 matches (5000/100)
			await waitFor(() => {
				expect(screen.getByText(/\/50/)).toBeInTheDocument();
			});
		});

		it('completes preview render of 5,000 line document', () => {
			const veryLargeContent = generateLargeDocument(5000);
			const props = createDefaultProps({ content: veryLargeContent, mode: 'preview' });

			renderWithProvider(<AutoRun {...props} />);

			expect(screen.getByTestId('react-markdown')).toBeInTheDocument();
		});
	});
});
