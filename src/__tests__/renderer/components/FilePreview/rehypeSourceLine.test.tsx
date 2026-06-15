import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { rehypeSourceLine } from '../../../../renderer/components/FilePreview/rehypeSourceLine';

const MD = `# Title

Para one.

## Section 2

- item a
- item b

## Section 5

Some text under five.
`;

/**
 * The rendered-markdown preview ⇄ edit toggle relies on these attributes being
 * present in the live DOM (lineSync.domGetTopLineByAttr reads them). These
 * tests assert react-markdown actually emits `data-source-line` - the camelCase
 * hast property must survive the property-information → DOM conversion AND the
 * rehype-raw round-trip.
 */
describe('rehypeSourceLine (rendered DOM)', () => {
	it('stamps data-source-line on block elements, including after rehypeRaw', () => {
		const { container } = render(
			<ReactMarkdown rehypePlugins={[rehypeSourceLine, rehypeRaw]}>{MD}</ReactMarkdown>
		);
		const tagged = container.querySelectorAll('[data-source-line]');
		expect(tagged.length).toBeGreaterThan(0);
	});

	it('maps headings to their 1-based source lines', () => {
		const { container } = render(
			<ReactMarkdown rehypePlugins={[rehypeSourceLine, rehypeRaw]}>{MD}</ReactMarkdown>
		);
		const h2s = Array.from(container.querySelectorAll('h2'));
		const byText = (t: string) => h2s.find((h) => h.textContent?.includes(t));
		expect(byText('Section 2')?.getAttribute('data-source-line')).toBe('5');
		expect(byText('Section 5')?.getAttribute('data-source-line')).toBe('10');
		expect(container.querySelector('h1')?.getAttribute('data-source-line')).toBe('1');
	});

	it('does not tag inline marks (keeps the attribute query block-level)', () => {
		const { container } = render(
			<ReactMarkdown rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
				{'A line with **bold** and `code`.\n'}
			</ReactMarkdown>
		);
		expect(container.querySelector('strong')?.hasAttribute('data-source-line')).toBe(false);
		expect(container.querySelector('code')?.hasAttribute('data-source-line')).toBe(false);
		// ...but the containing paragraph is tagged.
		expect(container.querySelector('p')?.getAttribute('data-source-line')).toBe('1');
	});
});
