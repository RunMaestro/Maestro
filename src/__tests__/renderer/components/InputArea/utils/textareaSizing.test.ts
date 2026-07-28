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

	it('scrolls to the bottom when the caret is mid-way through the final line', () => {
		const textarea = document.createElement('textarea');
		// Caret sits before the trailing characters of the last line, which is what an
		// inserted mention or trailing whitespace leaves behind. That row still has to
		// stay visible, so the gate keys off the final logical line, not value.length.
		textarea.value = 'first\nsecond\nlast line';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', {
			value: textarea.value.indexOf('last line') + 4,
			configurable: true,
		});

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(240);
	});

	it('scrolls to the bottom when the caret is mid-text in a single-line value', () => {
		const textarea = document.createElement('textarea');
		// No newline at all: the whole value IS the final line, so any caret qualifies.
		textarea.value = 'hello';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(240);
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
