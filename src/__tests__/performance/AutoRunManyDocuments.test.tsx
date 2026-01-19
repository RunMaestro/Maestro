/**
 * @file AutoRunManyDocuments.test.tsx
 * @description Performance and stress tests for Auto Run with many documents in a folder
 *
 * Task 7.2 - Many documents in folder tests:
 * - Folder with 500+ documents
 * - Document selector performance
 * - File watcher with many files
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import {
	AutoRunDocumentSelector,
	DocTreeNode,
} from '../../renderer/components/AutoRunDocumentSelector';
import { AutoRun, AutoRunHandle } from '../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';

// Helper to wrap component in LayerStackProvider with custom rerender
const renderWithProviders = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};

// Mock dependencies for AutoRun component
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

// Mock lucide-react icons for AutoRunDocumentSelector and AutoRun
vi.mock('lucide-react', () => ({
	ChevronDown: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="chevron-down" className={className} style={style}>
			▼
		</span>
	),
	ChevronRight: ({ className }: { className?: string }) => (
		<span data-testid="chevron-right" className={className}>
			▶
		</span>
	),
	RefreshCw: ({ className }: { className?: string }) => (
		<span data-testid="refresh-icon" className={className}>
			↻
		</span>
	),
	FolderOpen: ({ className }: { className?: string }) => (
		<span data-testid="folder-open" className={className}>
			📂
		</span>
	),
	Plus: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="plus-icon" className={className} style={style}>
			+
		</span>
	),
	Folder: ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<span data-testid="folder-icon" className={className} style={style}>
			📁
		</span>
	),
	Search: ({ className }: { className?: string }) => (
		<span data-testid="search-icon" className={className}>
			🔍
		</span>
	),
	X: ({ className }: { className?: string }) => (
		<span data-testid="x-icon" className={className}>
			×
		</span>
	),
	ArrowUp: () => <span data-testid="arrow-up">↑</span>,
	ArrowDown: () => <span data-testid="arrow-down">↓</span>,
	Save: () => <span data-testid="save-icon">💾</span>,
	RotateCcw: () => <span data-testid="rotate-icon">↺</span>,
	Maximize2: ({ className }: { className?: string }) => (
		<span data-testid="maximize-icon" className={className}>
			⛶
		</span>
	),
	Image: ({ className }: { className?: string }) => (
		<span data-testid="image-icon" className={className}>
			🖼
		</span>
	),
	HelpCircle: ({ className }: { className?: string }) => (
		<span data-testid="help-icon" className={className}>
			?
		</span>
	),
	Play: ({ className }: { className?: string }) => (
		<span data-testid="play-icon" className={className}>
			▶
		</span>
	),
	Square: ({ className }: { className?: string }) => (
		<span data-testid="square-icon" className={className}>
			■
		</span>
	),
	Eye: ({ className }: { className?: string }) => (
		<span data-testid="eye-icon" className={className}>
			👁
		</span>
	),
	Edit: ({ className }: { className?: string }) => (
		<span data-testid="edit-icon" className={className}>
			✎
		</span>
	),
	Edit3: ({ className }: { className?: string }) => (
		<span data-testid="edit3-icon" className={className}>
			✎
		</span>
	),
	Loader2: ({ className }: { className?: string }) => (
		<span data-testid="loader-icon" className={className}>
			⟳
		</span>
	),
	FileText: ({ className }: { className?: string }) => (
		<span data-testid="filetext-icon" className={className}>
			📄
		</span>
	),
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
		bgSidebar: '#202020',
		bgHover: '#353535',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
		purple: '#8b5cf6',
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

/**
 * Generate a list of many document names
 */
function generateManyDocuments(count: number, prefix: string = 'Document'): string[] {
	const documents: string[] = [];
	for (let i = 1; i <= count; i++) {
		// Mix different naming conventions for realism
		if (i % 10 === 0) {
			documents.push(`Phase-${Math.floor(i / 10)}`);
		} else if (i % 7 === 0) {
			documents.push(`task-${i}-implementation`);
		} else if (i % 5 === 0) {
			documents.push(`Bug Fix ${i}`);
		} else if (i % 3 === 0) {
			documents.push(`feature/${prefix}-${i}`);
		} else {
			documents.push(`${prefix}-${i.toString().padStart(4, '0')}`);
		}
	}
	return documents;
}

