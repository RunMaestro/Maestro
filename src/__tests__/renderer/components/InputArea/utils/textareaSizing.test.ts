import { describe, expect, it } from 'vitest';
import {
	resizeTextareaToContent,
	scrollTextareaToCaretEnd,
} from '../../../../../renderer/components/InputArea/utils/textareaSizing';

describe('InputArea textareaSizing utils', () => {
	it('resizes to content height capped by max height', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 220, configurable: true });

		resizeTextareaToContent(textarea, 176);

		expect(textarea.style.height).toBe('176px');
	});

	it('resizes to exact content height below cap', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 80, configurable: true });

		resizeTextareaToContent(textarea, 176);

		expect(textarea.style.height).toBe('80px');
	});

	it('scrolls the textarea to the bottom when the caret is at the end', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'hello';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.length,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(240);
	});

	it('leaves scroll untouched when the caret is mid-way through the final logical line', () => {
		const textarea = document.createElement('textarea');
		// Regression for the soft-wrap edge case: a long final logical line can wrap
		// across several visual rows past the height cap. A caret before the trailing
		// characters (e.g. an inserted mention) belongs to an earlier visual row, so
		// snapping to scrollHeight would scroll it out of view. The gate keys off the
		// true end of the value, not the final logical line, precisely to avoid that.
		textarea.value = 'first\nsecond\nlast line';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.indexOf('last line') + 4,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(12);
	});

	it('leaves scroll untouched when the caret is mid-text in a single-line value', () => {
		const textarea = document.createElement('textarea');
		// A single logical line can still soft-wrap beyond the cap, so a mid-text caret
		// is not guaranteed to be on the bottom visual row. Only a caret at value.length
		// qualifies for the bottom snap.
		textarea.value = 'hello';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(12);
	});

	it('leaves textarea scroll position untouched when the caret is on an earlier line', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'first\nsecond\nlast line';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(12);
	});

	it('leaves scroll untouched with the caret exactly on the last newline', () => {
		const textarea = document.createElement('textarea');
		// selectionEnd === lastIndexOf('\n') means the caret ends the second-to-last
		// line, so it belongs to an earlier row and must not jump the viewport.
		textarea.value = 'first\nsecond';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.lastIndexOf('\n'),
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(12);
	});

	it('preserves scroll position across the auto-height toggle', () => {
		const textarea = document.createElement('textarea');
		Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true });
		textarea.scrollTop = 120;

		resizeTextareaToContent(textarea, 176);

		expect(textarea.scrollTop).toBe(120);
	});
});
