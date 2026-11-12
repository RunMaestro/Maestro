import { describe, expect, it } from 'vitest';
import {
	getAtMentionTrigger,
	shouldOpenSlashCommand,
} from '../../../../../renderer/components/InputArea/utils/inputTriggers';

describe('InputArea inputTriggers utils', () => {
	it('opens slash commands only for a single slash token', () => {
		expect(shouldOpenSlashCommand('/')).toBe(true);
		expect(shouldOpenSlashCommand('/help')).toBe(true);
		expect(shouldOpenSlashCommand('/help now')).toBe(false);
		expect(shouldOpenSlashCommand('/help\nnow')).toBe(false);
		expect(shouldOpenSlashCommand(' /help')).toBe(false);
	});

	it('detects @ mention trigger at the start of input', () => {
		expect(getAtMentionTrigger('@src', 4)).toEqual({
			open: true,
			filter: 'src',
			startIndex: 0,
		});
	});

	it('detects @ mention trigger after whitespace', () => {
		expect(getAtMentionTrigger('open @utils', 11)).toEqual({
			open: true,
			filter: 'utils',
			startIndex: 5,
		});
	});

	it('rejects @ mention trigger inside a token or after a space in the mention', () => {
		expect(getAtMentionTrigger('email@test', 10)).toBeNull();
		expect(getAtMentionTrigger('open @src file', 14)).toBeNull();
		expect(getAtMentionTrigger('no mention', 10)).toBeNull();
	});

	it('keeps the picker open across spaces inside a quoted mention', () => {
		// A quoted mention carries a path with spaces, so a space must not close it.
		expect(getAtMentionTrigger('@"Meetings/MEET - Diag', 22)).toEqual({
			open: true,
			// Raw filter: the opening quote is kept so acceptance can splice over it.
			filter: '"Meetings/MEET - Diag',
			startIndex: 0,
		});
		expect(getAtMentionTrigger("open @'my notes", 15)).toEqual({
			open: true,
			filter: "'my notes",
			startIndex: 5,
		});
	});

	it('closes once the quoted mention is closed', () => {
		// Closing quote completes the mention - nothing left to filter on.
		expect(getAtMentionTrigger('@"my notes.md"', 14)).toBeNull();
		expect(getAtMentionTrigger('@"my notes.md" and more', 23)).toBeNull();
	});

	it('never lets an unclosed quote swallow a newline', () => {
		expect(getAtMentionTrigger('@"my notes\nnext line', 20)).toBeNull();
	});
});
