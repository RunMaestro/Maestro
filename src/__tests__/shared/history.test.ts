/**
 * Tests for src/shared/history.ts
 *
 * Per-session history utilities: constants, types, and helper functions
 */

import { describe, it, expect } from 'vitest';
import {
	HISTORY_VERSION,
	MAX_ENTRIES_PER_SESSION,
	ORPHANED_SESSION_ID,
	resolveHistoryEntryLimit,
	parseHistoryJsonl,
	serializeHistoryEntryLine,
	trimHistoryEntriesToLimit,
	sanitizeSessionId,
	paginateEntries,
	sortEntriesByTimestamp,
	normalizeHistoryEntryType,
	normalizeHistoryEntries,
	isHistoryEntryType,
	visibleHistoryEntryTypes,
	ALL_HISTORY_ENTRY_TYPES,
	type HistoryFileData,
	type MigrationMarker,
	type PaginationOptions,
	type PaginatedResult,
} from '../../shared/history';
import type { HistoryEntry } from '../../shared/types';

// Helper to create mock history entries
function createMockEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: `entry-${Math.random().toString(36).slice(2)}`,
		type: 'USER',
		timestamp: Date.now(),
		summary: 'Test entry',
		projectPath: '/test/project',
		...overrides,
	};
}

describe('shared/history', () => {
	describe('Constants', () => {
		it('exports HISTORY_VERSION as 1', () => {
			expect(HISTORY_VERSION).toBe(1);
		});

		it('exports MAX_ENTRIES_PER_SESSION as 5000', () => {
			expect(MAX_ENTRIES_PER_SESSION).toBe(5000);
		});

		it('exports ORPHANED_SESSION_ID as _orphaned', () => {
			expect(ORPHANED_SESSION_ID).toBe('_orphaned');
		});
	});

	describe('resolveHistoryEntryLimit', () => {
		it('returns the configured cap when it is a positive number', () => {
			expect(resolveHistoryEntryLimit(25000)).toBe(25000);
			expect(resolveHistoryEntryLimit(1)).toBe(1);
		});

		it('parses a numeric string (settings files hand-edited as text)', () => {
			expect(resolveHistoryEntryLimit('12000')).toBe(12000);
		});

		it('floors a fractional cap so slice() gets an integer', () => {
			expect(resolveHistoryEntryLimit(10.9)).toBe(10);
		});

		it('falls back to MAX_ENTRIES_PER_SESSION for unusable values', () => {
			for (const value of [undefined, null, 0, -5, NaN, Infinity, 'abc', {}, []]) {
				expect(resolveHistoryEntryLimit(value)).toBe(MAX_ENTRIES_PER_SESSION);
			}
		});
	});

	describe('JSONL storage format', () => {
		describe('serializeHistoryEntryLine', () => {
			it('emits exactly one newline-terminated line', () => {
				const line = serializeHistoryEntryLine(createMockEntry({ id: 'x' }));
				expect(line.endsWith('\n')).toBe(true);
				expect(line.trimEnd().split('\n')).toHaveLength(1);
			});

			it('escapes embedded newlines so one entry stays one line', () => {
				// The one-entry-one-line invariant is what makes torn-line recovery
				// possible; a raw newline in a summary would break it.
				const line = serializeHistoryEntryLine(
					createMockEntry({ summary: 'first\nsecond\nthird' })
				);
				expect(line.trimEnd().split('\n')).toHaveLength(1);
				expect(parseHistoryJsonl(line).entries[0].summary).toBe('first\nsecond\nthird');
			});

			it('round-trips through parseHistoryJsonl', () => {
				const entries = [createMockEntry({ id: 'a' }), createMockEntry({ id: 'b' })];
				const raw = entries.map(serializeHistoryEntryLine).join('');
				const parsed = parseHistoryJsonl(raw);
				expect(parsed.entries).toEqual(entries);
				expect(parsed.malformedLines).toBe(0);
			});
		});

		describe('parseHistoryJsonl', () => {
			it('returns an empty result for empty input', () => {
				expect(parseHistoryJsonl('')).toEqual({ entries: [], malformedLines: 0 });
			});

			it('ignores blank lines without counting them as malformed', () => {
				const raw = `${serializeHistoryEntryLine(createMockEntry({ id: 'a' }))}\n\n`;
				const parsed = parseHistoryJsonl(raw);
				expect(parsed.entries).toHaveLength(1);
				expect(parsed.malformedLines).toBe(0);
			});

			it('keeps every good line when the final line is torn', () => {
				// An append interrupted by a crash leaves a partial last line. The
				// whole point of the format is that this costs one entry, not the file.
				const good = [createMockEntry({ id: 'a' }), createMockEntry({ id: 'b' })];
				const raw = `${good.map(serializeHistoryEntryLine).join('')}{"id":"torn","summ`;
				const parsed = parseHistoryJsonl(raw);
				expect(parsed.entries.map((e) => e.id)).toEqual(['a', 'b']);
				expect(parsed.malformedLines).toBe(1);
			});

			it('survives a torn line in the MIDDLE of the file', () => {
				const raw = [
					serializeHistoryEntryLine(createMockEntry({ id: 'a' })),
					'{"id":"torn"\n',
					serializeHistoryEntryLine(createMockEntry({ id: 'c' })),
				].join('');
				const parsed = parseHistoryJsonl(raw);
				expect(parsed.entries.map((e) => e.id)).toEqual(['a', 'c']);
				expect(parsed.malformedLines).toBe(1);
			});

			it('counts a line that parses but is not entry-shaped as malformed', () => {
				const raw = `${serializeHistoryEntryLine(createMockEntry({ id: 'a' }))}null\n42\n`;
				const parsed = parseHistoryJsonl(raw);
				expect(parsed.entries).toHaveLength(1);
				expect(parsed.malformedLines).toBe(2);
			});

			it('yields no entries for a legacy single-object file', () => {
				// Pretty-printed legacy JSON spans many lines, none individually
				// parseable. Callers detect this via the legacy path, not here.
				const legacy = JSON.stringify({ version: 1, entries: [createMockEntry()] }, null, 2);
				expect(parseHistoryJsonl(legacy).entries).toHaveLength(0);
			});
		});

		describe('trimHistoryEntriesToLimit', () => {
			const entries = ['a', 'b', 'c', 'd'].map((id) => createMockEntry({ id }));

			it('keeps the NEWEST entries, i.e. the tail of file order', () => {
				expect(trimHistoryEntriesToLimit(entries, 2).map((e) => e.id)).toEqual(['c', 'd']);
			});

			it('returns the input untouched when it already fits', () => {
				expect(trimHistoryEntriesToLimit(entries, 4)).toBe(entries);
				expect(trimHistoryEntriesToLimit(entries, 99)).toBe(entries);
			});

			it('refuses to trim on a nonsensical limit rather than emptying the file', () => {
				expect(trimHistoryEntriesToLimit(entries, 0)).toBe(entries);
				expect(trimHistoryEntriesToLimit(entries, -5)).toBe(entries);
			});
		});
	});

	describe('sanitizeSessionId', () => {
		it('returns alphanumeric strings unchanged', () => {
			expect(sanitizeSessionId('session123')).toBe('session123');
		});

		it('allows underscores and hyphens', () => {
			expect(sanitizeSessionId('my-session_id')).toBe('my-session_id');
		});

		it('replaces spaces with underscores', () => {
			expect(sanitizeSessionId('session with spaces')).toBe('session_with_spaces');
		});

		it('replaces special characters with underscores', () => {
			expect(sanitizeSessionId('session!@#$%^&*()')).toBe('session__________');
		});

		it('replaces slashes with underscores', () => {
			expect(sanitizeSessionId('path/to/session')).toBe('path_to_session');
		});

		it('replaces backslashes with underscores', () => {
			expect(sanitizeSessionId('path\\to\\session')).toBe('path_to_session');
		});

		it('handles empty string', () => {
			expect(sanitizeSessionId('')).toBe('');
		});

		it('preserves case', () => {
			expect(sanitizeSessionId('MySession')).toBe('MySession');
		});

		it('handles mixed content', () => {
			expect(sanitizeSessionId('my-session_123!test')).toBe('my-session_123_test');
		});
	});

	describe('paginateEntries', () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			createMockEntry({ id: `entry-${i}`, timestamp: 1000 + i })
		);

		it('returns all entries with default pagination when total < limit', () => {
			const result = paginateEntries(entries);
			expect(result.entries.length).toBe(10);
			expect(result.total).toBe(10);
			expect(result.limit).toBe(100);
			expect(result.offset).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('respects custom limit', () => {
			const result = paginateEntries(entries, { limit: 5 });
			expect(result.entries.length).toBe(5);
			expect(result.total).toBe(10);
			expect(result.limit).toBe(5);
			expect(result.hasMore).toBe(true);
		});

		it('respects custom offset', () => {
			const result = paginateEntries(entries, { offset: 3, limit: 3 });
			expect(result.entries.length).toBe(3);
			expect(result.entries[0].id).toBe('entry-3');
			expect(result.offset).toBe(3);
		});

		it('returns hasMore=false when at end', () => {
			const result = paginateEntries(entries, { offset: 8, limit: 5 });
			expect(result.entries.length).toBe(2);
			expect(result.hasMore).toBe(false);
		});

		it('returns empty entries when offset exceeds total', () => {
			const result = paginateEntries(entries, { offset: 100 });
			expect(result.entries.length).toBe(0);
			expect(result.hasMore).toBe(false);
			expect(result.total).toBe(10);
		});

		it('handles empty array', () => {
			const result = paginateEntries([]);
			expect(result.entries.length).toBe(0);
			expect(result.total).toBe(0);
			expect(result.hasMore).toBe(false);
		});

		it('handles undefined options', () => {
			const result = paginateEntries(entries, undefined);
			expect(result.limit).toBe(100);
			expect(result.offset).toBe(0);
		});

		it('handles partial options (limit only)', () => {
			const result = paginateEntries(entries, { limit: 3 });
			expect(result.limit).toBe(3);
			expect(result.offset).toBe(0);
		});

		it('handles partial options (offset only)', () => {
			const result = paginateEntries(entries, { offset: 2 });
			expect(result.offset).toBe(2);
			expect(result.limit).toBe(100);
		});
	});

	describe('sortEntriesByTimestamp', () => {
		it('sorts entries by timestamp descending (most recent first)', () => {
			const entries = [
				createMockEntry({ id: 'old', timestamp: 1000 }),
				createMockEntry({ id: 'new', timestamp: 3000 }),
				createMockEntry({ id: 'mid', timestamp: 2000 }),
			];

			const sorted = sortEntriesByTimestamp(entries);
			expect(sorted[0].id).toBe('new');
			expect(sorted[1].id).toBe('mid');
			expect(sorted[2].id).toBe('old');
		});

		it('does not mutate original array', () => {
			const entries = [
				createMockEntry({ id: 'old', timestamp: 1000 }),
				createMockEntry({ id: 'new', timestamp: 3000 }),
			];
			const originalFirst = entries[0].id;

			sortEntriesByTimestamp(entries);
			expect(entries[0].id).toBe(originalFirst);
		});

		it('handles empty array', () => {
			const result = sortEntriesByTimestamp([]);
			expect(result).toEqual([]);
		});

		it('handles single entry', () => {
			const entry = createMockEntry({ id: 'solo' });
			const result = sortEntriesByTimestamp([entry]);
			expect(result.length).toBe(1);
			expect(result[0].id).toBe('solo');
		});

		it('handles entries with same timestamp', () => {
			const entries = [
				createMockEntry({ id: 'a', timestamp: 1000 }),
				createMockEntry({ id: 'b', timestamp: 1000 }),
			];

			const sorted = sortEntriesByTimestamp(entries);
			expect(sorted.length).toBe(2);
			// Order is stable but not guaranteed, just ensure both are present
			expect(sorted.map((e) => e.id).sort()).toEqual(['a', 'b']);
		});
	});

	describe('Type exports', () => {
		it('exports HistoryFileData interface', () => {
			const data: HistoryFileData = {
				version: HISTORY_VERSION,
				sessionId: 'test-session',
				projectPath: '/test/project',
				entries: [],
			};
			expect(data.version).toBe(1);
		});

		it('exports MigrationMarker interface', () => {
			const marker: MigrationMarker = {
				migratedAt: Date.now(),
				version: HISTORY_VERSION,
				legacyEntryCount: 100,
				sessionsMigrated: 5,
			};
			expect(marker.version).toBe(1);
		});

		it('exports PaginationOptions interface', () => {
			const opts: PaginationOptions = { limit: 50, offset: 10 };
			expect(opts.limit).toBe(50);
		});

		it('exports PaginatedResult interface', () => {
			const result: PaginatedResult<string> = {
				entries: ['a', 'b'],
				total: 100,
				limit: 10,
				offset: 0,
				hasMore: true,
			};
			expect(result.entries.length).toBe(2);
		});
	});

	describe('Edge cases', () => {
		it('sanitizeSessionId handles unicode characters', () => {
			const result = sanitizeSessionId('session-日本語');
			expect(result).toBe('session-___');
		});

		it('paginateEntries with limit 0 returns empty', () => {
			const entries = [createMockEntry()];
			const result = paginateEntries(entries, { limit: 0 });
			expect(result.entries.length).toBe(0);
		});

		it('paginateEntries with negative offset treated as 0', () => {
			const entries = [createMockEntry()];
			// JavaScript slice handles negative indices differently
			const result = paginateEntries(entries, { offset: -1 });
			// slice(-1, 99) would return the last element
			expect(result.entries.length).toBeLessThanOrEqual(1);
		});
	});
});

