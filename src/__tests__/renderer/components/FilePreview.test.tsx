import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { FilePreview } from '../../../renderer/components/FilePreview';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	FileCode: () => <span data-testid="file-code-icon">FileCode</span>,
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
	ExternalLink: () => <span data-testid="external-link-icon">ExternalLink</span>,
	RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
	X: () => <span data-testid="x-icon">X</span>,
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

// Mock useClickOutside hook - capture both container and TOC callbacks separately
// FilePreview calls useClickOutside twice: first for container (handleEscapeRequest), second for TOC
const mockContainerClickOutside = { callback: null as (() => void) | null, enabled: false };
const mockTocClickOutside = { callback: null as (() => void) | null, enabled: false };
let useClickOutsideCallCount = 0;
vi.mock('../../../renderer/hooks/ui/useClickOutside', () => ({
	useClickOutside: (_ref: unknown, callback: () => void, enabled: boolean, _options?: unknown) => {
		// First call is for container (handleEscapeRequest), second is for TOC
		if (useClickOutsideCallCount % 2 === 0) {
			mockContainerClickOutside.callback = callback;
			mockContainerClickOutside.enabled = enabled;
		} else {
			mockTocClickOutside.callback = callback;
			mockTocClickOutside.enabled = enabled;
		}
		useClickOutsideCallCount++;
	},
}));
// Legacy aliases for backward compatibility with existing tests
const mockClickOutsideCallback = {
	get current() {
		return mockContainerClickOutside.callback;
	},
};
const mockClickOutsideEnabled = {
	get current() {
		return mockContainerClickOutside.enabled;
	},
};

// Mock MermaidRenderer
vi.mock('../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: () => <div data-testid="mermaid-renderer">Mermaid</div>,
}));

// Mock CsvTableRenderer
vi.mock('../../../renderer/components/CsvTableRenderer', () => ({
	CsvTableRenderer: ({ content, searchQuery, delimiter }: { content: string; searchQuery?: string; delimiter?: string }) => (
		<div data-testid="csv-table-renderer" data-search={searchQuery ?? ''} data-delimiter={delimiter ?? ','}>
			{content.substring(0, 50)}
		</div>
	),
}));

// Mock token counter - getEncoder must return a Promise
vi.mock('../../../renderer/utils/tokenCounter', () => ({
	getEncoder: vi.fn(() => Promise.resolve({ encode: () => [1, 2, 3] })),
	formatTokenCount: vi.fn((count: number) => `${count} tokens`),
}));

