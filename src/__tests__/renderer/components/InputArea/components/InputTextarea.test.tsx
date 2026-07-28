import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import { InputTextarea } from '../../../../../renderer/components/InputArea/components/InputTextarea';
import { TEXTAREA_MAX_HEIGHT } from '../../../../../renderer/components/InputArea/utils/textareaSizing';
import { createInputAreaSession, inputAreaTheme } from '../_fixtures';

/**
 * jsdom performs no layout, so the browser's scroll clamping (scrollTop can
 * never exceed scrollHeight - clientHeight) does not exist here. Install it by
 * hand: that clamp IS the bug being reproduced. While the overlay is still one
 * row short, a copied scrollTop gets clamped and the glyphs sit above the caret.
 */
function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number) {
	let scrollTop = 0;
	let currentScrollHeight = scrollHeight;
	Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
	Object.defineProperty(el, 'scrollHeight', {
		get: () => currentScrollHeight,
		configurable: true,
	});
	Object.defineProperty(el, 'scrollTop', {
		get: () => scrollTop,
		set: (v: number) => {
			scrollTop = Math.max(0, Math.min(v, currentScrollHeight - clientHeight));
		},
		configurable: true,
	});
	return {
		grow: (nextScrollHeight: number) => {
			currentScrollHeight = nextScrollHeight;
		},
	};
}

function renderTextarea(overrides: Record<string, unknown> = {}) {
	const inputRef: RefObject<HTMLTextAreaElement> = { current: null };
	const props = {
		session: createInputAreaSession(),
		theme: inputAreaTheme,
		isTerminalMode: false,
		inputValue: 'first line',
		spellCheckEnabled: false,
		inputRef,
		onInputFocus: vi.fn(),
		onChange: vi.fn(),
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
		...overrides,
	};
	const view = render(<InputTextarea {...(props as any)} />);
	const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
	const overlay = view.container.querySelector('.maestro-input-text-overlay') as HTMLDivElement;
	return {
		...view,
		textarea,
		overlay,
		rerenderWith: (value: string) =>
			view.rerender(<InputTextarea {...(props as any)} inputValue={value} />),
	};
}

describe('InputTextarea', () => {
	it('caps the textarea with the shared TEXTAREA_MAX_HEIGHT constant', () => {
		const { textarea } = renderTextarea();

		// Locks the dedupe in: the CSS cap must stay the same value the resize
		// logic clamps to, never a re-hard-coded `11rem`.
		expect(textarea.style.maxHeight).toBe(`${TEXTAREA_MAX_HEIGHT}px`);
		expect(textarea.style.maxHeight).toBe('176px');
	});

	it('renders every glyph in the overlay over a transparent textarea in AI mode', () => {
		const { textarea, overlay } = renderTextarea({ inputValue: 'plain text, no mention' });

		expect(overlay).not.toBeNull();
		expect(overlay.textContent).toBe('plain text, no mention');
		expect(textarea.style.color).toBe('transparent');
	});

	it('does not render the overlay in terminal mode', () => {
		const { container, textarea } = renderTextarea({ isTerminalMode: true });

		expect(container.querySelector('.maestro-input-text-overlay')).toBeNull();
		expect(textarea.style.color).not.toBe('transparent');
	});

	it('re-syncs the overlay after the grown content commits, repairing the stale clamp', () => {
		const { textarea, overlay, rerenderWith } = renderTextarea({ inputValue: 'line one' });

		// Text region is 8 rows of 20px. The textarea has already outgrown it; the
		// overlay is still rendering the shorter, pre-keystroke content.
		makeScrollable(textarea, 220, 160);
		const overlayScroll = makeScrollable(overlay, 160, 160);

		// Native caret auto-scroll happens BEFORE React commits the taller overlay.
		textarea.scrollTop = 60;
		fireEvent.scroll(textarea);

		// The stale overlay cannot reach 60, so the browser clamps it: this is the
		// desync the user sees as a clipped final row.
		expect(overlay.scrollTop).toBe(0);
		expect(overlay.scrollTop).not.toBe(textarea.scrollTop);

		// Commit the taller overlay content. The layout effect keyed on the rendered
		// segments re-copies the scroll position once the overlay can actually reach it.
		overlayScroll.grow(220);
		rerenderWith('line one\nline two');

		expect(overlay.scrollTop).toBe(60);
		expect(overlay.scrollTop).toBe(textarea.scrollTop);
	});

	it('keeps syncing the overlay on user-driven scrolling', () => {
		const { textarea, overlay } = renderTextarea({ inputValue: 'line one' });

		makeScrollable(textarea, 400, 160);
		makeScrollable(overlay, 400, 160);

		textarea.scrollTop = 90;
		textarea.scrollLeft = 7;
		fireEvent.scroll(textarea);

		expect(overlay.scrollTop).toBe(90);
		expect(overlay.scrollLeft).toBe(7);
	});
});
