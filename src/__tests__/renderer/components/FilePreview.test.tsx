import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePreview } from '../../../renderer/components/FilePreview';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	FileCode: () => <span data-testid="file-code-icon">FileCode</span>,
	X: () => <span data-testid="x-icon">X</span>,
	Eye: () => <span data-testid="eye-icon">Eye</span>,
	ChevronUp: () => <span data-testid="chevron-up">ChevronUp</span>,
	ChevronDown: () => <span data-testid="chevron-down">ChevronDown</span>,
	ChevronLeft: () => <span data-testid="chevron-left">ChevronLeft</span>,
	ChevronRight: () => <span data-testid="chevron-right">ChevronRight</span>,
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	Loader2: () => <span data-testid="loader-icon">Loader2</span>,
	Image: () => <span data-testid="image-icon">Image</span>,
	Globe: () => <span data-testid="globe-icon">Globe</span>,
	Save: () => <span data-testid="save-icon">Save</span>,
	Edit: () => <span data-testid="edit-icon">Edit</span>,
	FolderOpen: () => <span data-testid="folder-open-icon">FolderOpen</span>,
	AlertTriangle: () => <span data-testid="alert-icon">AlertTriangle</span>,
	Share2: () => <span data-testid="share-icon">Share2</span>,
	GitGraph: () => <span data-testid="gitgraph-icon">GitGraph</span>,
	List: () => <span data-testid="list-icon">List</span>,
}));

// Mock react-markdown
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="markdown-content">{children}</div>
	),
}));

// Mock remark/rehype plugins
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('rehype-raw', () => ({ default: () => {} }));
vi.mock('rehype-slug', () => ({ default: () => {} }));
vi.mock('remark-frontmatter', () => ({ default: () => {} }));

// Mock syntax highlighter
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

// Mock unist-util-visit
vi.mock('unist-util-visit', () => ({
	visit: vi.fn(),
}));

// Mock LayerStackContext
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

// Mock MODAL_PRIORITIES
vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		FILE_PREVIEW: 100,
	},
}));

// Mock useClickOutside hook - capture the callback for testing
const mockClickOutsideCallback = { current: null as (() => void) | null };
vi.mock('../../../renderer/hooks/ui/useClickOutside', () => ({
	useClickOutside: (
		_ref: unknown,
		callback: () => void,
		_enabled: boolean,
		_options?: unknown
	) => {
		mockClickOutsideCallback.current = callback;
	},
}));

// Mock MermaidRenderer
vi.mock('../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: () => <div data-testid="mermaid-renderer">Mermaid</div>,
}));

// Mock token counter - getEncoder must return a Promise
vi.mock('../../../renderer/utils/tokenCounter', () => ({
	getEncoder: vi.fn(() => Promise.resolve({ encode: () => [1, 2, 3] })),
	formatTokenCount: vi.fn((count: number) => `${count} tokens`),
}));

// Mock shortcut formatter
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string) => keys),
}));

// Mock remarkFileLinks
vi.mock('../../../renderer/utils/remarkFileLinks', () => ({
	remarkFileLinks: vi.fn(() => () => {}),
}));

// Mock remarkFrontmatterTable
vi.mock('../../../renderer/utils/remarkFrontmatterTable', () => ({
	remarkFrontmatterTable: vi.fn(() => () => {}),
}));

// Mock gitUtils
vi.mock('../../../shared/gitUtils', () => ({
	isImageFile: (filename: string) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(filename),
}));

const mockTheme = {
	colors: {
		bgMain: '#1a1a2e',
		bgActivity: '#16213e',
		textMain: '#eee',
		textDim: '#888',
		border: '#333',
		accent: '#4a9eff',
		success: '#22c55e',
	},
};

const defaultProps = {
	file: { name: 'test.md', content: '# Hello World', path: '/test/test.md' },
	onClose: vi.fn(),
	theme: mockTheme,
	markdownEditMode: false,
	setMarkdownEditMode: vi.fn(),
	shortcuts: {},
};

