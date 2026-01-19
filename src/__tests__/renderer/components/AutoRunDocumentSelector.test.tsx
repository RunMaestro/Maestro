import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
	AutoRunDocumentSelector,
	DocTreeNode,
} from '../../../renderer/components/AutoRunDocumentSelector';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react icons
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
}));

// Test theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		border: '#374151',
		accent: '#6366f1',
		accentForeground: '#ffffff',
		textMain: '#e5e7eb',
		textDim: '#9ca3af',
		success: '#22c55e',
		warning: '#eab308',
		error: '#ef4444',
		purple: '#8b5cf6',
	},
};

const defaultProps = {
	theme: mockTheme,
	documents: ['doc1', 'doc2', 'doc3'],
	selectedDocument: null,
	onSelectDocument: vi.fn(),
	onRefresh: vi.fn(),
	onChangeFolder: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	isLoading: false,
};

describe('AutoRunDocumentSelector', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Exports', () => {
		it('exports DocTreeNode interface type', () => {
			// TypeScript compile-time check - if this compiles, the export exists
			const node: DocTreeNode = {
				name: 'test',
				type: 'file',
				path: 'test',
			};
			expect(node.name).toBe('test');
			expect(node.type).toBe('file');
		});

		it('exports AutoRunDocumentSelector component', () => {
			expect(AutoRunDocumentSelector).toBeDefined();
			expect(typeof AutoRunDocumentSelector).toBe('function');
		});
	});

	describe('Initial Render', () => {
		it('renders dropdown button with placeholder when no selection', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			expect(button).toBeInTheDocument();
			expect(button).toHaveTextContent('Select a document...');
		});

		it('renders dropdown button with selected document name', () => {
			render(<AutoRunDocumentSelector {...defaultProps} selectedDocument="doc1" />);

			const button = screen.getByRole('button', { name: /doc1\.md/i });
			expect(button).toBeInTheDocument();
			expect(button).toHaveTextContent('doc1.md');
		});

		it('renders create new document button', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const createButton = screen.getByTitle('Create new document');
			expect(createButton).toBeInTheDocument();
		});

		it('renders refresh button', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const refreshButton = screen.getByTitle('Refresh document list');
			expect(refreshButton).toBeInTheDocument();
		});

		it('renders change folder button', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const changeFolderButton = screen.getByTitle('Change folder');
			expect(changeFolderButton).toBeInTheDocument();
		});

		it('applies theme colors to dropdown button', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			expect(button).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
			expect(button).toHaveStyle({ color: mockTheme.colors.textMain });
		});
	});

	describe('Dropdown Toggle', () => {
		it('opens dropdown when button is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Dropdown should be visible with document options
			expect(screen.getByText('doc1.md')).toBeInTheDocument();
			expect(screen.getByText('doc2.md')).toBeInTheDocument();
			expect(screen.getByText('doc3.md')).toBeInTheDocument();
		});

		it('closes dropdown when button is clicked again', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);
			expect(screen.getByText('doc1.md')).toBeInTheDocument();

			fireEvent.click(button);
			expect(screen.queryByText('doc1.md')).not.toBeInTheDocument();
		});

		it('rotates chevron icon when dropdown is open', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			const chevron = within(button).getByTestId('chevron-down');

			// Initially not rotated
			expect(chevron.className).not.toContain('rotate-180');

			fireEvent.click(button);

			// Should have rotate-180 class when open
			expect(chevron.className).toContain('rotate-180');
		});
	});

	describe('Document Selection', () => {
		it('calls onSelectDocument when document is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			// Open dropdown
			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Click on a document
			const docButton = screen.getByText('doc2.md');
			fireEvent.click(docButton);

			expect(defaultProps.onSelectDocument).toHaveBeenCalledWith('doc2');
		});

		it('closes dropdown after selection', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			const docButton = screen.getByText('doc1.md');
			fireEvent.click(docButton);

			// Dropdown should be closed
			expect(screen.queryByText('doc2.md')).not.toBeInTheDocument();
		});

		it('highlights selected document in dropdown', () => {
			render(<AutoRunDocumentSelector {...defaultProps} selectedDocument="doc2" />);

			const button = screen.getByRole('button', { name: /doc2\.md/i });
			fireEvent.click(button);

			// Find all elements with doc2.md text, find the one in the dropdown
			const docElements = screen.getAllByText('doc2.md');
			// The dropdown item is a span inside a button with hover:bg-white/5 class
			const selectedDoc = docElements
				.find((el) => {
					const parent = el.closest('button');
					return parent && parent.className.includes('hover:bg-white/5');
				})
				?.closest('button');
			expect(selectedDoc).toHaveStyle({ color: mockTheme.colors.accent });
			expect(selectedDoc).toHaveStyle({ backgroundColor: mockTheme.colors.bgActivity });
		});
	});

	describe('Empty State', () => {
		it('shows empty message when no documents', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documents={[]} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			expect(screen.getByText('No markdown files found')).toBeInTheDocument();
		});
	});

	describe('Tree Mode', () => {
		const documentTree: DocTreeNode[] = [
			{
				name: 'folder1',
				type: 'folder',
				path: 'folder1',
				children: [
					{ name: 'nested-doc', type: 'file', path: 'folder1/nested-doc' },
					{
						name: 'subfolder',
						type: 'folder',
						path: 'folder1/subfolder',
						children: [{ name: 'deep-doc', type: 'file', path: 'folder1/subfolder/deep-doc' }],
					},
				],
			},
			{ name: 'root-doc', type: 'file', path: 'root-doc' },
		];

		it('renders folder nodes with chevron icons', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/nested-doc', 'folder1/subfolder/deep-doc', 'root-doc']}
					documentTree={documentTree}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Folder should be visible with chevron
			expect(screen.getByText('folder1')).toBeInTheDocument();
		});

		it('expands folder when clicked', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/nested-doc', 'folder1/subfolder/deep-doc', 'root-doc']}
					documentTree={documentTree}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Initially folder is collapsed, nested doc shouldn't be visible
			expect(screen.queryByText('nested-doc.md')).not.toBeInTheDocument();

			// Click folder to expand
			const folderButton = screen.getByText('folder1');
			fireEvent.click(folderButton);

			// Now nested doc should be visible
			expect(screen.getByText('nested-doc.md')).toBeInTheDocument();
		});

		it('collapses folder when clicked again', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/nested-doc', 'folder1/subfolder/deep-doc', 'root-doc']}
					documentTree={documentTree}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Expand folder
			const folderButton = screen.getByText('folder1');
			fireEvent.click(folderButton);
			expect(screen.getByText('nested-doc.md')).toBeInTheDocument();

			// Collapse folder
			fireEvent.click(folderButton);
			expect(screen.queryByText('nested-doc.md')).not.toBeInTheDocument();
		});

		it('renders nested folders correctly', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/nested-doc', 'folder1/subfolder/deep-doc', 'root-doc']}
					documentTree={documentTree}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Expand folder1
			fireEvent.click(screen.getByText('folder1'));
			expect(screen.getByText('subfolder')).toBeInTheDocument();

			// Expand subfolder
			fireEvent.click(screen.getByText('subfolder'));
			expect(screen.getByText('deep-doc.md')).toBeInTheDocument();
		});

		it('selects file from tree', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/nested-doc', 'folder1/subfolder/deep-doc', 'root-doc']}
					documentTree={documentTree}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Expand folder and select nested doc
			fireEvent.click(screen.getByText('folder1'));
			fireEvent.click(screen.getByText('nested-doc.md'));

			expect(defaultProps.onSelectDocument).toHaveBeenCalledWith('folder1/nested-doc');
		});

		it('renders root-level file in tree', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/nested-doc', 'folder1/subfolder/deep-doc', 'root-doc']}
					documentTree={documentTree}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			expect(screen.getByText('root-doc.md')).toBeInTheDocument();
		});
	});

	describe('Click Outside', () => {
		it('closes dropdown when clicking outside', () => {
			render(
				<div>
					<div data-testid="outside">Outside element</div>
					<AutoRunDocumentSelector {...defaultProps} />
				</div>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);
			expect(screen.getByText('doc1.md')).toBeInTheDocument();

			// Click outside
			fireEvent.mouseDown(screen.getByTestId('outside'));
			expect(screen.queryByText('doc1.md')).not.toBeInTheDocument();
		});
	});

	describe('Escape Key', () => {
		it('closes dropdown when Escape is pressed', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);
			expect(screen.getByText('doc1.md')).toBeInTheDocument();

			fireEvent.keyDown(document, { key: 'Escape' });
			expect(screen.queryByText('doc1.md')).not.toBeInTheDocument();
		});

		it('returns focus to button after closing with Escape', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(document.activeElement).toBe(button);
		});
	});

	describe('Refresh Button', () => {
		it('calls onRefresh when clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const refreshButton = screen.getByTitle('Refresh document list');
			fireEvent.click(refreshButton);

			expect(defaultProps.onRefresh).toHaveBeenCalledTimes(1);
		});

		it('is disabled when loading', () => {
			render(<AutoRunDocumentSelector {...defaultProps} isLoading={true} />);

			const refreshButton = screen.getByTitle('Refresh document list');
			expect(refreshButton).toBeDisabled();
		});

		it('shows spinning icon when loading', () => {
			render(<AutoRunDocumentSelector {...defaultProps} isLoading={true} />);

			const refreshIcon = screen.getByTestId('refresh-icon');
			expect(refreshIcon.className).toContain('animate-spin');
		});

		it('does not show spinning icon when not loading', () => {
			render(<AutoRunDocumentSelector {...defaultProps} isLoading={false} />);

			const refreshIcon = screen.getByTestId('refresh-icon');
			expect(refreshIcon.className).not.toContain('animate-spin');
		});
	});

	describe('Change Folder Button', () => {
		it('calls onChangeFolder when top-level button clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const changeFolderButton = screen.getByTitle('Change folder');
			fireEvent.click(changeFolderButton);

			expect(defaultProps.onChangeFolder).toHaveBeenCalledTimes(1);
		});

		it('calls onChangeFolder from dropdown option', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			// Open dropdown
			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Click "Change Folder..." option in dropdown
			const changeFolderOption = screen.getByText('Change Folder...');
			fireEvent.click(changeFolderOption);

			expect(defaultProps.onChangeFolder).toHaveBeenCalledTimes(1);
		});

		it('closes dropdown when Change Folder option is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);
			expect(screen.getByText('doc1.md')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Change Folder/ }));
			expect(screen.queryByText('doc1.md')).not.toBeInTheDocument();
		});
	});

	describe('Create Document Modal', () => {
		it('opens modal when create button is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const createButton = screen.getByTitle('Create new document');
			fireEvent.click(createButton);

			expect(screen.getByRole('dialog', { name: /create new document/i })).toBeInTheDocument();
		});

		it('renders modal with correct elements', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			expect(screen.getByText('Document Name')).toBeInTheDocument();
			expect(screen.getByPlaceholderText('my-tasks')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
			expect(screen.getByRole('button', { name: /^create$/i })).toBeInTheDocument();
		});

		it('focuses input when modal opens', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			await waitFor(() => {
				const input = screen.getByPlaceholderText('my-tasks');
				expect(document.activeElement).toBe(input);
			});
		});

		it('closes modal when Cancel is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			expect(screen.getByRole('dialog')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('closes modal when backdrop is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const dialog = screen.getByRole('dialog');

			// Click on the backdrop (the dialog element itself, not its children)
			fireEvent.click(dialog);
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('does not close modal when modal content is clicked', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			// Click on the input inside the modal
			fireEvent.click(screen.getByPlaceholderText('my-tasks'));
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('closes modal on Escape key', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			expect(screen.getByRole('dialog')).toBeInTheDocument();

			fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});

		it('clears input when modal is closed', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'test-doc' } });
			expect(input).toHaveValue('test-doc');

			fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

			// Reopen modal
			fireEvent.click(screen.getByTitle('Create new document'));
			expect(screen.getByPlaceholderText('my-tasks')).toHaveValue('');
		});
	});

	describe('Duplicate Detection', () => {
		it('shows error when document name already exists', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documents={['existing-doc', 'doc2']} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'existing-doc' } });

			expect(screen.getByText(/a document with this name already exists/i)).toBeInTheDocument();
		});

		it('shows error for case-insensitive duplicates', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documents={['ExistingDoc', 'doc2']} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'existingdoc' } });

			expect(screen.getByText(/a document with this name already exists/i)).toBeInTheDocument();
		});

		it('shows error when adding .md makes duplicate', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documents={['test-doc', 'doc2']} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'test-doc.md' } });

			expect(screen.getByText(/a document with this name already exists/i)).toBeInTheDocument();
		});

		it('disables Create button when duplicate', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documents={['existing-doc', 'doc2']} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'existing-doc' } });

			const createButton = screen.getByRole('button', { name: /^create$/i });
			expect(createButton).toBeDisabled();
		});

		it('applies error border color to input when duplicate', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documents={['existing-doc', 'doc2']} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'existing-doc' } });

			expect(input).toHaveStyle({ borderColor: mockTheme.colors.error });
		});
	});

	describe('Form Submission', () => {
		it('calls onCreateDocument when Create button is clicked', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });

			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('new-doc');
			});
		});

		it('calls onCreateDocument when Enter is pressed', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('new-doc');
			});
		});

		it('does not submit when name is empty', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			expect(defaultProps.onCreateDocument).not.toHaveBeenCalled();
		});

		it('does not submit when name is only whitespace', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: '   ' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			expect(defaultProps.onCreateDocument).not.toHaveBeenCalled();
		});

		it('disables Create button when input is empty', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const createButton = screen.getByRole('button', { name: /^create$/i });
			expect(createButton).toBeDisabled();
		});

		it('shows Creating... state during submission', async () => {
			const slowCreateDocument = vi
				.fn()
				.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(true), 100)));

			render(<AutoRunDocumentSelector {...defaultProps} onCreateDocument={slowCreateDocument} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			expect(screen.getByText('Creating...')).toBeInTheDocument();

			await waitFor(() => {
				expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
			});
		});

		it('closes modal on successful creation', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
			});
		});

		it('keeps modal open on failed creation', async () => {
			const failingCreate = vi.fn().mockResolvedValue(false);

			render(<AutoRunDocumentSelector {...defaultProps} onCreateDocument={failingCreate} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(screen.getByRole('dialog')).toBeInTheDocument();
			});
		});
	});

	describe('File Extension Handling', () => {
		it('adds .md extension if not provided', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('new-doc');
			});
		});

		it('strips .md extension from document name', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc.md' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('new-doc');
			});
		});

		it('strips .MD extension (case insensitive)', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc.MD' } });
			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('new-doc');
			});
		});
	});

	describe('Folder Selection in Create Modal', () => {
		const documentTree: DocTreeNode[] = [
			{
				name: 'folder1',
				type: 'folder',
				path: 'folder1',
				children: [
					{
						name: 'subfolder',
						type: 'folder',
						path: 'folder1/subfolder',
						children: [],
					},
				],
			},
			{
				name: 'folder2',
				type: 'folder',
				path: 'folder2',
				children: [],
			},
		];

		it('shows folder selector when tree has folders', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			expect(screen.getByText('Location')).toBeInTheDocument();
			expect(screen.getByRole('combobox')).toBeInTheDocument();
		});

		it('does not show folder selector when no tree', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			expect(screen.queryByText('Location')).not.toBeInTheDocument();
		});

		it('does not show folder selector when tree is empty', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={[]} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			expect(screen.queryByText('Location')).not.toBeInTheDocument();
		});

		it('lists all folders in selector', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const select = screen.getByRole('combobox');
			expect(select).toBeInTheDocument();

			// Check options
			const options = within(select).getAllByRole('option');
			expect(options).toHaveLength(4); // Root + folder1 + subfolder + folder2
		});

		it('creates document in selected folder', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			// Select folder
			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'folder1' } });

			// Enter document name
			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'nested-doc' } });

			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('folder1/nested-doc');
			});
		});

		it('creates document in nested folder', async () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'folder1/subfolder' } });

			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'deep-doc' } });

			fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

			await waitFor(() => {
				expect(defaultProps.onCreateDocument).toHaveBeenCalledWith('folder1/subfolder/deep-doc');
			});
		});

		it('shows preview of full path in helper text', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'folder1' } });

			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'new-doc' } });

			expect(screen.getByText(/will create: folder1\/new-doc\.md/i)).toBeInTheDocument();
		});

		it('detects duplicate in subfolder', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['folder1/existing-doc']}
					documentTree={documentTree}
				/>
			);

			fireEvent.click(screen.getByTitle('Create new document'));

			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'folder1' } });

			const input = screen.getByPlaceholderText('my-tasks');
			fireEvent.change(input, { target: { value: 'existing-doc' } });

			expect(
				screen.getByText(/a document with this name already exists in folder1/i)
			).toBeInTheDocument();
		});

		it('resets folder selection when modal closes', () => {
			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'folder1' } });

			fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

			// Reopen and check
			fireEvent.click(screen.getByTitle('Create new document'));
			expect(screen.getByRole('combobox')).toHaveValue('');
		});
	});

	describe('Helper Text', () => {
		it('shows extension hint when no folder selected', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			expect(
				screen.getByText(/the \.md extension will be added automatically/i)
			).toBeInTheDocument();
		});

		it('shows path preview when folder is selected', () => {
			const documentTree: DocTreeNode[] = [
				{ name: 'folder1', type: 'folder', path: 'folder1', children: [] },
			];

			render(<AutoRunDocumentSelector {...defaultProps} documentTree={documentTree} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const select = screen.getByRole('combobox');
			fireEvent.change(select, { target: { value: 'folder1' } });

			// With folder selected, shows path preview instead of extension hint
			expect(
				screen.queryByText(/the \.md extension will be added automatically/i)
			).not.toBeInTheDocument();
			expect(screen.getByText(/will create: folder1\//i)).toBeInTheDocument();
		});
	});

	describe('Edge Cases', () => {
		it('handles documents with special characters', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['doc-with-dash', 'doc_with_underscore', 'doc.with.dots']}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			expect(screen.getByText('doc-with-dash.md')).toBeInTheDocument();
			expect(screen.getByText('doc_with_underscore.md')).toBeInTheDocument();
			expect(screen.getByText('doc.with.dots.md')).toBeInTheDocument();
		});

		it('handles document names with unicode', () => {
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={['日本語ドキュメント', 'émojis-📝']}
				/>
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			expect(screen.getByText('日本語ドキュメント.md')).toBeInTheDocument();
			expect(screen.getByText('émojis-📝.md')).toBeInTheDocument();
		});

		it('handles very long document names', () => {
			const longName = 'a'.repeat(200);
			render(
				<AutoRunDocumentSelector
					{...defaultProps}
					documents={[longName]}
					selectedDocument={longName}
				/>
			);

			const button = screen.getByRole('button', { name: new RegExp(longName.substring(0, 50)) });
			expect(button).toBeInTheDocument();
		});

		it('handles rapid dropdown toggling', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });

			// Rapid toggling
			for (let i = 0; i < 10; i++) {
				fireEvent.click(button);
			}

			// Should be in a consistent state (even number of clicks = closed)
			expect(screen.queryByText('doc1.md')).not.toBeInTheDocument();
		});

		it('handles rapid refresh clicks', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const refreshButton = screen.getByTitle('Refresh document list');

			for (let i = 0; i < 5; i++) {
				fireEvent.click(refreshButton);
			}

			expect(defaultProps.onRefresh).toHaveBeenCalledTimes(5);
		});

		it('handles tree with only folders (no files)', () => {
			const foldersOnly: DocTreeNode[] = [
				{ name: 'folder1', type: 'folder', path: 'folder1', children: [] },
				{ name: 'folder2', type: 'folder', path: 'folder2', children: [] },
			];

			render(
				<AutoRunDocumentSelector {...defaultProps} documents={[]} documentTree={foldersOnly} />
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Should show empty message since no documents exist
			expect(screen.getByText('No markdown files found')).toBeInTheDocument();
		});

		it('handles XSS-like document names safely', () => {
			render(
				<AutoRunDocumentSelector {...defaultProps} documents={['<script>alert("xss")</script>']} />
			);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Should render as text, not execute
			const docElement = screen.getByText('<script>alert("xss")</script>.md');
			expect(docElement).toBeInTheDocument();
		});
	});

	describe('Styling', () => {
		it('applies theme colors to dropdown menu', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			const button = screen.getByRole('button', { name: /select a document/i });
			fireEvent.click(button);

			// Find the dropdown menu - the doc text is in a span, inside a button, inside the menu container
			const docText = screen.getByText('doc1.md');
			const docButton = docText.closest('button');
			const menu = docButton?.parentElement;
			expect(menu).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('applies theme colors to create modal', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			// Find the modal content container - it's the inner div with the border style
			const modalHeader = screen.getByText('Create New Document');
			const modalContent = modalHeader.closest('div[style*="background"]');
			expect(modalContent).toHaveStyle({ backgroundColor: mockTheme.colors.bgSidebar });
		});

		it('applies loading opacity to refresh button', () => {
			render(<AutoRunDocumentSelector {...defaultProps} isLoading={true} />);

			const refreshButton = screen.getByTitle('Refresh document list');
			expect(refreshButton.className).toContain('opacity-50');
		});
	});

	describe('Accessibility', () => {
		it('modal has correct aria attributes', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			fireEvent.click(screen.getByTitle('Create new document'));

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Create New Document');
		});

		it('buttons have accessible titles', () => {
			render(<AutoRunDocumentSelector {...defaultProps} />);

			expect(screen.getByTitle('Create new document')).toBeInTheDocument();
			expect(screen.getByTitle('Refresh document list')).toBeInTheDocument();
			expect(screen.getByTitle('Change folder')).toBeInTheDocument();
		});
	});
});
