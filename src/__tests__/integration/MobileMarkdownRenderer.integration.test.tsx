/**
 * Tests for MobileMarkdownRenderer component
 * @vitest-environment jsdom
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MobileMarkdownRenderer } from '../../web/mobile/MobileMarkdownRenderer';
import { HAPTIC_PATTERNS, triggerHaptic } from '../../web/mobile/constants';

const themeState = vi.hoisted(() => ({
	isDark: true,
}));

vi.mock('../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		accent: '#8b5cf6',
		border: '#374151',
		bgActivity: '#1f2937',
		textMain: '#f3f4f6',
		textDim: '#9ca3af',
		success: '#22c55e',
	}),
	useTheme: () => ({ isDark: themeState.isDark }),
}));

vi.mock('../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		success: [10, 50, 10],
		error: [50, 50, 50],
	},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children, style }: { children: string; style?: { name?: string } }) => (
		<pre data-testid="syntax-highlighter" data-style-name={style?.name}>
			{children}
		</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: { name: 'dark' },
	vs: { name: 'light' },
}));

describe('MobileMarkdownRenderer', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		themeState.isDark = true;
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	it('applies Bionify emphasis to prose when enabled', () => {
		const { container } = render(
			<MobileMarkdownRenderer
				content="Reading mode improves prose."
				enableBionifyReadingMode={true}
			/>
		);

		expect(container.querySelector('.bionify-word-emphasis')).toBeInTheDocument();
	});

	it('leaves prose unchanged when disabled', () => {
		const { container } = render(
			<MobileMarkdownRenderer
				content="Reading mode stays plain."
				enableBionifyReadingMode={false}
			/>
		);

		expect(container.querySelector('.bionify-word-emphasis')).toBeNull();
	});

	it('does not bionify fenced code blocks', () => {
		const { container, getByTestId } = render(
			<MobileMarkdownRenderer
				content={'Intro text\n```ts\nconst value = 1;\n```'}
				enableBionifyReadingMode={true}
			/>
		);

		expect(container.querySelector('.bionify-word-emphasis')).toBeInTheDocument();
		expect(getByTestId('syntax-highlighter').querySelector('.bionify-word-emphasis')).toBeNull();
	});

	it('renders mobile markdown blocks with theme-aware structure and GFM elements', () => {
		const { container } = render(
			<MobileMarkdownRenderer
				fontSize={17}
				content={`# Title
## Section
### Subsection
#### Detail
##### Fine print
###### Aside

Paragraph with [link](https://example.com), \`inline\`, **strong**, _em_, and ~~gone~~.

> Quoted text

- [x] Done
1. Ordered

![Alt image](https://example.com/image.png)

---

| A | B |
| - | - |
| 1 | 2 |`}
			/>
		);

		expect(container.querySelector('.mobile-markdown-content')).toHaveStyle({ fontSize: '17px' });
		expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { level: 6, name: 'Aside' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute('target', '_blank');
		expect(screen.getByText('inline').tagName.toLowerCase()).toBe('code');
		expect(screen.getByText('Quoted text').closest('blockquote')).toBeInTheDocument();
		expect(screen.getByRole('checkbox')).toBeDisabled();
		expect(screen.getByAltText('Alt image')).toHaveAttribute(
			'src',
			'https://example.com/image.png'
		);
		expect(container.querySelector('hr')).toBeInTheDocument();
		expect(container.querySelector('table')).toBeInTheDocument();
	});

	it('copies fenced code blocks and reports success', async () => {
		vi.useFakeTimers();
		render(<MobileMarkdownRenderer content={'```js\nconsole.log(1)\n```'} />);

		fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

		await act(async () => {
			await Promise.resolve();
		});
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('console.log(1)');
		expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.success);
		expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
		vi.useRealTimers();
	});

	it('uses fallback code language label and haptic error when copy fails', async () => {
		vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));

		render(<MobileMarkdownRenderer content={'```\nplain\n```'} />);

		expect(screen.getByText('code')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

		await waitFor(() => {
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.error);
		});
		expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
	});

	it('uses light syntax highlighting and empty alt text when provided by markdown', () => {
		themeState.isDark = false;
		const { container } = render(
			<MobileMarkdownRenderer
				content={'```ts\nconst light = true\n```\n\n![](https://example.com/no-alt.png)'}
			/>
		);

		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-style-name', 'light');
		expect(container.querySelector('img')).toHaveAttribute('alt', '');
	});
});
