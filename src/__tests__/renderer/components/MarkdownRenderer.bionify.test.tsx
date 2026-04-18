import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer } from '../../../renderer/components/MarkdownRenderer';

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));
vi.mock('lucide-react', () => ({
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
	Loader2: () => <span data-testid="loader-icon">Loader</span>,
	ImageOff: () => <span data-testid="image-off-icon">ImageOff</span>,
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
		expect(screen.getByTestId('syntax-highlighter')).toHaveTextContent('const value = 1;');
		expect(document.querySelector('pre .bionify-word')).not.toBeInTheDocument();
	});
});