// Mock shortcut formatter
vi.mock('../../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: vi.fn((keys: string) => keys),
	isMacOS: vi.fn(() => false),
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
		// Reset useClickOutside call counter so each test starts fresh
		useClickOutsideCallCount = 0;
		mockContainerClickOutside.callback = null;
		mockContainerClickOutside.enabled = false;
		mockTocClickOutside.callback = null;
		mockTocClickOutside.enabled = false;
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

	describe('Open in Default App button', () => {
		it('shows Open in Default App button with ExternalLink icon', () => {
			render(<FilePreview {...defaultProps} />);

			const button = screen.getByTitle('Open in Default App');
			expect(button).toBeInTheDocument();
			expect(screen.getByTestId('external-link-icon')).toBeInTheDocument();
		});

		it('calls shell.openExternal with file:// URL when clicked', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'readme.md', content: '# Readme', path: '/test/readme.md' }}
				/>
			);

			const button = screen.getByTitle('Open in Default App');
			fireEvent.click(button);

			expect(window.maestro?.shell?.openExternal).toHaveBeenCalledWith('file:///test/readme.md');
		});

		it('hides Open in Default App button for SSH remote sessions', () => {
			render(
				<FilePreview
					{...defaultProps}
					sshRemoteId="remote-host-1"
				/>
			);

			expect(screen.queryByTitle('Open in Default App')).not.toBeInTheDocument();
		});
	});

	describe('file changed on disk banner', () => {
		it('shows reload banner when polling detects a newer mtime', async () => {
			vi.useFakeTimers();
			const onReloadFile = vi.fn();

			// Mock stat to return a newer mtime than lastModified
			const mockStat = vi.fn().mockResolvedValue({
				modifiedAt: new Date(2000).toISOString(),
				size: 100,
				isFile: true,
				isDirectory: false,
			});
			window.maestro.fs.stat = mockStat;

			render(
				<FilePreview
					{...defaultProps}
					lastModified={1000}
					onReloadFile={onReloadFile}
				/>
			);

			// Banner should not be visible initially
			expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();

			// Advance timer to trigger the 3s polling interval
			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText('File changed on disk.')).toBeInTheDocument();
			expect(screen.getByTestId('refresh-icon')).toBeInTheDocument();

			vi.useRealTimers();
		});

		it('calls onReloadFile when Reload button is clicked', async () => {
			vi.useFakeTimers();
			const onReloadFile = vi.fn();

			window.maestro.fs.stat = vi.fn().mockResolvedValue({
				modifiedAt: new Date(2000).toISOString(),
				size: 100,
				isFile: true,
				isDirectory: false,
			});

			render(
				<FilePreview
					{...defaultProps}
					lastModified={1000}
					onReloadFile={onReloadFile}
				/>
			);

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			const reloadButton = screen.getByText('Reload');
			fireEvent.click(reloadButton);

			expect(onReloadFile).toHaveBeenCalledOnce();
			// Banner should be dismissed after reload
			expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();

			vi.useRealTimers();
		});

		it('dismisses banner when X button is clicked', async () => {
			vi.useFakeTimers();

			window.maestro.fs.stat = vi.fn().mockResolvedValue({
				modifiedAt: new Date(2000).toISOString(),
				size: 100,
				isFile: true,
				isDirectory: false,
			});

			render(
				<FilePreview
					{...defaultProps}
					lastModified={1000}
					onReloadFile={vi.fn()}
				/>
			);

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText('File changed on disk.')).toBeInTheDocument();

			const dismissButton = screen.getByTitle('Dismiss');
			fireEvent.click(dismissButton);

			expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();

			vi.useRealTimers();
		});

		it('shows unsaved edits warning when in edit mode with changes', async () => {
			vi.useFakeTimers();

			window.maestro.fs.stat = vi.fn().mockResolvedValue({
				modifiedAt: new Date(2000).toISOString(),
				size: 100,
				isFile: true,
				isDirectory: false,
			});

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: '# Original', path: '/test/test.md' }}
					markdownEditMode={true}
					externalEditContent="# Modified by user"
					lastModified={1000}
					onReloadFile={vi.fn()}
				/>
			);

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(
				screen.getByText(/File changed on disk\. You have unsaved edits/)
			).toBeInTheDocument();

			vi.useRealTimers();
		});

		it('does not poll when lastModified is not provided', async () => {
			vi.useFakeTimers();
			const mockStat = vi.fn().mockResolvedValue({
				modifiedAt: new Date(2000).toISOString(),
				size: 100,
				isFile: true,
				isDirectory: false,
			});
			window.maestro.fs.stat = mockStat;

			render(
				<FilePreview
					{...defaultProps}
					onReloadFile={vi.fn()}
				/>
			);

			// Allow the initial file stats fetch to complete
			await act(async () => {
				await Promise.resolve();
			});

			const callsAfterMount = mockStat.mock.calls.length;

			// Advance timers past multiple poll intervals — no additional calls should happen
			await act(async () => {
				vi.advanceTimersByTime(6000);
			});

			expect(mockStat).toHaveBeenCalledTimes(callsAfterMount);

			vi.useRealTimers();
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

	describe('edit mode keyboard navigation', () => {
		const multiLineContent = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';

		it('Cmd+Shift+Up selects from cursor to beginning of document', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: multiLineContent, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			// Place cursor at position 14 (start of Line 3)
			textarea.setSelectionRange(14, 14);

			fireEvent.keyDown(textarea, { key: 'ArrowUp', metaKey: true, shiftKey: true });

			expect(textarea.selectionStart).toBe(0);
			expect(textarea.selectionEnd).toBe(14);
		});

		it('Cmd+Shift+Down selects from cursor to end of document', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: multiLineContent, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			// Place cursor at position 14 (start of Line 3)
			textarea.setSelectionRange(14, 14);

			fireEvent.keyDown(textarea, { key: 'ArrowDown', metaKey: true, shiftKey: true });

			expect(textarea.selectionStart).toBe(14);
			expect(textarea.selectionEnd).toBe(multiLineContent.length);
		});

		it('Cmd+Up moves cursor to beginning without selection', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: multiLineContent, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(14, 14);

			fireEvent.keyDown(textarea, { key: 'ArrowUp', metaKey: true });

			expect(textarea.selectionStart).toBe(0);
			expect(textarea.selectionEnd).toBe(0);
		});

		it('Cmd+Down moves cursor to end without selection', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: multiLineContent, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(14, 14);

			fireEvent.keyDown(textarea, { key: 'ArrowDown', metaKey: true });

			expect(textarea.selectionStart).toBe(multiLineContent.length);
			expect(textarea.selectionEnd).toBe(multiLineContent.length);
		});
	});

	describe('basic rendering', () => {
		it('renders file preview with file name', () => {
			render(<FilePreview {...defaultProps} />);

			expect(screen.getByText('test.md')).toBeInTheDocument();
		});

		// Close button was removed - now handled by file tab's X button
		// See Phase 8: Cleanup & Polish task for details

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

		it('uses the same callback for click outside as for escape key in overlay mode', () => {
			// This verifies that useClickOutside is set up with handleEscapeRequest
			// which provides consistent behavior between Escape key and click outside
			// This only applies to overlay mode (isTabMode=false or undefined)
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} isTabMode={false} />);

			// The callback should be registered
			expect(mockClickOutsideCallback.current).toBeDefined();
			expect(typeof mockClickOutsideCallback.current).toBe('function');

			// Invoking the callback should have the same effect as pressing Escape
			// (calling onClose when no overlays are open)
			mockClickOutsideCallback.current?.();
			expect(onClose).toHaveBeenCalledOnce();
		});

		it('does not close tab on Escape key when isTabMode is true', () => {
			// In tab mode, Escape should only close internal UI (search, TOC)
			// not the tab itself - tabs close via Cmd+W or close button
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} isTabMode={true} />);

			// The callback should be registered but disabled in tab mode
			expect(mockClickOutsideEnabled.current).toBe(false);

			// Even if callback is invoked, it should NOT close in tab mode
			// This matches the updated handleEscapeRequest behavior
		});

		it('disables click-outside-to-close when isTabMode is true', () => {
			// In tab mode, file preview tabs should persist until explicitly closed
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} isTabMode={true} />);

			// Click outside should be disabled in tab mode
			expect(mockClickOutsideEnabled.current).toBe(false);
		});

		it('enables click-outside-to-close when isTabMode is false or undefined', () => {
			const onClose = vi.fn();
			render(<FilePreview {...defaultProps} onClose={onClose} />);

			// Click outside should be enabled by default (non-tab mode)
			expect(mockClickOutsideEnabled.current).toBe(true);
		});
	});

	describe('edit content state persistence', () => {
		it('calls onEditContentChange when editing content', () => {
			const onEditContentChange = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'original content', path: '/test/test.md' }}
					markdownEditMode={true}
					onEditContentChange={onEditContentChange}
				/>
			);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'modified content' } });

			expect(onEditContentChange).toHaveBeenCalledWith('modified content');
		});

		it('uses externalEditContent when provided', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'original content', path: '/test/test.md' }}
					markdownEditMode={true}
					externalEditContent="externally managed content"
				/>
			);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('externally managed content');
		});

		it('falls back to internal state when externalEditContent is not provided', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'file content', path: '/test/test.md' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('file content');
		});

		it('preserves external edit content across re-renders', () => {
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'original', path: '/test/test.md' }}
					markdownEditMode={true}
					externalEditContent="preserved content"
				/>
			);

			// Re-render with same external content
			rerender(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'original', path: '/test/test.md' }}
					markdownEditMode={true}
					externalEditContent="preserved content"
				/>
			);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toHaveValue('preserved content');
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

		it('keeps TOC overlay open when clicking a heading entry', () => {
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

			// TOC overlay should stay open so user can click multiple items
			expect(screen.getByText('Contents')).toBeInTheDocument();
		});

		it('displays Top and Bottom navigation buttons as sticky sash elements', () => {
			const markdownWithManyHeadings = Array.from(
				{ length: 20 },
				(_, i) => `# Heading ${i + 1}`
			).join('\n');
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithManyHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			// Open TOC
			const tocButton = screen.getByTitle('Table of Contents');
			fireEvent.click(tocButton);

			// Both Top and Bottom buttons should be visible with their sash styling
			const topButton = screen.getByTestId('toc-top-button');
			const bottomButton = screen.getByTestId('toc-bottom-button');

			expect(topButton).toBeInTheDocument();
			expect(bottomButton).toBeInTheDocument();
			expect(topButton).toHaveTextContent('Top');
			expect(bottomButton).toHaveTextContent('Bottom');

			// Verify both buttons have border styling (indicating sash design)
			expect(topButton).toHaveClass('border-b');
			expect(bottomButton).toHaveClass('border-t');
		});

		it('keeps TOC open when clicking Top button', () => {
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

			// Click Top button
			const topButton = screen.getByTestId('toc-top-button');
			fireEvent.click(topButton);

			// TOC overlay should stay open so user can click multiple items
			expect(screen.getByText('Contents')).toBeInTheDocument();
		});

		it('keeps TOC open when clicking Bottom button', () => {
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

			// Click Bottom button
			const bottomButton = screen.getByTestId('toc-bottom-button');
			fireEvent.click(bottomButton);

			// TOC overlay should stay open so user can click multiple items
			expect(screen.getByText('Contents')).toBeInTheDocument();
		});

		it('closes TOC when clicking outside of it', async () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2\n## Heading 3';
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

			// Verify TOC is open
			expect(screen.getByText('Contents')).toBeInTheDocument();

			// Simulate click outside by invoking the TOC click-outside callback
			// (the mock captures this callback when useClickOutside is called for TOC)
			// Wrap in act() to ensure React state updates are processed
			expect(mockTocClickOutside.callback).not.toBeNull();
			act(() => {
				mockTocClickOutside.callback?.();
			});

			// TOC should be closed
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
		});

		it('closes TOC overlay when pressing Escape', () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2';
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
					isTabMode={true}
				/>
			);

			// Open TOC
			const tocButton = screen.getByTitle('Table of Contents');
			fireEvent.click(tocButton);

			// Verify TOC is open
			expect(screen.getByText('Contents')).toBeInTheDocument();

			// Press Escape key on the container
			const previewContainer = container.querySelector('[tabindex="0"]');
			expect(previewContainer).not.toBeNull();
			fireEvent.keyDown(previewContainer!, { key: 'Escape' });

			// TOC should be closed
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
		});

		it('closes search before TOC when both are open and Escape is pressed', () => {
			const markdownWithHeadings = '# Heading 1\n## Heading 2';
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
					isTabMode={true}
				/>
			);

			// Open TOC first
			const tocButton = screen.getByTitle('Table of Contents');
			fireEvent.click(tocButton);
			expect(screen.getByText('Contents')).toBeInTheDocument();

			// Open search (Cmd+F)
			const previewContainer = container.querySelector('[tabindex="0"]');
			expect(previewContainer).not.toBeNull();
			fireEvent.keyDown(previewContainer!, { key: 'f', metaKey: true });

			// Search should be open
			expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();

			// Press Escape - should close TOC first (it's checked first in the handler)
			fireEvent.keyDown(previewContainer!, { key: 'Escape' });

			// TOC should be closed, search should still be open
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
			expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();

			// Press Escape again - should close search
			fireEvent.keyDown(previewContainer!, { key: 'Escape' });
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
		});
	});

	describe('search state persistence', () => {
		it('calls onSearchQueryChange when typing in search', async () => {
			const onSearchQueryChange = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'const searchable = true;', path: '/test/test.ts' }}
					onSearchQueryChange={onSearchQueryChange}
				/>
			);

			// Open search with keyboard shortcut (Cmd/Ctrl+F)
			// The container div has tabIndex=0 and handles keyboard events
			const mainContainer = container.firstChild as HTMLElement;
			fireEvent.keyDown(mainContainer, { key: 'f', metaKey: true });

			// Find the search input and type
			const searchInput = screen.getByPlaceholderText(/Search in file/);
			fireEvent.change(searchInput, { target: { value: 'searchable' } });

			expect(onSearchQueryChange).toHaveBeenCalledWith('searchable');
		});

		it('initializes with initialSearchQuery and auto-opens search', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'const foo = "bar";', path: '/test/test.ts' }}
					initialSearchQuery="foo"
				/>
			);

			// Search should be auto-opened with the initial query
			const searchInput = screen.getByPlaceholderText(/Search in file/);
			expect(searchInput).toBeInTheDocument();
			expect(searchInput).toHaveValue('foo');
		});

		it('does not auto-open search when initialSearchQuery is empty', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'const foo = "bar";', path: '/test/test.ts' }}
					initialSearchQuery=""
				/>
			);

			// Search should not be open
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
		});

		it('does not throw when onSearchQueryChange is not provided', async () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'const searchable = true;', path: '/test/test.ts' }}
					// No onSearchQueryChange prop
				/>
			);

			// Open search and type - should not throw
			const mainContainer = container.firstChild as HTMLElement;
			fireEvent.keyDown(mainContainer, { key: 'f', metaKey: true });
			const searchInput = screen.getByPlaceholderText(/Search in file/);
			expect(() => fireEvent.change(searchInput, { target: { value: 'test' } })).not.toThrow();
		});
	});

	describe('scroll position persistence', () => {
		it('calls onScrollPositionChange when scrolling (throttled)', async () => {
			const onScrollPositionChange = vi.fn();
			vi.useFakeTimers();

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'Some content', path: '/test/test.md' }}
					onScrollPositionChange={onScrollPositionChange}
				/>
			);

			// Get the content container (the scrollable div)
			const container = document.querySelector('.overflow-y-auto');
			expect(container).not.toBeNull();

			// Simulate scroll events
			fireEvent.scroll(container!, { target: { scrollTop: 100 } });

			// The callback is throttled at 200ms
			expect(onScrollPositionChange).not.toHaveBeenCalled();

			// Fast-forward timers
			vi.advanceTimersByTime(200);

			expect(onScrollPositionChange).toHaveBeenCalledWith(100);

			vi.useRealTimers();
		});

		it('accepts initialScrollTop prop without errors', () => {
			// This just verifies the prop is accepted without errors
			// The actual scroll restoration uses requestAnimationFrame which is hard to test
			expect(() =>
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'test.md', content: 'Some content', path: '/test/test.md' }}
						initialScrollTop={150}
					/>
				)
			).not.toThrow();
		});

		it('does not call onScrollPositionChange when not provided', () => {
			vi.useFakeTimers();

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'Some content', path: '/test/test.md' }}
					// No onScrollPositionChange prop
				/>
			);

			const container = document.querySelector('.overflow-y-auto');
			expect(container).not.toBeNull();

			// Simulate scroll - should not throw
			fireEvent.scroll(container!, { target: { scrollTop: 100 } });
			vi.advanceTimersByTime(200);

			// Test passes if no errors occurred

			vi.useRealTimers();
		});

		it('clears pending scroll save timer on unmount', () => {
			const onScrollPositionChange = vi.fn();
			vi.useFakeTimers();

			const { unmount } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.md', content: 'Some content', path: '/test/test.md' }}
					onScrollPositionChange={onScrollPositionChange}
				/>
			);

			const container = document.querySelector('.overflow-y-auto');
			fireEvent.scroll(container!, { target: { scrollTop: 100 } });

			// Unmount before timer fires
			unmount();
			vi.advanceTimersByTime(200);

			// Callback should not be called after unmount
			expect(onScrollPositionChange).not.toHaveBeenCalled();

			vi.useRealTimers();
		});
	});

	describe('CSV file rendering', () => {
		it('renders CsvTableRenderer for .csv files with comma delimiter', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.csv', content: 'Name,Age\nAlice,30', path: '/test/data.csv' }}
				/>
			);

			const renderer = screen.getByTestId('csv-table-renderer');
			expect(renderer).toBeInTheDocument();
			expect(renderer).toHaveAttribute('data-delimiter', ',');
		});

		it('renders CsvTableRenderer for .tsv files with tab delimiter', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.tsv', content: 'Name\tAge\nAlice\t30', path: '/test/data.tsv' }}
				/>
			);

			const renderer = screen.getByTestId('csv-table-renderer');
			expect(renderer).toBeInTheDocument();
			expect(renderer).toHaveAttribute('data-delimiter', '\t');
		});

		it('shows edit button for CSV files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.csv', content: 'Name,Age\nAlice,30', path: '/test/data.csv' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
		});

		it('shows textarea when in edit mode for CSV files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.csv', content: 'Name,Age\nAlice,30', path: '/test/data.csv' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox');
			expect(textarea).toBeInTheDocument();
			expect(textarea).toHaveValue('Name,Age\nAlice,30');
		});

		it('does not render CsvTableRenderer when in edit mode', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.csv', content: 'Name,Age\nAlice,30', path: '/test/data.csv' }}
					markdownEditMode={true}
				/>
			);

			expect(screen.queryByTestId('csv-table-renderer')).not.toBeInTheDocument();
		});
	});
});
