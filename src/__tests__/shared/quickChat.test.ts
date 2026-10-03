/**
 * @file quickChat.test.ts
 * @description The Quick Chat contract: settings resolution and the log -> message transform.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_QUICK_CHAT_SETTINGS,
	QUICK_CHAT_MAX_MESSAGES,
	logsToQuickChatMessages,
	resolveQuickChatSettings,
} from '../../shared/quickChat';

const log = (id: string, source: string, text: string) => ({ id, timestamp: 1, source, text });

describe('resolveQuickChatSettings', () => {
	it('returns the defaults when nothing is persisted', () => {
		expect(resolveQuickChatSettings(undefined)).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings(null)).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings('garbage')).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
	});

	it('defaults the hotkey to Option/Alt+Space', () => {
		expect(resolveQuickChatSettings(undefined).hotkey).toEqual(['Alt', 'Space']);
	});

	it('keeps saved values and fills a partial object from the defaults', () => {
		expect(resolveQuickChatSettings({ agentId: 'a1', persistent: true })).toEqual({
			...DEFAULT_QUICK_CHAT_SETTINGS,
			agentId: 'a1',
			persistent: true,
		});
	});

	it('keeps an empty hotkey, which is how the user turns it off', () => {
		expect(resolveQuickChatSettings({ hotkey: [] }).hotkey).toEqual([]);
	});

	it('ignores values of the wrong type', () => {
		expect(
			resolveQuickChatSettings({
				hotkey: 'Alt+Space',
				agentId: 7,
				persistent: 'yes',
				ephemeralHistory: null,
			})
		).toEqual(DEFAULT_QUICK_CHAT_SETTINGS);
		expect(resolveQuickChatSettings({ hotkey: ['Alt', 3, 'K'] }).hotkey).toEqual(['Alt', 'K']);
	});

	it('never hands back the shared default array', () => {
		const resolved = resolveQuickChatSettings(undefined);
		resolved.hotkey.push('X');
		expect(DEFAULT_QUICK_CHAT_SETTINGS.hotkey).toEqual(['Alt', 'Space']);
	});
});

describe('logsToQuickChatMessages', () => {
	it('maps user, agent output, and errors, and drops process detail', () => {
		const messages = logsToQuickChatMessages([
			log('1', 'user', 'hello'),
			log('2', 'thinking', 'hmm'),
			log('3', 'tool', 'Read file'),
			log('4', 'stdout', 'hi there'),
			log('5', 'system', 'session started'),
			log('6', 'error', 'rate limited'),
		]);
		expect(messages.map((m) => [m.role, m.text])).toEqual([
			['user', 'hello'],
			['assistant', 'hi there'],
			['error', 'rate limited'],
		]);
	});

	it('joins consecutive output chunks into one reply', () => {
		const messages = logsToQuickChatMessages([
			log('1', 'user', 'q'),
			log('2', 'stdout', 'Fuhged'),
			log('3', 'thinking', 'still going'),
			log('4', 'stdout', 'daboudit'),
		]);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ id: '2', role: 'assistant', text: 'Fuhgeddaboudit' });
	});

	it('does not mutate the source log', () => {
		const logs = [log('1', 'stdout', 'a'), log('2', 'ai', 'b')];
		logsToQuickChatMessages(logs);
		expect(logs[0].text).toBe('a');
	});

	it('skips blank entries', () => {
		expect(logsToQuickChatMessages([log('1', 'stdout', '  \n')])).toEqual([]);
	});

	it('keeps only the newest messages', () => {
		const logs = Array.from({ length: QUICK_CHAT_MAX_MESSAGES + 5 }, (_, i) =>
			log(String(i), i % 2 === 0 ? 'user' : 'stdout', `m${i}`)
		);
		const messages = logsToQuickChatMessages(logs);
		expect(messages).toHaveLength(QUICK_CHAT_MAX_MESSAGES);
		expect(messages[messages.length - 1].text).toBe(`m${QUICK_CHAT_MAX_MESSAGES + 4}`);
	});
});
