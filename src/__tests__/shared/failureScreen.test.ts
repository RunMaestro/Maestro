/**
 * @file failureScreen.test.ts
 * @description Tests for src/shared/failureScreen.ts: the terminal screen kept
 * as evidence beside a failure message, and the inline view of a message.
 */

import { describe, expect, it } from 'vitest';

import {
	FAILURE_SCREEN_MAX_CHARS,
	INLINE_ERROR_MAX_CHARS,
	formatFailureScreen,
	inlineErrorText,
	withoutFailureScreen,
} from '../../shared/failureScreen';

const LEGACY_MESSAGE = 'Failed.\n\nWhat Claude Code last showed:\n\n```\n│ row │\n❯ No, exit\n```';

describe('formatFailureScreen()', () => {
	it('returns undefined without a screen', () => {
		expect(formatFailureScreen(undefined)).toBeUndefined();
		expect(formatFailureScreen('   \n')).toBeUndefined();
	});

	it('keeps the rows, trimming trailing blanks', () => {
		expect(formatFailureScreen('\n\n❯ No, exit   \n  Yes, add it\n\n')).toBe(
			'❯ No, exit\n  Yes, add it'
		);
	});

	it('strips raw and literal ANSI escapes', () => {
		const screen = '\x1b[1mBold\x1b[0m\n\\033[1;30m~/work\\033[0m $';
		expect(formatFailureScreen(screen)).toBe('Bold\n~/work $');
	});

	it('returns undefined when only escapes remain', () => {
		expect(formatFailureScreen('\\033[1;30m\\033[0m')).toBeUndefined();
	});

	it('keeps only the tail of a long screen', () => {
		const screen = formatFailureScreen(`${'a'.repeat(FAILURE_SCREEN_MAX_CHARS)}END`)!;
		expect(screen.endsWith('END')).toBe(true);
		expect(screen.length).toBeLessThanOrEqual(FAILURE_SCREEN_MAX_CHARS);
	});

	it('redacts secrets on the screen', () => {
		const screen = formatFailureScreen(
			'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
		);
		expect(screen).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
	});
});

describe('withoutFailureScreen()', () => {
	it('strips a screen an older build appended to the message', () => {
		expect(withoutFailureScreen(LEGACY_MESSAGE)).toBe('Failed.');
	});

	it('leaves a message without a screen alone', () => {
		expect(withoutFailureScreen('Overloaded.')).toBe('Overloaded.');
	});
});

describe('inlineErrorText()', () => {
	it('drops a legacy screen', () => {
		expect(inlineErrorText(LEGACY_MESSAGE)).toBe('Failed.');
	});

	it('collapses whitespace to one line', () => {
		expect(inlineErrorText('Line one.\n\n  Line two.')).toBe('Line one. Line two.');
	});

	it('cuts a long message at a word', () => {
		const text = inlineErrorText('word '.repeat(200));
		expect(text.length).toBeLessThanOrEqual(INLINE_ERROR_MAX_CHARS);
		expect(text.endsWith('word…')).toBe(true);
	});
});
