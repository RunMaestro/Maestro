import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { FilePreview } from '../../../renderer/components/FilePreview';
import { formatShortcutKeys } from '../../../renderer/utils/shortcutFormatter';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useImageAnnotatorStore } from '../../../renderer/components/ImageAnnotator/imageAnnotatorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';

import { mockTheme } from '../../helpers/mockTheme';

const clipboardMocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
	safeClipboardWriteImage: vi.fn(),
}));

const flashMocks = vi.hoisted(() => ({
	flashCopiedToClipboard: vi.fn(),
}));

const openUrlMocks = vi.hoisted(() => ({
	openUrl: vi.fn(),
}));

const markdownEditorHandle = vi.hoisted(() => ({
	focus: vi.fn(),
	scrollToLine: vi.fn(),
	getTopLine: vi.fn(() => 7),
	setScrollPercent: vi.fn(),
	setSearchMatches: vi.fn(),
}));

const markdownFastHandle = vi.hoisted(() => ({
	findInContent: vi.fn(() => []),
	scrollToMatch: vi.fn(),
	scrollToHeading: vi.fn(() => true),
}));

const textFastHandle = vi.hoisted(() => ({
	findInContent: vi.fn(() => []),
	scrollToMatch: vi.fn(),
	getTopLine: vi.fn(() => 3),
	scrollToLine: vi.fn(),
}));

const giantHandle = vi.hoisted(() => ({
	findInContent: vi.fn(() => []),
	scrollToMatch: vi.fn(),
	getTopLine: vi.fn(() => 4),
	scrollToLine: vi.fn(),
}));

vi.mock('../../../renderer/utils/clipboard', () => clipboardMocks);
vi.mock('../../../renderer/utils/flashCopiedToClipboard', () => flashMocks);
vi.mock('../../../renderer/utils/openUrl', () => openUrlMocks);

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	FileCode: () => <span data-testid="file-code-icon">FileCode</span>,
	Eye: () => <span data-testid="eye-icon">Eye</span>,
	ChevronUp: () => <span data-testid="chevron-up">ChevronUp</span>,
	ChevronDown: () => <span data-testid="chevron-down">ChevronDown</span>,
	ChevronLeft: () => <span data-testid="chevron-left">ChevronLeft</span>,
	ChevronRight: () => <span data-testid="chevron-right">ChevronRight</span>,
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	Copy: () => <span data-testid="copy-icon">Copy</span>,
	FilePlus2: () => <span data-testid="file-plus-icon">FilePlus2</span>,
	FileWarning: () => <span data-testid="file-warning-icon">FileWarning</span>,
	Loader2: () => <span data-testid="loader-icon">Loader2</span>,
	Image: () => <span data-testid="image-icon">Image</span>,
	Globe: () => <span data-testid="globe-icon">Globe</span>,
	Wand2: () => <span data-testid="wand-icon">Wand2</span>,
	Save: () => <span data-testid="save-icon">Save</span>,
	Edit: () => <span data-testid="edit-icon">Edit</span>,
	AlertTriangle: () => <span data-testid="alert-icon">AlertTriangle</span>,
	Share2: () => <span data-testid="share-icon">Share2</span>,
	GitGraph: () => <span data-testid="gitgraph-icon">GitGraph</span>,
	List: () => <span data-testid="list-icon">List</span>,
	ExternalLink: () => <span data-testid="external-link-icon">ExternalLink</span>,
	RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
	X: () => <span data-testid="x-icon">X</span>,
	Filter: () => <span data-testid="filter-icon">Filter</span>,
	Table2: () => <span data-testid="table-icon">Table2</span>,
	ZoomIn: () => <span data-testid="zoom-in-icon">ZoomIn</span>,
	ZoomOut: () => <span data-testid="zoom-out-icon">ZoomOut</span>,
	Maximize2: () => <span data-testid="maximize-icon">Maximize2</span>,
	// Icons added by PreviewTierChip in Phase 2.
	Sparkles: () => <span data-testid="sparkles-icon">Sparkles</span>,
	Zap: () => <span data-testid="zap-icon">Zap</span>,
	Database: () => <span data-testid="database-icon">Database</span>,
	WrapText: () => <span data-testid="wraptext-icon">WrapText</span>,
	AppWindow: () => <span data-testid="appwindow-icon">AppWindow</span>,
	// Icons added by the search-kind toggle (text/regex/literal).
	Filter: () => <span data-testid="filter-icon">Filter</span>,
	Type: () => <span data-testid="type-icon">Type</span>,
	Regex: () => <span data-testid="regex-icon">Regex</span>,
	Hash: () => <span data-testid="hash-icon">Hash</span>,
}));