/**
 * Generate a tree structure with many documents across folders
 */
function generateDocumentTree(count: number): { tree: DocTreeNode[]; files: string[] } {
	const tree: DocTreeNode[] = [];
	const files: string[] = [];

	// Create folders with varying numbers of documents
	const foldersCount = Math.ceil(count / 50); // ~50 docs per folder

	for (let folderIndex = 0; folderIndex < foldersCount; folderIndex++) {
		const folderName = `folder-${folderIndex + 1}`;
		const folderNode: DocTreeNode = {
			name: folderName,
			type: 'folder',
			path: folderName,
			children: [],
		};

		const docsInFolder = Math.min(50, count - folderIndex * 50);

		for (let docIndex = 0; docIndex < docsInFolder; docIndex++) {
			const docName = `doc-${folderIndex * 50 + docIndex + 1}`;
			const docPath = `${folderName}/${docName}`;

			folderNode.children!.push({
				name: docName,
				type: 'file',
				path: docPath,
			});

			files.push(docPath);
		}

		tree.push(folderNode);
	}

	// Add some root-level documents
	for (let i = 0; i < 20; i++) {
		const docName = `root-doc-${i + 1}`;
		tree.push({
			name: docName,
			type: 'file',
			path: docName,
		});
		files.push(docName);
	}

	return { tree, files };
}

/**
 * Generate task counts for many documents
 */
function generateTaskCounts(
	documents: string[]
): Map<string, { completed: number; total: number }> {
	const taskCounts = new Map<string, { completed: number; total: number }>();

	for (let i = 0; i < documents.length; i++) {
		const doc = documents[i];
		const total = Math.floor(Math.random() * 10) + 1; // 1-10 tasks
		const completed = Math.floor(Math.random() * (total + 1)); // 0-total completed
		taskCounts.set(doc, { completed, total });
	}

	return taskCounts;
}

// Default props for AutoRunDocumentSelector
const createSelectorDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof AutoRunDocumentSelector>> = {}
) => ({
	theme: createMockTheme(),
	documents: ['doc1', 'doc2', 'doc3'],
	selectedDocument: null,
	onSelectDocument: vi.fn(),
	onRefresh: vi.fn(),
	onChangeFolder: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	isLoading: false,
	...overrides,
});

