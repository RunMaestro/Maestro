/**
 * @file conversation-buffer.test.ts
 *
 * The memory that lets the Conductor hold a conversation. Two of these tests are
 * about forgetting rather than remembering, which is the half that goes wrong:
 * a buffer that survives a dispatch makes the next request arrive wearing the
 * last one's context.
 */

import { describe, it, expect } from 'vitest';
import { ConversationBuffer } from '../../../../main/acappella/router/conversation-buffer';

describe('ConversationBuffer', () => {
	it('keeps both halves of the exchange in order', () => {
		const buffer = new ConversationBuffer();

		buffer.add('user', 'the refresh keeps failing');
		buffer.add('conductor', 'On the second load, or every time?');
		buffer.add('user', 'second load');

		expect(buffer.history).toEqual([
			{ role: 'user', text: 'the refresh keeps failing' },
			{ role: 'conductor', text: 'On the second load, or every time?' },
			{ role: 'user', text: 'second load' },
		]);
	});

	it('starts empty and reports it', () => {
		const buffer = new ConversationBuffer();

		expect(buffer.active).toBe(false);
		expect(buffer.history).toEqual([]);
	});

	it('forgets everything on clear, which is what a dispatch does', () => {
		// The discussion that produced a request is finished the moment it is sent.
		const buffer = new ConversationBuffer();
		buffer.add('user', 'fix the auth bug');

		buffer.clear();

		expect(buffer.active).toBe(false);
		expect(buffer.history).toEqual([]);
	});

	it('ignores an empty line rather than recording a blank turn', () => {
		const buffer = new ConversationBuffer();

		buffer.add('user', '   ');

		expect(buffer.active).toBe(false);
	});

	it('trims the text it records', () => {
		const buffer = new ConversationBuffer();

		buffer.add('user', '  spaced out  ');

		expect(buffer.history[0].text).toBe('spaced out');
	});

	it('drops the oldest turns once it is full', () => {
		const buffer = new ConversationBuffer({ maxTurns: 3 });

		for (const text of ['one', 'two', 'three', 'four']) buffer.add('user', text);

		expect(buffer.history.map((turn) => turn.text)).toEqual(['two', 'three', 'four']);
	});

	it('drops by size too, since ten paragraphs is a prompt that keeps growing', () => {
		const buffer = new ConversationBuffer({ maxTurns: 50, maxChars: 30 });

		buffer.add('user', 'x'.repeat(25));
		buffer.add('user', 'y'.repeat(25));

		expect(buffer.history).toHaveLength(1);
		expect(buffer.history[0].text.startsWith('y')).toBe(true);
	});

	it('never drops below one turn, however long that turn is', () => {
		// The thing just said is the least droppable part of the context, even when
		// it blows the budget on its own.
		const buffer = new ConversationBuffer({ maxTurns: 50, maxChars: 10 });

		buffer.add('user', 'z'.repeat(500));

		expect(buffer.history).toHaveLength(1);
	});

	it('hands out a copy, so a caller cannot edit the memory in place', () => {
		const buffer = new ConversationBuffer();
		buffer.add('user', 'original');

		buffer.history.push({ role: 'user', text: 'injected' });

		expect(buffer.history).toHaveLength(1);
	});
});
