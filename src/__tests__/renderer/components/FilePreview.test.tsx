import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { visit } from 'unist-util-visit';
import {
	FilePreview,
	_clearExpiredImageCacheForTesting,
} from '../../../renderer/components/FilePreview';
import { remarkFileLinks } from '../../../renderer/utils/remarkFileLinks';
import { captureException } from '../../../renderer/utils/sentry';
import { formatShortcutKeys } from '../../../renderer/utils/shortcutFormatter';
import { getEncoder } from '../../../renderer/utils/tokenCounter';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

const reactMarkdownMocks = vi.hoisted(() => ({
	lastRemarkPlugins: null as unknown[] | null,
}));

const csvRendererMocks = vi.hoisted(() => ({
	lastOnMatchCount: null as ((count: number) => void) | null,
}));

const clipboardMocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
	safeClipboardWriteBlob: vi.fn(),
}));

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
}));

// Mock react-markdown
vi.mock('react-markdown', () => ({
	default: ({
		children,
		components,
		remarkPlugins,
	}: {
		children: string;
		components?: Record<string, React.ComponentType<any>>;
		remarkPlugins?: unknown[];
	}) => {
		reactMarkdownMocks.lastRemarkPlugins = remarkPlugins ?? null;
		const ImageComponent = components?.img;
		const AnchorComponent = components?.a;
		const PreComponent = components?.pre;
		const DetailsComponent = components?.details;
		const imageMatches = [...children.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)];
		const linkMatches = [...children.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]*)\)/g)];
		const mermaidMatches = [...children.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)];
		const hasDetails = /<details[\s>]/.test(children);

		return (
			<div data-testid="markdown-content">
				{children}
				{PreComponent &&
					mermaidMatches.map((match, index) => (
						<PreComponent key={`mermaid-${index}`}>
							<code className="language-mermaid">{match[1].replace(/\n$/, '')}</code>
						</PreComponent>
					))}
				{DetailsComponent && hasDetails && (
					<DetailsComponent data-testid="sanitized-details" onToggle="raw-string-handler" open>
						<summary>More</summary>
						<div>Details body</div>
					</DetailsComponent>
				)}
				{ImageComponent &&
					imageMatches.map((match, index) => {
						const isFromTree = match[1].startsWith('Tree:');
						const alt = isFromTree ? match[1].replace(/^Tree:\s*/, '') : match[1];

						return (
							<ImageComponent
								key={`${match[2]}-${index}`}
								alt={alt}
								src={match[2]}
								data-maestro-from-tree={isFromTree ? 'true' : undefined}
							/>
						);
					})}
				{AnchorComponent &&
					linkMatches.map((match, index) => (
						<AnchorComponent key={`${match[2]}-${index}`} href={match[2]}>
							{match[1]}
						</AnchorComponent>
					))}
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

// Mock CsvTableRenderer
vi.mock('../../../renderer/components/CsvTableRenderer', () => ({
	CsvTableRenderer: ({
		content,
		searchQuery,
		delimiter,
		onMatchCount,
	}: {
		content: string;
		searchQuery?: string;
		delimiter?: string;
		onMatchCount?: (count: number) => void;
	}) =>
		(() => {
			csvRendererMocks.lastOnMatchCount = onMatchCount ?? null;
			return (
				<div
					data-testid="csv-table-renderer"
					data-search={searchQuery ?? ''}
					data-delimiter={delimiter ?? ','}
				>
					{content.substring(0, 50)}
				</div>
			);
		})(),
}));

// Mock token counter - getEncoder must return a Promise
vi.mock('../../../renderer/utils/tokenCounter', () => ({
	getEncoder: vi.fn(() => Promise.resolve({ encode: () => [1, 2, 3] })),
	formatTokenCount: vi.fn((count: number) => `${count} tokens`),
}));

vi.mock('../../../renderer/utils/clipboard', () => clipboardMocks);

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
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
	buildFileTreeIndices: vi.fn(() => ({
		allPaths: new Set(['docs/guide.md']),
		filenameIndex: new Map([['guide.md', ['docs/guide.md']]]),
	})),
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
		useSettingsStore.setState({ bionifyReadingMode: false });
		// Reset useClickOutside call counter so each test starts fresh
		useClickOutsideCallCount = 0;
		mockContainerClickOutside.callback = null;
		mockContainerClickOutside.enabled = false;
		mockTocClickOutside.callback = null;
		mockTocClickOutside.enabled = false;
		clipboardMocks.safeClipboardWrite.mockResolvedValue(true);
		clipboardMocks.safeClipboardWriteBlob.mockResolvedValue(true);
		reactMarkdownMocks.lastRemarkPlugins = null;
		csvRendererMocks.lastOnMatchCount = null;
		vi.mocked(getEncoder).mockImplementation(() => new Promise(() => {}));
		window.maestro.fs.stat = vi.fn(() => new Promise(() => {}));
		window.maestro.fs.readFile = vi.fn().mockResolvedValue('');
		globalThis.fetch = vi.fn().mockResolvedValue({
			blob: vi.fn().mockResolvedValue(new Blob(['image'], { type: 'image/png' })),
		}) as any;
		Object.defineProperty(globalThis, 'ClipboardItem', {
			value: class MockClipboardItem {
				items: Record<string, Blob>;
				constructor(items: Record<string, Blob>) {
					this.items = items;
				}
			},
			configurable: true,
		});
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

			const graphButton = screen.getByTitle(
				`View in Document Graph (${formatShortcutKeys(['Meta', 'Shift', 'g'])})`
			);
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

			const graphButton = screen.getByTitle(
				`View in Document Graph (${formatShortcutKeys(['Meta', 'Shift', 'g'])})`
			);
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

			expect(
				screen.queryByTitle(
					`View in Document Graph (${formatShortcutKeys(['Meta', 'Shift', 'g'])})`
				)
			).not.toBeInTheDocument();
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

			expect(
				screen.queryByTitle(
					`View in Document Graph (${formatShortcutKeys(['Meta', 'Shift', 'g'])})`
				)
			).not.toBeInTheDocument();
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

			expect(
				screen.getByTitle(`View in Document Graph (${formatShortcutKeys(['Meta', 'Shift', 'g'])})`)
			).toBeInTheDocument();
		});
	});

	describe('GitHub Gist publish button', () => {
		it('shows and calls the publish action when GitHub CLI is available', () => {
			const onPublishGist = vi.fn();
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					ghCliAvailable={true}
					onPublishGist={onPublishGist}
					hasGist={false}
				/>
			);

			fireEvent.click(screen.getByTitle('Publish as GitHub Gist'));
			expect(onPublishGist).toHaveBeenCalledOnce();

			rerender(
				<FilePreview
					{...defaultProps}
					ghCliAvailable={true}
					onPublishGist={onPublishGist}
					hasGist={true}
				/>
			);

			expect(screen.getByTitle('View published gist')).toBeInTheDocument();
		});

		it('hides the publish action when unavailable, editing, or previewing an image', () => {
			const onPublishGist = vi.fn();
			const { rerender } = render(
				<FilePreview {...defaultProps} ghCliAvailable={false} onPublishGist={onPublishGist} />
			);

			expect(screen.queryByTestId('share-icon')).not.toBeInTheDocument();

			rerender(<FilePreview {...defaultProps} ghCliAvailable={true} />);
			expect(screen.queryByTestId('share-icon')).not.toBeInTheDocument();

			rerender(
				<FilePreview
					{...defaultProps}
					ghCliAvailable={true}
					onPublishGist={onPublishGist}
					markdownEditMode={true}
				/>
			);
			expect(screen.queryByTestId('share-icon')).not.toBeInTheDocument();

			rerender(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,abc123',
						path: '/test/diagram.png',
					}}
					ghCliAvailable={true}
					onPublishGist={onPublishGist}
				/>
			);
			expect(screen.queryByTestId('share-icon')).not.toBeInTheDocument();
		});
	});

	describe('Open in Default App button', () => {
		it('shows Open in Default App button with ExternalLink icon', () => {
			render(<FilePreview {...defaultProps} />);

			const button = screen.getByTitle('Open in Default App');
			expect(button).toBeInTheDocument();
			expect(screen.getByTestId('external-link-icon')).toBeInTheDocument();
		});

		it('calls shell.openPath with file path when clicked', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'readme.md', content: '# Readme', path: '/test/readme.md' }}
				/>
			);

			const button = screen.getByTitle('Open in Default App');
			fireEvent.click(button);

			expect(window.maestro?.shell?.openPath).toHaveBeenCalledWith('/test/readme.md');
		});

		it('hides Open in Default App button for SSH remote sessions', () => {
			render(<FilePreview {...defaultProps} sshRemoteId="remote-host-1" />);

			expect(screen.queryByTitle('Open in Default App')).not.toBeInTheDocument();
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
			const largeContent = 'Readable paragraph with plenty of words for truncation. '.repeat(4000);

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

		it('allows Bionify to be toggled from the file preview header', () => {
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

			expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Enable Bionify for this preview'));

			expect(screen.getByTitle('Disable Bionify for this preview')).toBeInTheDocument();
			expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		});

		it('uses the same square toolbar geometry for the Bionify toggle as sibling header buttons', () => {
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

			const bionifyButton = screen.getByTitle('Enable Bionify for this preview');
			const clipboardButton = screen.getByTitle('Copy content to clipboard');

			expect(bionifyButton.className).toContain('inline-flex');
			expect(bionifyButton.className).toContain('justify-center');
			expect(bionifyButton.className).toContain('min-w-9');
			expect(bionifyButton.className).toContain('min-h-9');
			expect(bionifyButton.className).toBe(clipboardButton.className);
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

			// Advance timers past multiple poll intervals — no additional calls should happen
			await act(async () => {
				vi.advanceTimersByTime(6000);
			});

			expect(mockStat).toHaveBeenCalledTimes(callsAfterMount);

			vi.useRealTimers();
		});

		it('keeps the reload banner hidden when polled stats are missing or unchanged', async () => {
			vi.useFakeTimers();
			const mockStat = vi
				.fn()
				.mockResolvedValueOnce({
					size: 100,
					createdAt: '2024-01-01T00:00:00.000Z',
					modifiedAt: new Date(1000).toISOString(),
				})
				.mockResolvedValueOnce({ size: 100 })
				.mockResolvedValueOnce({
					size: 100,
					modifiedAt: new Date(1000).toISOString(),
				});
			window.maestro.fs.stat = mockStat;

			try {
				render(<FilePreview {...defaultProps} lastModified={1000} onReloadFile={vi.fn()} />);

				await act(async () => {
					await Promise.resolve();
				});

				await act(async () => {
					vi.advanceTimersByTime(3000);
					await Promise.resolve();
				});

				expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();

				await act(async () => {
					vi.advanceTimersByTime(3000);
					await Promise.resolve();
				});

				expect(screen.queryByText('File changed on disk.')).not.toBeInTheDocument();
				expect(mockStat).toHaveBeenCalledTimes(3);
			} finally {
				vi.useRealTimers();
			}
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

		it('treats unknown extensions and extensionless files as editable text', () => {
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'settings.custom', content: 'key=value', path: '/test/settings.custom' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();

			rerender(
				<FilePreview
					{...defaultProps}
					file={{ name: 'README', content: '', path: '/test/README' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
		});

		it('treats a filename with an empty trailing extension as editable text', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'README.', content: 'plain text', path: '/test/README.' }}
				/>
			);

			expect(screen.getByTestId('edit-icon')).toBeInTheDocument();
			expect(screen.getByTestId('syntax-highlighter')).toHaveTextContent('plain text');
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

		it('renders binary extension files without text editing controls', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'archive.zip', content: 'PK\\u0003\\u0004', path: '/test/archive.zip' }}
				/>
			);

			expect(screen.getByText('Binary File')).toBeInTheDocument();
			expect(screen.getByText('This file cannot be displayed as text.')).toBeInTheDocument();
			expect(screen.queryByTestId('edit-icon')).not.toBeInTheDocument();
		});

		it('opens binary files in the default app from the binary fallback', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'archive.zip', content: 'PK\\u0003\\u0004', path: '/test/archive.zip' }}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Open in Default App' }));

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/test/archive.zip');
		});

		it('renders files with binary-looking text content without text editing controls', () => {
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'payload.txt', content: 'hello\0world', path: '/test/payload.txt' }}
				/>
			);

			expect(screen.getByText('Binary File')).toBeInTheDocument();
			expect(screen.queryByTestId('edit-icon')).not.toBeInTheDocument();

			rerender(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'controls.txt',
						content: '\u0001\u0002\u0003text',
						path: '/test/controls.txt',
					}}
				/>
			);

			expect(screen.getByText('Binary File')).toBeInTheDocument();
			expect(screen.queryByTestId('edit-icon')).not.toBeInTheDocument();
		});

		it('treats C1 control characters as binary-looking content', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'controls.txt',
						content: `${'\u0080'.repeat(4)}text`,
						path: '/test/c1-controls.txt',
					}}
				/>
			);

			expect(screen.getByText('Binary File')).toBeInTheDocument();
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

		it('Cmd+Shift+Up preserves the backward selection anchor', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: multiLineContent, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(8, 14, 'backward');

			fireEvent.keyDown(textarea, { key: 'ArrowUp', metaKey: true, shiftKey: true });

			expect(textarea.selectionStart).toBe(0);
			expect(textarea.selectionEnd).toBe(14);
			expect(textarea.selectionDirection).toBe('backward');
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

		it('Cmd+Shift+Down preserves the forward selection anchor', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: multiLineContent, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			textarea.setSelectionRange(8, 14, 'forward');

			fireEvent.keyDown(textarea, { key: 'ArrowDown', metaKey: true, shiftKey: true });

			expect(textarea.selectionStart).toBe(8);
			expect(textarea.selectionEnd).toBe(multiLineContent.length);
			expect(textarea.selectionDirection).toBe('forward');
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

		it('saves from the textarea shortcut and exits edit mode on Escape', async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const setMarkdownEditMode = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content: 'original', path: '/test/test.txt' }}
					markdownEditMode={true}
					onSave={onSave}
					setMarkdownEditMode={setMarkdownEditMode}
				/>
			);

			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'changed' } });
			fireEvent.keyDown(textarea, { key: 's', metaKey: true });

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('/test/test.txt', 'changed');
			});

			fireEvent.change(textarea, { target: { value: 'changed again' } });
			fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('/test/test.txt', 'changed again');
			});

			fireEvent.keyDown(textarea, { key: 'Escape' });
			expect(setMarkdownEditMode).toHaveBeenCalledWith(false);
		});

		it('moves the textarea cursor by page with Option+Arrow shortcuts', () => {
			const content = 'aaaa\nbbbb\ncccc\ndddd\neeee';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.txt', content, path: '/test/test.txt' }}
					markdownEditMode={true}
				/>
			);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			Object.defineProperty(textarea, 'clientHeight', { value: 2, configurable: true });
			textarea.scrollTop = 20;
			const downStart = content.indexOf('bbbb') + 2;
			textarea.setSelectionRange(downStart, downStart);

			fireEvent.keyDown(textarea, { key: 'ArrowDown', altKey: true });

			expect(textarea.selectionStart).toBeGreaterThan(downStart);
			expect(textarea.scrollTop).toBe(22);

			const upStart = content.indexOf('dddd') + 2;
			textarea.setSelectionRange(upStart, upStart);
			textarea.scrollTop = 20;

			fireEvent.keyDown(textarea, { key: 'ArrowUp', altKey: true });

			expect(textarea.selectionStart).toBeLessThan(upStart);
			expect(textarea.scrollTop).toBe(18);
		});

		it('keeps Option+Arrow page movement inside empty document boundaries', () => {
			const getComputedStyleSpy = vi
				.spyOn(window, 'getComputedStyle')
				.mockReturnValue({ lineHeight: 'normal' } as CSSStyleDeclaration);

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'empty.txt', content: '', path: '/test/empty.txt' }}
						markdownEditMode={true}
						externalEditContent=""
					/>
				);

				const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				Object.defineProperty(textarea, 'clientHeight', { value: 48, configurable: true });
				textarea.setSelectionRange(0, 0);

				fireEvent.keyDown(textarea, { key: 'ArrowUp', altKey: true });
				expect(textarea.selectionStart).toBe(0);

				fireEvent.keyDown(textarea, { key: 'ArrowUp' });
				expect(textarea.selectionStart).toBe(0);

				fireEvent.keyDown(textarea, { key: 'ArrowDown', altKey: true });
				expect(textarea.selectionStart).toBe(0);
			} finally {
				getComputedStyleSpy.mockRestore();
			}
		});
	});

	describe('container keyboard shortcuts', () => {
		it('saves changed edit content from the container Cmd+S shortcut', async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
					markdownEditMode={true}
					onSave={onSave}
				/>
			);

			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'updated' } });
			fireEvent.keyDown(container.firstChild as HTMLElement, { key: 's', metaKey: true });

			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('/test/notes.txt', 'updated');
			});
		});

		it('handles copy path and markdown-mode toggle shortcuts', async () => {
			const setMarkdownEditMode = vi.fn();
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					setMarkdownEditMode={setMarkdownEditMode}
					onShortcutUsed={onShortcutUsed}
					shortcuts={{
						copyFilePath: { keys: ['Meta', 'Shift', 'c'] },
						toggleMarkdownMode: { keys: ['Meta', 'e'] },
					}}
				/>
			);
			const root = container.firstChild as HTMLElement;

			fireEvent.keyDown(root, { key: 'c', metaKey: true, shiftKey: true });
			await waitFor(() => {
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('/test/test.md');
			});
			expect(onShortcutUsed).toHaveBeenCalledWith('copyFilePath');

			fireEvent.keyDown(root, { key: 'e', metaKey: true });
			expect(setMarkdownEditMode).toHaveBeenCalledWith(true);
		});

		it('matches Ctrl, Alt, and Shift shortcut modifiers for custom bindings', async () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					shortcuts={{ copyFilePath: { keys: ['Ctrl', 'Alt', 'Shift', 'p'] } }}
				/>
			);

			fireEvent.keyDown(container.firstChild as HTMLElement, {
				key: 'p',
				ctrlKey: true,
				altKey: true,
				shiftKey: true,
			});

			await waitFor(() => {
				expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('/test/test.md');
			});
		});

		it('ignores shortcut bindings when a required modifier is not pressed', () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					shortcuts={{ copyFilePath: { keys: ['Ctrl', 'Alt', 'Shift', 'p'] } }}
				/>
			);

			fireEvent.keyDown(container.firstChild as HTMLElement, {
				key: 'p',
				ctrlKey: true,
				altKey: true,
			});

			expect(clipboardMocks.safeClipboardWrite).not.toHaveBeenCalled();
		});

		it('scrolls preview content with arrow key variants', () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'line 1\nline 2', path: '/test/notes.txt' }}
				/>
			);
			const root = container.firstChild as HTMLElement;
			const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
			Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true });
			Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
			scrollContainer.scrollTop = 400;

			fireEvent.keyDown(root, { key: 'ArrowUp' });
			expect(scrollContainer.scrollTop).toBe(360);

			fireEvent.keyDown(root, { key: 'ArrowDown' });
			expect(scrollContainer.scrollTop).toBe(400);

			fireEvent.keyDown(root, { key: 'ArrowUp', altKey: true });
			expect(scrollContainer.scrollTop).toBe(200);

			fireEvent.keyDown(root, { key: 'ArrowDown', altKey: true });
			expect(scrollContainer.scrollTop).toBe(400);

			fireEvent.keyDown(root, { key: 'ArrowUp', metaKey: true });
			expect(scrollContainer.scrollTop).toBe(0);

			fireEvent.keyDown(root, { key: 'ArrowDown', metaKey: true });
			expect(scrollContainer.scrollTop).toBe(1000);
		});

		it('routes history, graph, and fuzzy-search keyboard shortcuts', () => {
			const onNavigateBack = vi.fn();
			const onNavigateForward = vi.fn();
			const onOpenInGraph = vi.fn();
			const onOpenFuzzySearch = vi.fn();
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					canGoBack={true}
					canGoForward={true}
					onNavigateBack={onNavigateBack}
					onNavigateForward={onNavigateForward}
					onOpenInGraph={onOpenInGraph}
					onOpenFuzzySearch={onOpenFuzzySearch}
					onShortcutUsed={onShortcutUsed}
					shortcuts={{ fuzzyFileSearch: { keys: ['Meta', 'g'] } }}
				/>
			);
			const root = container.firstChild as HTMLElement;

			fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });
			expect(onNavigateBack).toHaveBeenCalledOnce();
			expect(onShortcutUsed).toHaveBeenCalledWith('filePreviewBack');

			fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });
			expect(onNavigateForward).toHaveBeenCalledOnce();
			expect(onShortcutUsed).toHaveBeenCalledWith('filePreviewForward');

			fireEvent.keyDown(root, { key: 'ArrowLeft', ctrlKey: true });
			fireEvent.keyDown(root, { key: 'ArrowRight', ctrlKey: true });
			expect(onNavigateBack).toHaveBeenCalledTimes(2);
			expect(onNavigateForward).toHaveBeenCalledTimes(2);

			fireEvent.keyDown(root, { key: 'g', metaKey: true, shiftKey: true });
			expect(onOpenInGraph).toHaveBeenCalledOnce();
			expect(onOpenFuzzySearch).not.toHaveBeenCalled();

			fireEvent.keyDown(root, { key: 'g', metaKey: true });
			expect(onOpenFuzzySearch).toHaveBeenCalledOnce();
		});

		it('does not navigate history when keyboard shortcuts are unavailable', () => {
			const onNavigateBack = vi.fn();
			const onNavigateForward = vi.fn();
			const onShortcutUsed = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					canGoBack={false}
					canGoForward={false}
					onNavigateBack={onNavigateBack}
					onNavigateForward={onNavigateForward}
					onShortcutUsed={onShortcutUsed}
				/>
			);
			const root = container.firstChild as HTMLElement;

			fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });
			fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });

			expect(onNavigateBack).not.toHaveBeenCalled();
			expect(onNavigateForward).not.toHaveBeenCalled();
			expect(onShortcutUsed).not.toHaveBeenCalled();
		});

		it('leaves history and fuzzy-search shortcuts inactive in edit mode', () => {
			const onNavigateBack = vi.fn();
			const onOpenFuzzySearch = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					markdownEditMode={true}
					canGoBack={true}
					onNavigateBack={onNavigateBack}
					onOpenFuzzySearch={onOpenFuzzySearch}
					shortcuts={{ fuzzyFileSearch: { keys: ['Meta', 'g'] } }}
				/>
			);
			const root = container.firstChild as HTMLElement;

			fireEvent.keyDown(root, { key: 'ArrowLeft', metaKey: true });
			fireEvent.keyDown(root, { key: 'g', metaKey: true });
			fireEvent.keyDown(root, { key: 'ArrowRight', metaKey: true });

			expect(onNavigateBack).not.toHaveBeenCalled();
			expect(onOpenFuzzySearch).not.toHaveBeenCalled();
		});

		it('copies image content from the container Cmd+C shortcut', async () => {
			const imageDataUrl = 'data:image/png;base64,abc123';
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'diagram.png', content: imageDataUrl, path: '/test/diagram.png' }}
				/>
			);

			fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'c', metaKey: true });

			await screen.findByText('Image Copied to Clipboard');
			expect(globalThis.fetch).toHaveBeenCalledWith(imageDataUrl);
			expect(clipboardMocks.safeClipboardWriteBlob).toHaveBeenCalledOnce();
		});

		it('supports Ctrl-key variants for search, save, graph, and image copy shortcuts', async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const onOpenInGraph = vi.fn();
			const textView = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.md', content: '# Notes', path: '/test/notes.md' }}
					onOpenInGraph={onOpenInGraph}
				/>
			);

			fireEvent.keyDown(textView.container.firstChild as HTMLElement, { key: 'f', ctrlKey: true });
			expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();

			fireEvent.keyDown(textView.container.firstChild as HTMLElement, {
				key: 'g',
				ctrlKey: true,
				shiftKey: true,
			});
			expect(onOpenInGraph).toHaveBeenCalledOnce();
			textView.unmount();

			const editView = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
					markdownEditMode={true}
					onSave={onSave}
				/>
			);
			const textarea = screen.getByRole('textbox');
			fireEvent.change(textarea, { target: { value: 'changed' } });
			fireEvent.keyDown(editView.container.firstChild as HTMLElement, { key: 's', ctrlKey: true });
			await waitFor(() => {
				expect(onSave).toHaveBeenCalledWith('/test/notes.txt', 'changed');
			});
			editView.unmount();

			const imageDataUrl = 'data:image/png;base64,ctrl-image';
			const imageView = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'diagram.png', content: imageDataUrl, path: '/test/diagram.png' }}
				/>
			);
			fireEvent.keyDown(imageView.container.firstChild as HTMLElement, { key: 'c', ctrlKey: true });
			await screen.findByText('Image Copied to Clipboard');
			expect(globalThis.fetch).toHaveBeenCalledWith(imageDataUrl);
		});
	});

	describe('basic rendering', () => {
		it('renders file preview with file name', () => {
			render(<FilePreview {...defaultProps} />);

			expect(screen.getByText('test.md')).toBeInTheDocument();
		});

		it('exposes an imperative focus method for tab focus restoration', () => {
			const previewRef = React.createRef<FilePreviewHandle>();
			const { container } = render(<FilePreview {...defaultProps} ref={previewRef} />);
			const root = container.firstChild as HTMLElement;
			const focus = vi.spyOn(root, 'focus');

			previewRef.current?.focus();

			expect(focus).toHaveBeenCalledOnce();
		});

		// Close button was removed - now handled by file tab's X button
		// See Phase 8: Cleanup & Polish task for details

		it('renders nothing when file is null', () => {
			const { container } = render(<FilePreview {...defaultProps} file={null} />);

			expect(container.firstChild).toBeNull();
		});
	});

	describe('metadata, save, and clipboard actions', () => {
		it('renders file stats and token count for text files', async () => {
			window.maestro.fs.stat = vi.fn().mockResolvedValue({
				size: 2048,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
			});
			vi.mocked(getEncoder).mockResolvedValue({ encode: () => [1, 2, 3, 4] } as any);

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
				/>
			);

			expect(await screen.findByText('2 KB')).toBeInTheDocument();
			expect(await screen.findByText('4 tokens')).toBeInTheDocument();
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/test/notes.txt', undefined);
		});

		it('renders zero-byte file stats', async () => {
			window.maestro.fs.stat = vi.fn().mockResolvedValue({
				size: 0,
				createdAt: '2024-01-01T00:00:00.000Z',
				modifiedAt: '2024-01-15T12:30:00.000Z',
			});

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'empty.txt', content: '', path: '/test/empty.txt' }}
				/>
			);

			expect(await screen.findByText('0 B')).toBeInTheDocument();
		});

		it('renders markdown task counts in the metadata bar', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'tasks.md',
						content: '- [ ] Open item\n- [x] Done item\n* [X] Another done item',
						path: '/test/tasks.md',
					}}
				/>
			);

			const taskStats = screen.getByText('Tasks:').parentElement;
			expect(taskStats).not.toBeNull();
			expect(within(taskStats!).getByText('2')).toBeInTheDocument();
			expect(within(taskStats!).getByText(/of 3/)).toBeInTheDocument();
		});

		it('falls back cleanly when file stats and token counting fail', async () => {
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			window.maestro.fs.stat = vi.fn().mockRejectedValue(new Error('stat failed'));
			vi.mocked(getEncoder).mockRejectedValueOnce(new Error('encoder failed'));

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
				/>
			);

			await act(async () => {
				await Promise.resolve();
			});

			expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith('Failed to get file stats:', expect.any(Error));
			expect(consoleError).toHaveBeenCalledWith('Failed to count tokens:', expect.any(Error));
			consoleError.mockRestore();
		});

		it('saves modified text content and hides the success notification after the timeout', async () => {
			vi.useFakeTimers();
			const onSave = vi.fn().mockResolvedValue(undefined);

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
						markdownEditMode={true}
						externalEditContent="updated"
						onSave={onSave}
					/>
				);

				fireEvent.click(screen.getByTitle('Save changes (Ctrl+S)'));

				await act(async () => {
					await Promise.resolve();
				});
				expect(screen.getByText('File Saved')).toBeInTheDocument();
				expect(onSave).toHaveBeenCalledWith('/test/notes.txt', 'updated');

				act(() => {
					vi.advanceTimersByTime(2000);
				});
				expect(screen.queryByText('File Saved')).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it('shows a failure notification when saving modified content rejects and hides it', async () => {
			vi.useFakeTimers();
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const onSave = vi.fn().mockRejectedValue(new Error('save failed'));

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
						markdownEditMode={true}
						externalEditContent="updated"
						onSave={onSave}
					/>
				);

				fireEvent.click(screen.getByTitle('Save changes (Ctrl+S)'));

				await act(async () => {
					await Promise.resolve();
				});
				expect(screen.getByText('Save Failed')).toBeInTheDocument();
				expect(consoleError).toHaveBeenCalledWith('Failed to save file:', expect.any(Error));

				act(() => {
					vi.advanceTimersByTime(2000);
				});
				expect(screen.queryByText('Save Failed')).not.toBeInTheDocument();
			} finally {
				consoleError.mockRestore();
				vi.useRealTimers();
			}
		});

		it('does not call onSave for unchanged edit content from a save shortcut', () => {
			const onSave = vi.fn();
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'original', path: '/test/notes.txt' }}
					markdownEditMode={true}
					externalEditContent="original"
					onSave={onSave}
				/>
			);

			fireEvent.keyDown(container.firstChild as HTMLElement, { key: 's', metaKey: true });

			expect(onSave).not.toHaveBeenCalled();
		});

		it('copies the file path to the clipboard', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy full path to clipboard'));

			await screen.findByText('File Path Copied to Clipboard');
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('/test/notes.txt');
		});

		it('hides copy notifications after the timeout', async () => {
			vi.useFakeTimers();

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
					/>
				);

				fireEvent.click(screen.getByTitle('Copy full path to clipboard'));

				await act(async () => {
					await Promise.resolve();
				});
				expect(screen.getByText('File Path Copied to Clipboard')).toBeInTheDocument();

				act(() => {
					vi.advanceTimersByTime(2000);
				});
				expect(screen.queryByText('File Path Copied to Clipboard')).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it('shows a failure notification when copying the file path fails', async () => {
			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy full path to clipboard'));

			await screen.findByText('Failed to Copy Path');
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('/test/notes.txt');
		});

		it('copies text content to the clipboard', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy content to clipboard'));

			await screen.findByText('Content Copied to Clipboard');
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('plain text content');
		});

		it('hides text content copy notifications after the timeout', async () => {
			vi.useFakeTimers();

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
					/>
				);

				fireEvent.click(screen.getByTitle('Copy content to clipboard'));

				await act(async () => {
					await Promise.resolve();
				});
				expect(screen.getByText('Content Copied to Clipboard')).toBeInTheDocument();

				act(() => {
					vi.advanceTimersByTime(2000);
				});
				expect(screen.queryByText('Content Copied to Clipboard')).not.toBeInTheDocument();
			} finally {
				vi.useRealTimers();
			}
		});

		it('shows a failure notification when copying text content fails', async () => {
			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'plain text content', path: '/test/notes.txt' }}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy content to clipboard'));

			await screen.findByText('Failed to Copy Content');
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith('plain text content');
		});

		it('copies image blobs to the clipboard', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,diagram',
						path: '/test/diagram.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (Ctrl+C)'));

			await screen.findByText('Image Copied to Clipboard');
			expect(globalThis.fetch).toHaveBeenCalledWith('data:image/png;base64,diagram');
			expect(clipboardMocks.safeClipboardWriteBlob).toHaveBeenCalledOnce();
		});

		it('falls back to copying the image data URL when blob clipboard write fails', async () => {
			clipboardMocks.safeClipboardWriteBlob.mockResolvedValueOnce(false);

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,diagram',
						path: '/test/diagram.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (Ctrl+C)'));

			await screen.findByText('Image URL Copied to Clipboard');
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith(
				'data:image/png;base64,diagram'
			);
		});

		it('shows a failure notification when blob copy and image data URL fallback both fail', async () => {
			clipboardMocks.safeClipboardWriteBlob.mockResolvedValueOnce(false);
			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,diagram',
						path: '/test/diagram.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (Ctrl+C)'));

			await screen.findByText('Failed to Copy Image');
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith(
				'data:image/png;base64,diagram'
			);
		});

		it('copies the image data URL when image fetch fails but fallback succeeds', async () => {
			const imageFetchError = new Error('image fetch failed');
			vi.mocked(globalThis.fetch).mockRejectedValueOnce(imageFetchError);

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,diagram',
						path: '/test/diagram.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (Ctrl+C)'));

			await screen.findByText('Image URL Copied to Clipboard');
			expect(captureException).toHaveBeenCalledWith(imageFetchError);
			expect(clipboardMocks.safeClipboardWrite).toHaveBeenCalledWith(
				'data:image/png;base64,diagram'
			);
		});

		it('shows a failure notification when image fetch and data URL fallback both fail', async () => {
			const imageFetchError = new Error('image fetch failed');
			vi.mocked(globalThis.fetch).mockRejectedValueOnce(imageFetchError);
			clipboardMocks.safeClipboardWrite.mockResolvedValueOnce(false);

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'diagram.png',
						content: 'data:image/png;base64,diagram',
						path: '/test/diagram.png',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Copy image to clipboard (Ctrl+C)'));

			await screen.findByText('Failed to Copy Image');
			expect(captureException).toHaveBeenCalledWith(imageFetchError);
		});
	});

	describe('markdown links', () => {
		it('opens file, web, and mailto markdown links through shell callbacks', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content:
							'[Local file](file:///tmp/readme.md) [Website](https://example.com/docs) [Email](mailto:support@example.com)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'Local file' }));
			fireEvent.click(screen.getByRole('link', { name: 'Website' }));
			fireEvent.click(screen.getByRole('link', { name: 'Email' }));

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/tmp/readme.md');
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('mailto:support@example.com');
		});

		it('routes relative markdown links through onFileClick with modifier state', () => {
			const onFileClick = vi.fn();

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '[Guide](docs/guide.md) [License](LICENSE)',
						path: '/project/docs/readme.md',
					}}
					onFileClick={onFileClick}
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'Guide' }));
			fireEvent.click(screen.getByRole('link', { name: 'License' }), { metaKey: true });

			expect(onFileClick).toHaveBeenCalledWith('docs/guide.md', { openInNewTab: false });
			expect(onFileClick).toHaveBeenCalledWith('LICENSE', { openInNewTab: true });
		});

		it('ignores unsupported external markdown link protocols', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '[Custom](custom://open-me)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'Custom' }));

			expect(window.maestro.shell.openPath).not.toHaveBeenCalled();
			expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();
		});

		it('renders mermaid code fences and strips raw details event handlers', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content:
							'```mermaid\nflowchart TD\nA-->B\n```\n<details onToggle="alert(1)"><summary>More</summary>Body</details>',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			expect(screen.getByTestId('mermaid-renderer')).toBeInTheDocument();
			expect(screen.getByTestId('sanitized-details')).toBeInTheDocument();
			expect(screen.getByTestId('sanitized-details')).not.toHaveAttribute('onToggle');
		});
	});

	describe('markdown images', () => {
		it('ignores markdown image nodes without a source', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Missing source]()',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			await act(async () => {
				await Promise.resolve();
			});

			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
			expect(screen.queryByText('Loading image...')).not.toBeInTheDocument();
		});

		it('renders inline data URL markdown images without filesystem reads', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Inline diagram](data:image/png;base64,inline-diagram)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			const image = await screen.findByAltText('Inline diagram');
			expect(image).toHaveAttribute('src', 'data:image/png;base64,inline-diagram');
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('uses empty alt text for markdown images without alt text', async () => {
			const { container } = render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![](data:image/png;base64,decorative-diagram)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			await waitFor(() => expect(container.querySelector('img')).toBeInTheDocument());
			const image = container.querySelector('img')!;
			expect(container.querySelector('img')).toBe(image);
			expect(image).toHaveAttribute('alt', '');
			expect(image).toHaveAttribute('src', 'data:image/png;base64,decorative-diagram');
		});

		it('blocks remote markdown images by default', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Remote diagram](https://example.com/diagram.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			expect(await screen.findByText('Remote image blocked')).toBeInTheDocument();
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('shows remote markdown images when the remote image toggle is enabled', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Remote diagram](https://example.com/remote-diagram.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Show remote images'));

			const image = await screen.findByAltText('Remote diagram');
			expect(image).toHaveAttribute('src', 'https://example.com/remote-diagram.png');
		});

		it('shows http markdown images when the remote image toggle is enabled', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![HTTP diagram](http://example.com/http-diagram.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			fireEvent.click(screen.getByTitle('Show remote images'));

			const image = await screen.findByAltText('HTTP diagram');
			expect(image).toHaveAttribute('src', 'http://example.com/http-diagram.png');
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('loads local markdown images through the filesystem bridge', async () => {
			window.maestro.fs.readFile = vi.fn().mockResolvedValue('data:image/png;base64,local-diagram');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Local diagram](./images/local.png)',
						path: '/project/docs/readme.md',
					}}
					sshRemoteId="remote-1"
				/>
			);

			const image = await screen.findByAltText('Local diagram');
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/project/docs/images/local.png',
				'remote-1'
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,local-diagram');

			Object.defineProperty(image, 'naturalWidth', { value: 640, configurable: true });
			Object.defineProperty(image, 'naturalHeight', { value: 480, configurable: true });
			fireEvent.load(image);
		});

		it('loads absolute markdown image paths without rebasing to the markdown directory', async () => {
			window.maestro.fs.readFile = vi
				.fn()
				.mockResolvedValue('data:image/png;base64,absolute-diagram');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Absolute diagram](/assets/absolute.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			const image = await screen.findByAltText('Absolute diagram');
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/assets/absolute.png', undefined);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,absolute-diagram');
		});

		it('enables file-tree link plugins when fileTree and cwd are provided', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '# Linked docs',
						path: '/project/docs/readme.md',
					}}
					fileTree={
						[
							{
								name: 'docs',
								path: '/project/docs',
								type: 'directory',
								children: [
									{
										name: 'guide.md',
										path: '/project/docs/guide.md',
										type: 'file',
									},
								],
							},
						] as any
					}
					cwd="project"
				/>
			);

			expect(reactMarkdownMocks.lastRemarkPlugins).toEqual(
				expect.arrayContaining([
					expect.arrayContaining([
						remarkFileLinks,
						expect.objectContaining({
							cwd: 'project',
							indices: expect.any(Object),
						}),
					]),
				])
			);
		});

		it('rewrites ==highlight== markdown text into mark HTML nodes', () => {
			vi.mocked(visit).mockImplementation((tree: any, type: string, visitor: any) => {
				const walk = (node: any, parent?: any) => {
					if (node.type === type && parent?.children) {
						visitor(node, parent.children.indexOf(node), parent);
					}
					for (const child of node.children ? [...node.children] : []) {
						walk(child, node);
					}
				};
				walk(tree);
			});

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{
							name: 'notes.md',
							content: 'Before ==important== middle ==urgent== after',
							path: '/project/notes.md',
						}}
					/>
				);

				const highlightPlugin = reactMarkdownMocks.lastRemarkPlugins?.find(
					(plugin) => typeof plugin === 'function' && plugin.name === 'remarkHighlight'
				) as (() => (tree: any) => void) | undefined;
				expect(highlightPlugin).toBeDefined();

				const tree = {
					type: 'root',
					children: [
						{
							type: 'paragraph',
							children: [{ type: 'text', value: 'Before ==important== middle ==urgent== after' }],
						},
					],
				};

				highlightPlugin!()(tree);

				expect(tree.children[0].children).toEqual([
					{ type: 'text', value: 'Before ' },
					{
						type: 'html',
						value:
							'<mark style="background-color: #ffd700; color: #000; padding: 0 4px; border-radius: 2px;">important</mark>',
					},
					{ type: 'text', value: ' middle ' },
					{
						type: 'html',
						value:
							'<mark style="background-color: #ffd700; color: #000; padding: 0 4px; border-radius: 2px;">urgent</mark>',
					},
					{ type: 'text', value: ' after' },
				]);
			} finally {
				vi.mocked(visit).mockReset();
			}
		});

		it('leaves markdown highlight text unchanged when there is no match or parent context', () => {
			const parent = {
				type: 'paragraph',
				children: [{ type: 'text', value: 'plain text' }],
			};
			vi.mocked(visit).mockImplementation((_tree: any, _type: string, visitor: any) => {
				visitor(parent.children[0], 0, parent);
				visitor({ type: 'text', value: '==orphan==' }, null, undefined);
			});

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{
							name: 'notes.md',
							content: 'plain text',
							path: '/project/notes.md',
						}}
					/>
				);

				const highlightPlugin = reactMarkdownMocks.lastRemarkPlugins?.find(
					(plugin) => typeof plugin === 'function' && plugin.name === 'remarkHighlight'
				) as (() => (tree: any) => void) | undefined;
				expect(highlightPlugin).toBeDefined();

				highlightPlugin!()({ type: 'root', children: [parent] });

				expect(parent.children).toEqual([{ type: 'text', value: 'plain text' }]);
			} finally {
				vi.mocked(visit).mockReset();
			}
		});

		it('rewrites highlight text that occupies the full text node', () => {
			vi.mocked(visit).mockImplementation((tree: any, _type: string, visitor: any) => {
				const parent = {
					type: 'paragraph',
					children: [{ type: 'text', value: '==solo==' }],
				};
				visitor(parent.children[0], 0, parent);
				tree.children = [parent];
			});

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{
							name: 'notes.md',
							content: '==solo==',
							path: '/project/notes.md',
						}}
					/>
				);

				const highlightPlugin = reactMarkdownMocks.lastRemarkPlugins?.find(
					(plugin) => typeof plugin === 'function' && plugin.name === 'remarkHighlight'
				) as (() => (tree: any) => void) | undefined;
				expect(highlightPlugin).toBeDefined();

				const tree = { type: 'root', children: [] as any[] };
				highlightPlugin!()(tree);

				expect(tree.children[0].children).toEqual([
					{
						type: 'html',
						value:
							'<mark style="background-color: #ffd700; color: #000; padding: 0 4px; border-radius: 2px;">solo</mark>',
					},
				]);
			} finally {
				vi.mocked(visit).mockReset();
			}
		});

		it('loads file-tree markdown images from the project root when cwd matches', async () => {
			window.maestro.fs.readFile = vi.fn().mockResolvedValue('data:image/png;base64,tree-image');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Tree: Repo image](assets/logo.png)',
						path: '/workspace/project/docs/readme.md',
					}}
					cwd="project"
				/>
			);

			const image = await screen.findByAltText('Repo image');
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/workspace/assets/logo.png',
				undefined
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,tree-image');
		});

		it('falls back to the first cwd segment for file-tree markdown images', async () => {
			window.maestro.fs.readFile = vi.fn().mockResolvedValue('data:image/png;base64,segment-image');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Tree: Segment image](assets/from-segment.png)',
						path: '/workspace/root/project/readme.md',
					}}
					cwd="project/docs"
				/>
			);

			const image = await screen.findByAltText('Segment image');
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/workspace/root/assets/from-segment.png',
				undefined
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,segment-image');
		});

		it('falls back to markdown-relative paths for file-tree images outside the cwd', async () => {
			window.maestro.fs.readFile = vi.fn().mockResolvedValue('data:image/png;base64,rootless');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Tree: Rootless image](assets/rootless.png)',
						path: '/workspace/other/docs/readme.md',
					}}
					cwd="project/docs"
				/>
			);

			const image = await screen.findByAltText('Rootless image');
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/workspace/other/docs/assets/rootless.png',
				undefined
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,rootless');
		});

		it('decodes URL-encoded local markdown image paths before reading them', async () => {
			window.maestro.fs.readFile = vi.fn().mockResolvedValue('data:image/png;base64,encoded');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Encoded diagram](./images/local%20diagram.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			const image = await screen.findByAltText('Encoded diagram');
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
				'/project/docs/images/local diagram.png',
				undefined
			);
			expect(image).toHaveAttribute('src', 'data:image/png;base64,encoded');
		});

		it('reuses cached local markdown image data on later renders', async () => {
			const readFile = vi.fn().mockResolvedValue('data:image/png;base64,cached-diagram');
			window.maestro.fs.readFile = readFile;

			const file = {
				name: 'readme.md',
				content: '![Cached diagram](./images/cached.png)',
				path: '/project/docs/cache-test.md',
			};
			const { unmount } = render(<FilePreview {...defaultProps} file={file} />);

			expect(await screen.findByAltText('Cached diagram')).toHaveAttribute(
				'src',
				'data:image/png;base64,cached-diagram'
			);
			expect(readFile).toHaveBeenCalledTimes(1);

			unmount();
			readFile.mockClear();

			render(<FilePreview {...defaultProps} file={file} />);

			expect(await screen.findByAltText('Cached diagram')).toHaveAttribute(
				'src',
				'data:image/png;base64,cached-diagram'
			);
			expect(readFile).not.toHaveBeenCalled();
		});

		it('expires stale local markdown image cache entries', async () => {
			const readFile = vi
				.fn()
				.mockResolvedValueOnce('data:image/png;base64,stale-diagram')
				.mockResolvedValue('data:image/png;base64,fresh-diagram');
			window.maestro.fs.readFile = readFile;

			const file = {
				name: 'readme.md',
				content: '![Expiring diagram](./images/expiring.png)',
				path: '/project/docs/expiring-cache.md',
			};
			let view = render(<FilePreview {...defaultProps} file={file} />);

			expect(await screen.findByAltText('Expiring diagram')).toHaveAttribute(
				'src',
				'data:image/png;base64,stale-diagram'
			);
			expect(readFile).toHaveBeenCalledTimes(1);

			view.unmount();
			readFile.mockClear();
			_clearExpiredImageCacheForTesting(Date.now());

			view = render(<FilePreview {...defaultProps} file={file} />);
			const cachedImage = await screen.findByAltText('Expiring diagram');
			expect(cachedImage).toHaveAttribute('src', 'data:image/png;base64,stale-diagram');
			expect(readFile).not.toHaveBeenCalled();

			Object.defineProperty(cachedImage, 'naturalWidth', { value: 320, configurable: true });
			Object.defineProperty(cachedImage, 'naturalHeight', { value: 200, configurable: true });
			_clearExpiredImageCacheForTesting(Date.now() + 10 * 60 * 1000 + 1);
			fireEvent.load(cachedImage);

			view.unmount();

			render(<FilePreview {...defaultProps} file={file} />);
			expect(await screen.findByAltText('Expiring diagram')).toHaveAttribute(
				'src',
				'data:image/png;base64,fresh-diagram'
			);
			expect(readFile).toHaveBeenCalledTimes(1);
		});

		it('shows an error when local markdown image data is invalid', async () => {
			window.maestro.fs.readFile = vi.fn().mockResolvedValue('not-an-image-data-url');

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Broken diagram](broken.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			expect(await screen.findByText('Invalid image data')).toBeInTheDocument();
		});

		it('shows an unknown error message when local markdown image loading rejects without a message', async () => {
			window.maestro.fs.readFile = vi.fn().mockRejectedValue({});

			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'readme.md',
						content: '![Rejected diagram](rejected.png)',
						path: '/project/docs/readme.md',
					}}
				/>
			);

			expect(await screen.findByText('Failed to load image: Unknown error')).toBeInTheDocument();
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

		it('loads full file content when "Load full file" button is clicked', () => {
			const largeContent = 'y'.repeat(200 * 1024); // 200KB
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

		it('click outside closes TOC before search and keeps the preview open', () => {
			const onClose = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					onClose={onClose}
					file={{ name: 'doc.md', content: '# Heading\nalpha alpha', path: '/test/doc.md' }}
					initialSearchQuery="alpha"
				/>
			);

			fireEvent.click(screen.getByTitle('Table of Contents'));
			expect(screen.getByText('Contents')).toBeInTheDocument();
			expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			expect(screen.queryByText('Contents')).not.toBeInTheDocument();
			expect(screen.getByPlaceholderText(/Search in file/)).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});

		it('asks for confirmation before closing dirty overlay edit content', () => {
			const onClose = vi.fn();
			render(
				<FilePreview
					{...defaultProps}
					onClose={onClose}
					file={{ name: 'test.md', content: 'original', path: '/test/test.md' }}
					markdownEditMode={true}
					externalEditContent="changed"
					isTabMode={false}
				/>
			);

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();

			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();

			fireEvent.click(screen.getByText('No, Stay'));
			expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			fireEvent.click(screen.getByText('Yes, Discard'));

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('does not close tab on Escape key when isTabMode is true', () => {
			// In tab mode, Escape should only close internal UI (search, TOC)
			// not the tab itself - tabs close via Cmd+W or close button
			const onClose = vi.fn();
			const { container } = render(
				<FilePreview {...defaultProps} onClose={onClose} isTabMode={true} />
			);

			// The callback should be registered but disabled in tab mode
			expect(mockClickOutsideEnabled.current).toBe(false);

			fireEvent.keyDown(container.firstChild as HTMLElement, { key: 'Escape' });
			expect(onClose).not.toHaveBeenCalled();

			act(() => {
				mockClickOutsideCallback.current?.();
			});
			expect(onClose).not.toHaveBeenCalled();
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

		it('renders deeper heading levels with compact TOC styling', () => {
			const markdownWithDeepHeading = '# Top\n#### Deep Heading';
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'doc.md', content: markdownWithDeepHeading, path: '/test/doc.md' }}
					markdownEditMode={false}
				/>
			);

			fireEvent.click(screen.getByTitle('Table of Contents'));

			const deepHeadingButton = screen.getByTitle('Deep Heading');
			expect(deepHeadingButton).toHaveStyle({ opacity: '0.85', fontSize: '0.75rem' });
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

		it('scrolls to heading entries and stops wheel propagation inside the TOC', () => {
			const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
			const scrollIntoView = vi.fn();
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
				value: scrollIntoView,
				configurable: true,
			});

			try {
				const { container } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'doc.md', content: '# Heading 1\n## Heading 2', path: '/test/doc.md' }}
						markdownEditMode={false}
					/>
				);

				fireEvent.click(screen.getByTitle('Table of Contents'));
				const markdownContainer = container.querySelector('.file-preview-content')!;
				const targetHeading = document.createElement('h1');
				targetHeading.id = 'heading-1';
				markdownContainer.appendChild(targetHeading);

				fireEvent.click(screen.getByTitle('Heading 1'));
				expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

				const overlay = screen.getByText('Contents').parentElement?.parentElement as HTMLElement;
				const overlayWheel = new WheelEvent('wheel', { bubbles: true });
				const stopOverlayWheel = vi.fn();
				Object.defineProperty(overlayWheel, 'stopPropagation', {
					value: stopOverlayWheel,
					configurable: true,
				});
				overlay.dispatchEvent(overlayWheel);
				expect(stopOverlayWheel).toHaveBeenCalledOnce();

				const entriesScroller = screen.getByTitle('Heading 1').parentElement!;
				const listWheel = new WheelEvent('wheel', { bubbles: true });
				const stopListWheel = vi.fn();
				Object.defineProperty(listWheel, 'stopPropagation', {
					value: stopListWheel,
					configurable: true,
				});
				entriesScroller.dispatchEvent(listWheel);
				expect(stopListWheel).toHaveBeenCalledOnce();
			} finally {
				if (originalScrollIntoView === undefined) {
					delete (HTMLElement.prototype as any).scrollIntoView;
				} else {
					Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
						value: originalScrollIntoView,
						configurable: true,
					});
				}
			}
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

		it('uses CSS Custom Highlight API for markdown search matches and cleans up on unmount', async () => {
			const originalHighlights = (CSS as any).highlights;
			const originalHighlight = (window as any).Highlight;
			const originalRangeRect = (Range.prototype as any).getBoundingClientRect;
			const originalScrollTo = HTMLElement.prototype.scrollTo;
			const highlights = {
				set: vi.fn(),
				delete: vi.fn(),
			};

			(CSS as any).highlights = highlights;
			(window as any).Highlight = vi.fn(function MockHighlight(...ranges: Range[]) {
				this.ranges = ranges;
			});
			Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
				value: vi.fn(() => ({
					top: 24,
					bottom: 34,
					left: 0,
					right: 10,
					width: 10,
					height: 10,
					x: 0,
					y: 24,
					toJSON: () => ({}),
				})),
				configurable: true,
			});
			Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
				value: vi.fn(),
				configurable: true,
			});

			try {
				const { unmount } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.md', content: 'alpha beta alpha', path: '/test/notes.md' }}
						initialSearchQuery="alpha"
					/>
				);

				expect(await screen.findByText('1/2')).toBeInTheDocument();
				expect(highlights.set).toHaveBeenCalledWith('search-results', expect.any(Object));
				expect(highlights.set).toHaveBeenCalledWith('search-current', expect.any(Object));

				fireEvent.click(screen.getByTitle('Next match (Enter)'));
				expect(await screen.findByText('2/2')).toBeInTheDocument();

				unmount();
				expect(highlights.delete).toHaveBeenCalledWith('search-results');
				expect(highlights.delete).toHaveBeenCalledWith('search-current');
			} finally {
				if (originalHighlights === undefined) {
					delete (CSS as any).highlights;
				} else {
					(CSS as any).highlights = originalHighlights;
				}
				if (originalHighlight === undefined) {
					delete (window as any).Highlight;
				} else {
					(window as any).Highlight = originalHighlight;
				}
				if (originalRangeRect === undefined) {
					delete (Range.prototype as any).getBoundingClientRect;
				} else {
					Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
						value: originalRangeRect,
						configurable: true,
					});
				}
				if (originalScrollTo === undefined) {
					delete (HTMLElement.prototype as any).scrollTo;
				} else {
					Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
						value: originalScrollTo,
						configurable: true,
					});
				}
			}
		});

		it('clears CSS markdown search highlights when there are no matches', async () => {
			const originalHighlights = (CSS as any).highlights;
			const highlights = {
				set: vi.fn(),
				delete: vi.fn(),
			};
			(CSS as any).highlights = highlights;

			try {
				const { unmount } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.md', content: 'alpha beta', path: '/test/notes.md' }}
						initialSearchQuery="missing"
					/>
				);

				expect(await screen.findByText('No matches')).toBeInTheDocument();
				expect(highlights.delete).toHaveBeenCalledWith('search-results');
				expect(highlights.delete).toHaveBeenCalledWith('search-current');
				unmount();
			} finally {
				if (originalHighlights === undefined) {
					delete (CSS as any).highlights;
				} else {
					(CSS as any).highlights = originalHighlights;
				}
			}
		});

		it('clears CSS markdown highlights when the search query is emptied', async () => {
			const originalHighlights = (CSS as any).highlights;
			const originalHighlight = (window as any).Highlight;
			const originalRangeRect = (Range.prototype as any).getBoundingClientRect;
			const originalScrollTo = HTMLElement.prototype.scrollTo;
			const highlights = {
				set: vi.fn(),
				delete: vi.fn(),
			};
			(CSS as any).highlights = highlights;
			(window as any).Highlight = vi.fn(function MockHighlight(...ranges: Range[]) {
				this.ranges = ranges;
			});
			Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
				value: vi.fn(() => ({
					top: 24,
					bottom: 34,
					left: 0,
					right: 10,
					width: 10,
					height: 10,
					x: 0,
					y: 24,
					toJSON: () => ({}),
				})),
				configurable: true,
			});
			Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
				value: vi.fn(),
				configurable: true,
			});

			try {
				const { unmount } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.md', content: 'alpha beta alpha', path: '/test/notes.md' }}
						initialSearchQuery="alpha"
					/>
				);

				expect(await screen.findByText('1/2')).toBeInTheDocument();
				fireEvent.change(screen.getByPlaceholderText(/Search in file/), { target: { value: '' } });

				await waitFor(() => {
					expect(highlights.delete).toHaveBeenCalledWith('search-results');
					expect(highlights.delete).toHaveBeenCalledWith('search-current');
				});
				unmount();
			} finally {
				if (originalHighlights === undefined) {
					delete (CSS as any).highlights;
				} else {
					(CSS as any).highlights = originalHighlights;
				}
				if (originalHighlight === undefined) {
					delete (window as any).Highlight;
				} else {
					(window as any).Highlight = originalHighlight;
				}
				if (originalRangeRect === undefined) {
					delete (Range.prototype as any).getBoundingClientRect;
				} else {
					Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
						value: originalRangeRect,
						configurable: true,
					});
				}
				if (originalScrollTo === undefined) {
					delete (HTMLElement.prototype as any).scrollTo;
				} else {
					Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
						value: originalScrollTo,
						configurable: true,
					});
				}
			}
		});

		it('falls back to text walking for markdown search when CSS highlights are unavailable', async () => {
			const originalHighlights = (CSS as any).highlights;
			const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
			const scrollIntoView = vi.fn();

			delete (CSS as any).highlights;
			Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
				value: scrollIntoView,
				configurable: true,
			});

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.md', content: 'alpha beta alpha', path: '/test/notes.md' }}
						initialSearchQuery="alpha"
					/>
				);

				expect(await screen.findByText('1/2')).toBeInTheDocument();
				expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });

				fireEvent.click(screen.getByTitle('Next match (Enter)'));

				expect(await screen.findByText('2/2')).toBeInTheDocument();
			} finally {
				if (originalHighlights !== undefined) {
					(CSS as any).highlights = originalHighlights;
				}
				if (originalScrollIntoView === undefined) {
					delete (HTMLElement.prototype as any).scrollIntoView;
				} else {
					Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
						value: originalScrollIntoView,
						configurable: true,
					});
				}
			}
		});

		it('reports no markdown matches in the text-walking fallback', async () => {
			const originalHighlights = (CSS as any).highlights;
			delete (CSS as any).highlights;

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.md', content: 'alpha beta', path: '/test/notes.md' }}
						initialSearchQuery="missing"
					/>
				);

				expect(await screen.findByText('No matches')).toBeInTheDocument();
			} finally {
				if (originalHighlights !== undefined) {
					(CSS as any).highlights = originalHighlights;
				}
			}
		});

		it('navigates highlighted code search matches with next and previous controls', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{
						name: 'test.ts',
						content: 'const foo = "foo";\nfoo();',
						path: '/test/test.ts',
					}}
					initialSearchQuery="foo"
				/>
			);

			expect(await screen.findByText('1/3')).toBeInTheDocument();
			expect(document.querySelectorAll('mark.search-match')).toHaveLength(3);

			fireEvent.click(screen.getByTitle('Next match (Enter)'));
			expect(await screen.findByText('2/3')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Previous match (Shift+Enter)'));
			expect(await screen.findByText('1/3')).toBeInTheDocument();
		});

		it('highlights a code search match that spans the entire text node', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'foo', path: '/test/test.ts' }}
					initialSearchQuery="foo"
				/>
			);

			expect(await screen.findByText('1/1')).toBeInTheDocument();
			expect(document.querySelectorAll('mark.search-match')).toHaveLength(1);
		});

		it('counts no matches for edit-mode search queries', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'alpha beta gamma', path: '/test/notes.txt' }}
					markdownEditMode={true}
					initialSearchQuery="missing"
				/>
			);

			expect(await screen.findByText('No matches')).toBeInTheDocument();
			expect(screen.getByDisplayValue('alpha beta gamma')).toBeInTheDocument();
		});

		it('selects the active match when navigating edit-mode search results', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'notes.txt', content: 'alpha beta alpha', path: '/test/notes.txt' }}
					markdownEditMode={true}
					initialSearchQuery="alpha"
				/>
			);

			const textarea = screen.getByDisplayValue('alpha beta alpha') as HTMLTextAreaElement;
			expect(await screen.findByText('1/2')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Next match (Enter)'));

			expect(await screen.findByText('2/2')).toBeInTheDocument();
			await waitFor(() => {
				expect(textarea.selectionStart).toBe(11);
				expect(textarea.selectionEnd).toBe(16);
			});

			fireEvent.click(screen.getByTitle('Previous match (Shift+Enter)'));

			expect(await screen.findByText('1/2')).toBeInTheDocument();
		});

		it('uses a fallback line height when navigating edit-mode search matches', async () => {
			const getComputedStyleSpy = vi
				.spyOn(window, 'getComputedStyle')
				.mockReturnValue({ lineHeight: 'normal' } as CSSStyleDeclaration);

			try {
				const { container } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'notes.txt', content: 'alpha\nbeta\nalpha', path: '/test/notes.txt' }}
						markdownEditMode={true}
						initialSearchQuery="alpha"
					/>
				);

				const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
				expect(await screen.findByText('1/2')).toBeInTheDocument();

				fireEvent.click(screen.getByTitle('Next match (Enter)'));

				expect(await screen.findByText('2/2')).toBeInTheDocument();
				await waitFor(() => {
					expect(textarea.selectionStart).toBe(11);
				});
			} finally {
				getComputedStyleSpy.mockRestore();
			}
		});

		it('clamps edit-mode search index when edited content loses matches', async () => {
			const file = { name: 'notes.txt', content: 'alpha beta alpha', path: '/test/notes.txt' };
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					file={file}
					markdownEditMode={true}
					externalEditContent="alpha beta alpha"
					initialSearchQuery="alpha"
				/>
			);

			expect(await screen.findByText('1/2')).toBeInTheDocument();
			fireEvent.click(screen.getByTitle('Next match (Enter)'));
			expect(await screen.findByText('2/2')).toBeInTheDocument();

			rerender(
				<FilePreview
					{...defaultProps}
					file={file}
					markdownEditMode={true}
					externalEditContent="alpha only once"
					initialSearchQuery="alpha"
				/>
			);

			expect(await screen.findByText('1/1')).toBeInTheDocument();
		});

		it('handles search input Enter, Shift+Enter, and Escape keys', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'const foo = "foo";\nfoo();', path: '/test/test.ts' }}
					initialSearchQuery="foo"
				/>
			);

			const searchInput = screen.getByPlaceholderText(/Search in file/);
			expect(await screen.findByText('1/3')).toBeInTheDocument();

			fireEvent.keyDown(searchInput, { key: 'Enter' });
			expect(await screen.findByText('2/3')).toBeInTheDocument();

			fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });
			expect(await screen.findByText('1/3')).toBeInTheDocument();

			fireEvent.keyDown(searchInput, { key: 'Tab' });
			expect(await screen.findByText('1/3')).toBeInTheDocument();

			fireEvent.keyDown(searchInput, { key: 'Escape' });
			expect(screen.queryByPlaceholderText(/Search in file/)).not.toBeInTheDocument();
		});

		it('keeps no-match search navigation as a no-op', async () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'test.ts', content: 'const foo = "bar";', path: '/test/test.ts' }}
					initialSearchQuery="missing"
				/>
			);

			const searchInput = screen.getByPlaceholderText(/Search in file/);
			expect(await screen.findByText('No matches')).toBeInTheDocument();

			fireEvent.keyDown(searchInput, { key: 'Enter' });
			fireEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });

			expect(screen.getByText('No matches')).toBeInTheDocument();
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

	describe('navigation history controls', () => {
		it('opens back and forward history popups and navigates to selected entries', async () => {
			const onNavigateBack = vi.fn();
			const onNavigateForward = vi.fn();
			const onNavigateToIndex = vi.fn();

			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'current.md', content: '# Current', path: '/test/current.md' }}
					canGoBack={true}
					canGoForward={true}
					onNavigateBack={onNavigateBack}
					onNavigateForward={onNavigateForward}
					onNavigateToIndex={onNavigateToIndex}
					currentHistoryIndex={1}
					backHistory={[
						{ name: 'Earlier.md', path: '/test/earlier.md' },
						{ name: 'Previous.md', path: '/test/previous.md' },
					]}
					forwardHistory={[
						{ name: 'Next.md', path: '/test/next.md' },
						{ name: 'Later.md', path: '/test/later.md' },
					]}
				/>
			);

			const backButton = screen.getByTitle('Go back (Ctrl+ARROWLEFT)');
			const forwardButton = screen.getByTitle('Go forward (Ctrl+ARROWRIGHT)');

			fireEvent.click(backButton);
			fireEvent.click(forwardButton);
			expect(onNavigateBack).toHaveBeenCalledOnce();
			expect(onNavigateForward).toHaveBeenCalledOnce();

			fireEvent.mouseEnter(backButton.parentElement!);
			fireEvent.click(await screen.findByText('Previous.md'));
			expect(onNavigateToIndex).toHaveBeenCalledWith(1);

			fireEvent.mouseEnter(forwardButton.parentElement!);
			fireEvent.click(await screen.findByText('Later.md'));
			expect(onNavigateToIndex).toHaveBeenCalledWith(3);
		});

		it('closes navigation popups after their hover leave delay', () => {
			vi.useFakeTimers();

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'current.md', content: '# Current', path: '/test/current.md' }}
						canGoBack={true}
						canGoForward={true}
						onNavigateBack={vi.fn()}
						onNavigateForward={vi.fn()}
						backHistory={[{ name: 'Previous.md', path: '/test/previous.md' }]}
						forwardHistory={[{ name: 'Next.md', path: '/test/next.md' }]}
					/>
				);

				const backWrapper = screen.getByTitle('Go back (Ctrl+ARROWLEFT)').parentElement!;
				fireEvent.mouseEnter(backWrapper);
				expect(screen.getByText('Previous.md')).toBeInTheDocument();
				fireEvent.mouseLeave(backWrapper);
				act(() => {
					vi.advanceTimersByTime(150);
				});
				expect(screen.queryByText('Previous.md')).not.toBeInTheDocument();

				const forwardWrapper = screen.getByTitle('Go forward (Ctrl+ARROWRIGHT)').parentElement!;
				fireEvent.mouseEnter(forwardWrapper);
				expect(screen.getByText('Next.md')).toBeInTheDocument();
				fireEvent.mouseLeave(forwardWrapper);
				act(() => {
					vi.advanceTimersByTime(150);
				});
				expect(screen.queryByText('Next.md')).not.toBeInTheDocument();
			} finally {
				vi.runOnlyPendingTimers();
				vi.useRealTimers();
			}
		});

		it('clears pending navigation popup close timers when hovering back in', () => {
			vi.useFakeTimers();
			const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'current.md', content: '# Current', path: '/test/current.md' }}
						canGoBack={true}
						onNavigateBack={vi.fn()}
						backHistory={[{ name: 'Previous.md', path: '/test/previous.md' }]}
					/>
				);

				const backButton = screen.getByTitle('Go back (Ctrl+ARROWLEFT)');
				const wrapper = backButton.parentElement!;

				fireEvent.mouseEnter(wrapper);
				expect(screen.getByText('Previous.md')).toBeInTheDocument();

				fireEvent.mouseLeave(wrapper);
				fireEvent.mouseEnter(wrapper);

				expect(clearTimeoutSpy).toHaveBeenCalled();
			} finally {
				vi.runOnlyPendingTimers();
				clearTimeoutSpy.mockRestore();
				vi.useRealTimers();
			}
		});

		it('clears pending forward popup close timers when hovering back in', () => {
			vi.useFakeTimers();
			const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

			try {
				render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'current.md', content: '# Current', path: '/test/current.md' }}
						canGoForward={true}
						onNavigateForward={vi.fn()}
						forwardHistory={[{ name: 'Next.md', path: '/test/next.md' }]}
					/>
				);

				const forwardButton = screen.getByTitle('Go forward (Ctrl+ARROWRIGHT)');
				const wrapper = forwardButton.parentElement!;

				fireEvent.mouseEnter(wrapper);
				expect(screen.getByText('Next.md')).toBeInTheDocument();

				fireEvent.mouseLeave(wrapper);
				fireEvent.mouseEnter(wrapper);

				expect(clearTimeoutSpy).toHaveBeenCalled();
			} finally {
				vi.runOnlyPendingTimers();
				clearTimeoutSpy.mockRestore();
				vi.useRealTimers();
			}
		});

		it('does not open disabled navigation history popups on hover', () => {
			const { rerender } = render(
				<FilePreview
					{...defaultProps}
					canGoBack={false}
					canGoForward={true}
					backHistory={[{ name: 'Back item', path: '/test/back.md' }]}
					forwardHistory={[{ name: 'Forward item', path: '/test/forward.md' }]}
				/>
			);

			fireEvent.mouseEnter(screen.getByTitle('Go back (Ctrl+ARROWLEFT)').parentElement!);
			expect(screen.queryByText('Back item')).not.toBeInTheDocument();

			rerender(
				<FilePreview
					{...defaultProps}
					canGoBack={true}
					canGoForward={false}
					backHistory={[{ name: 'Back item', path: '/test/back.md' }]}
					forwardHistory={[{ name: 'Forward item', path: '/test/forward.md' }]}
				/>
			);

			fireEvent.mouseEnter(screen.getByTitle('Go forward (Ctrl+ARROWRIGHT)').parentElement!);
			expect(screen.queryByText('Forward item')).not.toBeInTheDocument();
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

		it('replaces pending scroll save timers when scroll events repeat quickly', () => {
			const onScrollPositionChange = vi.fn();
			vi.useFakeTimers();
			const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
			let unmount: (() => void) | undefined;

			try {
				({ unmount } = render(
					<FilePreview
						{...defaultProps}
						file={{ name: 'test.md', content: 'Some content', path: '/test/test.md' }}
						onScrollPositionChange={onScrollPositionChange}
					/>
				));

				const container = document.querySelector('.overflow-y-auto')!;
				fireEvent.scroll(container, { target: { scrollTop: 100 } });
				fireEvent.scroll(container, { target: { scrollTop: 200 } });

				expect(clearTimeoutSpy).toHaveBeenCalled();
				act(() => {
					vi.advanceTimersByTime(200);
				});
				expect(onScrollPositionChange).toHaveBeenCalledWith(200);
			} finally {
				unmount?.();
				clearTimeoutSpy.mockRestore();
				vi.useRealTimers();
			}
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

		it('does not restore scroll again for the same file after the first restore', () => {
			const originalGlobalRaf = Object.getOwnPropertyDescriptor(
				globalThis,
				'requestAnimationFrame'
			);
			const originalWindowRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
			const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			});
			Object.defineProperty(globalThis, 'requestAnimationFrame', {
				value: requestAnimationFrameMock,
				configurable: true,
				writable: true,
			});
			Object.defineProperty(window, 'requestAnimationFrame', {
				value: requestAnimationFrameMock,
				configurable: true,
				writable: true,
			});

			try {
				const file = { name: 'test.md', content: 'Some content', path: '/test/test.md' };
				const { rerender } = render(
					<FilePreview {...defaultProps} file={file} initialScrollTop={150} />
				);
				expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);

				rerender(<FilePreview {...defaultProps} file={file} />);

				expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);
			} finally {
				if (originalGlobalRaf === undefined) {
					delete (globalThis as any).requestAnimationFrame;
				} else {
					Object.defineProperty(globalThis, 'requestAnimationFrame', originalGlobalRaf);
				}
				if (originalWindowRaf === undefined) {
					delete (window as any).requestAnimationFrame;
				} else {
					Object.defineProperty(window, 'requestAnimationFrame', originalWindowRaf);
				}
			}
		});

		it('syncs preview scroll percentage into the textarea when entering edit mode', () => {
			const originalGlobalRaf = Object.getOwnPropertyDescriptor(
				globalThis,
				'requestAnimationFrame'
			);
			const originalWindowRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
			const rafCallbacks: FrameRequestCallback[] = [];
			const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
				rafCallbacks.push(callback);
				return rafCallbacks.length;
			});
			Object.defineProperty(globalThis, 'requestAnimationFrame', {
				value: requestAnimationFrameMock,
				configurable: true,
				writable: true,
			});
			Object.defineProperty(window, 'requestAnimationFrame', {
				value: requestAnimationFrameMock,
				configurable: true,
				writable: true,
			});

			try {
				const file = { name: 'notes.txt', content: 'line\n'.repeat(50), path: '/test/notes.txt' };
				const { container, rerender } = render(
					<FilePreview {...defaultProps} file={file} markdownEditMode={false} />
				);
				const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
				Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1000, configurable: true });
				Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true });
				scrollContainer.scrollTop = 400;

				rerender(<FilePreview {...defaultProps} file={file} markdownEditMode={true} />);
				const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				Object.defineProperty(textarea, 'scrollHeight', { value: 500, configurable: true });
				Object.defineProperty(textarea, 'clientHeight', { value: 100, configurable: true });

				act(() => {
					rafCallbacks.forEach((callback) => callback(0));
				});

				expect(textarea.scrollTop).toBe(200);
			} finally {
				if (originalGlobalRaf === undefined) {
					delete (globalThis as any).requestAnimationFrame;
				} else {
					Object.defineProperty(globalThis, 'requestAnimationFrame', originalGlobalRaf);
				}
				if (originalWindowRaf === undefined) {
					delete (window as any).requestAnimationFrame;
				} else {
					Object.defineProperty(window, 'requestAnimationFrame', originalWindowRaf);
				}
			}
		});

		it('syncs textarea scroll percentage back into preview when leaving edit mode', () => {
			const originalGlobalRaf = Object.getOwnPropertyDescriptor(
				globalThis,
				'requestAnimationFrame'
			);
			const originalWindowRaf = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
			const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			});
			Object.defineProperty(globalThis, 'requestAnimationFrame', {
				value: requestAnimationFrameMock,
				configurable: true,
				writable: true,
			});
			Object.defineProperty(window, 'requestAnimationFrame', {
				value: requestAnimationFrameMock,
				configurable: true,
				writable: true,
			});

			try {
				const file = { name: 'notes.txt', content: 'line\n'.repeat(50), path: '/test/notes.txt' };
				const { container, rerender } = render(
					<FilePreview {...defaultProps} file={file} markdownEditMode={true} />
				);
				const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				Object.defineProperty(textarea, 'scrollHeight', { value: 1000, configurable: true });
				Object.defineProperty(textarea, 'clientHeight', { value: 200, configurable: true });
				textarea.scrollTop = 400;

				const scrollContainer = container.querySelector('.overflow-y-auto') as HTMLElement;
				Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1200, configurable: true });
				Object.defineProperty(scrollContainer, 'clientHeight', { value: 200, configurable: true });

				rerender(<FilePreview {...defaultProps} file={file} markdownEditMode={false} />);

				expect(requestAnimationFrameMock).toHaveBeenCalled();
				expect(scrollContainer.scrollTop).toBe(500);
			} finally {
				if (originalGlobalRaf === undefined) {
					delete (globalThis as any).requestAnimationFrame;
				} else {
					Object.defineProperty(globalThis, 'requestAnimationFrame', originalGlobalRaf);
				}
				if (originalWindowRaf === undefined) {
					delete (window as any).requestAnimationFrame;
				} else {
					Object.defineProperty(window, 'requestAnimationFrame', originalWindowRaf);
				}
			}
		});

		it('does not require a previous textarea when leaving edit mode after a null file', () => {
			const file = { name: 'notes.txt', content: 'line\n'.repeat(5), path: '/test/notes.txt' };
			const { rerender } = render(
				<FilePreview {...defaultProps} file={null} markdownEditMode={true} />
			);

			expect(() =>
				rerender(<FilePreview {...defaultProps} file={file} markdownEditMode={false} />)
			).not.toThrow();
			expect(screen.getByText('notes.txt')).toBeInTheDocument();
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

		it('uses CsvTableRenderer match counts for search status', () => {
			render(
				<FilePreview
					{...defaultProps}
					file={{ name: 'data.csv', content: 'Name,Age\nAlice,30', path: '/test/data.csv' }}
					initialSearchQuery="Alice"
				/>
			);

			expect(csvRendererMocks.lastOnMatchCount).toEqual(expect.any(Function));

			act(() => {
				csvRendererMocks.lastOnMatchCount?.(3);
			});
			expect(screen.getByText('1/3')).toBeInTheDocument();

			act(() => {
				csvRendererMocks.lastOnMatchCount?.(0);
			});
			expect(screen.getByText('No matches')).toBeInTheDocument();
		});
	});
});
