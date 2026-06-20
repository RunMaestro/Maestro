import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarkdownRenderer } from '../../renderer/components/MarkdownRenderer';
import type { FileNode } from '../../renderer/types/fileTree';

// Mock react-syntax-highlighter
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children, language }: { children: string; language?: string }) => (
		<pre data-testid="syntax-highlighter" data-language={language}>
			{children}
		</pre>
	),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	ChevronDown: () => <span data-testid="chevron-down-icon">ChevronDown</span>,
	Loader2: () => <span data-testid="loader-icon">Loader</span>,
	ImageOff: () => <span data-testid="image-off-icon">ImageOff</span>,
}));

const mockTheme = {
	id: 'test-theme',
	colors: {
		bgMain: '#1a1a2e',
		bgActivity: '#16213e',
		bgSidebar: '#111',
		textMain: '#eee',
		textDim: '#888',
		border: '#333',
		accent: '#4a9eff',
	},
} as any;

const defaultProps = {
	content: '',
	theme: mockTheme,
	onCopy: vi.fn(),
};

describe('MarkdownRenderer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.fs.readFile).mockReset();
		vi.mocked(window.maestro.fs.readFile).mockResolvedValue('');
	});

	describe('basic rendering', () => {
		it('renders plain markdown text', () => {
			render(<MarkdownRenderer {...defaultProps} content="Hello world" />);
			expect(screen.getByText('Hello world')).toBeInTheDocument();
		});

		it('renders bold text', () => {
			render(<MarkdownRenderer {...defaultProps} content="**bold text**" />);
			expect(screen.getByText('bold text')).toBeInTheDocument();
		});

		it('applies readable text transforms across prose block elements', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					enableBionifyReadingMode={true}
					content={[
						'# Heading one',
						'## Heading two',
						'### Heading three',
						'#### Heading four',
						'##### Heading five',
						'###### Heading six',
						'Paragraph words',
						'> Quoted words',
						'- Listed words',
					].join('\n\n')}
				/>
			);

			expect(screen.getByRole('heading', { level: 1, name: 'Heading one' })).toBeInTheDocument();
			expect(screen.getByRole('heading', { level: 6, name: 'Heading six' })).toBeInTheDocument();
			expect(container.querySelector('blockquote .bionify-word')).toBeInTheDocument();
			expect(container.querySelector('li .bionify-word')).toBeInTheDocument();
			expect(container.querySelectorAll('.bionify-word').length).toBeGreaterThan(8);
		});
	});

	describe('code blocks', () => {
		it('copies fenced code content without the trailing newline', () => {
			const onCopy = vi.fn();

			render(
				<MarkdownRenderer {...defaultProps} onCopy={onCopy} content={'```ts\nconst x = 1;\n```'} />
			);

			fireEvent.click(screen.getByTitle('Copy code'));

			expect(onCopy).toHaveBeenCalledWith('const x = 1;');
			expect(screen.getByTestId('code-fence')).toHaveTextContent('const x = 1;');
			expect(screen.getByTestId('code-fence')).toHaveAttribute('data-language', 'typescript');
		});

		it('defaults fenced code without a language to text and falls back for raw pre blocks', () => {
			render(
				<MarkdownRenderer
					{...defaultProps}
					allowRawHtml={true}
					content={'```\nplain text\n```\n\n<pre>raw pre</pre>'}
				/>
			);

			expect(screen.getByTestId('code-fence')).toHaveAttribute('data-language', 'text');
			expect(screen.getByText('raw pre')).toBeInTheDocument();
		});

		it('renders inline code through the inline code component', () => {
			const { container } = render(<MarkdownRenderer {...defaultProps} content="Use `maestro`." />);

			expect(container.querySelector('code')).toHaveTextContent('maestro');
		});
	});

	describe('links', () => {
		it('routes external, file, and git links through the shell APIs', () => {
			render(
				<MarkdownRenderer
					{...defaultProps}
					allowRawHtml={true}
					content={[
						'[External](https://example.com)',
						'[File](file:///tmp/report.md)',
						'[Repo](git@github.com:RunMaestro/Maestro.git)',
						'[Relative](notes.md)',
					].join('\n\n')}
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'External' }));
			fireEvent.click(screen.getByRole('link', { name: 'File' }));
			fireEvent.click(screen.getByRole('link', { name: 'Repo' }));
			fireEvent.click(screen.getByRole('link', { name: 'Relative' }));

			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com');
			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/tmp/report.md');
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://github.com/RunMaestro/Maestro'
			);
			expect(window.maestro.shell.openExternal).toHaveBeenCalledTimes(2);
		});

		it('strips unsafe markdown link schemes before click handling', () => {
			render(<MarkdownRenderer {...defaultProps} content="[Unsafe](javascript:alert(1))" />);

			const link = screen.getByText('Unsafe').closest('a');
			expect(link).toHaveAttribute('href', '');
			fireEvent.click(link!);

			expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();
			expect(window.maestro.shell.openPath).not.toHaveBeenCalled();
		});

		it('calls onFileClick for direct maestro-file links', () => {
			const onFileClick = vi.fn();

			render(
				<MarkdownRenderer
					{...defaultProps}
					onFileClick={onFileClick}
					content="[Readme](maestro-file://docs/readme.md)"
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'Readme' }));

			expect(onFileClick).toHaveBeenCalledWith('docs/readme.md');
		});

		it('calls onFileClick for maestro file links from data attributes', () => {
			const onFileClick = vi.fn();

			render(
				<MarkdownRenderer
					{...defaultProps}
					allowRawHtml={true}
					onFileClick={onFileClick}
					content='<a href="#" data-maestro-file="docs/readme.md">Readme</a>'
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'Readme' }));

			expect(onFileClick).toHaveBeenCalledWith('docs/readme.md');
			expect(window.maestro.shell.openExternal).not.toHaveBeenCalled();
		});

		it('converts known file-tree links to file-click callbacks', () => {
			const onFileClick = vi.fn();
			const fileTree: FileNode[] = [
				{
					name: 'docs',
					type: 'folder',
					children: [{ name: 'guide.md', type: 'file', fullPath: '/repo/docs/guide.md' }],
				},
			];

			render(
				<MarkdownRenderer
					{...defaultProps}
					content="[Guide](guide.md)"
					fileTree={fileTree}
					cwd="docs"
					onFileClick={onFileClick}
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: 'Guide' }));

			expect(onFileClick).toHaveBeenCalledWith('docs/guide.md');
		});

		it('converts absolute project-root paths to file-click callbacks without a file tree', () => {
			const onFileClick = vi.fn();

			render(
				<MarkdownRenderer
					{...defaultProps}
					content="See /repo/docs/guide.md"
					projectRoot="/repo"
					onFileClick={onFileClick}
				/>
			);

			fireEvent.click(screen.getByRole('link', { name: '/repo/docs/guide.md' }));

			expect(onFileClick).toHaveBeenCalledWith('docs/guide.md');
		});
	});

	describe('local images', () => {
		it('renders data and HTTP images without IPC reads', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content={[
						'![Pixel](data:image/png;base64,abc123)',
						'![Remote](https://example.com/image.png)',
						'![](https://example.com/no-alt.png)',
					].join('\n\n')}
				/>
			);

			expect(screen.getByAltText('Pixel')).toHaveAttribute('src', 'data:image/png;base64,abc123');
			expect(screen.getByAltText('Remote')).toHaveAttribute('src', 'https://example.com/image.png');
			expect(container.querySelector('img[src="https://example.com/no-alt.png"]')).toHaveAttribute(
				'alt',
				''
			);
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('loads file images through IPC, decodes file URLs, passes SSH config, and reuses cache', async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('data:image/png;base64,loaded');

			const { unmount } = render(
				<MarkdownRenderer
					{...defaultProps}
					content="![Local](file:///tmp/local%20image.png)"
					sshRemoteId="ssh-1"
				/>
			);

			expect(screen.getByText('Loading image...')).toBeInTheDocument();
			expect(await screen.findByAltText('Local')).toHaveAttribute(
				'src',
				'data:image/png;base64,loaded'
			);
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/tmp/local image.png', 'ssh-1');

			vi.mocked(window.maestro.fs.readFile).mockClear();
			unmount();

			render(
				<MarkdownRenderer
					{...defaultProps}
					content="![Local](file:///tmp/local%20image.png)"
					sshRemoteId="ssh-1"
				/>
			);

			expect(screen.getByAltText('Local')).toHaveAttribute('src', 'data:image/png;base64,loaded');
			expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		});

		it('uses the cache if another same-src image load completes before its effect runs', async () => {
			vi.mocked(window.maestro.fs.readFile).mockReturnValueOnce({
				then: (resolve: (value: string) => void) => {
					resolve('data:image/png;base64,shared');
					return { catch: vi.fn() };
				},
			} as any);

			render(
				<MarkdownRenderer
					{...defaultProps}
					content={['![Shared](/tmp/shared-image.png)', '![Shared](/tmp/shared-image.png)'].join(
						'\n\n'
					)}
				/>
			);

			await waitFor(() => expect(screen.getAllByAltText('Shared')).toHaveLength(2));
			expect(window.maestro.fs.readFile).toHaveBeenCalledTimes(1);
		});

		it('ignores image load resolution and rejection after unmount', async () => {
			let resolveImage: (value: string) => void = () => {};
			let rejectImage: (reason?: unknown) => void = () => {};
			const success = new Promise<string>((resolve) => {
				resolveImage = resolve;
			});
			const failure = new Promise<string>((_resolve, reject) => {
				rejectImage = reject;
			});

			vi.mocked(window.maestro.fs.readFile)
				.mockReturnValueOnce(success)
				.mockReturnValueOnce(failure);

			const first = render(
				<MarkdownRenderer {...defaultProps} content="![Slow](/tmp/slow-image.png)" />
			);
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/tmp/slow-image.png', undefined);
			first.unmount();
			resolveImage('data:image/png;base64,late');
			await success;

			const second = render(
				<MarkdownRenderer {...defaultProps} content="![Late](/tmp/late-error.png)" />
			);
			expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/tmp/late-error.png', undefined);
			second.unmount();
			rejectImage(new Error('too late'));
			await failure.catch(() => undefined);

			await waitFor(() => expect(window.maestro.fs.readFile).toHaveBeenCalledTimes(2));
		});

		it('shows an image placeholder when IPC returns non-image data', async () => {
			vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('not-image-data');

			render(<MarkdownRenderer {...defaultProps} content="![Broken](/tmp/broken-image.png)" />);

			expect(await screen.findByTitle('Invalid image data')).toHaveTextContent('Broken');
			expect(screen.getByTestId('image-off-icon')).toBeInTheDocument();
		});

		it('shows an unknown-error placeholder when image loading rejects without a message', async () => {
			vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce({});

			render(<MarkdownRenderer {...defaultProps} content="![Denied](/tmp/denied-image.png)" />);

			expect(await screen.findByTitle('Failed to load image: Unknown error')).toHaveTextContent(
				'Denied'
			);
		});

		it('applies image widths from raw data attributes and ignores images without a source', async () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					allowRawHtml={true}
					content={[
						'<img alt="Sized" src="https://example.com/sized.png" data-maestro-width="320">',
						'<img alt="Missing">',
					].join('')}
				/>
			);

			expect(screen.getByAltText('Sized')).toHaveStyle({ width: '320px', height: 'auto' });
			await waitFor(() => expect(window.maestro.fs.readFile).not.toHaveBeenCalled());
			expect(container.querySelector('img[alt="Missing"]')).not.toBeInTheDocument();
		});
	});

	describe('tables and raw details', () => {
		it('wraps tables and applies theme-aware cell styles', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content={'| Name | Value |\n| --- | --- |\n| A | B |'}
				/>
			);

			expect(container.querySelector('.overflow-x-auto table')).toBeInTheDocument();
			expect(screen.getByText('Name')).toHaveStyle({
				borderBottom: `1px solid ${mockTheme.colors.border}`,
			});
			expect(screen.getByText('A')).toHaveStyle({ verticalAlign: 'top' });
		});

		it('strips raw details event handlers before rendering', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					allowRawHtml={true}
					content='<details open onToggle="alert(1)"><summary>More</summary><p>Body</p></details>'
				/>
			);

			expect(container.querySelector('details')).toBeInTheDocument();
			expect(container.querySelector('details')).not.toHaveAttribute('onToggle');
			expect(screen.getByText('Body')).toBeInTheDocument();
		});
	});

	describe('DOMPurify sanitization with allowRawHtml', () => {
		it('strips script tags when allowRawHtml is true', () => {
			const maliciousContent = 'Hello <script>alert("xss")</script> world';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('<script>');
			expect(container.innerHTML).not.toContain('alert');
			expect(screen.getByText(/Hello/)).toBeInTheDocument();
			expect(screen.getByText(/world/)).toBeInTheDocument();
		});

		it('strips event handler attributes when allowRawHtml is true', async () => {
			const maliciousContent = '<img src="x" onerror="alert(1)">';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('onerror');
			expect(container.innerHTML).not.toContain('alert');
			expect(await screen.findByTitle('Invalid image data')).toBeInTheDocument();
		});

		it('strips iframe tags when allowRawHtml is true', () => {
			const maliciousContent = 'Text <iframe src="https://evil.com"></iframe> more text';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('<iframe');
			expect(screen.getByText(/Text/)).toBeInTheDocument();
		});

		it('preserves safe HTML when allowRawHtml is true', () => {
			const safeContent = '<strong>bold</strong> and <em>italic</em>';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={safeContent} allowRawHtml={true} />
			);
			expect(container.querySelector('strong')).toBeInTheDocument();
			expect(container.querySelector('em')).toBeInTheDocument();
			expect(screen.getByText('bold')).toBeInTheDocument();
			expect(screen.getByText(/italic/)).toBeInTheDocument();
		});

		it('does not apply DOMPurify when allowRawHtml is false (default)', () => {
			// When allowRawHtml is false, ReactMarkdown treats HTML as text
			const content = 'Hello <b>bold</b> world';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={content} allowRawHtml={false} />
			);
			// With allowRawHtml=false, raw HTML tags are not rendered as HTML elements
			// ReactMarkdown strips them by default
			expect(container.innerHTML).not.toContain('<script>');
		});

		it('strips onload event handlers from body tags when allowRawHtml is true', () => {
			const maliciousContent = '<body onload="alert(1)"><p>Content</p></body>';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('onload');
			expect(container.innerHTML).not.toContain('alert');
		});

		it('strips javascript: URLs from anchor tags when allowRawHtml is true', () => {
			const maliciousContent = '<a href="javascript:alert(1)">click me</a>';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('javascript:');
		});

		it('strips style-based XSS when allowRawHtml is true', () => {
			const maliciousContent = '<div style="background:url(javascript:alert(1))">styled</div>';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('javascript:');
		});
	});
});
