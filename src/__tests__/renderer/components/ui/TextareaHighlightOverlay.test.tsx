/**
 * Tests for TextareaHighlightOverlay.
 *
 * The invariants worth pinning are the ones that make the illusion hold: the
 * backdrop must contribute BACKGROUNDS ONLY (its own glyphs transparent, the
 * visible ones belonging to the textarea above), it must reproduce the document
 * character for character so the marks line up, and it must be invisible to
 * assistive tech since it is a duplicate of text already on screen.
 */

import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { render } from '@testing-library/react';
import { TextareaHighlightOverlay } from '../../../../renderer/components/ui/TextareaHighlightOverlay';
import { mockTheme } from '../../../helpers/mockTheme';

function renderOverlay(value: string, query: string) {
	const ref = createRef<HTMLTextAreaElement>();
	const utils = render(
		<div className="dual-pane-highlight-wrap">
			<TextareaHighlightOverlay
				textareaRef={ref}
				value={value}
				query={query}
				theme={mockTheme}
				backgroundColor="#101010"
			/>
			<textarea ref={ref} readOnly value={value} />
		</div>
	);
	const backdrop = utils.container.querySelector('.dual-pane-highlight-backdrop');
	return { ...utils, backdrop, ref };
}

describe('TextareaHighlightOverlay', () => {
	it('renders nothing at all without a query', () => {
		// No marks to paint, so the editor should not carry an invisible copy of
		// its own document.
		const { backdrop } = renderOverlay('some text', '');
		expect(backdrop).toBeNull();
	});

	it('marks every occurrence of the query', () => {
		const { backdrop } = renderOverlay('pedram and pedram again', 'pedram');
		const marks = backdrop!.querySelectorAll('mark');
		expect(marks).toHaveLength(2);
		expect(Array.from(marks, (m) => m.textContent)).toEqual(['pedram', 'pedram']);
	});

	it('matches case-insensitively while preserving the original casing', () => {
		const { backdrop } = renderOverlay('Pedram', 'pedram');
		expect(backdrop!.querySelector('mark')?.textContent).toBe('Pedram');
	});

	it('paints only a background - every glyph it owns is transparent', () => {
		// If the backdrop drew visible text it would double every character,
		// slightly offset, which reads as a rendering fault.
		const { backdrop } = renderOverlay('ask pedram now', 'pedram');
		const mark = backdrop!.querySelector('mark') as HTMLElement;
		expect(mark.style.color).toBe('transparent');
		expect(mark.style.backgroundColor).toBeTruthy();
		for (const span of Array.from(backdrop!.querySelectorAll('span'))) {
			expect((span as HTMLElement).style.color).toBe('transparent');
		}
	});

	it('reproduces the document exactly, so marks line up with the text above', () => {
		const text = 'alpha pedram\nbeta\n\ngamma pedram';
		const { backdrop } = renderOverlay(text, 'pedram');
		// A trailing newline is appended so a document ending in one keeps its
		// last row; everything before it must match the source character for
		// character.
		expect(backdrop!.textContent?.startsWith(text)).toBe(true);
	});

	it('is hidden from assistive tech and from the pointer', () => {
		const { backdrop } = renderOverlay('pedram', 'pedram');
		expect(backdrop!.getAttribute('aria-hidden')).toBe('true');
		// pointer-events comes from the stylesheet, which jsdom does not load, so
		// assert the class that carries it rather than the computed value.
		expect(backdrop!.className).toContain('dual-pane-highlight-backdrop');
	});

	it('carries the editor fill, since the textarea above goes transparent', () => {
		const { backdrop } = renderOverlay('pedram', 'pedram');
		expect((backdrop as HTMLElement).style.backgroundColor).toBeTruthy();
	});

	it('follows the textarea when it scrolls', () => {
		const { backdrop, ref } = renderOverlay('pedram\n'.repeat(50), 'pedram');
		const textarea = ref.current!;

		Object.defineProperty(textarea, 'scrollTop', { value: 120, writable: true });
		textarea.dispatchEvent(new Event('scroll'));

		expect((backdrop as HTMLElement).scrollTop).toBe(120);
	});

	it('survives a query containing regex metacharacters', () => {
		const { backdrop } = renderOverlay('cost $100 today', '$100');
		expect(backdrop!.querySelector('mark')?.textContent).toBe('$100');
	});

	it('renders no marks when the query matches nothing', () => {
		const { backdrop } = renderOverlay('hello world', 'zzz');
		expect(backdrop!.querySelectorAll('mark')).toHaveLength(0);
	});
});
