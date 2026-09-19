/**
 * @file chatSteering.test.ts
 * @description Tests for src/shared/chatSteering.ts - the wire protocol for
 * steering a Claude turn that is already running, and the reading of claude's own
 * `queue-operation` transcript rows that say what it did with the message.
 */

import { describe, expect, it } from 'vitest';

import {
	classifyQueueOperation,
	parseSteeringRequest,
	STEERING_MAX_TEXT_BYTES,
} from '../../shared/chatSteering';

describe('parseSteeringRequest', () => {
	it('parses a well-formed frame', () => {
		expect(parseSteeringRequest('{"type":"steer","id":"a1","text":"go left"}')).toEqual({
			type: 'steer',
			id: 'a1',
			text: 'go left',
		});
	});

	it('ignores blank lines and malformed JSON', () => {
		// The socket is reachable by anything holding the path, so a bad line must
		// never be able to kill a turn that is midway through real work.
		expect(parseSteeringRequest('')).toBeNull();
		expect(parseSteeringRequest('   ')).toBeNull();
		expect(parseSteeringRequest('{not json')).toBeNull();
		expect(parseSteeringRequest('null')).toBeNull();
		expect(parseSteeringRequest('[]')).toBeNull();
	});

	it('ignores a frame of the wrong type or missing fields', () => {
		expect(parseSteeringRequest('{"type":"other","id":"a","text":"b"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","text":"b"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","id":"a"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","id":"","text":"b"}')).toBeNull();
		expect(parseSteeringRequest('{"type":"steer","id":"a","text":""}')).toBeNull();
	});

	it('rejects text past the byte cap', () => {
		// Every byte is TYPED into a live PTY at 256 bytes per repaint, so an
		// unbounded frame would hold the turn's keyboard for minutes.
		const tooBig = 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1);
		expect(
			parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'a', text: tooBig }))
		).toBeNull();
		const justFits = 'x'.repeat(STEERING_MAX_TEXT_BYTES);
		expect(
			parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'a', text: justFits }))
		).not.toBeNull();
	});

	it('measures the cap in BYTES, not characters', () => {
		// A multi-byte prompt is typed as bytes and queued as bytes, so a
		// character-counted cap would let through several times the intended size.
		const multibyte = '“'.repeat(STEERING_MAX_TEXT_BYTES / 3 + 1);
		expect(multibyte.length).toBeLessThan(STEERING_MAX_TEXT_BYTES);
		expect(
			parseSteeringRequest(JSON.stringify({ type: 'steer', id: 'a', text: multibyte }))
		).toBeNull();
	});
});

describe('classifyQueueOperation', () => {
	const TEXT = 'stop reading and answer instead';

	it('reads absorbed_mid_turn as absorbed', () => {
		// Claude's own word for it. The only verdict meaning the running turn
		// changed course.
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: TEXT,
					reason: 'absorbed_mid_turn',
				},
				TEXT
			)
		).toEqual({ verdict: 'absorbed', matchedContent: true });
	});

	it('reads a removal for another reason as queued, not absorbed', () => {
		// Only `absorbed_mid_turn` proves the in-flight loop took it. Anything else
		// must not be reported as a steer.
		expect(
			classifyQueueOperation(
				{ type: 'queue-operation', operation: 'remove', content: TEXT, reason: 'user_cleared' },
				TEXT
			)
		).toEqual({ verdict: 'queued', matchedContent: true });
	});

	it('ignores a removal naming different text', () => {
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: 'somebody else',
					reason: 'absorbed_mid_turn',
				},
				TEXT
			)
		).toBeNull();
	});

	it('compares content ignoring surrounding whitespace', () => {
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: `  ${TEXT}\n`,
					reason: 'absorbed_mid_turn',
				},
				TEXT
			)
		).toEqual({ verdict: 'absorbed', matchedContent: true });
	});

	it('reports a bare dequeue as queued and unattributed', () => {
		// The row carries no content, so it cannot name its own injection; the
		// caller resolves it positionally.
		expect(classifyQueueOperation({ type: 'queue-operation', operation: 'dequeue' }, TEXT)).toEqual(
			{
				verdict: 'queued',
				matchedContent: false,
			}
		);
	});

	it('treats enqueue as not a verdict', () => {
		// It only proves claude accepted the keystrokes, which `delivered` already
		// said. Resolving on it would report every steer as queued.
		expect(
			classifyQueueOperation({ type: 'queue-operation', operation: 'enqueue', content: TEXT }, TEXT)
		).toBeNull();
	});

	it('ignores rows that are not queue operations', () => {
		expect(classifyQueueOperation({ type: 'assistant' }, TEXT)).toBeNull();
		expect(classifyQueueOperation(null, TEXT)).toBeNull();
		expect(classifyQueueOperation('queue-operation', TEXT)).toBeNull();
	});
});
