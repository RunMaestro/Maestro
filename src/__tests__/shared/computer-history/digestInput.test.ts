/**
 * @file digestInput.test.ts
 * @description What a local model is shown to write a Computer History digest:
 * a segment as compact lines inside a character budget, a block as its
 * 15-minute digests, and the instruction above each.
 */

import { describe, expect, it } from 'vitest';
import {
	MAX_DIGEST_EVENT_TEXT_CHARS,
	MAX_ROLLUP_DIGEST_CHARS,
	MIN_DIGEST_EVENT_TEXT_CHARS,
	buildLocalDigestInstruction,
	renderDigestsForRollup,
	renderSegmentForDigest,
} from '../../../shared/computer-history/digestInput';
import type { StoredEvent } from '../../../shared/computer-history/types';

const SAFARI = { id: 'com.apple.Safari', name: 'Safari', pid: 1 };
const SLACK = { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 2 };

function event(seq: number, partial: Partial<StoredEvent>): StoredEvent {
	const ts = new Date(Date.parse('2026-10-03T14:15:00.000Z') + seq * 1000).toISOString();
	return { v: 1, seq, ts, kind: 'content.snapshot', app: SAFARI, ...partial };
}

describe('renderSegmentForDigest', () => {
	it('writes one line per event, with the time and the app in front', () => {
		const { text, shown, total } = renderSegmentForDigest(
			[
				event(0, { kind: 'app.activated', window: { title: 'Invoices', url: 'https://x.test/a' } }),
				event(1, {
					kind: 'text.committed',
					window: { title: 'Invoices', url: 'https://x.test/a' },
					element: { role: 'search_field', label: 'Search' },
					text: 'overdue\n  invoices',
					reason: 'idle',
				}),
				event(2, {
					kind: 'selection.changed',
					window: { title: 'Invoices', url: 'https://x.test/a' },
					text: 'Total due',
				}),
				event(3, { window: { title: 'Invoices', url: 'https://x.test/a' }, text: 'Row one' }),
			],
			{ maxChars: 10_000 }
		);
		expect(text.split('\n')).toEqual([
			'14:15:00 Safari: window "Invoices" (https://x.test/a)',
			// Whitespace is folded, so an event is always one line.
			'14:15:01 Safari: typed in "Search": overdue invoices',
			'14:15:02 Safari: selected: Total due',
			'14:15:03 Safari: on screen: Row one',
		]);
		expect(shown).toBe(4);
		expect(total).toBe(4);
	});

	it('names the window again only when the app, title or URL changes', () => {
		const { text } = renderSegmentForDigest(
			[
				event(0, { window: { title: 'A' }, text: 'one' }),
				event(1, { window: { title: 'A' }, text: 'two' }),
				event(2, { app: SLACK, window: { title: 'general' }, text: 'three' }),
				event(3, { window: { title: 'A' }, text: 'four' }),
			],
			{ maxChars: 10_000 }
		);
		expect(text.split('\n')).toEqual([
			'14:15:00 Safari: window "A"',
			'14:15:00 Safari: on screen: one',
			'14:15:01 Safari: on screen: two',
			'14:15:02 Slack: window "general"',
			'14:15:02 Slack: on screen: three',
			'14:15:03 Safari: window "A"',
			'14:15:03 Safari: on screen: four',
		]);
	});

	it('skips a snapshot identical to the last one of the same window', () => {
		const { text, total } = renderSegmentForDigest(
			[
				event(0, { window: { title: 'A' }, text: 'same screen' }),
				event(1, { window: { title: 'A' }, text: 'same   screen' }),
				event(2, { window: { title: 'A' }, text: 'new screen' }),
				event(3, { window: { title: 'A' }, text: '' }),
			],
			{ maxChars: 10_000 }
		);
		expect(text.match(/on screen/g)).toHaveLength(2);
		expect(total).toBe(4);
	});

	it('says a field was cleared, and falls back to the app id and a bare window', () => {
		const { text } = renderSegmentForDigest(
			[
				event(0, {
					kind: 'text.committed',
					app: { id: 'org.example.app', name: '', pid: 3 },
					element: { role: 'text_field', label: 'Note' },
					reason: 'cleared',
				}),
			],
			{ maxChars: 10_000 }
		);
		expect(text.split('\n')).toEqual([
			'14:15:00 org.example.app: in front',
			'14:15:00 org.example.app: cleared the field in "Note"',
		]);
	});

	it('cuts each event to its share of the budget, never under the floor', () => {
		const long = 'x'.repeat(5000);
		const roomy = renderSegmentForDigest([event(0, { window: { title: 'A' }, text: long })], {
			maxChars: 100_000,
		});
		expect(roomy.text).toContain(`${'x'.repeat(MAX_DIGEST_EVENT_TEXT_CHARS)}...`);
		expect(roomy.text).not.toContain('x'.repeat(MAX_DIGEST_EVENT_TEXT_CHARS + 1));

		const many = Array.from({ length: 40 }, (_, i) =>
			event(i, { window: { title: 'A' }, text: `${i} ${long}` })
		);
		const tight = renderSegmentForDigest(many, { maxChars: 4000 });
		for (const line of tight.text.split('\n').filter((l) => l.includes('on screen'))) {
			const shownText = line.slice(line.indexOf('on screen: ') + 'on screen: '.length);
			expect(shownText.length).toBe(MIN_DIGEST_EVENT_TEXT_CHARS + '...'.length);
		}
	});

	it('samples evenly across the window when the lines still do not fit', () => {
		const many = Array.from({ length: 300 }, (_, i) =>
			event(i, { window: { title: 'A' }, text: `screen ${i} ${'y'.repeat(200)}` })
		);
		const { text, shown, total } = renderSegmentForDigest(many, { maxChars: 3000 });
		expect(text.length).toBeLessThanOrEqual(3000);
		expect(total).toBe(300);
		expect(shown).toBeLessThan(300);
		// The last minute is still there: the cut is a stride, not a head.
		const lines = text.split('\n');
		const lastClock = lines[lines.length - 1].slice(0, 8);
		expect(lastClock >= '14:19:00').toBe(true);
	});

	it('an empty or text-free segment renders nothing', () => {
		expect(renderSegmentForDigest([], { maxChars: 100 })).toEqual({ text: '', shown: 0, total: 0 });
	});
});

