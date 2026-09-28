/**
 * Tests for useStickToBottom.
 *
 * jsdom has no layout engine, so scrollHeight/clientHeight are stubbed on the
 * element. That is the honest way to test this hook: the behavior under test is
 * pure arithmetic over those three numbers plus the scroll event, and none of
 * it depends on real glyph metrics.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { useStickToBottom } from '../../../renderer/hooks/ui/useStickToBottom';

/** Give an element fake geometry, the way a real overflowing box would report. */
function setGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number) {
	Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

const CLIENT_HEIGHT = 480;

function Harness({ initialText = 'line' }: { initialText?: string }) {
	const [text, setText] = useState(initialText);
	const ref = useStickToBottom<HTMLDivElement>(text);
	return (
		<>
			<div data-testid="box" ref={ref}>
				{text}
			</div>
			<button data-testid="append" onClick={() => setText((t) => `${t}\nmore`)}>
				append
			</button>
		</>
	);
}

let box: HTMLElement;
let append: HTMLElement;

function renderHarness() {
	const utils = render(<Harness />);
	box = utils.getByTestId('box');
	append = utils.getByTestId('append');
	// Start overflowing and already at the bottom.
	setGeometry(box, 1000, CLIENT_HEIGHT);
	box.scrollTop = 1000 - CLIENT_HEIGHT;
	return utils;
}

/** Simulate content growing, then the browser firing no scroll event of its own. */
function grow(to: number) {
	setGeometry(box, to, CLIENT_HEIGHT);
	act(() => {
		append.click();
	});
}

beforeEach(() => {
	// jsdom leaves scrollTop writable and inert, which is exactly what we need.
});

describe('useStickToBottom', () => {
	it('follows new content while the user is at the bottom', () => {
		renderHarness();

		grow(2000);

		expect(box.scrollTop).toBe(2000);
	});

	it('stops following once the user scrolls up', () => {
		// The whole point: a box that yanks you back down makes reading earlier
		// output impossible.
		renderHarness();

		box.scrollTop = 100;
		fireEvent.scroll(box);

		grow(2000);

		expect(box.scrollTop).toBe(100);
	});

	it('resumes following when the user scrolls back to the bottom', () => {
		renderHarness();

		box.scrollTop = 100;
		fireEvent.scroll(box);
		grow(2000);
		expect(box.scrollTop).toBe(100);

		// Back to the bottom of the grown content.
		box.scrollTop = 2000 - CLIENT_HEIGHT;
		fireEvent.scroll(box);
		grow(3000);

		expect(box.scrollTop).toBe(3000);
	});

	it('treats being within the threshold of the bottom as pinned', () => {
		// Sub-pixel rounding means an exact test would drop the pin at rest.
		renderHarness();

		box.scrollTop = 1000 - CLIENT_HEIGHT - 40;
		fireEvent.scroll(box);

		grow(2000);

		expect(box.scrollTop).toBe(2000);
	});

	it('drops the pin just past the threshold', () => {
		renderHarness();

		box.scrollTop = 1000 - CLIENT_HEIGHT - 60;
		fireEvent.scroll(box);

		grow(2000);

		expect(box.scrollTop).toBe(1000 - CLIENT_HEIGHT - 60);
	});

	it('stays pinned for a box that does not overflow at all', () => {
		// scrollHeight === clientHeight means there is nowhere to scroll; the user
		// has not "scrolled up", so growth must still follow.
		renderHarness();
		setGeometry(box, CLIENT_HEIGHT, CLIENT_HEIGHT);
		box.scrollTop = 0;
		fireEvent.scroll(box);

		grow(2000);

		expect(box.scrollTop).toBe(2000);
	});

	it('does not fight a horizontal scroll', () => {
		// A long unwrapped line scrolls sideways and fires the same event. Vertical
		// geometry is unchanged, so the pin must survive it.
		renderHarness();

		box.scrollLeft = 300;
		fireEvent.scroll(box);

		grow(2000);

		expect(box.scrollTop).toBe(2000);
	});
});
