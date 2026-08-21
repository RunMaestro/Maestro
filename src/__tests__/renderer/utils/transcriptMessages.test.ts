/**
 * Tests for the transcript message helpers that back scroll-to-top history
 * loading (issue #1407).
 *
 * `selectOlderEntries` is the load-bearing piece: it decides where a freshly
 * read transcript window overlaps what the tab already shows. Getting it wrong
 * either duplicates the visible conversation or silently drops history, so the
 * cases below cover both id-matched tabs (hydrated from disk) and text-matched
 * tabs (ran live, then survived a restart with locally generated ids).
 */

import { describe, it, expect } from 'vitest';
import type { LogEntry } from '../../../renderer/types';
import {
	isSynopsisRequest,
	selectOlderEntries,
	stripSynopsisTurns,
	transcriptMessagesToLogEntries,
	type TranscriptMessage,
} from '../../../renderer/utils/transcriptMessages';

function entry(id: string, text: string, source: LogEntry['source'] = 'user', ts = 0): LogEntry {
	return { id, text, source, timestamp: ts };
}

function message(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
	return {
		type: 'user',
		content: 'hello',
		timestamp: '2026-01-01T00:00:00.000Z',
		uuid: 'uuid-1',
		...overrides,
	};
}

describe('transcriptMessagesToLogEntries', () => {
	it('keeps messages with text and maps user vs assistant to log sources', () => {
		const entries = transcriptMessagesToLogEntries([
			message({ uuid: 'a', type: 'user', content: 'question' }),
			message({ uuid: 'b', type: 'assistant', content: 'answer' }),
		]);

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: 'a', text: 'question', source: 'user' });
		expect(entries[1]).toMatchObject({ id: 'b', text: 'answer', source: 'stdout' });
	});

	it('drops tool-only messages but keeps image-only ones', () => {
		const entries = transcriptMessagesToLogEntries([
			message({ uuid: 'tool', content: '   ' }),
			message({ uuid: 'img', content: '', images: ['data:image/png;base64,AAA'] }),
		]);

		expect(entries.map((e) => e.id)).toEqual(['img']);
		expect(entries[0].images).toEqual(['data:image/png;base64,AAA']);
	});
});

describe('stripSynopsisTurns', () => {
	it('removes the Auto Run synopsis request and the reply that follows it', () => {
		const kept = stripSynopsisTurns([
			message({ uuid: 'a', content: 'real question' }),
			message({
				uuid: 'b',
				content: 'Give a brief synopsis of what you just accomplished',
			}),
			message({ uuid: 'c', type: 'assistant', content: '**Summary:** did things' }),
			message({ uuid: 'd', type: 'assistant', content: 'real answer' }),
		]);

		expect(kept.map((m) => m.uuid)).toEqual(['a', 'd']);
	});

	it('only treats user turns as synopsis requests', () => {
		expect(
			isSynopsisRequest({
				type: 'assistant',
				content: 'Give a brief synopsis of what you just accomplished',
			})
		).toBe(false);
	});
});

