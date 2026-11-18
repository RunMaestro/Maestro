/**
 * @file failureScreen.test.ts
 * @description Tests for src/shared/failureScreen.ts: the terminal screen shown
 * under a failure message, and the classification view that leaves it out.
 */

import { describe, expect, it } from 'vitest';

import {
	FAILURE_SCREEN_MAX_CHARS,
	appendFailureScreen,
	withoutFailureScreen,
} from '../../shared/failureScreen';

describe('appendFailureScreen()', () => {
	it('returns the message unchanged without a screen', () => {
		expect(appendFailureScreen('Failed.', undefined)).toBe('Failed.');
		expect(appendFailureScreen('Failed.', '   \n')).toBe('Failed.');
	});

	it('appends the screen in a code block', () => {
		const message = appendFailureScreen('Failed.', '❯ No, exit');
		expect(message).toBe('Failed.\n\nWhat Claude Code last showed:\n\n```\n❯ No, exit\n```');
	});

	it('keeps only the tail of a long screen', () => {
		const screen = `${'a'.repeat(FAILURE_SCREEN_MAX_CHARS)}END`;
		const message = appendFailureScreen('Failed.', screen);
		expect(message).toContain('END');
		expect(message.length).toBeLessThan(FAILURE_SCREEN_MAX_CHARS + 100);
	});

	it('cannot close its own code block early', () => {
		const message = appendFailureScreen('Failed.', 'before\n```\nafter');
		expect(message.match(/```/g)).toHaveLength(2);
	});

	it('redacts secrets on the screen', () => {
		const message = appendFailureScreen(
			'Failed.',
			'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
		);
		expect(message).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
	});
});

describe('withoutFailureScreen()', () => {
	it('strips a screen appendFailureScreen added', () => {
		const message = appendFailureScreen('Failed.', 'Rate limit reached');
		expect(withoutFailureScreen(message)).toBe('Failed.');
	});

	it('leaves a message without a screen alone', () => {
		expect(withoutFailureScreen('Overloaded.')).toBe('Overloaded.');
	});
});