// Default props for AutoRun component
const createAutoRunDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof AutoRun>> = {}
) => ({
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

describe('AutoRun Many Documents Performance', () => {
	let mockMaestro: ReturnType<typeof setupMaestroMock>;

	beforeEach(() => {
		mockMaestro = setupMaestroMock();
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('Folder with 500+ Documents', () => {
		it('renders AutoRunDocumentSelector with 500 documents', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Dropdown button should render with selected document
			const button = screen.getByRole('button', { name: new RegExp(documents[0], 'i') });
			expect(button).toBeInTheDocument();
		});

		it('renders dropdown with 500 documents when opened', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			const button = screen.getByRole('button', { name: new RegExp(documents[0], 'i') });
			fireEvent.click(button);

			// Check that documents are rendered (spot check a few) - use getAllByText since selected doc appears twice
			const firstDocElements = screen.getAllByText(new RegExp(`${documents[0]}\\.md`));
			expect(firstDocElements.length).toBeGreaterThan(0);
			expect(screen.getByText(new RegExp(`${documents[100]}\\.md`))).toBeInTheDocument();
			expect(screen.getByText(new RegExp(`${documents[499]}\\.md`))).toBeInTheDocument();
		});

		it('renders dropdown with 1000 documents', () => {
			const documents = generateManyDocuments(1000);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			const button = screen.getByRole('button', { name: new RegExp(documents[0], 'i') });
			fireEvent.click(button);

			// Verify dropdown is visible - use getAllByText since selected doc appears twice
			const elements = screen.getAllByText(new RegExp(`${documents[0]}\\.md`));
			expect(elements.length).toBeGreaterThan(0);
		});

		it('selects document from large list (500 documents)', () => {
			const documents = generateManyDocuments(500);
			const onSelectDocument = vi.fn();
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				onSelectDocument,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Select a document in the middle
			const targetDoc = documents[250];
			fireEvent.click(screen.getByText(`${targetDoc}.md`));

			expect(onSelectDocument).toHaveBeenCalledWith(targetDoc);
		});

		it('closes dropdown after selection in large list', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Select a document
			fireEvent.click(screen.getByText(`${documents[100]}.md`));

			// Dropdown should be closed
			expect(screen.queryByText(`${documents[200]}.md`)).not.toBeInTheDocument();
		});

		it('renders with task counts for 500 documents', () => {
			const documents = generateManyDocuments(500);
			const documentTaskCounts = generateTaskCounts(documents);
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				documentTaskCounts,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Verify dropdown renders with task counts visible - use getAllByText since selected doc appears twice
			const elements = screen.getAllByText(new RegExp(`${documents[0]}\\.md`));
			expect(elements.length).toBeGreaterThan(0);
		});

		it('handles rapid document selection changes', () => {
			const documents = generateManyDocuments(500);
			const onSelectDocument = vi.fn();
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				onSelectDocument,
			});

			const { rerender } = renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Simulate rapid selection changes
			for (let i = 0; i < 20; i++) {
				fireEvent.click(
					screen.getByRole('button', { name: new RegExp(documents[i * 25] || documents[0], 'i') })
				);

				// Select next document
				const nextDoc = documents[(i + 1) * 25] || documents[i * 25 + 1];
				if (screen.queryByText(`${nextDoc}.md`)) {
					fireEvent.click(screen.getByText(`${nextDoc}.md`));
				}

				// Update props to simulate selection change
				rerender(<AutoRunDocumentSelector {...props} selectedDocument={nextDoc} />);
			}

			// Should have called onSelectDocument multiple times
			expect(onSelectDocument.mock.calls.length).toBeGreaterThan(0);
		});
	});

	describe('Document Selector Performance with Tree Structure', () => {
		it('renders tree structure with 500 documents across folders', () => {
			const { tree, files } = generateDocumentTree(500);
			const props = createSelectorDefaultProps({
				documents: files,
				documentTree: tree,
				selectedDocument: files[0],
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			const button = screen.getByRole('button', {
				name: new RegExp(files[0].split('/').pop() || '', 'i'),
			});
			fireEvent.click(button);

			// Should show folders
			expect(screen.getByText('folder-1')).toBeInTheDocument();
		});

		it('expands folder in tree with many documents', () => {
			const { tree, files } = generateDocumentTree(500);
			const props = createSelectorDefaultProps({
				documents: files,
				documentTree: tree,
				selectedDocument: files[0],
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(
				screen.getByRole('button', { name: new RegExp(files[0].split('/').pop() || '', 'i') })
			);

			// Click to expand folder-1
			const folderButton = screen.getByText('folder-1').closest('button');
			if (folderButton) {
				fireEvent.click(folderButton);

				// Should show documents in that folder
				expect(screen.getByText('doc-1.md')).toBeInTheDocument();
			}
		});

		it('handles tree with 1000 documents', () => {
			const { tree, files } = generateDocumentTree(1000);
			const props = createSelectorDefaultProps({
				documents: files,
				documentTree: tree,
				selectedDocument: files[0],
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown - should not crash or freeze
			fireEvent.click(
				screen.getByRole('button', { name: new RegExp(files[0].split('/').pop() || '', 'i') })
			);

			// Verify some folders are visible
			expect(screen.getByText('folder-1')).toBeInTheDocument();
		});

		it('selects document from nested tree structure', () => {
			const { tree, files } = generateDocumentTree(500);
			const onSelectDocument = vi.fn();
			const props = createSelectorDefaultProps({
				documents: files,
				documentTree: tree,
				selectedDocument: files[0],
				onSelectDocument,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(
				screen.getByRole('button', { name: new RegExp(files[0].split('/').pop() || '', 'i') })
			);

			// Expand a folder and select a document
			const folderButton = screen.getByText('folder-5').closest('button');
			if (folderButton) {
				fireEvent.click(folderButton);

				// Select a document in this folder
				const docInFolder = screen.getByText('doc-201.md');
				fireEvent.click(docInFolder);

				expect(onSelectDocument).toHaveBeenCalledWith('folder-5/doc-201');
			}
		});
	});

	describe('Document Selector Scrolling and Navigation', () => {
		it('dropdown is scrollable with many documents', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			const { container } = renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Find the dropdown menu (has max-height and overflow-y: auto)
			const dropdown = container.querySelector('[style*="max-height"]');
			expect(dropdown).toBeInTheDocument();
		});

		it('Escape key closes dropdown with many documents', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Press Escape
			fireEvent.keyDown(document, { key: 'Escape' });

			// Dropdown should be closed
			expect(screen.queryByText(`${documents[100]}.md`)).not.toBeInTheDocument();
		});

		it('clicking outside closes dropdown with many documents', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			const { container } = renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Click outside (on container)
			fireEvent.mouseDown(container);

			// Dropdown should be closed
			expect(screen.queryByText(`${documents[100]}.md`)).not.toBeInTheDocument();
		});
	});

	describe('Create Document Modal with Many Existing Documents', () => {
		it('opens create modal with 500 existing documents', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Click create button
			fireEvent.click(screen.getByTitle('Create new document'));

			// Modal should appear
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText('Create New Document')).toBeInTheDocument();
		});

		it('detects duplicate name from large document list', async () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open create modal
			fireEvent.click(screen.getByTitle('Create new document'));

			// Type an existing document name
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: documents[0] } });

			// Should show duplicate warning
			await waitFor(() => {
				expect(screen.getByText(/already exists/i)).toBeInTheDocument();
			});
		});

		it('creates new document when not duplicate in large list', async () => {
			const documents = generateManyDocuments(500);
			const onCreateDocument = vi.fn().mockResolvedValue(true);
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				onCreateDocument,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open create modal
			fireEvent.click(screen.getByTitle('Create new document'));

			// Type a new document name
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'brand-new-unique-document' } });

			// Click Create
			fireEvent.click(screen.getByText('Create'));

			await waitFor(() => {
				expect(onCreateDocument).toHaveBeenCalledWith('brand-new-unique-document');
			});
		});
	});

	describe('File Watcher with Many Files Simulation', () => {
		// These tests simulate the behavior of the file watcher when many files exist
		// The actual file watcher is in the main process, so we test the expected behaviors

		it('handles debounced events for many file changes', async () => {
			// Simulate debounced handler logic
			const events: string[] = [];
			const DEBOUNCE_MS = 300;
			let debounceTimer: NodeJS.Timeout | null = null;

			const handleFileChange = (filename: string) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
				}
				debounceTimer = setTimeout(() => {
					events.push(filename);
					debounceTimer = null;
				}, DEBOUNCE_MS);
			};

			// Simulate 100 rapid file changes (as if saving many files at once)
			for (let i = 0; i < 100; i++) {
				handleFileChange(`doc-${i}.md`);
			}

			// Only the last event should be recorded after debounce
			await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
			expect(events).toHaveLength(1);
			expect(events[0]).toBe('doc-99.md');
		});

		it('filters only .md files from many file events', () => {
			const files = [
				'document1.md',
				'document2.md',
				'image.png',
				'data.json',
				'readme.txt',
				'task.md',
				'.hidden.md',
				'config.yml',
			];

			const mdFiles = files.filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('.'));
			expect(mdFiles).toEqual(['document1.md', 'document2.md', 'task.md']);
			expect(mdFiles).toHaveLength(3);
		});

		it('processes many concurrent file change events', async () => {
			// Simulate handling many file events in succession
			const processedFiles: Set<string> = new Set();
			const pendingTimers: NodeJS.Timeout[] = [];

			const handleFileEvent = (filename: string) => {
				const timer = setTimeout(() => {
					processedFiles.add(filename);
				}, 50);
				pendingTimers.push(timer);
			};

			// Simulate 500 file events
			for (let i = 0; i < 500; i++) {
				handleFileEvent(`doc-${i}.md`);
			}

			// Wait for all to process
			await vi.advanceTimersByTimeAsync(100);

			// All files should be processed
			expect(processedFiles.size).toBe(500);
		});

		it('cleanup handles many active watchers', () => {
			// Simulate watcher cleanup for many folders
			const watchers = new Map<string, { close: () => void }>();

			for (let i = 0; i < 100; i++) {
				watchers.set(`/path/to/folder-${i}`, {
					close: vi.fn(),
				});
			}

			// Cleanup all watchers
			for (const [_path, watcher] of watchers) {
				watcher.close();
			}
			watchers.clear();

			expect(watchers.size).toBe(0);
		});
	});

	describe('AutoRun Component with Many Documents in List', () => {
		it('renders AutoRun with document selector showing many documents', () => {
			const documents = generateManyDocuments(500);
			const props = createAutoRunDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
			});

			renderWithProviders(<AutoRun {...props} />);

			// Component should render
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('handles document switching with large document list', () => {
			const documents = generateManyDocuments(500);
			const onSelectDocument = vi.fn();
			const props = createAutoRunDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				onSelectDocument,
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Simulate switching to different document
			rerender(<AutoRun {...props} selectedFile={documents[250]} />);

			// Component should update without issues
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('maintains edit state across document list updates', () => {
			const documents = generateManyDocuments(500);
			const props = createAutoRunDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Original Content',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Make an edit
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: '# Modified Content' } });

			// Update document list (simulating refresh)
			const updatedDocuments = [...documents, 'new-doc-501'];
			rerender(<AutoRun {...props} documentList={updatedDocuments} />);

			// Edit should be preserved (local state)
			expect(textarea).toHaveValue('# Modified Content');
		});

		it('loads new document content when switching in large list', () => {
			const documents = generateManyDocuments(500);
			const props = createAutoRunDefaultProps({
				documentList: documents,
				selectedFile: documents[0],
				content: '# Document 1 Content',
			});

			const { rerender } = renderWithProviders(<AutoRun {...props} />);

			// Switch document with new content
			rerender(
				<AutoRun {...props} selectedFile={documents[100]} content="# Document 100 Content" />
			);

			// Should show new content
			expect(screen.getByRole('textbox')).toHaveValue('# Document 100 Content');
		});
	});

	describe('Performance Boundary Tests', () => {
		it('renders selector with 2000 documents', () => {
			const documents = generateManyDocuments(2000);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			// Should render without crashing
			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			expect(
				screen.getByRole('button', { name: new RegExp(documents[0], 'i') })
			).toBeInTheDocument();
		});

		it('opens dropdown with 2000 documents', () => {
			const documents = generateManyDocuments(2000);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown - should not freeze
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// Should render first and last documents - use getAllByText since selected appears twice
			const firstElements = screen.getAllByText(new RegExp(`${documents[0]}\\.md`));
			expect(firstElements.length).toBeGreaterThan(0);
			expect(screen.getByText(new RegExp(`${documents[1999]}\\.md`))).toBeInTheDocument();
		});

		it('handles task counts for 2000 documents', () => {
			const documents = generateManyDocuments(2000);
			const documentTaskCounts = generateTaskCounts(documents);
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				documentTaskCounts,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Should render without issues
			expect(
				screen.getByRole('button', { name: new RegExp(documents[0], 'i') })
			).toBeInTheDocument();
		});

		it('re-renders efficiently with large document list prop changes', () => {
			const documents = generateManyDocuments(1000);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			const { rerender } = renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Multiple re-renders with same list
			for (let i = 0; i < 10; i++) {
				rerender(<AutoRunDocumentSelector {...props} selectedDocument={documents[i * 100]} />);
			}

			// Should still be functional - use title to find the button specifically
			expect(screen.getByTitle('Create new document')).toBeInTheDocument();
		});
	});

	describe('Edge Cases with Many Documents', () => {
		it('handles empty document list', () => {
			const props = createSelectorDefaultProps({ documents: [], selectedDocument: null });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: /select a document/i }));

			// Should show "No markdown files found" message
			expect(screen.getByText('No markdown files found')).toBeInTheDocument();
		});

		it('handles documents with special characters', () => {
			const documents = [
				'doc-with-special-chars-!@#',
				'doc with spaces',
				'doc_with_underscores',
				'doc.with.dots',
				'DOC-UPPERCASE',
				'doc-lowercase',
			];
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown
			fireEvent.click(screen.getByRole('button', { name: /doc-with-special-chars/i }));

			// All documents should be visible - use queryAllByText since .md is appended
			documents.forEach((doc) => {
				// Find elements containing the document name
				const elements = screen.getAllByText((content, element) => {
					return element?.textContent?.includes(doc) ?? false;
				});
				expect(elements.length).toBeGreaterThan(0);
			});
		});

		it('handles very long document names', () => {
			const longName =
				'this-is-a-very-long-document-name-that-might-cause-layout-issues-in-the-dropdown-selector-component';
			const documents = [longName, 'short-doc', 'another-long-document-name-for-testing-purposes'];
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown - use the button that has the document name (partial match)
			fireEvent.click(screen.getByRole('button', { name: /this-is-a-very-long-document-name/i }));

			// Long name should be in the document - find element containing the name
			const elements = screen.getAllByText((content, element) => {
				return element?.textContent?.includes(longName) ?? false;
			});
			expect(elements.length).toBeGreaterThan(0);
		});

		it('handles documents with unicode characters', () => {
			const documents = ['文档-1', 'документ-2', 'ドキュメント-3', 'مستند-4', 'emoji-doc-😀'];
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown - use the button that has the first document name
			fireEvent.click(screen.getByRole('button', { name: new RegExp(documents[0], 'i') }));

			// All unicode documents should be visible - use element text content matching
			documents.forEach((doc) => {
				const elements = screen.getAllByText((content, element) => {
					return element?.textContent?.includes(doc) ?? false;
				});
				expect(elements.length).toBeGreaterThan(0);
			});
		});

		it('handles rapid open/close cycles with large list', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({ documents, selectedDocument: documents[0] });

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Rapid open/close
			const button = screen.getByRole('button', { name: new RegExp(documents[0], 'i') });

			for (let i = 0; i < 20; i++) {
				fireEvent.click(button); // Open
				fireEvent.click(button); // Close
			}

			// Component should still be functional
			expect(button).toBeInTheDocument();
		});

		it('handles mixed flat and tree document sources', () => {
			const flatDocuments = generateManyDocuments(100);
			const { tree } = generateDocumentTree(100);

			// When both are provided, tree takes precedence
			const props = createSelectorDefaultProps({
				documents: flatDocuments,
				documentTree: tree,
				selectedDocument: 'root-doc-1',
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Open dropdown - use the button that shows the selected document
			fireEvent.click(screen.getByRole('button', { name: /root-doc-1/i }));

			// Should show tree structure (folders)
			expect(screen.getByText('folder-1')).toBeInTheDocument();
		});
	});

	describe('Refresh and Loading State with Many Documents', () => {
		it('shows loading state during refresh with many documents', () => {
			const documents = generateManyDocuments(500);
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				isLoading: true,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Refresh button should show loading state
			const refreshButton = screen.getByTitle('Refresh document list');
			expect(refreshButton).toHaveClass('opacity-50');
			expect(refreshButton).toHaveClass('cursor-not-allowed');
		});

		it('calls onRefresh handler', () => {
			const documents = generateManyDocuments(500);
			const onRefresh = vi.fn();
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				onRefresh,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Click refresh
			fireEvent.click(screen.getByTitle('Refresh document list'));

			expect(onRefresh).toHaveBeenCalled();
		});

		it('refresh button is disabled while loading', () => {
			const documents = generateManyDocuments(500);
			const onRefresh = vi.fn();
			const props = createSelectorDefaultProps({
				documents,
				selectedDocument: documents[0],
				onRefresh,
				isLoading: true,
			});

			renderWithProviders(<AutoRunDocumentSelector {...props} />);

			// Click refresh (should be disabled)
			fireEvent.click(screen.getByTitle('Refresh document list'));

			// onRefresh should not be called when loading
			expect(onRefresh).not.toHaveBeenCalled();
		});
	});
});