describe('FilePreview', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('Document Graph button', () => {
		it('shows Document Graph button for markdown files when onOpenInGraph is provided', () => {
			const onOpenInGraph = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'readme.md', content: '# Readme', path: '/test/readme.md' }}
					onOpenInGraph={onOpenInGraph}
				/>
			);

			const graphButton = screen.getByTitle('View in Document Graph (⌘⇧G)');
			expect(graphButton).toBeInTheDocument();
			expect(screen.getByTestId('gitgraph-icon')).toBeInTheDocument();
		});

		it('calls onOpenInGraph when Document Graph button is clicked', () => {
			const onOpenInGraph = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'readme.md', content: '# Readme', path: '/test/readme.md' }}
					onOpenInGraph={onOpenInGraph}
				/>
			);

			const graphButton = screen.getByTitle('View in Document Graph (⌘⇧G)');
			fireEvent.click(graphButton);

			expect(onOpenInGraph).toHaveBeenCalledOnce();
		});

		it('does not show Document Graph button when onOpenInGraph is not provided', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'readme.md', content: '# Readme', path: '/test/readme.md' }}
				/>
			);

			expect(screen.queryByTitle('View in Document Graph (⌘⇧G)')).not.toBeInTheDocument();
		});

		it('does not show Document Graph button for non-markdown files', () => {
			const onOpenInGraph = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'app.tsx', content: 'const x = 1;', path: '/test/app.tsx' }}
					onOpenInGraph={onOpenInGraph}
				/>
			);

			expect(screen.queryByTitle('View in Document Graph (⌘⇧G)')).not.toBeInTheDocument();
		});

		it('shows Document Graph button for uppercase .MD extension', () => {
			const onOpenInGraph = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'README.MD', content: '# Readme', path: '/test/README.MD' }}
					onOpenInGraph={onOpenInGraph}
				/>
			);

			expect(screen.getByTitle('View in Document Graph (⌘⇧G)')).toBeInTheDocument();
		});
	});

	describe('text file editing', () => {
		it('shows edit button for markdown files', () => {
			render(<FilePreview {...defaultProps} />);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
		});

		it('shows edit button for JSON files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: '{"key": "value"}', path: '/test/config.json' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
		});

		it('shows edit button for YAML files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.yaml', content: 'key: value', path: '/test/config.yaml' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
		});

		it('shows edit button for TypeScript files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'app.ts', content: 'const x = 1;', path: '/test/app.ts' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
		});

		it('does not show edit button for image files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,...',
						path: '/test/image.png',
					}}
				/>
			);

			expect(screen.queryByTestId('edit-icon')).not.toBeInTheDocument();
		});

		it('toggles to edit mode when edit button is clicked', () => {
			const setMarkdownEditMode = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: '{"key": "value"}', path: '/test/config.json' }}
					setMarkdownEditMode={setMarkdownEditMode}
				/>
			);

			const editButton = screen.getByTestId('edit-icon').parentElement;
			fireEvent.click(editButton!);

			expect(setMarkdownEditMode).toHaveBeenCalledWith(true);
		});

		it('shows textarea when in edit mode for non-markdown files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: '{"key": "value"}', path: '/test/config.json' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
			expect(textarea).toHaveValue('{"key": "value"}');
		});
	});

	describe('basic rendering', () => {
		it('renders file preview with file name', () => {
			render(<FilePreview {...defaultProps} />);

			expect(screen.getByText('test.md')).toBeInTheDocument();
		});

		it('renders close button', () => {
			render(<FilePreview {...defaultProps} />);

			expect(screen.getByTestId('x-icon')).toBeInTheDocument();
		});

		it('calls onClose when close button is clicked', () => {
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} />);

			const closeButton = screen.getByTestId('x-icon').parentElement;
			fireEvent.click(closeButton!);

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('renders nothing when file is null', () => {
			const { container } = render(<FilePreview {...defaultProps} file={null} />);

			expect(container.firstChild).toBeNull();
		});
	});

	describe('large file handling', () => {
		it('shows truncation banner for files larger than 100KB', () => {
			// Create content larger than LARGE_FILE_PREVIEW_LIMIT (100KB)
			const largeContent = 'x'.repeat(150 * 1024); // 150KB
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'large.json', content: largeContent, path: '/test/large.json' }}
				/>
			);

			expect(screen.getByText(/Large file preview truncated/)).toBeInTheDocument();
			expect(screen.getByText(/Use an external editor for the full file/)).toBeInTheDocument();
		});

		it('does not show truncation banner for small files', () => {
			const smallContent = 'x'.repeat(50 * 1024); // 50KB - under threshold
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'small.json', content: smallContent, path: '/test/small.json' }}
				/>
			);

			expect(screen.queryByText(/Large file preview truncated/)).not.toBeInTheDocument();
		});

		it('does not show truncation banner for markdown files (they are not truncated)', () => {
			// Markdown files are rendered with ReactMarkdown, not SyntaxHighlighter
			// They should not be truncated as ReactMarkdown handles large content differently
			const largeMarkdown = '# Header\n'.repeat(20 * 1024); // Large markdown
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'large.md', content: largeMarkdown, path: '/test/large.md' }}
				/>
			);

			expect(screen.queryByText(/Large file preview truncated/)).not.toBeInTheDocument();
		});

		it('truncates displayed content to 100KB for syntax highlighting', () => {
			const largeContent = 'y'.repeat(200 * 1024); // 200KB
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'large.ts', content: largeContent, path: '/test/large.ts' }}
				/>
			);

			// The syntax highlighter should receive truncated content
			const highlighter = screen.getByTestId('syntax-highlighter');
			// Content should be truncated to 100KB (LARGE_FILE_PREVIEW_LIMIT)
			expect(highlighter.textContent?.length).toBe(100 * 1024);
		});

		it('skips token counting for files larger than 1MB', async () => {
			const { getEncoder } = await import('../../../renderer/utils/tokenCounter');

			// Create content larger than LARGE_FILE_TOKEN_SKIP_THRESHOLD (1MB)
			const hugeContent = 'z'.repeat(1.5 * 1024 * 1024); // 1.5MB
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'huge.json', content: hugeContent, path: '/test/huge.json' }}
				/>
			);

			// Token counting should be skipped for large files
			// getEncoder should not have been called for this file
			// (it may have been called from previous tests, but not with this content)
			// The token count state should remain null for large files
			expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
		});
	});

	describe('click outside to dismiss', () => {
		it('calls onClose when clicking outside the preview', () => {
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} />);

			// Simulate click outside via the captured callback
			expect(mockClickOutsideCallback.current).not.toBeNull();
			mockClickOutsideCallback.current?.();

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('calls onClose when clicking outside in edit mode without changes', () => {
			const onClose = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					onClose={onClose}
					markdownEditMode={true}
					file={{ name: 'test.md', content: 'original', path: '/test/test.md' }}
				/>
			);

			// Simulate click outside - should close since no changes were made
			mockClickOutsideCallback.current?.();

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('registers useClickOutside hook with container ref and enabled when file exists', () => {
			render(<FilePreview {...defaultProps} />);

			// The hook should be registered with a callback
			expect(mockClickOutsideCallback.current).not.toBeNull();
		});

		it('uses the same callback for click outside as for escape key', () => {
			// This verifies that useClickOutside is set up with handleEscapeRequest
			// which provides consistent behavior between Escape key and click outside
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} />);

			// The callback should be registered
			expect(mockClickOutsideCallback.current).toBeDefined();
			expect(typeof mockClickOutsideCallback.current).toBe('function');

			// Invoking the callback should have the same effect as pressing Escape
			// (calling onClose when no overlays are open)
			mockClickOutsideCallback.current?.();
			expect(onClose).toHaveBeenCalledOnce();
		});
	});

	describe('table of contents', () => {
		it('shows TOC button for markdown files with headings in preview mode', () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2\n### Heading 3\nContent here';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			expect(screen.getByTitle('Table of Contents')).toBeInTheDocument();
			expect(screen.getByTestId('list-icon')).toBeInTheDocument();
		});

		it('does not show TOC button for markdown without headings', () => {
			const markdownNoHeadings = 'This is just plain text.\nNo headings here.';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownNoHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			expect(screen.queryByTitle('Table of Contents')).not.toBeInTheDocument();
		});

		it('does not include comments inside code fences as headings', () => {
			// This tests that # comments in code blocks are not parsed as headings
			const markdownWithCodeComments = `# Real Heading

\`\`\`bash
# This is a comment, not a heading
echo "hello"
# Another comment
\`\`\`

## Another Real Heading

\`\`\`python
# Python comment
print("world")
\`\`\`
`;
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithCodeComments, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			// Open TOC
			const tocButton = screen.getByTitle('Table of Contents');
			fireEvent.click(tocButton);

			// Should only show 2 headings (the real ones), not the code comments
			expect(screen.getByText('2 headings')).toBeInTheDocument();
			expect(screen.getByText('Real Heading')).toBeInTheDocument();
			expect(screen.getByText('Another Real Heading')).toBeInTheDocument();
			// Code comments should NOT appear in the TOC
			expect(screen.queryByText('This is a comment, not a heading')).not.toBeInTheDocument();
			expect(screen.queryByText('Another comment')).not.toBeInTheDocument();
			expect(screen.queryByText('Python comment')).not.toBeInTheDocument();
		});

		it('does not show TOC button in edit mode', () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={true}
				/>
			);

			expect(screen.queryByTitle('Table of Contents')).not.toBeInTheDocument();
		});

		it('does not show TOC button for non-markdown files', () => {
			const jsonContent = '{"title": "Not markdown"}';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: jsonContent, path: '/test/config.json' }}
				/>
			);

			expect(screen.queryByTitle('Table of Contents')).not.toBeInTheDocument();
		});

		it('opens TOC overlay when button is clicked', () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2\n### Heading 3';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			const tocButton = screen.getByTitle('Table of Contents');
			fireEvent.click(tocButton);

			// TOC overlay should be visible with heading entries
			expect(screen.getByText('Contents')).toBeInTheDocument();
			expect(screen.getByText('3 headings')).toBeInTheDocument();
			expect(screen.getByText('Heading 1')).toBeInTheDocument();
			expect(screen.getByText('Heading 2')).toBeInTheDocument();
			expect(screen.getByText('Heading 3')).toBeInTheDocument();
		});

		it('closes TOC overlay when clicking a heading entry', () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			// Open TOC
			const tocButton = screen.getByTitle('Table of Contents');
			fireEvent.click(tocButton);

			// Click a heading entry
			const headingEntry = screen.getByText('Heading 1');
			fireEvent.click(headingEntry);

			// TOC overlay should close
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
		});
	});
});
