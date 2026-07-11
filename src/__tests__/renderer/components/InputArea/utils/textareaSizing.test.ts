import { describe, expect, it } from 'vitest';
import {
	resizeTextareaToContent,
	scrollTextareaToCaretEnd,
	shouldScrollTextareaToEnd,
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

	it('leaves textarea scroll position untouched when the caret is mid-text', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'hello';
		textarea.scrollTop = 12;
		Object.defineProperty(textarea, 'scrollHeight', { value: 240, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

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

	it('scrolls when caret was at previous end', () => {
		expect(shouldScrollTextareaToEnd(5, 5, 6)).toBe(true);
	});

	it('scrolls for bulk inserts even when caret was mid-text', () => {
		expect(shouldScrollTextareaToEnd(2, 5, 9)).toBe(true);
	});

	it('does not scroll normal mid-text typing', () => {
		expect(shouldScrollTextareaToEnd(2, 5, 6)).toBe(false);
	});
});
