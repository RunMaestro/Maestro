// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/history.test.ts
// Source: src/__tests__/shared/duration.test.ts
// Source: src/__tests__/shared/autorunMarkers.test.ts
// Source: src/__tests__/shared/claudeTokenMode.test.ts
import { describe, it, expect } from 'vitest';
import {
	HISTORY_VERSION,
	MAX_ENTRIES_PER_SESSION,
	ORPHANED_SESSION_ID,
	resolveHistoryEntryLimit,
	parseHistoryJsonl,
	parseHistoryFileData,
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
/**
 * Tests for shared/duration.ts - the single unit ladder every humanized
 * duration in Maestro renders from.
 *
 * The preset cases below are not decoration: each one is the exact output some
 * surface shipped before those formatters were folded onto the shared engine.
 * They exist so a future change to the engine cannot quietly restyle the Usage
 * Dashboard, the retry countdown, or a conductor badge.
 */
import {
	humanizeDuration,
	formatDurationHuman,
	formatDurationCompact,
	formatDurationVerbose,
	formatDurationParts,
	formatDurationDecimal,
	formatDurationLong,
	formatDurationWords,
	formatActiveTime,
	formatElapsedTime,
	formatElapsedTicker,
	formatElapsedTickerCompact,
	formatTurnDuration,
	DURATION_MS,
	DURATION_LADDER_DAYS,
	DURATION_LADDER_HOURS,
} from '../../shared/duration';
import {
	scanMaestroMarkers,
	findPendingHitlGate,
	acknowledgeHitlGate,
	detectHaltMarker,
	describeUnresolvedHaltMarker,
	findHaltMarker,
	hasMaestroMarker,
} from '../../shared/autorunMarkers';
import {
	getClaudeTokenMode,
	toClaudeTokenModeSource,
	getClaudeTokenSourceFields,
	autoRunMaestroPMaxWaitSeconds,
	type ClaudeTokenMode,
} from '../../shared/claudeTokenMode';
// Source: src/__tests__/shared/history.test.ts
describe('', () => {
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
			it('exports MAX_ENTRIES_PER_SESSION as 10000', () => {
				expect(MAX_ENTRIES_PER_SESSION).toBe(10000);
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
			timestamp: 1700000000000,
			summary: 'Consulted by Pedsidian: why',
			projectPath: '/repo',
		};
		describe('ALL_HISTORY_ENTRY_TYPES', () => {
			it('is the single list of every entry type', () => {
				expect([...ALL_HISTORY_ENTRY_TYPES].sort()).toEqual([
					'AGENT',
					'AUTO',
					'CUE',
					'RELAY',
					'USER',
				]);
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
				expect(normalizeHistoryEntryType({ ...base, type: 'CUE', sourceAgentName: 'X' })).toBe(
					'CUE'
				);
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
	describe('parseHistoryFileData (legacy single-object format)', () => {
		const doc = { version: 1, sessionId: 's', projectPath: '/p', entries: [{ id: 'a' }] };
		it('parses a well-formed file without marking it recovered', () => {
			expect(parseHistoryFileData(JSON.stringify(doc))).toEqual({ data: doc, recovered: false });
		});
		it('strips a leading BOM', () => {
			expect(parseHistoryFileData(`\uFEFF${JSON.stringify(doc)}`).data).toEqual(doc);
		});
		it('recovers the first object when a torn write left trailing bytes', () => {
			const raw = `${JSON.stringify(doc)}{"version":1,"entr`;
			expect(parseHistoryFileData(raw)).toEqual({ data: doc, recovered: true });
		});
		it('does not mistake a brace inside a string for the end of the object', () => {
			const tricky = { ...doc, projectPath: '/p/{weird}"' };
			const raw = `${JSON.stringify(tricky)}garbage`;
			expect(parseHistoryFileData(raw).data).toEqual(tricky);
		});
		it('throws the SyntaxError for bytes it cannot recover', () => {
			expect(() => parseHistoryFileData('{"version":1,"entr')).toThrow(SyntaxError);
			expect(() => parseHistoryFileData('not json')).toThrow(SyntaxError);
		});
	});
});
// Source: src/__tests__/shared/duration.test.ts
describe('', () => {
	const SECOND = 1000;
	const MINUTE = 60 * SECOND;
	const HOUR = 60 * MINUTE;
	const DAY = 24 * HOUR;
	const WEEK = 7 * DAY;
	const YEAR = 365 * DAY;
	describe('shared/duration', () => {
		// ==========================================================================
		// humanizeDuration - the engine
		// ==========================================================================
		describe('humanizeDuration', () => {
			it('shows the two largest non-zero units by default', () => {
				expect(humanizeDuration(2 * HOUR + 15 * MINUTE + 30 * SECOND)).toBe('2h 15m');
				expect(humanizeDuration(6 * DAY + 7 * HOUR)).toBe('6d 7h');
			});
			it('skips zero units instead of padding them', () => {
				expect(humanizeDuration(2 * DAY + 30 * SECOND)).toBe('2d 30s');
			});
			it('pads zero units when asked, for steady-width columns', () => {
				expect(
					humanizeDuration(2 * HOUR, { keepZeroUnits: true, units: DURATION_LADDER_HOURS })
				).toBe('2h 0m');
			});
			it('never pads a leading zero unit', () => {
				expect(humanizeDuration(45 * SECOND, { keepZeroUnits: true })).toBe('45s');
			});
			it('pads a leading zero when keepLeadingZero is also set', () => {
				expect(
					humanizeDuration(3 * SECOND, {
						units: ['minute', 'second'],
						keepZeroUnits: true,
						keepLeadingZero: true,
					})
				).toBe('0m 3s');
			});
			it('honors the unit budget', () => {
				const span = DAY + 12 * HOUR + 20 * MINUTE;
				expect(humanizeDuration(span, { maxUnits: 1 })).toBe('1d');
				expect(humanizeDuration(span, { maxUnits: 3 })).toBe('1d 12h 20m');
				expect(humanizeDuration(span, { maxUnits: 0 })).toBe('1d');
			});
			it('stops at the ladder ceiling it is given', () => {
				// 30 hours is "1d 6h" on the day ladder but "30h 0m" on the hour ladder.
				expect(humanizeDuration(30 * HOUR, { units: DURATION_LADDER_DAYS })).toBe('1d 6h');
				expect(
					humanizeDuration(30 * HOUR, { units: DURATION_LADDER_HOURS, keepZeroUnits: true })
				).toBe('30h 0m');
			});
			it('renders each label style', () => {
				const span = 2 * HOUR + 30 * MINUTE;
				expect(humanizeDuration(span, { style: 'short' })).toBe('2h 30m');
				expect(humanizeDuration(span, { style: 'long' })).toBe('2 hours 30 minutes');
				expect(humanizeDuration(span, { style: 'caps' })).toBe('2H 30M');
			});
			it('pluralizes only in the long style', () => {
				expect(humanizeDuration(SECOND, { style: 'long' })).toBe('1 second');
				expect(humanizeDuration(2 * SECOND, { style: 'long' })).toBe('2 seconds');
			});
			it('accepts a custom separator', () => {
				expect(humanizeDuration(DAY + 12 * HOUR, { style: 'long', separator: ', ' })).toBe(
					'1 day, 12 hours'
				);
			});
			it('labels months "mo" so short output cannot collide with minutes', () => {
				expect(humanizeDuration(10 * WEEK, { maxUnits: 1 })).toBe('2mo');
				expect(humanizeDuration(10 * MINUTE, { maxUnits: 1 })).toBe('10m');
			});
			describe('adjacentUnits', () => {
				it('drops a distant second unit to keep near-exact spans round', () => {
					expect(humanizeDuration(HOUR + 59 * SECOND, { adjacentUnits: true })).toBe('1h');
					expect(humanizeDuration(YEAR + 3 * DAY, { adjacentUnits: true })).toBe('1y');
				});
				it('keeps the second unit when it is the very next rung', () => {
					expect(humanizeDuration(HOUR + 30 * MINUTE, { adjacentUnits: true })).toBe('1h 30m');
				});
				it('differs from the default, which reports both non-zero units', () => {
					expect(humanizeDuration(HOUR + 59 * SECOND)).toBe('1h 59s');
				});
			});
			describe('rounding', () => {
				it('floors by default, so not-quite-a-minute is not a minute', () => {
					expect(humanizeDuration(59400, { units: DURATION_LADDER_HOURS })).toBe('59s');
				});
				it('rounds up for countdowns, so time left never reads as zero', () => {
					expect(humanizeDuration(59400, { units: DURATION_LADDER_HOURS, round: 'ceil' })).toBe(
						'1m'
					);
					expect(humanizeDuration(1, { round: 'ceil' })).toBe('1s');
				});
			});
			describe('fallback', () => {
				it('renders a zero of the smallest rung by default', () => {
					expect(humanizeDuration(0)).toBe('0s');
					expect(humanizeDuration(0, { style: 'long' })).toBe('0 seconds');
					expect(humanizeDuration(0, { units: ['hour', 'minute'] })).toBe('0m');
				});
				it('uses an explicit fallback when given', () => {
					expect(humanizeDuration(0, { fallback: '<1M' })).toBe('<1M');
				});
				it('collapses spans below the smallest rung', () => {
					expect(humanizeDuration(999)).toBe('0s');
					expect(humanizeDuration(59 * SECOND, { units: ['hour', 'minute'] })).toBe('0m');
				});
				it('collapses negative and non-finite input rather than throwing', () => {
					// These arrive from clock deltas; a backwards jump must not blank a panel.
					expect(humanizeDuration(-5000)).toBe('0s');
					expect(humanizeDuration(Number.NaN)).toBe('0s');
					expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe('0s');
				});
			});
			it('falls back to the full ladder when handed an empty one', () => {
				expect(humanizeDuration(2 * HOUR, { units: [] })).toBe('2h');
			});
		});
		// ==========================================================================
		// Presets - each case is output that shipped before the consolidation
		// ==========================================================================
		describe('formatDurationHuman', () => {
			it('pads to two segments above a minute', () => {
				expect(formatDurationHuman(0)).toBe('0s');
				expect(formatDurationHuman(45 * SECOND)).toBe('45s');
				expect(formatDurationHuman(5 * MINUTE + 30 * SECOND)).toBe('5m 30s');
				expect(formatDurationHuman(5 * MINUTE)).toBe('5m 0s');
				expect(formatDurationHuman(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
			});
			it('counts past a day in hours', () => {
				expect(formatDurationHuman(30 * HOUR)).toBe('30h 0m');
			});
		});
		describe('formatDurationCompact', () => {
			it('drops seconds once the span reaches a minute', () => {
				expect(formatDurationCompact(0)).toBe('0s');
				expect(formatDurationCompact(45 * SECOND)).toBe('45s');
				expect(formatDurationCompact(5 * MINUTE + 30 * SECOND)).toBe('5m');
				expect(formatDurationCompact(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
				expect(formatDurationCompact(2 * HOUR)).toBe('2h 0m');
			});
		});
		describe('formatDurationVerbose', () => {
			it('spells the units out', () => {
				expect(formatDurationVerbose(45 * SECOND)).toBe('45 seconds');
				expect(formatDurationVerbose(5 * MINUTE + 30 * SECOND)).toBe('5 minutes 30 seconds');
				expect(formatDurationVerbose(HOUR + 15 * MINUTE)).toBe('1 hour 15 minutes');
			});
			it('stays round rather than trailing a distant unit', () => {
				expect(formatDurationVerbose(HOUR)).toBe('1 hour');
				expect(formatDurationVerbose(HOUR + 59 * SECOND)).toBe('1 hour');
			});
			it('pluralizes a zero span', () => {
				expect(formatDurationVerbose(0)).toBe('0 seconds');
			});
		});
		describe('formatDurationParts', () => {
			it('reports raw milliseconds below a second', () => {
				expect(formatDurationParts(500)).toBe('500ms');
			});
			it('lists every non-zero segment', () => {
				expect(formatDurationParts(5 * SECOND)).toBe('5s');
				expect(formatDurationParts(2 * MINUTE + 30 * SECOND)).toBe('2m 30s');
				expect(formatDurationParts(HOUR + 15 * MINUTE + 20 * SECOND)).toBe('1h 15m 20s');
			});
			it('drops seconds once the span reaches a day', () => {
				expect(formatDurationParts(3 * DAY + 2 * HOUR + 15 * MINUTE + 30 * SECOND)).toBe(
					'3d 2h 15m'
				);
			});
		});
		describe('formatDurationDecimal', () => {
			it('uses one decimal and a single unit', () => {
				expect(formatDurationDecimal(500)).toBe('500ms');
				expect(formatDurationDecimal(5200)).toBe('5.2s');
				expect(formatDurationDecimal(3 * MINUTE + 6 * SECOND)).toBe('3.1m');
				expect(formatDurationDecimal(HOUR + 30 * MINUTE)).toBe('1.5h');
			});
		});
		describe('formatDurationLong', () => {
			it('ladders to years without months', () => {
				expect(formatDurationLong(45 * SECOND)).toBe('45s');
				expect(formatDurationLong(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
				expect(formatDurationLong(6 * DAY + 7 * HOUR)).toBe('6d 7h');
				expect(formatDurationLong(3 * WEEK + 2 * DAY)).toBe('3w 2d');
				expect(formatDurationLong(YEAR + 7 * WEEK)).toBe('1y 7w');
			});
			it('collapses sub-second and invalid spans', () => {
				expect(formatDurationLong(999)).toBe('0s');
				expect(formatDurationLong(Number.NaN)).toBe('0s');
			});
		});
		describe('formatDurationWords', () => {
			it('singularizes a lone unit', () => {
				expect(formatDurationWords(SECOND)).toBe('1 second');
				expect(formatDurationWords(MINUTE)).toBe('1 minute');
				expect(formatDurationWords(DAY)).toBe('1 day');
			});
			it('pluralizes counts above one', () => {
				expect(formatDurationWords(45 * SECOND)).toBe('45 seconds');
				expect(formatDurationWords(3 * WEEK)).toBe('3 weeks');
			});
			it('shows the two largest non-zero units by default', () => {
				expect(formatDurationWords(5 * MINUTE + 30 * SECOND)).toBe('5 minutes, 30 seconds');
				expect(formatDurationWords(DAY + 12 * HOUR)).toBe('1 day, 12 hours');
				// The 130127.72s snooze gap that motivated this formatter.
				expect(formatDurationWords(130127720)).toBe('1 day, 12 hours');
			});
			it('skips units that are zero rather than padding them', () => {
				expect(formatDurationWords(2 * DAY + 30 * SECOND)).toBe('2 days, 30 seconds');
			});
			it('ladders up through months and years', () => {
				expect(formatDurationWords(10 * WEEK)).toBe('2 months, 1 week');
				expect(formatDurationWords(400 * DAY)).toBe('1 year, 1 month');
			});
			it('never reports twelve months instead of a year', () => {
				expect(formatDurationWords(364 * DAY)).toBe('11 months, 4 weeks');
			});
			it('honors an explicit unit budget', () => {
				expect(formatDurationWords(DAY + 12 * HOUR + 20 * MINUTE, 3)).toBe(
					'1 day, 12 hours, 20 minutes'
				);
				expect(formatDurationWords(DAY + 12 * HOUR, 1)).toBe('1 day');
				expect(formatDurationWords(DAY + 12 * HOUR, 0)).toBe('1 day');
			});
			it('collapses sub-second and invalid spans', () => {
				expect(formatDurationWords(0)).toBe('less than a second');
				expect(formatDurationWords(999)).toBe('less than a second');
				expect(formatDurationWords(-5000)).toBe('less than a second');
				expect(formatDurationWords(Number.NaN)).toBe('less than a second');
			});
		});
		describe('formatActiveTime', () => {
			it('uses uppercase units and shows only days past a day', () => {
				expect(formatActiveTime(30 * SECOND)).toBe('<1M');
				expect(formatActiveTime(5 * MINUTE)).toBe('5M');
				expect(formatActiveTime(2 * HOUR + 30 * MINUTE)).toBe('2H 30M');
				expect(formatActiveTime(2 * HOUR)).toBe('2H');
				expect(formatActiveTime(DAY + 3 * HOUR)).toBe('1D');
			});
		});
		describe('formatElapsedTime', () => {
			it('adds millisecond precision below a second', () => {
				expect(formatElapsedTime(500)).toBe('500ms');
				expect(formatElapsedTime(30 * SECOND)).toBe('30s');
				expect(formatElapsedTime(5 * MINUTE + 12 * SECOND)).toBe('5m 12s');
				expect(formatElapsedTime(HOUR + 10 * MINUTE)).toBe('1h 10m');
			});
		});
		describe('formatElapsedTicker', () => {
			it('keeps the thinking-pill display, including a leading 0m', () => {
				expect(formatElapsedTicker(0)).toBe('0m 0s');
				expect(formatElapsedTicker(3 * SECOND)).toBe('0m 3s');
				expect(formatElapsedTicker(HOUR + 2 * MINUTE + 5 * SECOND)).toBe('1h 2m 5s');
				expect(formatElapsedTicker(DAY + HOUR + MINUTE + SECOND)).toBe('1d 1h 1m 1s');
			});
		});
		describe('formatElapsedTickerCompact', () => {
			it('stays a bare seconds count below a minute', () => {
				expect(formatElapsedTickerCompact(0)).toBe('0s');
				expect(formatElapsedTickerCompact(3 * SECOND)).toBe('3s');
				expect(formatElapsedTickerCompact(59 * SECOND)).toBe('59s');
			});
			it('humanizes past a minute on the same ladder as the ticker', () => {
				expect(formatElapsedTickerCompact(MINUTE)).toBe('1m 0s');
				expect(formatElapsedTickerCompact(20 * MINUTE + 4 * SECOND)).toBe('20m 4s');
				expect(formatElapsedTickerCompact(HOUR + 2 * MINUTE + 5 * SECOND)).toBe('1h 2m 5s');
				expect(formatElapsedTickerCompact(DAY + HOUR + MINUTE + SECOND)).toBe('1d 1h 1m 1s');
			});
			it('collapses a backwards or non-finite clock delta to 0s', () => {
				expect(formatElapsedTickerCompact(-5000)).toBe('0s');
				expect(formatElapsedTickerCompact(Number.NaN)).toBe('0s');
			});
		});
		describe('formatTurnDuration', () => {
			it('stops at minutes, so a reply is never timed to the second', () => {
				expect(formatTurnDuration(25 * MINUTE + 41 * SECOND)).toBe('25m');
				expect(formatTurnDuration(2 * HOUR + 15 * MINUTE + 9 * SECOND)).toBe('2h 15m');
			});
			it('reads as instant below a minute rather than printing 0m', () => {
				expect(formatTurnDuration(0)).toBe('<1m');
				expect(formatTurnDuration(45 * SECOND)).toBe('<1m');
				expect(formatTurnDuration(-5000)).toBe('<1m');
				expect(formatTurnDuration(Number.NaN)).toBe('<1m');
			});
			it('keeps all three rungs on an absurdly long turn', () => {
				expect(formatTurnDuration(5 * DAY + 6 * HOUR + 25 * MINUTE)).toBe('5d 6h 25m');
			});
			it('counts past a week in days, never weeks or months', () => {
				expect(formatTurnDuration(40 * DAY)).toBe('40d');
			});
			it('drops a zero rung instead of padding it', () => {
				expect(formatTurnDuration(3 * HOUR)).toBe('3h');
				expect(formatTurnDuration(2 * DAY + 30 * MINUTE)).toBe('2d 30m');
			});
		});
		describe('DURATION_MS', () => {
			it('exposes the unit sizes callers would otherwise redeclare', () => {
				expect(DURATION_MS.second).toBe(1000);
				expect(DURATION_MS.minute).toBe(60000);
				expect(DURATION_MS.hour).toBe(3600000);
				expect(DURATION_MS.day).toBe(86400000);
				expect(DURATION_MS.week).toBe(604800000);
				expect(DURATION_MS.year).toBe(365 * DURATION_MS.day);
			});
			it('uses the average Gregorian month, so twelve exceed a year', () => {
				expect(DURATION_MS.month * 12).toBeGreaterThan(DURATION_MS.year);
			});
		});
	});
});
// Source: src/__tests__/shared/autorunMarkers.test.ts
describe('', () => {
	describe('scanMaestroMarkers - HITL', () => {
		it('marks a gate live when an unchecked task sits below it', () => {
			const doc = [
				'<!-- MAESTRO:HITL reason="Add the API key" artifact=".env" -->',
				'- [ ] Send the welcome mail',
			].join('\n');
			expect(scanMaestroMarkers(doc)).toEqual([
				{
					kind: 'hitl',
					status: 'live',
					line: 0,
					scope: 'document',
					reason: 'Add the API key',
					artifact: '.env',
				},
			]);
		});
		it('marks a gate spent once the box below it is ticked', () => {
			// Identical source text to the live case apart from one character, which
			// is precisely why reading the raw document cannot answer the question.
			const doc = [
				'<!-- MAESTRO:HITL reason="Add the API key" -->',
				'- [x] Send the welcome mail',
			].join('\n');
			expect(scanMaestroMarkers(doc)[0].status).toBe('spent');
		});
		it('marks a trailing gate spent because it gates nothing', () => {
			const doc = ['- [ ] Real work', '<!-- MAESTRO:HITL reason="Nothing below me" -->'].join('\n');
			expect(scanMaestroMarkers(doc)[0].status).toBe('spent');
		});
		it('resolves a chain of gates together', () => {
			const doc = [
				'<!-- MAESTRO:HITL reason="One" -->',
				'<!-- MAESTRO:HITL reason="Two" -->',
				'- [ ] Task',
			].join('\n');
			expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['live', 'live']);
		});
		it('agrees with the engine about which gate pauses the run', () => {
			// The pill must not claim a gate is live that findPendingHitlGate ignores,
			// or the user removes the wrong marker.
			const doc = [
				'<!-- MAESTRO:HITL reason="Already done" -->',
				'- [x] Approved',
				'<!-- MAESTRO:HITL reason="Still waiting" -->',
				'- [ ] Blocked',
			].join('\n');
			const scanned = scanMaestroMarkers(doc);
			expect(scanned.map((m) => m.status)).toEqual(['spent', 'live']);
			expect(findPendingHitlGate(doc)?.reason).toBe('Still waiting');
		});
		it('supplies the default reason when the attribute is missing', () => {
			expect(scanMaestroMarkers('<!-- MAESTRO:HITL -->\n- [ ] x')[0].reason).toBe(
				'Human review requested'
			);
		});
	});
	describe('scanMaestroMarkers - halt', () => {
		it('always reports a halt as live, wherever it sits', () => {
			// A halt blocks the NEXT run from anywhere in the document, so unlike a
			// HITL gate there is no position that makes it inert.
			const doc = ['- [x] Done', '<!-- maestro:halt: build is broken -->'].join('\n');
			expect(scanMaestroMarkers(doc)).toEqual([
				{ kind: 'halt', status: 'live', line: 1, scope: 'document', reason: 'build is broken' },
			]);
		});
		it('handles the bare form with no reason', () => {
			expect(scanMaestroMarkers('<!-- maestro:halt -->')[0].reason).toBeUndefined();
		});
	});
	describe('scanMaestroMarkers - model', () => {
		it('marks a document hint live above the first unfinished task', () => {
			const doc = ['<!-- MAESTRO:MODEL tier="high" effort="high" -->', '- [ ] Design'].join('\n');
			const [marker] = scanMaestroMarkers(doc);
			expect(marker.status).toBe('live');
			expect(marker.hint).toMatchObject({ tier: 'high', effort: 'high' });
		});
		it('marks a hint governing a later task upcoming, not spent', () => {
			// Regression: a single "have we passed a task yet" latch stamped every
			// marker below the first unchecked task as spent, so a document-wide low
			// with a high phase further down drew the high one as expired - under a
			// tooltip saying it no longer affected the run, while it was in fact the
			// setting that phase was about to be dispatched at.
			const doc = [
				'<!-- MAESTRO:MODEL tier="high" -->',
				'- [ ] Next up',
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] Later',
			].join('\n');
			expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['live', 'upcoming']);
		});
		it('marks a hint spent once a nearer one supersedes it', () => {
			// Nothing to govern: no task falls between the two, so the first never
			// applies to anything and the second is what the next dispatch reads.
			const doc = [
				'<!-- MAESTRO:MODEL tier="high" -->',
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] Only task',
			].join('\n');
			expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['spent', 'live']);
		});
		it('marks a hint spent when every task below it is finished', () => {
			const doc = [
				'- [ ] Still open',
				'<!-- MAESTRO:MODEL tier="high" -->',
				'- [x] Already done',
			].join('\n');
			expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['spent']);
		});
		it('keeps a hint alive across the checked tasks inside its own section', () => {
			// A half-finished section still needs the setting the rest of it runs at,
			// so a checked task must not consume the hint the way it consumes a gate.
			const doc = ['<!-- MAESTRO:MODEL tier="high" -->', '- [x] Done', '- [ ] Not done'].join('\n');
			expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['live']);
		});
		it('marks an inline hint on a later unfinished task upcoming', () => {
			const doc = ['- [ ] First', '- [ ] Design <!-- MAESTRO:MODEL tier="high" -->'].join('\n');
			const [marker] = scanMaestroMarkers(doc);
			expect(marker.status).toBe('upcoming');
			expect(marker.scope).toBe('task');
		});
		it('marks a marker that sets no level spent however much it explains', () => {
			const doc = ['<!-- MAESTRO:MODEL reason="This is only prose." -->', '- [ ] Task'].join('\n');
			const [marker] = scanMaestroMarkers(doc);
			expect(marker.status).toBe('spent');
			expect(marker.hint?.reason).toBe('This is only prose.');
		});
		it('carries the reason through to the marker for the pill to show', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="high" effort="high" reason="Lock ordering across three services. Getting it wrong corrupts data." -->',
				'- [ ] Design',
			].join('\n');
			const [marker] = scanMaestroMarkers(doc);
			expect(marker.status).toBe('live');
			expect(marker.hint?.reason).toBe(
				'Lock ordering across three services. Getting it wrong corrupts data.'
			);
		});
		it('marks an inline hint on a checked task spent', () => {
			const doc = ['- [x] Designed <!-- MAESTRO:MODEL tier="high" -->', '- [ ] Apply'].join('\n');
			const [marker] = scanMaestroMarkers(doc);
			expect(marker.status).toBe('spent');
			expect(marker.scope).toBe('task');
		});
		it('marks an inline hint on the next unfinished task live', () => {
			const doc = ['- [ ] Design <!-- MAESTRO:MODEL tier="high" -->'].join('\n');
			const [marker] = scanMaestroMarkers(doc);
			expect(marker.status).toBe('live');
			expect(marker.scope).toBe('task');
		});
		it('flags a misspelled value as invalid rather than showing it as live', () => {
			// The author believes this is doing something. Rendering it as a normal
			// hint would confirm that belief; the run will ignore it.
			const [marker] = scanMaestroMarkers('<!-- MAESTRO:MODEL tier="hgih" -->\n- [ ] x');
			expect(marker.status).toBe('invalid');
			expect(marker.hint?.invalid).toEqual([{ attribute: 'tier', value: 'hgih' }]);
		});
	});
	describe('scanMaestroMarkers - shared rules', () => {
		it('ignores every marker kind inside a fenced code block', () => {
			// Drawing a pill on a documentation example would state something false
			// about the document. The docs themselves contain all three forms.
			const doc = [
				'```markdown',
				'<!-- MAESTRO:HITL reason="example" -->',
				'<!-- maestro:halt: example -->',
				'<!-- MAESTRO:MODEL tier="high" -->',
				'```',
				'- [ ] The real task',
			].join('\n');
			expect(scanMaestroMarkers(doc)).toEqual([]);
		});
		it('returns markers in source order across kinds', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" -->',
				'<!-- MAESTRO:HITL reason="check" -->',
				'- [ ] Task',
				'<!-- maestro:halt: stopped -->',
			].join('\n');
			expect(scanMaestroMarkers(doc).map((m) => m.kind)).toEqual(['model', 'hitl', 'halt']);
		});
		it('finds nothing in an ordinary document', () => {
			expect(scanMaestroMarkers('# Title\n\n- [ ] Do the thing')).toEqual([]);
			expect(hasMaestroMarker('- [ ] Do the thing')).toBe(false);
			expect(hasMaestroMarker('<!-- MAESTRO:MODEL tier="low" -->')).toBe(true);
		});
		it('does not fire on an unrelated HTML comment', () => {
			expect(scanMaestroMarkers('<!-- TODO: halt later -->\n- [ ] x')).toEqual([]);
		});
	});
	describe('relocated engine helpers still behave', () => {
		it('detectHaltMarker keeps its case-insensitive contract', () => {
			expect(detectHaltMarker('<!-- MAESTRO:HALT: nope -->')).toEqual({
				halted: true,
				reason: 'nope',
			});
			expect(detectHaltMarker('<!-- maestro:something -->')).toEqual({ halted: false });
		});
		it('detectHaltMarker ignores a fenced example, agreeing with the pill', () => {
			// Reversed deliberately: authoring agents document this syntax far more
			// often than executing agents mis-indent a real halt, and a halt that
			// blocked the run while drawing no pill was an invisible cause.
			const doc = ['```', '<!-- maestro:halt: documented, not requested -->', '```'].join('\n');
			expect(detectHaltMarker(doc).halted).toBe(false);
			expect(scanMaestroMarkers(doc)).toEqual([]);
		});
	});
	describe('halt marker - description vs instruction', () => {
		it('obeys a marker standing alone in the document body', () => {
			const doc = [
				'# Plan',
				'',
				'- [ ] Ship it',
				'',
				'<!-- maestro:halt: build is broken -->',
			].join('\n');
			expect(findHaltMarker(doc)).toEqual({ reason: 'build is broken', line: 4 });
			expect(detectHaltMarker(doc)).toEqual({ halted: true, reason: 'build is broken' });
		});
		it('ignores a marker quoted in inline backticks', () => {
			const doc = 'If the build is broken, write `<!-- maestro:halt: build broken -->` and stop.';
			expect(findHaltMarker(doc)).toBeNull();
			expect(detectHaltMarker(doc).halted).toBe(false);
		});
		it('ignores a marker riding a checkbox line', () => {
			const doc = '- [ ] Run the tests. On failure emit <!-- maestro:halt: tests failed -->';
			expect(findHaltMarker(doc)).toBeNull();
			expect(detectHaltMarker(doc).halted).toBe(false);
		});
		it('does not let a described halt block a playbook that has real work', () => {
			// The field bug: an authoring agent writes the marker as a conditional and
			// the playbook refuses to start before its first task ever runs.
			const doc = [
				'# Migration',
				'',
				'If any step below fails irrecoverably, halt with `<!-- maestro:halt: reason -->`.',
				'',
				'- [ ] Write the migration',
				'- [ ] Apply the migration <!-- maestro:halt: only if the DB is unreachable -->',
				'',
				'```markdown',
				'<!-- maestro:halt: brief reason here -->',
				'```',
			].join('\n');
			expect(detectHaltMarker(doc).halted).toBe(false);
		});
		it('reports the first obeyed marker line so the error can point at it', () => {
			const doc = ['a', '<!-- maestro:halt -->', '<!-- maestro:halt: second -->'].join('\n');
			expect(findHaltMarker(doc)).toEqual({ reason: undefined, line: 1 });
		});
		it('draws a spent pill for a described halt and a live one for a real halt', () => {
			const doc = [
				'- [ ] Apply it <!-- maestro:halt: describe only -->',
				'<!-- maestro:halt: really stopped -->',
			].join('\n');
			const halts = scanMaestroMarkers(doc).filter((m) => m.kind === 'halt');
			expect(halts).toEqual([
				expect.objectContaining({ status: 'spent', scope: 'task', line: 0 }),
				expect.objectContaining({ status: 'live', scope: 'document', line: 1 }),
			]);
		});
		it('draws no pill for a halt quoted in prose', () => {
			const doc = 'Emit `<!-- maestro:halt: reason -->` to stop the run.';
			expect(scanMaestroMarkers(doc)).toEqual([]);
		});
	});
	describe('describeUnresolvedHaltMarker', () => {
		it('names the document, the 1-indexed line, and the reason', () => {
			const halt = findHaltMarker('# Review\n\n<!-- maestro:halt: queue empty -->');
			expect(describeUnresolvedHaltMarker('TASK-02', halt!)).toMatch(
				/^Document "TASK-02" contains an unresolved halt marker on line 3: queue empty\. Remove the <!-- maestro:halt --> marker before re-running\./
			);
		});
		it('omits the reason clause for a bare marker', () => {
			const message = describeUnresolvedHaltMarker('doc', { line: 0 });
			expect(message).toMatch(/^Document "doc" contains an unresolved halt marker on line 1\. /);
		});
	});
	describe('acknowledgeHitlGate', () => {
		it('passes a gate that has no box of its own, so Resume does not re-pause', () => {
			const doc = [
				'<!-- MAESTRO:HITL reason="Add GITHUB_CLIENT_ID to .dev.vars" -->',
				'',
				'- [ ] Wire the OAuth callback',
			].join('\n');
			const acked = acknowledgeHitlGate(doc);
			expect(acked).toBe(
				[
					'<!-- MAESTRO:HITL reason="Add GITHUB_CLIENT_ID to .dev.vars" -->',
					'',
					'- [x] Human step done: Add GITHUB_CLIENT_ID to .dev.vars',
					'- [ ] Wire the OAuth callback',
				].join('\n')
			);
			expect(findPendingHitlGate(acked!)).toBeNull();
			expect(scanMaestroMarkers(acked!)[0].status).toBe('spent');
		});
		it('passes every marker in a chain with one box', () => {
			const doc = [
				'<!-- MAESTRO:HITL reason="one" -->',
				'<!-- MAESTRO:HITL reason="two" -->',
				'- [ ] task',
			].join('\n');
			const acked = acknowledgeHitlGate(doc)!;
			expect(acked.split('\n')[2]).toBe('- [x] Human step done: one');
			expect(findPendingHitlGate(acked)).toBeNull();
		});
		it('re-ticks an acknowledgement a looped run unchecked instead of adding another', () => {
			const doc = [
				'<!-- MAESTRO:HITL reason="r" -->',
				'- [ ] Human step done: r',
				'- [ ] task',
			].join('\n');
			expect(acknowledgeHitlGate(doc)).toBe(
				['<!-- MAESTRO:HITL reason="r" -->', '- [x] Human step done: r', '- [ ] task'].join('\n')
			);
		});
		it('keeps CRLF line endings', () => {
			const acked = acknowledgeHitlGate('<!-- MAESTRO:HITL reason="r" -->\r\n- [ ] task\r\n')!;
			expect(acked).toBe(
				'<!-- MAESTRO:HITL reason="r" -->\r\n- [x] Human step done: r\r\n- [ ] task\r\n'
			);
		});
		it('returns null when no gate is pending', () => {
			expect(acknowledgeHitlGate('- [ ] task')).toBeNull();
			expect(
				acknowledgeHitlGate(
					['<!-- MAESTRO:HITL reason="r" -->', '- [x] done', '- [ ] task'].join('\n')
				)
			).toBeNull();
		});
	});
});
// Source: src/__tests__/shared/claudeTokenMode.test.ts
describe('', () => {
	describe('getClaudeTokenMode', () => {
		it('returns api for null/undefined source', () => {
			expect(getClaudeTokenMode(null)).toBe('api');
			expect(getClaudeTokenMode(undefined)).toBe('api');
		});
		it('returns api when the opt-in is off (or absent)', () => {
			expect(getClaudeTokenMode({})).toBe('api');
			expect(getClaudeTokenMode({ enableMaestroP: false })).toBe('api');
			// Even an explicit refinement is ignored while the opt-in is off.
			expect(getClaudeTokenMode({ enableMaestroP: false, maestroPMode: 'interactive' })).toBe(
				'api'
			);
		});
		it('migrates a legacy opt-in with no refinement to dynamic', () => {
			// A pre-refinement session that only had the Adaptive toggle on must read
			// as its historical behavior: dynamic auto-switching.
			expect(getClaudeTokenMode({ enableMaestroP: true })).toBe('dynamic');
		});
		it('honors an explicit refinement when the opt-in is on', () => {
			expect(getClaudeTokenMode({ enableMaestroP: true, maestroPMode: 'interactive' })).toBe(
				'interactive'
			);
			expect(getClaudeTokenMode({ enableMaestroP: true, maestroPMode: 'dynamic' })).toBe('dynamic');
		});
		describe('SSH default (sshEnabled option)', () => {
			it('defaults an UNCONFIGURED SSH agent to interactive (the remote TUI)', () => {
				// enableMaestroP unset over SSH => default to the Max-plan TUI, not API.
				expect(getClaudeTokenMode({}, { sshEnabled: true })).toBe('interactive');
				expect(getClaudeTokenMode(undefined, { sshEnabled: true })).toBe('interactive');
				expect(getClaudeTokenMode(null, { sshEnabled: true })).toBe('interactive');
				expect(getClaudeTokenMode({ maestroPMode: 'dynamic' }, { sshEnabled: true })).toBe(
					'interactive'
				);
			});
			it('still honors an EXPLICIT api choice over SSH (false is not unset)', () => {
				expect(getClaudeTokenMode({ enableMaestroP: false }, { sshEnabled: true })).toBe('api');
				expect(
					getClaudeTokenMode(
						{ enableMaestroP: false, maestroPMode: 'interactive' },
						{ sshEnabled: true }
					)
				).toBe('api');
			});
			it('honors an explicit opt-in over SSH unchanged', () => {
				expect(
					getClaudeTokenMode(
						{ enableMaestroP: true, maestroPMode: 'interactive' },
						{ sshEnabled: true }
					)
				).toBe('interactive');
				// dynamic is still surfaced here; resolveClaudeSpawnMode falls it back to api on SSH.
				expect(
					getClaudeTokenMode(
						{ enableMaestroP: true, maestroPMode: 'dynamic' },
						{ sshEnabled: true }
					)
				).toBe('dynamic');
			});
			it('does NOT change the local (non-SSH) default for an unconfigured agent', () => {
				expect(getClaudeTokenMode({}, { sshEnabled: false })).toBe('api');
				expect(getClaudeTokenMode(undefined)).toBe('api');
			});
			describe('remote maestro-p availability (sshMaestroPAvailable option)', () => {
				it('flips the unconfigured SSH default to api when the remote has no maestro-p', () => {
					expect(getClaudeTokenMode({}, { sshEnabled: true, sshMaestroPAvailable: false })).toBe(
						'api'
					);
					expect(
						getClaudeTokenMode(undefined, { sshEnabled: true, sshMaestroPAvailable: false })
					).toBe('api');
				});
				it('keeps the optimistic interactive default when availability is unknown or present', () => {
					expect(
						getClaudeTokenMode({}, { sshEnabled: true, sshMaestroPAvailable: undefined })
					).toBe('interactive');
					expect(getClaudeTokenMode({}, { sshEnabled: true, sshMaestroPAvailable: true })).toBe(
						'interactive'
					);
				});
				it('does not override an EXPLICIT opt-in even when the remote has no maestro-p', () => {
					// The selector / resolver enforce availability at spawn time; the stored
					// preference is left intact so it survives a transient probe miss.
					expect(
						getClaudeTokenMode(
							{ enableMaestroP: true, maestroPMode: 'interactive' },
							{ sshEnabled: true, sshMaestroPAvailable: false }
						)
					).toBe('interactive');
				});
			});
		});
	});
	describe('toClaudeTokenModeSource', () => {
		it('encodes each mode into the persisted pair, keeping the legacy boolean in sync', () => {
			expect(toClaudeTokenModeSource('api')).toEqual({
				enableMaestroP: false,
				maestroPMode: 'dynamic',
			});
			expect(toClaudeTokenModeSource('interactive')).toEqual({
				enableMaestroP: true,
				maestroPMode: 'interactive',
			});
			expect(toClaudeTokenModeSource('dynamic')).toEqual({
				enableMaestroP: true,
				maestroPMode: 'dynamic',
			});
		});
	});
	describe('round-trip', () => {
		it('getClaudeTokenMode(toClaudeTokenModeSource(m)) === m for every mode', () => {
			const modes: ClaudeTokenMode[] = ['api', 'interactive', 'dynamic'];
			for (const mode of modes) {
				expect(getClaudeTokenMode(toClaudeTokenModeSource(mode))).toBe(mode);
			}
		});
	});
	describe('getClaudeTokenSourceFields', () => {
		// This extractor is the single source of truth every spawn surface that
		// can't hydrate from the persisted session (tab naming, background synopsis)
		// forwards. The contract: it always carries the COMPLETE triple so a Claude
		// turn resolves the same provider the chat would - a partial forward is the
		// bug class that silently downgrades Dynamic to TUI.
		const KEYS = ['enableMaestroP', 'maestroPMode', 'maestroPPath'] as const;
		it('carries all three fields verbatim for every mode', () => {
			expect(
				getClaudeTokenSourceFields({
					enableMaestroP: true,
					maestroPMode: 'dynamic',
					maestroPPath: '/opt/maestro-p',
				})
			).toEqual({ enableMaestroP: true, maestroPMode: 'dynamic', maestroPPath: '/opt/maestro-p' });
			expect(
				getClaudeTokenSourceFields({ enableMaestroP: true, maestroPMode: 'interactive' })
			).toEqual({ enableMaestroP: true, maestroPMode: 'interactive', maestroPPath: undefined });
			expect(getClaudeTokenSourceFields({ enableMaestroP: false })).toEqual({
				enableMaestroP: false,
				maestroPMode: undefined,
				maestroPPath: undefined,
			});
		});
		it('preserves an explicit API opt-out (false must NOT collapse to undefined)', () => {
			// An explicit `false` is "user picked API". If a forward dropped it to
			// undefined, an SSH agent would revert to the interactive default.
			const out = getClaudeTokenSourceFields({ enableMaestroP: false });
			expect(out.enableMaestroP).toBe(false);
		});
		it('returns the full key set (never a partial) for null/undefined/empty input', () => {
			for (const src of [null, undefined, {}]) {
				const out = getClaudeTokenSourceFields(src);
				expect(Object.keys(out).sort()).toEqual([...KEYS].sort());
				expect(out).toEqual({
					enableMaestroP: undefined,
					maestroPMode: undefined,
					maestroPPath: undefined,
				});
			}
		});
		it('ignores unrelated fields on the source object', () => {
			const out = getClaudeTokenSourceFields({
				enableMaestroP: true,
				maestroPMode: 'dynamic',
				// @ts-expect-error - extra session fields must not leak through
				customModel: 'opus',
				cwd: '/tmp',
			});
			expect(Object.keys(out).sort()).toEqual([...KEYS].sort());
		});
	});
	describe('autoRunMaestroPMaxWaitSeconds', () => {
		it("uses the Auto Run inactivity budget, not maestro-p's 300s", () => {
			expect(autoRunMaestroPMaxWaitSeconds({ autoRunInactivityTimeoutMin: 30 })).toBe(1800);
		});
		it('treats an unset setting as its documented default (240 min)', () => {
			expect(autoRunMaestroPMaxWaitSeconds({})).toBe(240 * 60);
		});
		it('falls back to the task duration cap when the inactivity watchdog is off', () => {
			expect(
				autoRunMaestroPMaxWaitSeconds({
					autoRunInactivityTimeoutMin: 0,
					autoRunMaxTaskDurationMin: 90,
				})
			).toBe(5400);
		});
		it('gives a day when both watchdogs are off', () => {
			expect(
				autoRunMaestroPMaxWaitSeconds({
					autoRunInactivityTimeoutMin: 0,
					autoRunMaxTaskDurationMin: 0,
				})
			).toBe(86400);
		});
		it('ignores non-numeric raw settings values', () => {
			expect(
				autoRunMaestroPMaxWaitSeconds({
					autoRunInactivityTimeoutMin: '30',
					autoRunMaxTaskDurationMin: 0,
				})
			).toBe(86400);
		});
	});
});
