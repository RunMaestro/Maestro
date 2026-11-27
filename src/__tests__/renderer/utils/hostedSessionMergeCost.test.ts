/**
 * Parity R29 (the rest of R8): a streaming hosted reply costs each chunk the same work whatever the
 * length of the transcript, as a local reply does. The fourth live pass's soak streamed a
 * 4000-line reply; this is its unit-level bound: the count of entry compares (`drawsTheSame()`)
 * and of `canonicalJson()` calls per chunk for a 4000-entry transcript must stay constant.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '../../../renderer/types';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';

vi.mock('../../../shared/canonicalJson', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/canonicalJson')>();
	return { ...actual, canonicalJson: vi.fn(actual.canonicalJson) };
});

import { canonicalJson } from '../../../shared/canonicalJson';
import {
	__hostedEntryComparesForTests,
	mergeHostedLogs,
} from '../../../renderer/utils/hostedSession';

const TRANSCRIPT = 4000;
const CHUNKS = 40;

/** A saved transcript: user messages, answers, and a tool card every fourth entry. */
function savedTranscript(): LogEntryRecord[] {
	return Array.from({ length: TRANSCRIPT }, (_, i): LogEntryRecord => {
		const base = { id: `e${i}`, timestamp: i + 1 };
		if (i % 4 === 0) return { ...base, source: 'user', text: `ask ${i}`, delivered: true };
		if (i % 4 === 3) {
			return {
				...base,
				source: 'tool',
				text: 'Read',
				metadata: { toolState: { status: 'completed', input: { file_path: `/p/${i}.md` } } },
			};
		}
		return { ...base, source: 'stdout', text: `line ${i}` };
	});
}

/** The same entries as this machine held them before the read (a lift, a restart). */
function heldHere(records: readonly LogEntryRecord[]): LogEntry[] {
	return records.map((record) => ({
		id: record.id,
		timestamp: record.timestamp,
		source: record.source as LogEntry['source'],
		text: record.text,
		...(record.delivered !== undefined ? { delivered: record.delivered } : {}),
		...(record.metadata ? { metadata: structuredClone(record.metadata) } : {}),
	}));
}

/** The live tail after `n` chunks: one growing answer entry. */
const tailAt = (n: number): LogEntryRecord[] => [
	{
		id: 'live-answer',
		timestamp: TRANSCRIPT + 10,
		source: 'stdout',
		text: Array.from({ length: n }, (_, i) => `chunk ${i}`).join('\n'),
	},
];

describe('a streaming hosted reply costs each chunk the same (R29)', () => {
	beforeEach(() => {
		vi.mocked(canonicalJson).mockClear();
		__hostedEntryComparesForTests(true);
	});

	it('compares a constant number of entries and turns a constant number into strings per chunk, for a 4000-entry transcript', () => {
		const persisted = savedTranscript();
		let logs = mergeHostedLogs(heldHere(persisted), persisted, tailAt(1));
		// The first pass compares every entry once: the transcript was just read.
		expect(__hostedEntryComparesForTests(true)).toBeGreaterThanOrEqual(TRANSCRIPT);
		vi.mocked(canonicalJson).mockClear();

		const compares: number[] = [];
		const strings: number[] = [];
		for (let chunk = 2; chunk <= CHUNKS; chunk += 1) {
			const next = mergeHostedLogs(logs, persisted, tailAt(chunk));
			expect(next).not.toBe(logs);
			logs = next;
			compares.push(__hostedEntryComparesForTests(true));
			strings.push(vi.mocked(canonicalJson).mock.calls.length);
			vi.mocked(canonicalJson).mockClear();
		}

		// Only the live entry is new each chunk: no saved entry is compared again.
		expect(Math.max(...compares)).toBeLessThanOrEqual(2);
		expect(Math.max(...strings)).toBeLessThanOrEqual(2);
		// Every saved entry keeps the object it was drawn with, so its row does not render again.
		expect(logs.slice(0, TRANSCRIPT).every((entry, i) => entry.id === `e${i}`)).toBe(true);
		expect(logs[TRANSCRIPT].text).toContain(`chunk ${CHUNKS - 1}`);
	});

	it('still redraws a saved entry the host changed between chunks', () => {
		const persisted = savedTranscript();
		let logs = mergeHostedLogs(heldHere(persisted), persisted, tailAt(1));
		logs = mergeHostedLogs(logs, persisted, tailAt(2));
		const kept = logs[1];
		// A new read of the saved transcript with one line rewritten in place.
		const reread = persisted.map((record, i) =>
			i === 1 ? { ...record, text: 'rewritten' } : record
		);
		const next = mergeHostedLogs(logs, reread, tailAt(3));
		expect(next[1].text).toBe('rewritten');
		expect(next[1]).not.toBe(kept);
		expect(next[2]).toBe(logs[2]);
	});
});
