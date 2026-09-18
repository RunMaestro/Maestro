/**
 * Tests for the Cue/JSONL history merge.
 *
 * Cue runs live in two stores for as long as the pre-migration JSONL entries
 * survive: the `cue_events` table, and the agent's history file from back when
 * Cue runs were still written there. `dropCueRowsAlreadyInJsonl` is what keeps
 * a run that exists in both from rendering twice.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { dropCueRowsAlreadyInJsonl, mergeEntriesById } from '../../../main/utils/cue-history-merge';
import type { HistoryEntry } from '../../../shared/types';

const BASE = new Date('2026-09-14T12:00:00Z').getTime();

function cueEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: `id-${Math.random().toString(36).slice(2, 10)}`,
		type: 'CUE',
		timestamp: BASE,
		summary: 'no unfiled requests',
		projectPath: '/project',
		sessionId: 'session-1',
		cueTriggerName: 'Request-Drain',
		cueEventType: 'time.heartbeat',
		...overrides,
	};
}

describe('dropCueRowsAlreadyInJsonl', () => {
	it('returns the rows untouched when the history file has no Cue entries', () => {
		const rows = [cueEntry({ id: 'db-1' })];
		expect(dropCueRowsAlreadyInJsonl([], rows)).toEqual(rows);
		expect(dropCueRowsAlreadyInJsonl([cueEntry({ type: 'USER' })], rows)).toEqual(rows);
	});

	it('suppresses a row whose summary matches its JSONL twin exactly', () => {
		// The post-migration case: both writers derived the summary from the same
		// output, so the strings are byte-identical.
		const jsonl = [cueEntry({ id: 'jsonl-1', timestamp: BASE + 4000 })];
		const rows = [cueEntry({ id: 'db-1', timestamp: BASE, elapsedTimeMs: 4000 })];

		expect(dropCueRowsAlreadyInJsonl(jsonl, rows)).toEqual([]);
	});

	it('suppresses a pre-backfill row whose summary is a reconstructed label', () => {
		// Regression: runs that finished before output_excerpt existed have NULL
		// in the column, so the DB row falls back to buildCueRunSummary's
		// `"Trigger" - Agent` label while the JSONL entry kept the real output.
		// Two strings, one run. Measured at 565 rows rendering twice on ship day.
		const jsonl = [cueEntry({ id: 'jsonl-1', summary: 'no unfiled requests' })];
		const rows = [
			cueEntry({
				id: 'db-1',
				summary: '"Request-Drain" - Pedsidian',
				elapsedTimeMs: 0,
			}),
		];

		expect(dropCueRowsAlreadyInJsonl(jsonl, rows)).toEqual([]);
	});

	it('keeps a row from a DIFFERENT trigger even at the same instant', () => {
		// The fallback drops the summary from the key but never the trigger or
		// the event type, so unrelated runs cannot silence each other.
		const jsonl = [cueEntry({ id: 'jsonl-1', cueTriggerName: 'Request-Drain' })];
		const rows = [cueEntry({ id: 'db-1', cueTriggerName: 'Fact-Check', summary: 'other' })];

		expect(dropCueRowsAlreadyInJsonl(jsonl, rows).map((r) => r.id)).toEqual(['db-1']);
	});

	it('keeps a row from a different agent', () => {
		const jsonl = [cueEntry({ id: 'jsonl-1', sessionId: 'session-1' })];
		const rows = [cueEntry({ id: 'db-1', sessionId: 'session-2', summary: 'other' })];

		expect(dropCueRowsAlreadyInJsonl(jsonl, rows).map((r) => r.id)).toEqual(['db-1']);
	});

	it('keeps a row that finished outside the tolerance', () => {
		const jsonl = [cueEntry({ id: 'jsonl-1', timestamp: BASE })];
		const rows = [
			cueEntry({
				id: 'db-1',
				summary: '"Request-Drain" - Agent',
				timestamp: BASE + 60 * 60 * 1000,
			}),
		];

		expect(dropCueRowsAlreadyInJsonl(jsonl, rows).map((r) => r.id)).toEqual(['db-1']);
	});

	it('lets each JSONL entry hide at most ONE row', () => {
		// A heartbeat that prints the same line all day must not collapse: N
		// entries hide N rows, and the surplus stays visible.
		const jsonl = [
			cueEntry({ id: 'jsonl-1', timestamp: BASE }),
			cueEntry({ id: 'jsonl-2', timestamp: BASE + 60_000 }),
		];
		const rows = [
			cueEntry({ id: 'db-1', timestamp: BASE }),
			cueEntry({ id: 'db-2', timestamp: BASE + 60_000 }),
			cueEntry({ id: 'db-3', timestamp: BASE + 120_000 }),
		];

		const kept = dropCueRowsAlreadyInJsonl(jsonl, rows);
		expect(kept).toHaveLength(1);
		expect(kept[0].id).toBe('db-3');
	});

	it('does not let the two passes consume the same JSONL entry twice', () => {
		// One entry, two rows: one matching by summary and one only by trigger.
		// Exactly one row may be suppressed, or a real run would vanish.
		const jsonl = [cueEntry({ id: 'jsonl-1', summary: 'shared output', timestamp: BASE })];
		const rows = [
			cueEntry({ id: 'db-exact', summary: 'shared output', timestamp: BASE }),
			cueEntry({ id: 'db-label', summary: '"Request-Drain" - Agent', timestamp: BASE }),
		];

		const kept = dropCueRowsAlreadyInJsonl(jsonl, rows);
		expect(kept).toHaveLength(1);
		expect(kept[0].id).toBe('db-label');
	});

	it('keeps a run that only the database has', () => {
		// Past the JSONL cutover every run is DB-only; none may be hidden.
		const jsonl = [cueEntry({ id: 'jsonl-1', cueTriggerName: 'Old-Trigger' })];
		const rows = [
			cueEntry({ id: 'db-1', cueTriggerName: 'New-Trigger', summary: 'fresh run' }),
			cueEntry({ id: 'db-2', cueTriggerName: 'New-Trigger', summary: 'another' }),
		];

		expect(dropCueRowsAlreadyInJsonl(jsonl, rows).map((r) => r.id)).toEqual(['db-1', 'db-2']);
	});
});

describe('mergeEntriesById', () => {
	it('interleaves both sources newest-first', () => {
		const jsonl = [
			cueEntry({ id: 'a', type: 'USER', timestamp: BASE + 3000 }),
			cueEntry({ id: 'b', type: 'USER', timestamp: BASE + 1000 }),
		];
		const cue = [cueEntry({ id: 'c', timestamp: BASE + 2000 })];

		expect(mergeEntriesById(jsonl, cue).map((e) => e.id)).toEqual(['a', 'c', 'b']);
	});

	it('never admits an id the base already carries', () => {
		const jsonl = [cueEntry({ id: 'dupe', timestamp: BASE })];
		const cue = [cueEntry({ id: 'dupe', timestamp: BASE, summary: 'different text' })];

		const merged = mergeEntriesById(jsonl, cue);
		expect(merged).toHaveLength(1);
		expect(merged[0].summary).toBe('no unfiled requests');
	});
});
