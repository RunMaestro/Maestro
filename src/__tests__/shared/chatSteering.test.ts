/**
 * @file chatSteering.test.ts
 * @description Tests for src/shared/chatSteering.ts - the wire protocol for
 * steering a Claude turn that is already running, and the reading of claude's own
 * `queue-operation` transcript rows that say what it did with the message.
 */

import { describe, expect, it } from 'vitest';

import {
	classifyQueueOperation,
	oversizeSteeringRequestId,
	parseSteeringRequest,
	STEERING_MAX_TEXT_BYTES,
	steeringTextMatches,
	parseQueueSteerResult,
	QUEUE_STEER_RENDERER_TIMEOUT_MS,
	QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS,
	STEERING_REPLY_TIMEOUT_MS,
	startsWithTuiCommandPrefix,
} from '../../shared/chatSteering';

describe('startsWithTuiCommandPrefix', () => {
	it('flags text a TUI reads as a slash command or bash mode, after leading whitespace', () => {
		for (const text of ['/compact', '!commit', '  /clear', '\n\t!ls']) {
			expect(startsWithTuiCommandPrefix(text)).toBe(true);
		}
	});

	it('leaves a message with a slash or bang later on alone', () => {
		for (const text of ['see a/b', 'done!', '', '   ']) {
			expect(startsWithTuiCommandPrefix(text)).toBe(false);
		}
	});
});

describe('parseQueueSteerResult', () => {
	it('keeps a known outcome and its known fields', () => {
		expect(
			parseQueueSteerResult({
				outcome: 'refused',
				verdict: 'refused',
				refusal: 'blocking-dialog',
				detail: 'a permission prompt',
				extra: 'dropped',
			})
		).toEqual({
			outcome: 'refused',
			verdict: 'refused',
			refusal: 'blocking-dialog',
			detail: 'a permission prompt',
		});
	});

	it('rejects anything without a known outcome', () => {
		expect(parseQueueSteerResult({ outcome: 'exploded' })).toBeNull();
		expect(parseQueueSteerResult(null)).toBeNull();
		expect(parseQueueSteerResult('delivered')).toBeNull();
	});

	it('drops an unknown verdict rather than passing it through', () => {
		expect(parseQueueSteerResult({ outcome: 'delivered', verdict: 'maybe' })).toEqual({
			outcome: 'delivered',
		});
	});
});

describe('queue steer timeouts', () => {
	it('outlast each other outward: socket < main waiting on renderer < CLI waiting on main', () => {
		expect(QUEUE_STEER_RENDERER_TIMEOUT_MS).toBeGreaterThan(STEERING_REPLY_TIMEOUT_MS);
		expect(QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS).toBeGreaterThan(QUEUE_STEER_RENDERER_TIMEOUT_MS);
	});
});

describe('steeringTextMatches', () => {
	it('ignores whitespace claude rewrites on the way in', () => {
		expect(steeringTextMatches('a    b\nc', 'a\tb\r\nc')).toBe(true);
		expect(steeringTextMatches('  go left  ', 'go left')).toBe(true);
	});

	it('still tells different text apart', () => {
		expect(steeringTextMatches('go left', 'go right')).toBe(false);
	});
});

describe('oversizeSteeringRequestId', () => {
	it('returns the id of a steer whose only fault is size', () => {
		const tooBig = 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1);
		expect(
			oversizeSteeringRequestId(JSON.stringify({ type: 'steer', id: 'a', text: tooBig }))
		).toBe('a');
	});

	it('returns null for a frame that fits, is malformed, or is not a steer', () => {
		expect(
			oversizeSteeringRequestId(JSON.stringify({ type: 'steer', id: 'a', text: 'ok' }))
		).toBeNull();
		expect(oversizeSteeringRequestId('not json')).toBeNull();
		const tooBig = 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1);
		expect(
			oversizeSteeringRequestId(JSON.stringify({ type: 'other', id: 'a', text: tooBig }))
		).toBeNull();
		expect(oversizeSteeringRequestId(JSON.stringify({ type: 'steer', text: tooBig }))).toBeNull();
	});
});

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

	it('matches a row whose whitespace claude rewrote', () => {
		// Measured on claude 2.1.296: a steer containing a tab is recorded with the
		// tab as four spaces. A strict compare missed the row and reported an
		// absorbed steer as `dropped`.
		expect(
			classifyQueueOperation(
				{
					type: 'queue-operation',
					operation: 'remove',
					content: 'two lines:\nline B: col1    col2',
					reason: 'absorbed_mid_turn',
				},
				'two lines:\nline B: col1\tcol2'
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
