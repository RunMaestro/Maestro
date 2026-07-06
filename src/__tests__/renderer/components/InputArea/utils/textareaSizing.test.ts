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

	it('scrolls when caret was at previous end', () => {
		expect(shouldScrollTextareaToEnd(5, 5, 6)).toBe(true);
	});

	it('scrolls for bulk inserts even when caret was mid-text', () => {
		expect(shouldScrollTextareaToEnd(2, 5, 9)).toBe(true);
	});

	it('does not scroll normal mid-text typing', () => {
		expect(shouldScrollTextareaToEnd(2, 5, 6)).toBe(false);
	});

	it('scrolls to the bottom when the caret is at the end (issue #1169)', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'a'.repeat(500);
		Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 500, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(400);
	});

	it('leaves the scroll position untouched when the caret is mid-text', () => {
		const textarea = document.createElement('textarea');
		textarea.value = 'a'.repeat(500);
		Object.defineProperty(textarea, 'scrollHeight', { value: 400, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: 10, configurable: true });

		scrollTextareaToCaretEnd(textarea);

		expect(textarea.scrollTop).toBe(0);
	});
});
