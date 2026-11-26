/**
 * @fileoverview What a consult accepts off the wire from an asker on another machine
 * (`consults.ask`). The fields go into a prompt, a tab name, and a History entry on the
 * answering machine, so each is checked and bounded where it is read.
 */

import { describe, expect, it } from 'vitest';
import {
	MAX_WIRE_AGENT_NAME,
	MAX_WIRE_HANDOFF_ANSWER,
	MAX_WIRE_TRANSCRIPT_ENTRIES,
	MAX_WIRE_TRANSCRIPT_SOURCE,
	MAX_WIRE_TRANSCRIPT_TEXT,
	parseWireAgentName,
	parseWireHandoffAnswer,
	parseWireTranscript,
} from '../../shared/crossAgentTypes';

describe('parseWireTranscript', () => {
	it('keeps well-formed entries and only their known fields', () => {
		const parsed = parseWireTranscript([
			{ source: 'user', text: 'Fix the build', timestamp: 5, __proto__: { admin: true }, extra: 1 },
			{ source: 'ai', text: 'Done.' },
		]);
		expect(parsed).toEqual([
			{ source: 'user', text: 'Fix the build', timestamp: 5 },
			{ source: 'ai', text: 'Done.' },
		]);
		expect(Object.keys(parsed![0])).toEqual(['source', 'text', 'timestamp']);
	});

	it('answers undefined for a value that is not a list, or holds no usable entry', () => {
		expect(parseWireTranscript(undefined)).toBeUndefined();
		expect(parseWireTranscript('user: hi')).toBeUndefined();
		expect(parseWireTranscript({ 0: { source: 'user' } })).toBeUndefined();
		expect(
			parseWireTranscript([null, 7, 'x', { text: 'no source' }, { source: 9 }])
		).toBeUndefined();
	});

	it('bounds the entry count, each text, and the source name', () => {
		const many = Array.from({ length: MAX_WIRE_TRANSCRIPT_ENTRIES + 50 }, (_, index) => ({
			source: 'user',
			text: `m${index}`,
		}));
		const kept = parseWireTranscript(many)!;
		expect(kept).toHaveLength(MAX_WIRE_TRANSCRIPT_ENTRIES);
		// The newest entries are the ones kept.
		expect(kept[kept.length - 1].text).toBe(`m${MAX_WIRE_TRANSCRIPT_ENTRIES + 49}`);

		const long = parseWireTranscript([
			{ source: 'ai', text: 'x'.repeat(MAX_WIRE_TRANSCRIPT_TEXT + 1000) },
			{ source: 's'.repeat(MAX_WIRE_TRANSCRIPT_SOURCE + 1), text: 'dropped' },
		])!;
		expect(long).toHaveLength(1);
		expect(long[0].text).toHaveLength(MAX_WIRE_TRANSCRIPT_TEXT);
	});

	it('drops a timestamp that is not a finite number', () => {
		expect(parseWireTranscript([{ source: 'user', timestamp: Infinity }])).toEqual([
			{ source: 'user' },
		]);
	});
});

describe('parseWireAgentName', () => {
	it('trims and bounds the name, and answers undefined when nothing is left', () => {
		expect(parseWireAgentName('  Docs  ')).toBe('Docs');
		expect(parseWireAgentName('n'.repeat(MAX_WIRE_AGENT_NAME + 40))).toHaveLength(
			MAX_WIRE_AGENT_NAME
		);
		expect(parseWireAgentName('   ')).toBeUndefined();
		expect(parseWireAgentName(42)).toBeUndefined();
		expect(parseWireAgentName(undefined)).toBeUndefined();
	});
});

describe('parseWireHandoffAnswer', () => {
	it('keeps a string, the empty one included, bounded; anything else is no hand-off', () => {
		expect(parseWireHandoffAnswer('Ship it.')).toBe('Ship it.');
		expect(parseWireHandoffAnswer('')).toBe('');
		expect(parseWireHandoffAnswer('a'.repeat(MAX_WIRE_HANDOFF_ANSWER + 5))).toHaveLength(
			MAX_WIRE_HANDOFF_ANSWER
		);
		expect(parseWireHandoffAnswer(undefined)).toBeUndefined();
		expect(parseWireHandoffAnswer({ text: 'x' })).toBeUndefined();
	});
});