// Mock react-markdown
vi.mock('react-markdown', () => ({
	default: ({
		children,
		components,
	}: {
		children: string;
		components?: Record<string, React.ComponentType<any>>;
	}) => {
		const Anchor = components?.a;
		const Image = components?.img;
		const Details = components?.details;
		const Pre = components?.pre;
		const showCallbackHarness = String(children).includes('callback-harness');
		const showMermaidHarness = String(children).includes('mermaid-harness');
		const showSourceLineHarness = String(children).includes('source-line-harness');

		return (
			<div data-testid="markdown-content">
				{children}
				{showSourceLineHarness && <h1 data-source-line="4">Tagged heading</h1>}
				{showCallbackHarness && Anchor && (
					<>
						<Anchor href="docs/guide.md">Markdown relative link</Anchor>
						<Anchor href="https://runmaestro.ai">Markdown web link</Anchor>
						<Anchor href="mailto:support@runmaestro.ai">Markdown mail link</Anchor>
					</>
				)}
				{showCallbackHarness && Image && (
					<Image src="assets/logo.png" alt="tree asset" data-maestro-from-tree="true" />
				)}
				{showCallbackHarness && Details && (
					<Details open onToggle="ignored">
						Details content
					</Details>
				)}
				{showMermaidHarness && Pre && (
					<Pre>
						<code className="language-mermaid">graph TD; A--&gt;B;</code>
					</Pre>
				)}
			</div>
		);
	},
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
	vs: {},
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

vi.mock('../../../renderer/components/FilePreview/MarkdownImage', () => ({
	MarkdownImage: ({
		src,
		alt,
		isFromFileTree,
		projectRoot,
		markdownFilePath,
		sshRemoteId,
	}: any) => (
		<img
			data-testid="markdown-image"
			src={src}
			alt={alt}
			data-from-tree={String(isFromFileTree)}
			data-project-root={projectRoot ?? ''}
			data-markdown-file={markdownFilePath}
			data-remote-id={sshRemoteId ?? ''}
		/>
	),
}));

// Mock CsvTableRenderer
vi.mock('../../../renderer/components/CsvTableRenderer', () => ({
	CsvTableRenderer: ({
		content,
		searchQuery,
		delimiter,
	}: {
		content: string;
		searchQuery?: string;
		delimiter?: string;
	}) => (
		<div
			data-testid="csv-table-renderer"
			data-search={searchQuery ?? ''}
			data-delimiter={delimiter ?? ','}
		>
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
	formatShortcutKeys: vi.fn((keys: string[]) => {
		const keyMap: Record<string, string> = {
			Meta: 'Ctrl',
			Alt: 'Alt',
			Shift: 'Shift',
			Control: 'Ctrl',
		};
		return keys.map((k: string) => keyMap[k] || k.toUpperCase()).join('+');
	}),
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

// Mock MarkdownEditor. The real editor wraps CodeMirror, which jsdom can't
// satisfy `getByRole('textbox')` against. A bare `<textarea>` lets us keep
// the FilePreview wiring tests (controlled vs. internal editContent, onChange
// fan-out) without coupling to CodeMirror internals.
vi.mock('../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<
		unknown,
		{
			value: string;
			onChange: (v: string) => void;
			onLineNumberContextMenu?: (lineNumber: number, event: MouseEvent) => void;
			onKeyDown?: (event: KeyboardEvent) => void;
		}
	>(({ value, onChange, onLineNumberContextMenu, onKeyDown }, ref) => {
		React.useImperativeHandle(ref, () => markdownEditorHandle);
		return (
			<div>
				<button
					type="button"
					onContextMenu={(e) => {
						e.preventDefault();
						onLineNumberContextMenu?.(2, e.nativeEvent);
					}}
				>
					Line 2
				</button>
				<textarea
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => onKeyDown?.(e.nativeEvent)}
				/>
			</div>
		);
	}),
}));

vi.mock('../../../renderer/components/FilePreview/markdownFast', () => ({
	default: React.forwardRef(
		(
			{
				content,
				markdownContainerRef,
				onExternalLinkClick,
			}: {
				content: string;
				markdownContainerRef?: React.RefObject<HTMLDivElement | null>;
				onExternalLinkClick?: (href: string, opts?: unknown) => void;
			},
			ref
		) => {
			React.useImperativeHandle(ref, () => markdownFastHandle);
			return (
				<div ref={markdownContainerRef} data-testid="markdown-fast-preview">
					{content}
					<button type="button" onClick={() => onExternalLinkClick?.('file:///tmp/readme.md')}>
						Fast file link
					</button>
					<button type="button" onClick={() => onExternalLinkClick?.('https://runmaestro.ai')}>
						Fast web link
					</button>
				</div>
			);
		}
	),
}));

vi.mock('../../../renderer/components/FilePreview/textFast', () => ({
	default: React.forwardRef(
		(
			{
				content,
				containerRef,
			}: { content: string; containerRef?: React.RefObject<HTMLDivElement | null> },
			ref
		) => {
			React.useImperativeHandle(ref, () => textFastHandle);
			return (
				<div ref={containerRef} data-testid="text-fast-preview">
					{content}
				</div>
			);
		}
	),
}));

vi.mock('../../../renderer/components/FilePreview/giantPreview', () => ({
	default: React.forwardRef(
		(
			{
				content,
				containerRef,
			}: { content: string; containerRef?: React.RefObject<HTMLDivElement | null> },
			ref
		) => {
			React.useImperativeHandle(ref, () => giantHandle);
			return (
				<div ref={containerRef} data-testid="giant-preview">
					{content}
				</div>
			);
		}
	),
}));

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
		useSettingsStore.setState({ bionifyReadingMode: false });
		// Reset useClickOutside call counter so each test starts fresh
		useClickOutsideCallCount = 0;
		mockContainerClickOutside.callback = null;
		mockContainerClickOutside.enabled = false;
		mockTocClickOutside.callback = null;
		mockTocClickOutside.enabled = false;
		clipboardMocks.safeClipboardWrite.mockResolvedValue(true);
		clipboardMocks.safeClipboardWriteImage.mockResolvedValue(true);
		markdownEditorHandle.focus.mockClear();
		markdownEditorHandle.scrollToLine.mockClear();
		markdownEditorHandle.getTopLine.mockClear();
		markdownEditorHandle.setScrollPercent.mockClear();
		markdownEditorHandle.setSearchMatches.mockClear();
		markdownFastHandle.findInContent.mockClear();
		markdownFastHandle.scrollToMatch.mockClear();
		markdownFastHandle.scrollToHeading.mockClear();
		textFastHandle.findInContent.mockClear();
		textFastHandle.scrollToMatch.mockClear();
		textFastHandle.getTopLine.mockClear();
		textFastHandle.scrollToLine.mockClear();
		giantHandle.findInContent.mockClear();
		giantHandle.scrollToMatch.mockClear();
		giantHandle.getTopLine.mockClear();
		giantHandle.scrollToLine.mockClear();
		useSessionStore.setState({ activeSessionId: '' });
	});

	// Reset settings store after every test so mid-test `setState({ bionifyReadingMode: true })`
	// calls can't leak into sibling tests (including other suites) when a test throws mid-flight.
	afterEach(() => {
		useSettingsStore.setState({ bionifyReadingMode: false });
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

			const graphIcon = screen.getByTestId('gitgraph-icon');
			expect(graphIcon).toBeInTheDocument();
			expect(graphIcon.closest('button')).toBeInTheDocument();
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

			const graphButton = screen.getByTestId('gitgraph-icon').closest('button')!;
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

			expect(screen.queryByTestId('gitgraph-icon')).not.toBeInTheDocument();
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

			expect(screen.queryByTestId('gitgraph-icon')).not.toBeInTheDocument();
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

			expect(screen.getByTestId('gitgraph-icon')).toBeInTheDocument();
		});
	});

	describe('Open in Default App button', () => {
		it('shows Open in Default App button with ExternalLink icon', () => {
			render(<FilePreview {...defaultProps} />);

			const icon = screen.getByTestId('external-link-icon');
			expect(icon).toBeInTheDocument();
			expect(icon.closest('button')).toBeInTheDocument();
		});

		it('calls shell.openPath with file path when clicked', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'readme.md', content: '# Readme', path: '/test/readme.md' }}
				/>
			);

			const button = screen.getByTestId('external-link-icon').closest('button')!;
			fireEvent.click(button);

			expect(window.maestro?.shell?.openPath).toHaveBeenCalledWith('/test/readme.md');
		});

		it('hides Open in Default App button for SSH remote sessions', () => {
			render(<FilePreview {...defaultProps} sshRemoteId="remote-host-1" />);

			expect(screen.queryByTestId('external-link-icon')).not.toBeInTheDocument();
		});
	});

	describe('Mermaid (.mmd) preview', () => {
		const mermaidFile = {
			name: 'diagram.mmd',
			content: 'flowchart TB\n  A[Start] --> B[End]',
			path: '/test/diagram.mmd',
		};

		it('renders .mmd files as a diagram instead of raw text', () => {
			render(<FilePreview {...defaultProps} file={mermaidFile} />);

			expect(screen.getByTestId('mermaid-renderer')).toBeInTheDocument();
			expect(screen.queryByTestId('syntax-highlighter')).not.toBeInTheDocument();
		});

		it('also renders the uppercase .MERMAID extension as a diagram', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ ...mermaidFile, name: 'diagram.MERMAID', path: '/test/diagram.MERMAID' }}
				/>
			);

			expect(screen.getByTestId('mermaid-renderer')).toBeInTheDocument();
		});

		it('shows the raw source instead of the diagram in edit mode', () => {
			render(<FilePreview {...defaultProps} file={mermaidFile} markdownEditMode={true} />);

			expect(screen.queryByTestId('mermaid-renderer')).not.toBeInTheDocument();
		});
	});

	describe('readable text preview', () => {
		it('applies Bionify spans to .txt previews when reading mode is enabled', () => {
			useSettingsStore.setState({ bionifyReadingMode: true });

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'notes.txt',
						content: 'Readable text preview content',
						path: '/test/notes.txt',
					}}
				/>
			);

			expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
			expect(container.textContent).toContain('Readable text preview content');
			expect(screen.queryByTestId('syntax-highlighter')).not.toBeInTheDocument();
		});

		it('keeps readable .txt previews plain when reading mode is disabled', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'notes.txt',
						content: 'Readable text preview content',
						path: '/test/notes.txt',
					}}
				/>
			);

			expect(screen.getByText('Readable text preview content')).toBeInTheDocument();
			expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
		});

		it('disables Bionify spans while search is active so readable text remains searchable', async () => {
			useSettingsStore.setState({ bionifyReadingMode: true });

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'notes.txt',
						content: 'reading mode keeps reading searchable',
						path: '/test/notes.txt',
					}}
					initialSearchQuery="reading"
				/>
			);

			await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
			expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
		});

		it('shows the truncation banner for large readable text previews and can load the full file', () => {
			// Multi-line content sized to trigger the legacy 100KB truncation banner
			// (Rich tier) without crossing the long-line threshold that would
			// escalate to Giant tier.
			const largeContent = 'Readable paragraph with plenty of words for truncation.\n'.repeat(4000);

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'large.txt', content: largeContent, path: '/test/large.txt' }}
				/>
			);

			expect(screen.getByText(/Large file preview truncated/)).toBeInTheDocument();
			expect(screen.queryByTestId('syntax-highlighter')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('Load full file'));

			expect(screen.queryByText(/Large file preview truncated/)).not.toBeInTheDocument();
		});

		it('does not render a per-preview Bionify toggle button (Bionify is controlled globally)', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'notes.txt',
						content: 'Readable text preview content',
						path: '/test/notes.txt',
					}}
				/>
			);

			expect(screen.queryByTitle('Enable Bionify for this preview')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Disable Bionify for this preview')).not.toBeInTheDocument();
		});

		it('routes .mdx files through markdown preview instead of readable text preview', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'notes.mdx',
						content: '# MDX heading',
						path: '/test/notes.mdx',
					}}
				/>
			);

			expect(screen.getByTestId('markdown-content')).toBeInTheDocument();
			expect(screen.queryByTestId('syntax-highlighter')).not.toBeInTheDocument();
		});

		it('does not treat files with code extensions as readable-text basenames', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'README.ts',
						content: 'const value = true;',
						path: '/test/README.ts',
					}}
				/>
			);

			expect(screen.getByTestId('syntax-highlighter')).toBeInTheDocument();
		});

		it('does not treat other basename-style code files as readable text', () => {
			const files = [
				{ name: 'LICENSE.py', content: 'print("license")', path: '/test/LICENSE.py' },
				{ name: 'TODO.js', content: 'console.log("todo")', path: '/test/TODO.js' },
			];

			for (const file of files) {
				const { unmount } = render(<FilePreview {...defaultProps} file={file} />);
				expect(screen.getByTestId('syntax-highlighter')).toBeInTheDocument();
				unmount();
			}
		});
	});

	describe('markdown callback wiring', () => {
		it('routes rendered markdown links, images, and details through FilePreview callbacks', () => {
			const onFileClick = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'doc.md',
						content: 'callback-harness',
						path: '/Users/jeff/project/docs/doc.md',
					}}
					cwd="project"
					onFileClick={onFileClick}
				/>
			);

			fireEvent.click(screen.getByText('Markdown relative link'));
			fireEvent.click(screen.getByText('Markdown web link'));
			fireEvent.click(screen.getByText('Markdown mail link'));

			expect(onFileClick).toHaveBeenCalledWith('docs/guide.md', { openInNewTab: false });
			expect(openUrlMocks.openUrl.mock.calls.map(([href]) => href)).toEqual(
				expect.arrayContaining(['https://runmaestro.ai', 'mailto:support@runmaestro.ai'])
			);
			expect(screen.getByTestId('markdown-image')).toHaveAttribute('data-from-tree', 'true');
			expect(screen.getByTestId('markdown-image')).toHaveAttribute(
				'data-project-root',
				'/Users/jeff'
			);
			expect(screen.getByText('Details content').closest('details')).not.toHaveAttribute(
				'onToggle'
			);
		});

		it('renders Mermaid code blocks through the markdown language renderer', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.md',
						content: 'mermaid-harness',
						path: '/test/diagram.md',
					}}
				/>
			);

			expect(screen.getByTestId('mermaid-renderer')).toBeInTheDocument();
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

			render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={onReloadFile} />);

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

		it('ignores stat responses without modifiedAt while polling for file changes', async () => {
			vi.useFakeTimers();
			const mockStat = vi.fn().mockResolvedValue({
				size: 100,
				isFile: true,
				isDirectory: false,
			});
			window.maestro.fs.stat = mockStat;

			render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={vi.fn()} />);

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(mockStat).toHaveBeenCalled();
			expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();
			expect(
				screen.queryByText(/no longer exists at its original location/)
			).not.toBeInTheDocument();

			vi.useRealTimers();
		});

		it('clears file stats when the initial stat response is null', async () => {
			const mockStat = vi.fn().mockResolvedValue(null);
			window.maestro.fs.stat = mockStat;

			render(<FilePreview {...defaultProps} />);

			await waitFor(() => expect(mockStat).toHaveBeenCalledWith('/test/test.md', undefined));
			expect(screen.queryByText('100 B')).not.toBeInTheDocument();
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

			render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={onReloadFile} />);

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

			render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={vi.fn()} />);

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

			expect(screen.getByText(/File changed on disk\. You have unsaved edits/)).toBeInTheDocument();

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

			render(<FilePreview {...defaultProps} onReloadFile={vi.fn()} />);

			// Allow the initial file stats fetch to complete
			await act(async () => {
				await Promise.resolve();
			});

			const callsAfterMount = mockStat.mock.calls.length;

			// Advance timers past multiple poll intervals - no additional calls should happen
			await act(async () => {
				vi.advanceTimersByTime(6000);
			});

			expect(mockStat).toHaveBeenCalledTimes(callsAfterMount);

			vi.useRealTimers();
		});

		it('shows the missing-on-disk banner when polling stat throws (file gone)', async () => {
			vi.useFakeTimers();

			// stat rejects: the file no longer resolves at its cached path.
			window.maestro.fs.stat = vi.fn().mockRejectedValue(new Error('ENOENT'));

			render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={vi.fn()} />);

			expect(
				screen.queryByText(/no longer exists at its original location/)
			).not.toBeInTheDocument();

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText(/no longer exists at its original location/)).toBeInTheDocument();
			// There is nothing to reload, so no Reload button is offered.
			expect(screen.queryByText('Reload')).not.toBeInTheDocument();

			vi.useRealTimers();
		});

		it('dismisses the missing-on-disk banner when Dismiss is clicked', async () => {
			vi.useFakeTimers();

			window.maestro.fs.stat = vi.fn().mockRejectedValue(new Error('ENOENT'));

			render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={vi.fn()} />);

			await act(async () => {
				vi.advanceTimersByTime(3000);
			});

			expect(screen.getByText(/no longer exists at its original location/)).toBeInTheDocument();

			fireEvent.click(screen.getByText('Dismiss'));

			expect(
				screen.queryByText(/no longer exists at its original location/)
			).not.toBeInTheDocument();

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

		it('does not show the text edit toggle for image files', () => {
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

			// Images can be opened in the annotator ("Edit image"), but never get
			// the text/markdown edit-mode toggle.
			expect(screen.queryByTestId('edit-text-toggle')).not.toBeInTheDocument();
		});

		it('opens the image annotator on the toggleMarkdownMode shortcut (Cmd+E)', () => {
			const openAnnotator = vi.fn();
			useImageAnnotatorStore.setState({ openAnnotator });

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);

			const previewContainer = container.querySelector('[tabindex="0"]');
			expect(previewContainer).not.toBeNull();

			fireEvent.keyDown(previewContainer!, { key: 'e', metaKey: true });

			expect(openAnnotator).toHaveBeenCalledWith('data:image/png;base64,abc', expect.any(Function));
		});

		it('overwrites a PNG image edit and refreshes the preview', async () => {
			const editedDataUrl = 'data:image/png;base64,edited';
			const onReloadFile = vi.fn();
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) => {
				onSave(editedDataUrl);
			});
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });
			window.maestro.fs.stat = vi.fn().mockResolvedValue({
				size: 2048,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-02-01T00:00:00.000Z',
			});

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
					onReloadFile={onReloadFile}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, { key: 'e', metaKey: true });

			expect(await screen.findByText('Save edited image')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Overwrite the existing file/i }));

			await waitFor(() => {
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/image.png',
					editedDataUrl,
					undefined
				);
			});
			expect(onReloadFile).toHaveBeenCalledTimes(1);
		});

		it('writes a sibling PNG when overwriting an edited JPG image', async () => {
			const editedDataUrl = 'data:image/png;base64,edited';
			const onReloadFile = vi.fn();
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) => {
				onSave(editedDataUrl);
			});
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'photo.jpg',
						content: 'data:image/jpeg;base64,abc',
						path: '/test/photo.jpg',
					}}
					onReloadFile={onReloadFile}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, { key: 'e', metaKey: true });

			expect(await screen.findByText(/will create photo\.png instead/i)).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Overwrite the existing file/i }));

			await waitFor(() => {
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/photo.png',
					editedDataUrl,
					undefined
				);
			});
			expect(onReloadFile).not.toHaveBeenCalled();
		});

		it('normalizes JPEG annotator output so .jpeg files can be overwritten', async () => {
			const editedDataUrl = 'data:image/jpeg;base64,edited';
			const onReloadFile = vi.fn();
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) => {
				onSave(editedDataUrl);
			});
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'photo.jpeg',
						content: 'data:image/jpeg;base64,abc',
						path: '/test/photo.jpeg',
					}}
					onReloadFile={onReloadFile}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, { key: 'e', metaKey: true });

			expect(await screen.findByText('Save edited image')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Overwrite the existing file/i }));

			await waitFor(() => {
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/photo.jpeg',
					editedDataUrl,
					undefined
				);
			});
			expect(onReloadFile).toHaveBeenCalledTimes(1);
		});

		it('uses an SVG fallback sibling when annotator output is SVG data', async () => {
			const editedDataUrl = 'data:image/svg+xml;base64,edited';
			const onReloadFile = vi.fn();
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) => {
				onSave(editedDataUrl);
			});
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,abc',
						path: '/test/diagram.png',
					}}
					onReloadFile={onReloadFile}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, { key: 'e', metaKey: true });

			expect(await screen.findByText(/will create diagram\.svg instead/i)).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Overwrite the existing file/i }));

			await waitFor(() => {
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/diagram.svg',
					editedDataUrl,
					undefined
				);
			});
			expect(onReloadFile).not.toHaveBeenCalled();
		});

		it('saves an edited image to a custom sibling file', async () => {
			const editedDataUrl = 'data:image/png;base64,edited';
			const onReloadFile = vi.fn();
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) => {
				onSave(editedDataUrl);
			});
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });

			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
					onReloadFile={onReloadFile}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, { key: 'e', metaKey: true });

			expect(await screen.findByText('Save edited image')).toBeInTheDocument();
			fireEvent.click(screen.getByRole('button', { name: /Save to a new file/i }));
			fireEvent.change(screen.getByLabelText('File name'), {
				target: { value: 'custom-edited.png' },
			});
			fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

			await waitFor(() => {
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/custom-edited.png',
					editedDataUrl,
					undefined
				);
			});
			expect(onReloadFile).not.toHaveBeenCalled();
		});

		it('copies the file path with the configured shortcut', async () => {
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					onShortcutUsed={onShortcutUsed}
					shortcuts={{
						copyFilePath: {
							id: 'copyFilePath',
							label: 'Copy File Path',
							keys: ['Ctrl', 'Alt', 'Shift', 'p'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, {
				key: 'p',
				ctrlKey: true,
				altKey: true,
				shiftKey: true,
			});

			await waitFor(() => {
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('/test/test.md');
			});
			expect(flashMocks.flashCopiedToClipboard).toHaveBeenCalledWith(
				'/test/test.md',
				'File Path Copied'
			);
			expect(onShortcutUsed).toHaveBeenCalledWith('copyFilePath');
		});

		it('copies image content with Cmd+C while previewing an image', async () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
				/>
			);

			fireEvent.keyDown(container.querySelector('[tabindex="0"]')!, { key: 'c', metaKey: true });

			await waitFor(() => {
				expect(clipboardMocks.safeClipboardWriteImage).toHaveBeenCalledWith(
					'data:image/png;base64,abc'
				);
			});
			expect(flashMocks.flashCopiedToClipboard).toHaveBeenCalledWith(undefined, 'Image Copied');
		});

		it('copies text content from the header action', async () => {
			render(<FilePreview {...defaultProps} />);

			fireEvent.click(screen.getByTestId('clipboard-icon').closest('button')!);

			await waitFor(() => {
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('# Hello World');
			});
			expect(flashMocks.flashCopiedToClipboard).toHaveBeenCalledWith(undefined, 'Content Copied');
		});

		it('routes graph, fuzzy search, and history shortcuts', () => {
			const onOpenInGraph = vi.fn();
			const onOpenFuzzySearch = vi.fn();
			const onNavigateBack = vi.fn();
			const onNavigateForward = vi.fn();
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'notes.md',
						content: '# Heading\n\nBody',
						path: '/test/notes.md',
					}}
					onOpenInGraph={onOpenInGraph}
					onOpenFuzzySearch={onOpenFuzzySearch}
					onNavigateBack={onNavigateBack}
					onNavigateForward={onNavigateForward}
					canGoBack
					canGoForward
					onShortcutUsed={onShortcutUsed}
					shortcuts={{
						fuzzyFileSearch: {
							id: 'fuzzyFileSearch',
							label: 'Fuzzy File Search',
							keys: ['Meta', 'g'],
						},
					}}
				/>
			);
			const preview = container.querySelector('[tabindex="0"]')!;

			fireEvent.keyDown(preview, { key: 'g', metaKey: true, shiftKey: true });
			fireEvent.keyDown(preview, { key: 'g', metaKey: true });
			fireEvent.keyDown(preview, { key: 'ArrowLeft', metaKey: true });
			fireEvent.keyDown(preview, { key: 'ArrowRight', metaKey: true });

			expect(onOpenInGraph).toHaveBeenCalledTimes(1);
			expect(onOpenFuzzySearch).toHaveBeenCalledTimes(1);
			expect(onNavigateBack).toHaveBeenCalledTimes(1);
			expect(onNavigateForward).toHaveBeenCalledTimes(1);
			expect(onShortcutUsed).toHaveBeenCalledWith('filePreviewBack');
			expect(onShortcutUsed).toHaveBeenCalledWith('filePreviewForward');
		});

		it('copies a scoped deep link from the editor line menu', async () => {
			useSessionStore.setState({ activeSessionId: 'session-1' });
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'test.md',
						content: 'first\nsecond',
						path: '/test/test.md',
					}}
					markdownEditMode
				/>
			);

			fireEvent.contextMenu(screen.getByRole('button', { name: 'Line 2' }), {
				clientX: 11,
				clientY: 22,
			});
			fireEvent.click(await screen.findByRole('button', { name: 'Copy deep link to line 2' }));

			await waitFor(() => {
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith(
					'maestro://file/session-1/%2Ftest%2Ftest.md#L2'
				);
			});
			expect(flashMocks.flashCopiedToClipboard).toHaveBeenCalledWith(
				'maestro://file/session-1/%2Ftest%2Ftest.md#L2',
				'Deep Link Copied (L2)'
			);
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

		it('handles editor-local save, Escape, and toggle shortcuts', async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const setMarkdownEditMode = vi.fn();
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: '{"key": "value"}', path: '/test/config.json' }}
					markdownEditMode
					onSave={onSave}
					setMarkdownEditMode={setMarkdownEditMode}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);
			const textarea = screen.getByRole('textbox');

			fireEvent.change(textarea, { target: { value: '{"key": "changed"}' } });
			fireEvent.keyDown(textarea, { key: 's', metaKey: true });
			await waitFor(() =>
				expect(onSave).toHaveBeenCalledWith('/test/config.json', '{"key": "changed"}')
			);

			fireEvent.keyDown(textarea, { key: 'Escape' });
			expect(setMarkdownEditMode).toHaveBeenCalledWith(false);

			rerender(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: '{"key": "value"}', path: '/test/config.json' }}
					markdownEditMode
					setMarkdownEditMode={setMarkdownEditMode}
					shortcuts={{
						toggleMarkdownMode: {
							id: 'toggleMarkdownMode',
							label: 'Toggle Edit/Preview',
							keys: ['Meta', 'e'],
						},
					}}
				/>
			);
			fireEvent.keyDown(screen.getByRole('textbox'), { key: 'e', metaKey: true });
			expect(setMarkdownEditMode).toHaveBeenCalledWith(false);
		});
	});

	// `edit mode keyboard navigation` tests were removed when FilePreview's edit
	// surface was swapped from a raw <textarea> to CodeMirror. Cmd+Up/Down and
	// Cmd+Shift+Up/Down are now provided by CodeMirror's `defaultKeymap`
	// (cursorDocStart / cursorDocEnd / selectDocStart / selectDocEnd) - there's
	// no FilePreview-level handler to test, so the old tests would have only
	// exercised our mock.

	describe('basic rendering', () => {
		it('renders file preview with file name', () => {
			render(<FilePreview {...defaultProps} />);

			expect(screen.getByText('test.md')).toBeInTheDocument();
		});

		it('shows markdown task counts when checklist items exist', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'tasks.md',
						content: '- [ ] Open item\n- [x] Done item',
						path: '/test/tasks.md',
					}}
				/>
			);

			expect(screen.getByText('Tasks:')).toBeInTheDocument();
			expect(screen.getByText('of 2')).toBeInTheDocument();
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
			// Multi-line content to trigger the legacy Rich-tier truncation
			// banner without escalating to Giant via the long-line signal.
			const largeContent = ('x'.repeat(99) + '\n').repeat(1536); // ~150KB / ~1.5k lines
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'large.json', content: largeContent, path: '/test/large.json' }}
				/>
			);

			expect(screen.getByText(/Large file preview truncated/)).toBeInTheDocument();
			expect(screen.getByText('Load full file')).toBeInTheDocument();
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
			// Multi-line, no single line above the 10k long-line threshold.
			const largeContent = ('y'.repeat(99) + '\n').repeat(2048); // ~200KB / ~2k lines
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

		it('loads full file content when "Load full file" button is clicked', () => {
			// Multi-line, no single line above the 10k long-line threshold.
			const largeContent = ('y'.repeat(99) + '\n').repeat(2048); // ~200KB / ~2k lines
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'large.ts', content: largeContent, path: '/test/large.ts' }}
				/>
			);

			// Initially truncated
			expect(screen.getByTestId('syntax-highlighter').textContent?.length).toBe(100 * 1024);

			// Click load full file button
			fireEvent.click(screen.getByText('Load full file'));

			// Banner should disappear and full content should be shown
			expect(screen.queryByText(/Large file preview truncated/)).not.toBeInTheDocument();
			expect(screen.getByTestId('syntax-highlighter').textContent?.length).toBe(200 * 1024);
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

		it('clears token count when token counting fails', async () => {
			const { getEncoder } = await import('../../../renderer/utils/tokenCounter');
			const mockedGetEncoder = vi.mocked(getEncoder);
			mockedGetEncoder.mockClear();
			mockedGetEncoder.mockRejectedValueOnce(new Error('encoder unavailable'));

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'countable words', path: '/test/notes.txt' }}
				/>
			);

			await waitFor(() => expect(mockedGetEncoder).toHaveBeenCalledOnce());
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

		it('toggles TOC overlay with the toggleFilePreviewToc shortcut and reports usage', () => {
			const onShortcutUsed = vi.fn();
			const markdownWithHeadings = '# Heading 1\n## Heading 2\n### Heading 3';
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithHeadings, path: '/test/doc.md' }}
					markdownEditMode={false}
					isTabMode={true}
					shortcuts={{
						toggleFilePreviewToc: {
							id: 'toggleFilePreviewToc',
							label: 'Toggle Table of Contents (Markdown Preview)',
							keys: ['Meta', '\\'],
						},
					}}
					onShortcutUsed={onShortcutUsed}
				/>
			);

			const previewContainer = container.querySelector('[tabindex="0"]');
			expect(previewContainer).not.toBeNull();

			// First firing opens the overlay and reports usage
			fireEvent.keyDown(previewContainer!, { key: '\\', metaKey: true });
			expect(screen.getByText('Contents')).toBeInTheDocument();
			expect(onShortcutUsed).toHaveBeenCalledWith('toggleFilePreviewToc');

			// Second firing closes it
			fireEvent.keyDown(previewContainer!, { key: '\\', metaKey: true });
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
			expect(onShortcutUsed).toHaveBeenCalledTimes(2);
		});

		it('ignores toggleFilePreviewToc shortcut in edit mode (no TOC available)', () => {
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: '# Heading 1', path: '/test/doc.md' }}
					markdownEditMode={true}
					isTabMode={true}
					shortcuts={{
						toggleFilePreviewToc: {
							id: 'toggleFilePreviewToc',
							label: 'Toggle Table of Contents (Markdown Preview)',
							keys: ['Meta', '\\'],
						},
					}}
					onShortcutUsed={onShortcutUsed}
				/>
			);

			const previewContainer = container.querySelector('[tabindex="0"]');
			expect(previewContainer).not.toBeNull();

			fireEvent.keyDown(previewContainer!, { key: '\\', metaKey: true });
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
			expect(onShortcutUsed).not.toHaveBeenCalled();
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

	describe('HTML render mode', () => {
		const htmlFile = {
			name: 'page.html',
			content: '<!doctype html><body><h1>hello</h1></body>',
			path: '/test/page.html',
		};

		it('shows the HTML render toggle for .html files', () => {
			render(<FilePreview {...defaultProps} file={htmlFile} />);
			expect(screen.getByTestId('html-render-toggle')).toBeInTheDocument();
		});

		it('shows the HTML render toggle for .htm files', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ ...htmlFile, name: 'legacy.htm', path: '/test/legacy.htm' }}
				/>
			);
			expect(screen.getByTestId('html-render-toggle')).toBeInTheDocument();
		});

		it('does not show the HTML render toggle for non-HTML files', () => {
			render(<FilePreview {...defaultProps} />);
			expect(screen.queryByTestId('html-render-toggle')).not.toBeInTheDocument();
		});

		it('does not show the HTML render toggle while in edit mode', () => {
			render(<FilePreview {...defaultProps} file={htmlFile} markdownEditMode={true} />);
			expect(screen.queryByTestId('html-render-toggle')).not.toBeInTheDocument();
		});

		it('does not render the iframe when htmlRenderMode is false', () => {
			render(<FilePreview {...defaultProps} file={htmlFile} htmlRenderMode={false} />);
			expect(screen.queryByTestId('html-render-iframe')).not.toBeInTheDocument();
		});

		it('renders a sandboxed iframe when htmlRenderMode is true', () => {
			render(<FilePreview {...defaultProps} file={htmlFile} htmlRenderMode={true} />);
			const iframe = screen.getByTestId('html-render-iframe') as HTMLIFrameElement;
			expect(iframe).toBeInTheDocument();
			// Security-critical: scripts may run but the iframe must not be
			// same-origin (no `allow-same-origin`), so the rendered page can't
			// reach the host renderer.
			const sandbox = iframe.getAttribute('sandbox') ?? '';
			expect(sandbox).toContain('allow-scripts');
			expect(sandbox).not.toContain('allow-same-origin');
			expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
			expect(iframe.getAttribute('srcdoc')).toBe(htmlFile.content);
		});

		it('does not render the iframe while in edit mode even if htmlRenderMode is true', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={htmlFile}
					htmlRenderMode={true}
					markdownEditMode={true}
				/>
			);
			expect(screen.queryByTestId('html-render-iframe')).not.toBeInTheDocument();
		});

		it('calls onHtmlRenderModeChange when the toggle is clicked', () => {
			const onHtmlRenderModeChange = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={htmlFile}
					htmlRenderMode={false}
					onHtmlRenderModeChange={onHtmlRenderModeChange}
				/>
			);
			fireEvent.click(screen.getByTestId('html-render-toggle'));
			expect(onHtmlRenderModeChange).toHaveBeenCalledWith(true);
		});
	});

	describe('imperative navigation and preview tiers', () => {
		it('exposes a focus handle for parent tab activation', () => {
			const previewRef = React.createRef<{ focus: () => void }>();
			render(<FilePreview {...defaultProps} ref={previewRef} />);

			act(() => {
				previewRef.current?.focus();
			});

			expect(previewRef.current).toBeTruthy();
		});

		it('enters edit mode for pending line links and scrolls the mounted editor', async () => {
			const setMarkdownEditMode = vi.fn();
			const onPendingScrollToLineConsumed = vi.fn();
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					pendingScrollToLine={9}
					setMarkdownEditMode={setMarkdownEditMode}
				/>
			);

			expect(setMarkdownEditMode).toHaveBeenCalledWith(true);

			rerender(
				<FilePreview
					{...defaultProps}
					pendingScrollToLine={9}
					markdownEditMode={true}
					setMarkdownEditMode={setMarkdownEditMode}
					onPendingScrollToLineConsumed={onPendingScrollToLineConsumed}
				/>
			);

			await waitFor(() => {
				expect(markdownEditorHandle.focus).toHaveBeenCalled();
				expect(markdownEditorHandle.scrollToLine).toHaveBeenCalledWith(9);
				expect(onPendingScrollToLineConsumed).toHaveBeenCalled();
			});
		});

		it('leaves pending line links unconsumed when edit mode has no editor surface', async () => {
			const setMarkdownEditMode = vi.fn();
			const onPendingScrollToLineConsumed = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
					pendingScrollToLine={9}
					markdownEditMode
					setMarkdownEditMode={setMarkdownEditMode}
					onPendingScrollToLineConsumed={onPendingScrollToLineConsumed}
				/>
			);

			await act(async () => {
				await Promise.resolve();
			});

			expect(setMarkdownEditMode).not.toHaveBeenCalled();
			expect(onPendingScrollToLineConsumed).not.toHaveBeenCalled();
		});

		it('renders the fast markdown preview tier and routes TOC heading selection to it', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'doc.md',
						content: '# Heading 1\n## Heading 2\nContent',
						path: '/test/doc.md',
					}}
					previewTierOverride="fast"
				/>
			);

			expect(await screen.findByTestId('markdown-fast-preview')).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Table of Contents'));
			fireEvent.click(screen.getByText('Heading 2'));

			expect(markdownFastHandle.scrollToHeading).toHaveBeenCalled();
		});

		it('routes fast markdown external links through shell and URL handlers', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: '# Link harness', path: '/test/doc.md' }}
					previewTierOverride="fast"
				/>
			);

			fireEvent.click(await screen.findByText('Fast file link'));
			fireEvent.click(screen.getByText('Fast web link'));

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/tmp/readme.md');
			expect(openUrlMocks.openUrl).toHaveBeenCalledWith('https://runmaestro.ai', undefined);
		});

		it('renders fast text, fast code, and giant preview overrides', async () => {
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
					previewTierOverride="fast"
				/>
			);
			expect(await screen.findByTestId('text-fast-preview')).toHaveTextContent(
				'plain text content'
			);

			rerender(
				<FilePreview
					{...defaultProps}
					file={{ name: 'source.ts', content: 'const value = 1;', path: '/test/source.ts' }}
					previewTierOverride="fast"
				/>
			);
			expect(await screen.findByTestId('text-fast-preview')).toHaveTextContent('const value = 1;');

			rerender(
				<FilePreview
					{...defaultProps}
					file={{ name: 'source.ts', content: 'const value = 2;', path: '/test/source.ts' }}
					previewTierOverride="giant"
				/>
			);
			expect(await screen.findByTestId('giant-preview')).toHaveTextContent('const value = 2;');
		});

		it('routes search through the fast markdown adapter and navigates matches', async () => {
			const hits = [
				{ sourceOffset: 0, length: 6, blockIndex: 0, offsetWithinBlock: 0 },
				{ sourceOffset: 12, length: 6, blockIndex: 1, offsetWithinBlock: 2 },
			];
			markdownFastHandle.findInContent.mockReturnValue(hits);
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: '# needle\n\nneedle again', path: '/test/doc.md' }}
					previewTierOverride="fast"
				/>
			);

			fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'f', metaKey: true });
			const input = await screen.findByPlaceholderText(/Search in file/);
			fireEvent.change(input, {
				target: { value: 'needle' },
			});

			await waitFor(() => expect(markdownFastHandle.findInContent).toHaveBeenCalledWith('needle'));
			await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
			await waitFor(() => expect(markdownFastHandle.scrollToMatch).toHaveBeenCalledWith(hits[0]));

			fireEvent.click(screen.getByTitle('Next match (Enter)'));
			await waitFor(() => expect(markdownFastHandle.scrollToMatch).toHaveBeenCalledWith(hits[1]));

			fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
			await waitFor(() =>
				expect(markdownFastHandle.scrollToMatch).toHaveBeenLastCalledWith(hits[0])
			);

			fireEvent.keyDown(input, { key: 'Enter' });
			await waitFor(() =>
				expect(markdownFastHandle.scrollToMatch).toHaveBeenLastCalledWith(hits[1])
			);
		});

		it('routes search through fast text and giant adapters', async () => {
			const textHit = { sourceOffset: 0, length: 5, blockIndex: 0, offsetWithinBlock: 0 };
			const giantHit = { sourceOffset: 8, length: 5, blockIndex: 0, offsetWithinBlock: 8 };
			textFastHandle.findInContent.mockReturnValue([textHit]);
			giantHandle.findInContent.mockReturnValue([giantHit]);
			const { container, unmount } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain needle', path: '/test/notes.txt' }}
					previewTierOverride="fast"
				/>
			);

			fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'f', metaKey: true });
			fireEvent.change(await screen.findByPlaceholderText(/Search in file/), {
				target: { value: 'plain' },
			});

			await waitFor(() => expect(textFastHandle.findInContent).toHaveBeenCalledWith('plain'));
			await waitFor(() => expect(textFastHandle.scrollToMatch).toHaveBeenCalledWith(textHit));

			unmount();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'source.ts', content: 'const giant = true;', path: '/test/source.ts' }}
					previewTierOverride="giant"
					initialSearchQuery="giant"
				/>
			);

			await waitFor(() => expect(giantHandle.findInContent).toHaveBeenCalledWith('giant'));
			await waitFor(() => expect(giantHandle.scrollToMatch).toHaveBeenCalledWith(giantHit));
		});
	});

	describe('keyboard, search, and save edge cases', () => {
		it('opens jq mode search for JSON files and handles help, examples, clear, and Escape', async () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.json', content: '{"name":"Maestro"}', path: '/test/data.json' }}
				/>
			);
			const root = container.firstElementChild as HTMLElement;

			fireEvent.keyDown(root, { key: 'f', ctrlKey: true });
			const input = await screen.findByPlaceholderText(/Search in file/);
			fireEvent.click(screen.getByTitle('Switch to jq filter'));
			const jqInput = await screen.findByPlaceholderText(/jq filter/);

			fireEvent.focus(jqInput);
			expect(screen.getByText('jq Filter Syntax')).toBeInTheDocument();
			fireEvent.keyDown(jqInput, { key: 'Escape' });
			expect(screen.queryByText('jq Filter Syntax')).not.toBeInTheDocument();

			fireEvent.focus(jqInput);
			expect(screen.getByText('jq Filter Syntax')).toBeInTheDocument();
			fireEvent.mouseDown(document.body);
			expect(screen.queryByText('jq Filter Syntax')).not.toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Show syntax help'));
			expect(screen.getByText('jq Filter Syntax')).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Show syntax help'));
			expect(screen.queryByText('jq Filter Syntax')).not.toBeInTheDocument();

			fireEvent.focus(jqInput);
			expect(screen.getByText('jq Filter Syntax')).toBeInTheDocument();
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(screen.queryByText('jq Filter Syntax')).not.toBeInTheDocument();

			fireEvent.focus(jqInput);
			expect(screen.getByText('jq Filter Syntax')).toBeInTheDocument();
			fireEvent.click(screen.getByText('.fieldName').closest('button')!);
			expect(jqInput).toHaveValue('.fieldName');
			expect(screen.queryByText('jq Filter Syntax')).not.toBeInTheDocument();

			fireEvent.change(jqInput, { target: { value: '.name' } });
			fireEvent.click(screen.getByTitle('Clear filter'));
			expect(jqInput).toHaveValue('');

			fireEvent.keyDown(jqInput, { key: 'Escape' });
			expect(input).not.toBeInTheDocument();
		});

		it('closes rendered jq help from the search input Escape handler', async () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.json', content: '{"name":"Maestro"}', path: '/test/data.json' }}
				/>
			);

			fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'f', metaKey: true });
			fireEvent.click(await screen.findByTitle('Switch to jq filter'));

			const jqInput = await screen.findByPlaceholderText(/jq filter/);
			fireEvent.focus(jqInput);
			await waitFor(() => expect(screen.getByText('jq Filter Syntax')).toBeInTheDocument());

			fireEvent.keyDown(screen.getByPlaceholderText(/jq filter/), { key: 'Escape' });
			await waitFor(() => expect(screen.queryByText('jq Filter Syntax')).not.toBeInTheDocument());
		});

		it('handles rejected clipboard writes for path, content, and image copy actions', async () => {
			const { container, rerender } = render(<FilePreview {...defaultProps} />);

			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);
			fireEvent.click(screen.getByTestId('copy-icon').closest('button')!);
			await waitFor(() =>
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenLastCalledWith('/test/test.md')
			);

			clipboardMocks.safeClipboardWrite.mockRejectedValueOnce(new Error('denied'));
			fireEvent.click(screen.getByTestId('copy-icon').closest('button')!);
			await waitFor(() => expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledTimes(2));

			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);
			fireEvent.click(screen.getByTestId('clipboard-icon').closest('button')!);
			await waitFor(() =>
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenLastCalledWith('# Hello World')
			);

			clipboardMocks.safeClipboardWrite.mockRejectedValueOnce(new Error('content denied'));
			fireEvent.click(screen.getByTestId('clipboard-icon').closest('button')!);
			await waitFor(() => expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledTimes(4));

			clipboardMocks.safeClipboardWriteImage.mockResolvedValueOnce(false);
			rerender(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
				/>
			);
			fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'c', metaKey: true });
			await waitFor(() =>
				expect(clipboardMocks.safeClipboardWriteImage).toHaveBeenCalledWith(
					'data:image/png;base64,abc'
				)
			);
		});

		it('handles line context-menu missing-agent, failure, and backdrop dismissals', async () => {
			render(<FilePreview {...defaultProps} markdownEditMode />);

			fireEvent.contextMenu(screen.getByRole('button', { name: 'Line 2' }), {
				clientX: 11,
				clientY: 22,
			});
			fireEvent.click(await screen.findByRole('button', { name: 'Copy deep link to line 2' }));
			expect(clipboardMocks.safeClipboardWrite).not.toHaveBeenCalled();

			fireEvent.contextMenu(screen.getByRole('button', { name: 'Line 2' }), {
				clientX: 11,
				clientY: 22,
			});
			fireEvent.click(document.querySelector('.fixed.inset-0.z-40') as HTMLElement);
			expect(
				screen.queryByRole('button', { name: 'Copy deep link to line 2' })
			).not.toBeInTheDocument();

			fireEvent.contextMenu(screen.getByRole('button', { name: 'Line 2' }), {
				clientX: 11,
				clientY: 22,
			});
			fireEvent.contextMenu(document.querySelector('.fixed.inset-0.z-40') as HTMLElement);
			expect(
				screen.queryByRole('button', { name: 'Copy deep link to line 2' })
			).not.toBeInTheDocument();

			useSessionStore.setState({ activeSessionId: 'session-2' });
			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);
			fireEvent.contextMenu(screen.getByRole('button', { name: 'Line 2' }), {
				clientX: 11,
				clientY: 22,
			});
			fireEvent.click(await screen.findByRole('button', { name: 'Copy deep link to line 2' }));

			await waitFor(() =>
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith(
					'maestro://file/session-2/%2Ftest%2Ftest.md#L2'
				)
			);

			clipboardMocks.safeClipboardWrite.mockRejectedValueOnce(new Error('blocked'));
			fireEvent.contextMenu(screen.getByRole('button', { name: 'Line 2' }), {
				clientX: 11,
				clientY: 22,
			});
			fireEvent.click(await screen.findByRole('button', { name: 'Copy deep link to line 2' }));

			await waitFor(() =>
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenLastCalledWith(
					'maestro://file/session-2/%2Ftest%2Ftest.md#L2'
				)
			);
		});

		it('scrolls preview with arrow keys only when the main panel owns focus', () => {
			useUIStore.setState({ activeFocus: 'main' });
			const { container } = render(<FilePreview {...defaultProps} />);
			const root = container.firstElementChild as HTMLElement;
			const scroller = root.querySelector('.overflow-y-auto') as HTMLElement;
			Object.defineProperty(scroller, 'clientHeight', { value: 200, configurable: true });
			Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });

			fireEvent.keyDown(root, { key: 'ArrowDown' });
			expect(scroller.scrollTop).toBe(40);

			fireEvent.keyDown(root, { key: 'ArrowDown', altKey: true });
			expect(scroller.scrollTop).toBe(240);

			fireEvent.keyDown(root, { key: 'ArrowDown', ctrlKey: true });
			expect(scroller.scrollTop).toBe(1000);

			fireEvent.keyDown(root, { key: 'ArrowUp', altKey: true });
			expect(scroller.scrollTop).toBe(800);

			fireEvent.keyDown(root, { key: 'ArrowUp' });
			expect(scroller.scrollTop).toBe(760);

			fireEvent.keyDown(root, { key: 'ArrowUp', ctrlKey: true });
			expect(scroller.scrollTop).toBe(0);

			useUIStore.setState({ activeFocus: 'files' });
			fireEvent.keyDown(root, { key: 'ArrowDown' });
			fireEvent.keyDown(root, { key: 'ArrowUp' });
			expect(scroller.scrollTop).toBe(0);
			useUIStore.setState({ activeFocus: 'main' });
		});

		it('debounces scroll-position persistence and clears the pending timer on new scrolls', () => {
			vi.useFakeTimers();
			const onScrollPositionChange = vi.fn();
			const { container } = render(
				<FilePreview {...defaultProps} onScrollPositionChange={onScrollPositionChange} />
			);
			const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;

			scroller.scrollTop = 24;
			fireEvent.scroll(scroller);
			scroller.scrollTop = 48;
			fireEvent.scroll(scroller);

			expect(onScrollPositionChange).not.toHaveBeenCalled();
			act(() => {
				vi.advanceTimersByTime(200);
			});
			expect(onScrollPositionChange).toHaveBeenCalledTimes(1);
			expect(onScrollPositionChange).toHaveBeenCalledWith(48);

			vi.useRealTimers();
		});

		it('captures editor top line when scrolling in edit mode', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const { container } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.txt', content: 'one\ntwo', path: '/test/notes.txt' }}
						markdownEditMode
					/>
				);
				const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;

				fireEvent.scroll(scroller);

				expect(markdownEditorHandle.getTopLine).toHaveBeenCalled();
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('lets edit mode own preview navigation shortcuts for editable text files', () => {
			useUIStore.setState({ activeFocus: 'main' });
			const onNavigateBack = vi.fn();
			const onNavigateForward = vi.fn();
			const onOpenFuzzySearch = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'config.json', content: '{"key": "value"}', path: '/test/config.json' }}
					markdownEditMode
					canGoBack
					canGoForward
					onNavigateBack={onNavigateBack}
					onNavigateForward={onNavigateForward}
					onOpenFuzzySearch={onOpenFuzzySearch}
					shortcuts={{
						fuzzyFileSearch: {
							id: 'fuzzyFileSearch',
							label: 'Fuzzy File Search',
							keys: ['Meta', 'g'],
						},
					}}
				/>
			);
			const root = container.firstElementChild as HTMLElement;

			fireEvent.keyDown(root, { key: 'ArrowUp' });
			fireEvent.keyDown(root, { key: 'ArrowDown' });
			fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });
			fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });
			fireEvent.keyDown(root, { key: 'g', metaKey: true });

			expect(onNavigateBack).not.toHaveBeenCalled();
			expect(onNavigateForward).not.toHaveBeenCalled();
			expect(onOpenFuzzySearch).not.toHaveBeenCalled();
		});

		it('ignores configured shortcuts with unknown modifier keys', () => {
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					onShortcutUsed={onShortcutUsed}
					shortcuts={{
						copyFilePath: {
							id: 'copyFilePath',
							label: 'Copy File Path',
							keys: ['Hyper', 'p'],
						},
					}}
				/>
			);

			fireEvent.keyDown(container.firstElementChild as HTMLElement, { key: 'p' });

			expect(clipboardMocks.safeClipboardWrite).not.toHaveBeenCalled();
			expect(onShortcutUsed).not.toHaveBeenCalled();
		});

		it('preserves top line when switching between fast text preview and editor mode', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const file = {
					name: 'notes.txt',
					content: 'one\ntwo\nthree',
					path: '/test/notes.txt',
				};
				const renderPreview = (markdownEditMode = false) => (
					<FilePreview
						{...defaultProps}
						file={file}
						markdownEditMode={markdownEditMode}
						previewTierOverride="fast"
					/>
				);
				const { container, rerender } = render(renderPreview());
				const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;

				fireEvent.scroll(scroller);
				expect(textFastHandle.getTopLine).toHaveBeenCalled();

				rerender(renderPreview(true));
				expect(markdownEditorHandle.scrollToLine).toHaveBeenCalledWith(3, { select: false });

				rerender(renderPreview());
				expect(textFastHandle.scrollToLine).toHaveBeenCalledWith(3);
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('preserves top line when switching between giant preview and editor mode', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const file = {
					name: 'source.ts',
					content: 'const one = 1;\nconst two = 2;',
					path: '/test/source.ts',
				};
				const renderPreview = (markdownEditMode = false) => (
					<FilePreview
						{...defaultProps}
						file={file}
						markdownEditMode={markdownEditMode}
						previewTierOverride="giant"
					/>
				);
				const { container, rerender } = render(renderPreview());
				const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;

				fireEvent.scroll(scroller);
				expect(giantHandle.getTopLine).toHaveBeenCalled();

				rerender(renderPreview(true));
				expect(markdownEditorHandle.scrollToLine).toHaveBeenCalledWith(4, { select: false });

				rerender(renderPreview());
				expect(giantHandle.scrollToLine).toHaveBeenCalledWith(4);
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('uses percent scroll fallback when HTML preview switches into edit mode', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const file = {
					name: 'page.html',
					content: '<h1>Hello</h1>',
					path: '/test/page.html',
				};
				const renderPreview = (markdownEditMode = false) => (
					<FilePreview
						{...defaultProps}
						file={file}
						htmlRenderMode
						markdownEditMode={markdownEditMode}
					/>
				);
				const { container, rerender } = render(renderPreview());
				const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
				Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true });
				Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
				Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });

				rerender(renderPreview(true));

				expect(markdownEditorHandle.setScrollPercent).toHaveBeenCalledWith(0.5);
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('preserves top line when switching between DOM text preview and editor mode', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			const originalRangeRect = (Range.prototype as any).getBoundingClientRect;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;
			(Range.prototype as any).getBoundingClientRect = vi.fn(() => ({
				top: 0,
				height: 10,
				bottom: 10,
				left: 0,
				right: 0,
				width: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}));

			try {
				const file = {
					name: 'notes.txt',
					content: 'one\ntwo\nthree',
					path: '/test/notes.txt',
				};
				const renderPreview = (markdownEditMode = false) => (
					<FilePreview {...defaultProps} file={file} markdownEditMode={markdownEditMode} />
				);
				const { container, rerender } = render(renderPreview());
				const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;

				fireEvent.scroll(scroller);
				rerender(renderPreview(true));
				expect(markdownEditorHandle.scrollToLine).toHaveBeenCalledWith(3, { select: false });

				rerender(renderPreview());
				expect(scroller.scrollTop).toBeGreaterThanOrEqual(0);
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
				if (originalRangeRect) {
					(Range.prototype as any).getBoundingClientRect = originalRangeRect;
				} else {
					delete (Range.prototype as any).getBoundingClientRect;
				}
			}
		});

		it('preserves source-line tags when switching between rendered markdown and editor mode', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const file = {
					name: 'doc.md',
					content: 'source-line-harness',
					path: '/test/doc.md',
				};
				const renderPreview = (markdownEditMode = false) => (
					<FilePreview {...defaultProps} file={file} markdownEditMode={markdownEditMode} />
				);
				const { container, rerender } = render(renderPreview());
				const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;

				fireEvent.scroll(scroller);
				rerender(renderPreview(true));
				expect(markdownEditorHandle.scrollToLine).toHaveBeenCalledWith(4, { select: false });

				rerender(renderPreview());
				expect(scroller.scrollTop).toBeGreaterThanOrEqual(0);
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('uses percent fallback for CSV, jq JSON, and fast markdown preview modes', async () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const setScrollMetrics = (container: HTMLElement) => {
					const scroller = container.querySelector('.overflow-y-auto') as HTMLElement;
					Object.defineProperty(scroller, 'scrollTop', { value: 100, configurable: true });
					Object.defineProperty(scroller, 'scrollHeight', { value: 500, configurable: true });
					Object.defineProperty(scroller, 'clientHeight', { value: 300, configurable: true });
				};

				const { container, rerender, unmount } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'data.csv', content: 'name\nMaestro', path: '/test/data.csv' }}
					/>
				);
				setScrollMetrics(container);
				rerender(
					<FilePreview
						{...defaultProps}
						file={{ name: 'data.csv', content: 'name\nMaestro', path: '/test/data.csv' }}
						markdownEditMode
					/>
				);
				expect(markdownEditorHandle.setScrollPercent).toHaveBeenCalledWith(0.5);

				unmount();
				markdownEditorHandle.setScrollPercent.mockClear();

				const jsonRender = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'data.json', content: '{"name":"Maestro"}', path: '/test/data.json' }}
					/>
				);
				fireEvent.keyDown(jsonRender.container.firstElementChild as HTMLElement, {
					key: 'f',
					metaKey: true,
				});
				fireEvent.click(await screen.findByTitle('Switch to jq filter'));
				setScrollMetrics(jsonRender.container);
				jsonRender.rerender(
					<FilePreview
						{...defaultProps}
						file={{ name: 'data.json', content: '{"name":"Maestro"}', path: '/test/data.json' }}
						markdownEditMode
					/>
				);
				expect(markdownEditorHandle.setScrollPercent).toHaveBeenCalledWith(0.5);

				jsonRender.unmount();
				markdownEditorHandle.setScrollPercent.mockClear();

				const markdownRender = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'doc.md', content: '# Heading', path: '/test/doc.md' }}
						previewTierOverride="fast"
					/>
				);
				setScrollMetrics(markdownRender.container);
				markdownRender.rerender(
					<FilePreview
						{...defaultProps}
						file={{ name: 'doc.md', content: '# Heading', path: '/test/doc.md' }}
						previewTierOverride="fast"
						markdownEditMode
					/>
				);
				expect(markdownEditorHandle.setScrollPercent).toHaveBeenCalledWith(0.5);
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('falls back cleanly when leaving edit mode for a percent-only preview', () => {
			const originalRequestAnimationFrame = window.requestAnimationFrame;
			const originalCancelAnimationFrame = window.cancelAnimationFrame;
			window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			}) as typeof window.requestAnimationFrame;
			window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;

			try {
				const file = {
					name: 'page.html',
					content: '<h1>Hello</h1>',
					path: '/test/page.html',
				};
				const { rerender } = render(
					<FilePreview {...defaultProps} file={file} htmlRenderMode markdownEditMode />
				);

				expect(() =>
					rerender(<FilePreview {...defaultProps} file={file} htmlRenderMode />)
				).not.toThrow();
			} finally {
				if (originalRequestAnimationFrame) {
					window.requestAnimationFrame = originalRequestAnimationFrame;
				} else {
					delete (window as any).requestAnimationFrame;
				}
				if (originalCancelAnimationFrame) {
					window.cancelAnimationFrame = originalCancelAnimationFrame;
				} else {
					delete (window as any).cancelAnimationFrame;
				}
			}
		});

		it('invokes binary preview open-in-default-app action', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'archive.zip', content: 'PK\u0003\u0004', path: '/test/archive.zip' }}
				/>
			);

			const openButtons = screen.getAllByRole('button', { name: 'Open in Default App' });
			fireEvent.click(openButtons[openButtons.length - 1]);

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/test/archive.zip');
		});

		it('handles cancelled and failed saves without leaving the save button busy', async () => {
			const cancelledSave = vi.fn().mockResolvedValue(false);
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
					markdownEditMode
					onSave={cancelledSave}
				/>
			);
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } });
			fireEvent.click(screen.getByTestId('save-icon').closest('button')!);

			await waitFor(() => expect(cancelledSave).toHaveBeenCalledWith('/test/notes.txt', 'changed'));

			const failedSave = vi.fn().mockRejectedValue(new Error('disk full'));
			rerender(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
					markdownEditMode
					onSave={failedSave}
				/>
			);
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed again' } });
			fireEvent.click(screen.getByTestId('save-icon').closest('button')!);

			await waitFor(() =>
				expect(failedSave).toHaveBeenCalledWith('/test/notes.txt', 'changed again')
			);
			await waitFor(() =>
				expect(screen.getByTestId('save-icon').closest('button')).toBeInTheDocument()
			);
		});

		it('ignores save shortcuts when edit content has no changes', () => {
			const onSave = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
					markdownEditMode
					onSave={onSave}
				/>
			);

			fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', metaKey: true });

			expect(onSave).not.toHaveBeenCalled();
		});

		it('shows unsaved-change confirmation and confirms discard in overlay mode', () => {
			const onClose = vi.fn();
			render(
				<FilePreview {...defaultProps} onClose={onClose} markdownEditMode isTabMode={false} />
			);
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'dirty content' } });

			act(() => {
				mockClickOutsideCallback.current?.();
			});

			expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Yes, Discard'));
			expect(onClose).toHaveBeenCalled();
		});

		it('routes overlay click-outside Escape handling through TOC and search cleanup first', () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: '# Heading\n\nBody', path: '/test/doc.md' }}
					isTabMode={false}
				/>
			);
			const root = container.firstElementChild as HTMLElement;

			fireEvent.click(screen.getByTitle('Table of Contents'));
			expect(screen.getByText('Contents')).toBeInTheDocument();
			act(() => {
				mockContainerClickOutside.callback?.();
			});
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();

			fireEvent.keyDown(root, { key: 'f', metaKey: true });
			expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();
			act(() => {
				mockContainerClickOutside.callback?.();
			});
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
		});

		it('keeps overlay open when cancelling or closing the unsaved-change confirmation', () => {
			const onClose = vi.fn();
			render(
				<FilePreview {...defaultProps} onClose={onClose} markdownEditMode isTabMode={false} />
			);
			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'dirty content' } });

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			fireEvent.click(screen.getByText('No, Stay'));
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(onClose).not.toHaveBeenCalled();
			expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
		});
	});

	describe('image save edge cases', () => {
		it('dismisses the edited image save modal when cancelled', async () => {
			const editedDataUrl = 'data:image/png;base64,edited';
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) =>
				onSave(editedDataUrl)
			);
			useImageAnnotatorStore.setState({ openAnnotator });

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTestId('edit-image-button'));
			expect(await screen.findByText('Save edited image')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Cancel'));

			expect(screen.queryByText('Save edited image')).not.toBeInTheDocument();
		});

		it('falls back to PNG when edited image data has no image subtype', async () => {
			const editedDataUrl = 'data:application/octet-stream;base64,edited';
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) =>
				onSave(editedDataUrl)
			);
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'photo.jpg',
						content: 'data:image/jpeg;base64,abc',
						path: '/test/photo.jpg',
					}}
				/>
			);

			fireEvent.click(screen.getByTestId('edit-image-button'));
			expect(await screen.findByText(/will create photo\.png instead/i)).toBeInTheDocument();
			fireEvent.click(screen.getByText('Overwrite the existing file'));

			await waitFor(() =>
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/photo.png',
					editedDataUrl,
					undefined
				)
			);
		});

		it('preserves Windows separators when saving an edited image sibling', async () => {
			const editedDataUrl = 'data:image/png;base64,edited';
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) =>
				onSave(editedDataUrl)
			);
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockResolvedValue({ success: true });

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'photo.jpg',
						content: 'data:image/jpeg;base64,abc',
						path: 'C:\\work\\photo.jpg',
					}}
				/>
			);

			fireEvent.click(screen.getByTestId('edit-image-button'));
			expect(await screen.findByText(/will create photo\.png instead/i)).toBeInTheDocument();
			fireEvent.click(screen.getByText('Overwrite the existing file'));

			await waitFor(() =>
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'C:\\work\\photo.png',
					editedDataUrl,
					undefined
				)
			);
		});

		it('reports edited image save failures and keeps the save modal available', async () => {
			const editedDataUrl = 'data:image/png;base64,edited';
			const openAnnotator = vi.fn((_content: string, onSave: (dataUrl: string) => void) =>
				onSave(editedDataUrl)
			);
			useImageAnnotatorStore.setState({ openAnnotator });
			window.maestro.fs.writeImageFile = vi.fn().mockRejectedValue(new Error('read-only'));

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'image.png',
						content: 'data:image/png;base64,abc',
						path: '/test/image.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTestId('edit-image-button'));
			expect(await screen.findByText('Save edited image')).toBeInTheDocument();
			fireEvent.click(screen.getByText('Overwrite the existing file'));

			await waitFor(() =>
				expect(window.maestro.fs.writeImageFile).toHaveBeenCalledWith(
					'/test/image.png',
					editedDataUrl,
					undefined
				)
			);
			expect(screen.getByText('Save edited image')).toBeInTheDocument();
		});
	});
});
