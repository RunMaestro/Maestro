import { describe, expect, it } from 'vitest';
import {
	resizeTextareaToContent,
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