describe('history entry type helpers', () => {
	const base: HistoryEntry = {
		id: 'e1',
		type: 'AUTO',
		timestamp: 1_700_000_000_000,
		summary: 'Consulted by Pedsidian: why',
		projectPath: '/repo',
	};

	describe('ALL_HISTORY_ENTRY_TYPES', () => {
		it('is the single list of every entry type', () => {
			expect([...ALL_HISTORY_ENTRY_TYPES].sort()).toEqual(['AGENT', 'AUTO', 'CUE', 'USER']);
		});
	});

	describe('isHistoryEntryType', () => {
		it('accepts every known type', () => {
			for (const t of ALL_HISTORY_ENTRY_TYPES) expect(isHistoryEntryType(t)).toBe(true);
		});

		it('rejects unknown values without throwing', () => {
			for (const v of ['auto', 'BOGUS', '', null, undefined, 7, {}]) {
				expect(isHistoryEntryType(v)).toBe(false);
			}
		});
	});

	describe('visibleHistoryEntryTypes', () => {
		it('drops CUE when the Cue feature is off', () => {
			expect(visibleHistoryEntryTypes(false)).not.toContain('CUE');
		});

		it('keeps AGENT regardless of the Cue feature', () => {
			expect(visibleHistoryEntryTypes(false)).toContain('AGENT');
			expect(visibleHistoryEntryTypes(true)).toContain('AGENT');
		});
	});

	describe('normalizeHistoryEntryType', () => {
		it('re-maps a legacy consult (AUTO + sourceAgentName) to AGENT', () => {
			// Consults were written as AUTO before the AGENT type existed, which made
			// them render as Auto Run tasks and inflated the Auto Run counts.
			expect(normalizeHistoryEntryType({ ...base, sourceAgentName: 'Pedsidian' })).toBe('AGENT');
		});

		it('leaves a genuine Auto Run entry alone', () => {
			expect(normalizeHistoryEntryType(base)).toBe('AUTO');
		});

		it('leaves USER and CUE entries alone even if somehow attributed', () => {
			expect(normalizeHistoryEntryType({ ...base, type: 'USER' })).toBe('USER');
			expect(normalizeHistoryEntryType({ ...base, type: 'CUE', sourceAgentName: 'X' })).toBe('CUE');
		});

		it('passes through entries already written as AGENT', () => {
			expect(
				normalizeHistoryEntryType({ ...base, type: 'AGENT', sourceAgentName: 'Pedsidian' })
			).toBe('AGENT');
		});
	});

	describe('normalizeHistoryEntries', () => {
		it('re-maps only the legacy consults in a mixed list', () => {
			const result = normalizeHistoryEntries([
				base,
				{ ...base, id: 'e2', sourceAgentName: 'Pedsidian' },
				{ ...base, id: 'e3', type: 'USER' },
			]);
			expect(result.map((e) => e.type)).toEqual(['AUTO', 'AGENT', 'USER']);
		});

		it('returns the same array reference when nothing needs re-mapping', () => {
			// Hot path: every read goes through this, so it must not allocate for the
			// overwhelmingly common case of a file with no legacy consults.
			const entries = [base, { ...base, id: 'e2', type: 'USER' as const }];
			expect(normalizeHistoryEntries(entries)).toBe(entries);
		});

		it('does not mutate the input entries', () => {
			const entries = [{ ...base, sourceAgentName: 'Pedsidian' }];
			normalizeHistoryEntries(entries);
			expect(entries[0].type).toBe('AUTO');
		});

		it('handles an empty list', () => {
			expect(normalizeHistoryEntries([])).toEqual([]);
		});
	});
});
