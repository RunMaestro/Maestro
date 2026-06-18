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
});
