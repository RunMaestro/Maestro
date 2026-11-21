// Source: src/__tests__/renderer/components/MarkdownRenderer.bionify.test.tsx
// Source: src/__tests__/renderer/utils/bionifyReadingMode.test.tsx
// Source: src/__tests__/renderer/components/Markdown/InlineCode.test.tsx
import React from 'react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { MarkdownRenderer } from '../../../renderer/components/MarkdownRenderer';
import { beforeEach } from 'vitest';
import { BionifyText } from '../../../renderer/utils/bionifyReadingMode';
import { BionifyTextBlock } from '../../../renderer/utils/bionifyReadingMode';
import type { BionifyRenderConfig } from '../../../renderer/utils/bionifyReadingMode';
import { getBionifyReadingModeStyles } from '../../../renderer/utils/bionifyReadingMode';
import { resetBionifyStylesForTests } from '../../../renderer/utils/bionifyReadingMode';
import { renderBionifyText } from '../../../renderer/utils/bionifyReadingMode';
import { fireEvent } from '@testing-library/react';
import { InlineCode } from '../../../renderer/components/Markdown/components/InlineCode';
import { safeClipboardWrite } from '../../../renderer/utils/clipboard';
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

vi.mock('shiki', () => ({
	createHighlighter: vi.fn(async () => ({
		codeToHtml: () => '<pre class="shiki"><code>mocked</code></pre>',
		getLoadedLanguages: () => [],
		loadLanguage: async () => undefined,
	})),
	bundledLanguagesInfo: [],
	bundledLanguagesAlias: {},
}));
vi.mock('highlight.js', () => ({
	default: { highlightAuto: () => ({ language: null, relevance: 0 }) },
}));
vi.mock('lucide-react', () => ({
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	Loader2: () => <span data-testid="loader-icon">Loader</span>,
	ImageOff: () => <span data-testid="image-off-icon">ImageOff</span>,
	ChevronDown: () => <span data-testid="chevron-down-icon">ChevronDown</span>,
	Search: () => <span data-testid="search-icon">Search</span>,
	Check: () => <span data-testid="check-icon">Check</span>,
}));
describe('MarkdownRenderer.bionify', () => {
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

	describe('MarkdownRenderer bionify opt-in', () => {
		it('does not transform prose when reading mode is disabled', () => {
			render(<MarkdownRenderer {...defaultProps} content="Hello reading world" />);

			expect(screen.getByText('Hello reading world')).toBeInTheDocument();
			expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
		});

		it('transforms prose but leaves inline code and link text untouched when enabled', () => {
			render(
				<MarkdownRenderer
					{...defaultProps}
					enableBionifyReadingMode={true}
					content={'Hello `code sample` [example link](https://example.com) world'}
				/>
			);

			expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
			expect(screen.getByText('code sample')).toBeInTheDocument();
			expect(screen.getByRole('link', { name: 'example link' })).toBeInTheDocument();
			expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
			expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
		});

		it('preserves markdown task lists and fenced code blocks when enabled', () => {
			render(
				<MarkdownRenderer
					{...defaultProps}
					enableBionifyReadingMode={true}
					content={'- [x] Ship reader tests\n\n```ts\nconst value = 1;\n```'}
				/>
			);

			const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
			expect(checkbox).not.toBeNull();
			expect(checkbox?.checked).toBe(true);
			expect(checkbox?.closest('li')).toHaveTextContent('Ship reader tests');
			expect(screen.getByTestId('code-fence').querySelector('code')).toHaveTextContent(
				'const value = 1;'
			);
			expect(document.querySelector('pre .bionify-word')).not.toBeInTheDocument();
		});
	});
});
describe('bionifyReadingMode', () => {
	describe('bionifyReadingMode', () => {
		beforeEach(() => {
			resetBionifyStylesForTests();
		});

		it('leaves content unchanged when disabled', () => {
			render(<div>{renderBionifyText('Reading mode stays off.', false)}</div>);

			expect(screen.getByText('Reading mode stays off.')).toBeInTheDocument();
			expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
		});

		it('wraps readable prose words when enabled', () => {
			render(<div>{renderBionifyText('Reading mode turns on.', true)}</div>);

			const emphasized = document.querySelectorAll('.bionify-word-emphasis');
			expect(emphasized.length).toBeGreaterThan(0);
			expect(screen.getByText('Rea')).toBeInTheDocument();
			expect(screen.getByText('ding')).toBeInTheDocument();
		});

		it('applies the configured algorithm to longer words', () => {
			const config: BionifyRenderConfig = {
				enabled: true,
				algorithm: '- 0 1 1 2 0.4',
				intensity: 1,
			};

			render(<div>{renderBionifyText('clearly', config)}</div>);

			expect(screen.getByText('cle')).toBeInTheDocument();
			expect(screen.getByText('arly')).toBeInTheDocument();
		});

		it('does not emphasize common words when the algorithm disables them', () => {
			const config: BionifyRenderConfig = {
				enabled: true,
				algorithm: '- 0 1 1 2 0.4',
				intensity: 1,
			};

			const { container } = render(<div>{renderBionifyText('and clearly', config)}</div>);

			expect(container).toHaveTextContent('and clearly');
			expect(screen.queryByText('a')).not.toBeInTheDocument();
			expect(screen.getByText('cle')).toBeInTheDocument();
		});

		it('preserves inline code and links while transforming surrounding prose', () => {
			render(
				<BionifyText enabled={true}>
					Before <code>const value = 1</code> and <a href="https://example.com">Example Link</a>{' '}
					after
				</BionifyText>
			);

			expect(screen.getByText('const value = 1')).toBeInTheDocument();
			expect(screen.getByRole('link', { name: 'Example Link' })).toBeInTheDocument();
			expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
			expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
			expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		});

		it('renders a reusable readable text block wrapper for plain-text surfaces', () => {
			render(
				<BionifyTextBlock
					enabled={true}
					className="prose"
					data-testid="reading-block"
					intensity={1.2}
					algorithm="- 0 1 1 2 0.4"
				>
					Plain text blocks stay selectable.
				</BionifyTextBlock>
			);

			expect(screen.getByTestId('reading-block')).toHaveClass('bionify-text-block');
			expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
			expect(screen.getByTestId('reading-block')).toHaveTextContent(
				'Plain text blocks stay selectable.'
			);
			expect(screen.getByTestId('reading-block')).toHaveStyle({
				'--bionify-intensity': '1.2',
				'--bionify-rest-opacity': '0.45',
			});
		});

		it('injects a single shared style block for repeated readable-text wrappers', () => {
			render(
				<>
					<BionifyTextBlock enabled={true}>First block</BionifyTextBlock>
					<BionifyTextBlock enabled={true}>Second block</BionifyTextBlock>
				</>
			);

			expect(document.querySelectorAll('#maestro-bionify-reading-mode-styles')).toHaveLength(1);
		});

		it('exposes scoped reading-mode styles for prose containers', () => {
			expect(getBionifyReadingModeStyles('.custom-scope')).toContain('.custom-scope .bionify-word');
			expect(getBionifyReadingModeStyles('.custom-scope')).toContain(
				'.custom-scope .bionify-word-rest'
			);
			expect(getBionifyReadingModeStyles('.custom-scope')).toContain('font-weight: var(');
			expect(getBionifyReadingModeStyles('.custom-scope')).toContain('!important');
			expect(
				getBionifyReadingModeStyles('.custom-scope', {
					mode: 'light',
				} as any)
			).toContain('opacity: var(--bionify-rest-opacity, 0.73)');
		});
	});
});
describe('InlineCode', () => {
	describe('InlineCode', () => {
		it('renders a hex swatch before hex-color content', () => {
			const { container } = render(<InlineCode>#FF0000</InlineCode>);
			const code = container.querySelector('code')!;
			const swatch = code.querySelector('span');
			expect(swatch).toBeInTheDocument();
			expect(swatch!.getAttribute('style')).toContain('background-color');
			expect(code.textContent).toContain('#FF0000');
		});

		it('renders no swatch for non-hex content', () => {
			const { container } = render(<InlineCode>npm run dev</InlineCode>);
			const code = container.querySelector('code')!;
			expect(code.querySelector('span')).toBeNull();
			expect(code.textContent).toBe('npm run dev');
		});

		it('is keyboard- and click-copyable', async () => {
			const { container } = render(<InlineCode>copy me</InlineCode>);
			const code = container.querySelector('code')!;
			expect(code.getAttribute('role')).toBe('button');
			fireEvent.click(code);
			expect(safeClipboardWrite).toHaveBeenCalledWith('copy me');
		});

		it('forwards className and passthrough props, and keeps the pointer cursor', () => {
			const { container } = render(
				<InlineCode className="custom" passthrough={{ 'data-x': 'y' }} style={{ color: 'red' }}>
					code
				</InlineCode>
			);
			const code = container.querySelector('code')!;
			expect(code.className).toBe('custom');
			expect(code.getAttribute('data-x')).toBe('y');
			expect(code.style.cursor).toBe('pointer');
			expect(code.style.color).toBe('red');
		});
	});
});