describe('selectOlderEntries', () => {
	it('returns everything when the tab is empty', () => {
		const loaded = [entry('1', 'a'), entry('2', 'b')];
		expect(selectOlderEntries(loaded, [])).toEqual(loaded);
	});

	it('prepends only what sits above the first visible entry, matched by id', () => {
		const loaded = [entry('1', 'a'), entry('2', 'b'), entry('3', 'c'), entry('4', 'd')];
		const visible = [entry('3', 'c'), entry('4', 'd')];

		expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2']);
	});

	it('falls back to source+text when the tab holds locally generated ids', () => {
		// The restart path: same conversation, but the visible entries were built
		// live so their ids do not match the on-disk uuids.
		const loaded = [entry('u1', 'a'), entry('u2', 'b'), entry('u3', 'c')];
		const visible = [entry('local-x', 'c'), entry('local-y', 'd')];

		expect(selectOlderEntries(loaded, visible).map((e) => e.text)).toEqual(['a', 'b']);
	});

	it('returns nothing when the visible tab already starts at the first message', () => {
		const loaded = [entry('1', 'a'), entry('2', 'b')];
		const visible = [entry('1', 'a'), entry('2', 'b')];

		expect(selectOlderEntries(loaded, visible)).toEqual([]);
	});

	it('picks the boundary nearest the expected splice point when text repeats', () => {
		// "continue" appears three times. The window is 6 long and the tab shows the
		// newest 3, so the real boundary is index 3 - not the first or last match.
		const loaded = [
			entry('1', 'continue'),
			entry('2', 'work'),
			entry('3', 'continue'),
			entry('4', 'continue'),
			entry('5', 'more'),
			entry('6', 'done'),
		];
		const visible = [entry('x', 'continue'), entry('y', 'more'), entry('z', 'done')];

		expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2', '3']);
	});

	// The expected splice point is only an estimate: it is off by however many
	// renderer-only entries the tab holds (system notices, outage markers). Push
	// that estimate past one repetition of a repeated message and the NEAREST
	// source+text hit is the wrong occurrence, which silently drops the genuine
	// older turns between the two. A match needs corroboration, not just proximity.
	it('prefers the occurrence whose timestamp matches over a nearer text-only hit', () => {
		const loaded = [
			entry('1', 'start', 'user', 0),
			entry('2', 'continue', 'user', 100),
			entry('3', 'work', 'user', 200),
			entry('4', 'continue', 'user', 300),
			entry('5', 'more', 'user', 400),
			entry('6', 'done', 'user', 500),
		];
		// Tab was hydrated from disk (timestamps survive) but holds two
		// renderer-only notices, so expected lands on index 1 - the WRONG
		// "continue". The timestamp pins the real boundary at index 3.
		const visible = [
			entry('local-a', 'continue', 'user', 300),
			entry('sys-1', 'Agent reconnected', 'system', 310),
			entry('sys-2', 'Retrying', 'system', 320),
			entry('local-b', 'more', 'user', 400),
			entry('local-c', 'done', 'user', 500),
		];

		expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2', '3']);
	});

	it('prefers the occurrence whose following entry also lines up', () => {
		const loaded = [
			entry('1', 'start', 'user', 0),
			entry('2', 'continue', 'user', 100),
			entry('3', 'work', 'user', 200),
			entry('4', 'continue', 'user', 300),
			entry('5', 'more', 'user', 400),
			entry('6', 'done', 'user', 500),
		];
		// The restart path: local ids AND renderer clock timestamps, so neither id
		// nor timestamp can pick between the two "continue" entries. The entry that
		// FOLLOWS the boundary is what breaks the tie.
		const visible = [
			entry('local-a', 'continue', 'user', 9001),
			entry('local-b', 'more', 'user', 9002),
			entry('local-c', 'done', 'user', 9003),
			entry('sys-1', 'Agent reconnected', 'system', 9004),
			entry('sys-2', 'Retrying', 'system', 9005),
		];

		expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2', '3']);
	});

	it('still takes the nearest match when nothing corroborates either occurrence', () => {
		// No timestamps, no usable next entry: fall back to proximity, which is the
		// best guess available and the behavior every non-repeating case relies on.
		const loaded = [entry('1', 'continue'), entry('2', 'work'), entry('3', 'continue')];
		const visible = [entry('local-a', 'continue')];

		expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1', '2']);
	});

	it('cuts on timestamp when the boundary entry never reached disk', () => {
		// Maestro-injected system notices live only in the tab, so there is nothing
		// on disk to match. Anything strictly older than it is still safe to prepend.
		const loaded = [entry('1', 'a', 'user', 100), entry('2', 'b', 'user', 300)];
		const visible = [entry('sys', 'Agent reconnected', 'system', 200)];

		expect(selectOlderEntries(loaded, visible).map((e) => e.id)).toEqual(['1']);
	});
});