describe('renderDigestsForRollup', () => {
	it('joins the digests in order, drops empty ones, and cuts a runaway one', () => {
		const text = renderDigestsForRollup([
			'# 15-minute digest A\n\n- one\n',
			'   ',
			`# 15-minute digest B\n\n${'z'.repeat(MAX_ROLLUP_DIGEST_CHARS * 2)}`,
		]);
		const [first, second] = text.split('\n\n# 15-minute digest B');
		expect(first).toBe('# 15-minute digest A\n\n- one');
		expect(second.length).toBeLessThan(MAX_ROLLUP_DIGEST_CHARS + 10);
		expect(text.endsWith('...')).toBe(true);
	});
});

describe('buildLocalDigestInstruction', () => {
	const job15 = {
		kind: '15m' as const,
		windowStartIso: '2026-10-03T14:15:00.000Z',
		windowEndIso: '2026-10-03T14:30:00.000Z',
		shown: 10,
		total: 10,
	};
	const job6h = {
		kind: '6h' as const,
		blockStartIso: '2026-10-03T12:00:00.000Z',
		blockEndIso: '2026-10-03T18:00:00.000Z',
		digests: 7,
	};

	it('asks for the digest of the window when the record fits one call', () => {
		const text = buildLocalDigestInstruction(job15, { stage: 'whole' });
		expect(text).toContain('Write the digest of the 15 minutes from 2026-10-03T14:15:00.000Z');
		expect(text).toContain('Below is the activity record.');
		expect(text).toContain('at most 12 bullets');
	});

	it('tells the model when it sees a sample', () => {
		const text = buildLocalDigestInstruction(
			{ ...job15, shown: 40, total: 900 },
			{ stage: 'whole' }
		);
		expect(text).toContain('a sample of the activity record (900 events were recorded)');
	});

	it('asks for notes on a part, then for the digest from the notes', () => {
		const part = buildLocalDigestInstruction(job15, { stage: 'part', part: 2, parts: 3 });
		expect(part).toContain('Take notes for the digest');
		expect(part).toContain('part 2 of 3');
		expect(part).toContain('keep the times');
		const merge = buildLocalDigestInstruction(job15, { stage: 'notes', parts: 3 });
		expect(merge).toContain('notes taken on 3 parts');
		expect(merge).toContain('Merge them into one digest');
	});

	it('words a roll-up as a roll-up of digests', () => {
		const text = buildLocalDigestInstruction(job6h, { stage: 'whole' });
		expect(text).toContain('Write the roll-up of the 6 hours from 2026-10-03T12:00:00.000Z');
		expect(text).toContain('7 15-minute digest(s), in time order');
		expect(text).toContain('at most 15 bullets');
	});
});
