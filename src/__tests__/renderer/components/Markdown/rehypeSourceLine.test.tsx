import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { rehypeSourceLine } from '../../../../renderer/components/Markdown/rehypeSourceLine';

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

	it('stamps task checkboxes with their list item line', () => {
		const { container } = render(
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
				{'# Tasks\n\n- [ ] first\n- [x] second\n'}
			</ReactMarkdown>
		);
		const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
		expect(boxes.map((b) => b.getAttribute('data-source-line'))).toEqual(['3', '4']);
	});

	it('stamps task checkboxes in a loose list, where the box sits inside a paragraph', () => {
		const { container } = render(
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
				{'- [ ] first\n\n- [ ] second\n'}
			</ReactMarkdown>
		);
		const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
		expect(boxes.map((b) => b.getAttribute('data-source-line'))).toEqual(['1', '3']);
	});

	it('delivers the line to a custom input component (what makes a click editable)', () => {
		const seen: Array<Record<string, unknown>> = [];
		render(
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[rehypeSourceLine, rehypeRaw]}
				components={{
					input: ({ node: _node, ...props }: any) => {
						seen.push(props);
						return <input {...props} readOnly />;
					},
				}}
			>
				{'intro\n\n- [ ] first\n- [x] second\n'}
			</ReactMarkdown>
		);
		// Arrives as the DOM attribute string, so consumers must coerce it.
		expect(seen.map((p) => p['data-source-line'])).toEqual(['3', '4']);
	});

	it('leaves an ordinary list item without a checkbox', () => {
		const { container } = render(
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceLine, rehypeRaw]}>
				{'- plain item\n'}
			</ReactMarkdown>
		);
		expect(container.querySelector('input')).toBeNull();
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
