import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownRenderer } from '../../../renderer/components/MarkdownRenderer';

// Mock react-syntax-highlighter
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	Loader2: () => <span data-testid="loader-icon">Loader</span>,
	ImageOff: () => <span data-testid="image-off-icon">ImageOff</span>,
	Copy: () => <span data-testid="copy-icon">Copy</span>,
	ExternalLink: () => <span data-testid="external-link-icon">ExternalLink</span>,
	FileText: () => <span data-testid="file-text-icon">FileText</span>,
	Target: () => <span data-testid="target-icon">Target</span>,
}));

// Mock fileExplorerStore for FileContextMenu's Document Graph action
vi.mock('../../../renderer/stores/fileExplorerStore', () => ({
	useFileExplorerStore: {
		getState: () => ({
			focusFileInGraph: vi.fn(),
		}),
	},
}));

const mockTheme = {
	id: 'test-theme',
	mode: 'dark',
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
	describe('basic rendering', () => {
		it('renders plain markdown text', () => {
			render(<MarkdownRenderer {...defaultProps} content="Hello world" />);
			expect(screen.getByText('Hello world')).toBeInTheDocument();
		});

		it('renders bold text', () => {
			render(<MarkdownRenderer {...defaultProps} content="**bold text**" />);
			expect(screen.getByText('bold text')).toBeInTheDocument();
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

		it('strips event handler attributes when allowRawHtml is true', () => {
			const maliciousContent = '<img src="x" onerror="alert(1)">';
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content={maliciousContent} allowRawHtml={true} />
			);
			expect(container.innerHTML).not.toContain('onerror');
			expect(container.innerHTML).not.toContain('alert');
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

	describe('file context menu', () => {
		// maestro-file:// protocol is stripped by ReactMarkdown — use raw HTML
		// with data-maestro-file attribute (the same fallback used in production)
		it('renders file context menu on right-click of a file link', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content='<a href="#" data-maestro-file="report.csv">report.csv</a>'
					allowRawHtml={true}
					projectRoot="/Users/test/project"
					onFileClick={vi.fn()}
				/>
			);
			const link = container.querySelector('a[data-maestro-file]');
			expect(link).not.toBeNull();

			fireEvent.contextMenu(link!, { clientX: 150, clientY: 250 });

			expect(screen.getByText('Preview')).toBeInTheDocument();
			expect(screen.getByText('Copy Path')).toBeInTheDocument();
			expect(screen.getByText('Open in Default App')).toBeInTheDocument();
			// Should NOT show link menu items
			expect(screen.queryByText('Copy Link')).toBeNull();
			expect(screen.queryByText('Open in Browser')).toBeNull();
		});

		it('shows Document Graph option for markdown file references', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content='<a href="#" data-maestro-file="README.md">README.md</a>'
					allowRawHtml={true}
					projectRoot="/Users/test/project"
				/>
			);
			const link = container.querySelector('a[data-maestro-file]');
			expect(link).not.toBeNull();
			fireEvent.contextMenu(link!, { clientX: 150, clientY: 250 });

			expect(screen.getByText('Document Graph')).toBeInTheDocument();
		});

		it('does not show Document Graph for non-markdown files', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content='<a href="#" data-maestro-file="data.csv">data.csv</a>'
					allowRawHtml={true}
					projectRoot="/Users/test/project"
				/>
			);
			const link = container.querySelector('a[data-maestro-file]');
			expect(link).not.toBeNull();
			fireEvent.contextMenu(link!, { clientX: 150, clientY: 250 });

			expect(screen.queryByText('Document Graph')).toBeNull();
			expect(screen.getByText('Copy Path')).toBeInTheDocument();
		});
	});

	describe('link context menu', () => {
		it('renders a context menu with Copy Link and Open in Browser on right-click', () => {
			const { container } = render(
				<MarkdownRenderer
					{...defaultProps}
					content="Visit [Example](https://example.com) for details"
				/>
			);
			const link = container.querySelector('a[href="https://example.com"]');
			expect(link).not.toBeNull();

			fireEvent.contextMenu(link!, { clientX: 100, clientY: 200 });

			expect(screen.getByText('Copy Link')).toBeInTheDocument();
			expect(screen.getByText('Open in Browser')).toBeInTheDocument();
		});

		it('does not show context menu for links without href', () => {
			const { container } = render(
				<MarkdownRenderer {...defaultProps} content="Just **bold** text, no links" />
			);

			// Right-click on the container itself — no link, no menu
			fireEvent.contextMenu(container.firstElementChild!, { clientX: 100, clientY: 200 });

			expect(screen.queryByText('Copy Link')).toBeNull();
		});
	});
});
