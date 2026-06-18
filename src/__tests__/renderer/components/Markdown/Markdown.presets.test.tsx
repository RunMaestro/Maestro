import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Markdown } from '../../../../renderer/components/Markdown/Markdown';
import { mockTheme } from '../../../helpers/mockTheme';

// Mock Shiki + highlight.js so CodeFence's async highlighting doesn't hit the
// real libraries (tests assert on the synchronous fallback).
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
	default: { highlightAuto: vi.fn(() => ({ language: null, relevance: 0 })) },
}));
// Stub MermaidRenderer so the chat-preset mermaid path doesn't pull in the real
// mermaid library (async render, no-op in jsdom). We only assert that the chat
// surface routes mermaid through MermaidCodeBlock's wrapper, not the diagram itself.
vi.mock('../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) =>
		React.createElement('div', { 'data-testid': 'mermaid-diagram' }, chart),
}));

const noop = () => {};

// jsdom serializes inline color styles to rgb(); convert hex theme slots to match.
function hexToRgb(hex: string): string {
	const h = hex.replace('#', '');
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `rgb(${r}, ${g}, ${b})`;
}

describe('Markdown presets', () => {
	describe('chat preset', () => {
		it('wraps output in a prose container', () => {
			const { container } = render(
				<Markdown preset="chat" content="hello world" theme={mockTheme} onCopy={noop} />
			);
			expect(container.querySelector('.prose')).toBeInTheDocument();
		});

		it('renders fenced code through the Shiki CodeFence', () => {
			const { container } = render(
				<Markdown
					preset="chat"
					content={'```ts\nconst x = 1;\n```'}
					theme={mockTheme}
					onCopy={noop}
				/>
			);
			expect(container.querySelector('[data-testid="code-fence"]')).toBeInTheDocument();
		});

		it('renders links with the accentText color slot', () => {
			const { container } = render(
				<Markdown
					preset="chat"
					content="[link](https://example.com)"
					theme={mockTheme}
					onCopy={noop}
				/>
			);
			const link = container.querySelector('a')!;
			expect(link.style.color).toBe(hexToRgb(mockTheme.colors.accentText));
		});

		it('renders GFM tables in a horizontal-scroll wrapper', () => {
			const { container } = render(
				<Markdown
					preset="chat"
					content={'| a | b |\n| - | - |\n| 1 | 2 |'}
					theme={mockTheme}
					onCopy={noop}
				/>
			);
			expect(container.querySelector('.overflow-x-auto table')).toBeInTheDocument();
		});

		it('renders $$...$$ math when chatMath is enabled', () => {
			const { container } = render(
				<Markdown preset="chat" content={'$$a + b$$'} theme={mockTheme} onCopy={noop} chatMath />
			);
			// rehype-katex emits .katex markup
			expect(container.querySelector('.katex')).toBeInTheDocument();
		});

		it('does NOT parse $$...$$ as math when chatMath is off', () => {
			const { container } = render(
				<Markdown preset="chat" content={'$$a + b$$'} theme={mockTheme} onCopy={noop} />
			);
			expect(container.querySelector('.katex')).not.toBeInTheDocument();
		});

		it('renders mermaid fences via MermaidCodeBlock, not the plain CodeFence', () => {
			const { container, getByTitle } = render(
				<Markdown
					preset="chat"
					content={'```mermaid\ngraph TD; A-->B;\n```'}
					theme={mockTheme}
					onCopy={noop}
				/>
			);
			// Routed through the Diagram/Source wrapper...
			expect(container.querySelector('.mermaid-code-block')).toBeInTheDocument();
			expect(getByTitle('Show diagram source')).toBeInTheDocument();
			// ...not the syntax-highlighting code fence used for ordinary languages.
			expect(container.querySelector('[data-testid="code-fence"]')).not.toBeInTheDocument();
		});
	});

	describe('document preset', () => {
		it('renders links with the accent color slot and no chat prose container', () => {
			const { container } = render(
				<Markdown
					preset="document"
					content="[link](https://example.com)"
					theme={mockTheme}
					onExternalLinkClick={noop}
				/>
			);
			const link = container.querySelector('a')!;
			expect(link.style.color).toBe(hexToRgb(mockTheme.colors.accent));
			// The shell does not impose the chat prose container for document preset.
			expect(container.querySelector('.prose')).not.toBeInTheDocument();
		});

		it('does NOT render fenced code through the Shiki CodeFence (uses Prism path)', () => {
			const { container } = render(
				<Markdown preset="document" content={'```ts\nconst x = 1;\n```'} theme={mockTheme} />
			);
			expect(container.querySelector('[data-testid="code-fence"]')).not.toBeInTheDocument();
		});

		it('renders mermaid blocks via a custom language renderer', () => {
			const Mermaid = ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>;
			const { getByTestId } = render(
				<Markdown
					preset="document"
					content={'```mermaid\ngraph TD; A-->B;\n```'}
					theme={mockTheme}
					customLanguageRenderers={{ mermaid: Mermaid }}
				/>
			);
			expect(getByTestId('mermaid')).toHaveTextContent('graph TD; A-->B;');
		});
	});

	describe('release-notes preset', () => {
		it('does NOT parse GFM tables (plain CommonMark only)', () => {
			const { container } = render(
				<Markdown
					preset="release-notes"
					content={'| a | b |\n| - | - |\n| 1 | 2 |'}
					theme={mockTheme}
				/>
			);
			expect(container.querySelector('table')).not.toBeInTheDocument();
		});
	});

	describe('wizard-bubble preset', () => {
		it('applies the tailwind bubble paragraph classes', () => {
			const { container } = render(
				<Markdown preset="wizard-bubble" content="hello" theme={mockTheme} />
			);
			const p = container.querySelector('p')!;
			expect(p.className).toContain('mb-2');
		});
	});
});
