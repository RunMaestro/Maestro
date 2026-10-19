import { describe, it, expect } from 'vitest';
import { formatTimestamp } from '../../shared/formatters';
import {
	JOURNEY_MAX_ENTRIES_PER_AGENT,
	JOURNEY_RECENT_EMPTY_TEXT,
	JOURNEY_RECENT_MAX_ENTRIES,
	JOURNEY_RECENT_WINDOW_MS,
	JOURNEY_RETENTION_DAYS,
	USER_JOURNEY_KINDS,
	applyJourneyLimits,
	filterJourneyEntries,
	formatJourneyLine,
	formatRecentJourney,
	journeyFileName,
	parseJourneyJsonl,
	isUserJourneyKind,
	normalizeJourneyEntry,
	sanitizeJourneyUrl,
	recentJourneyReadOptions,
	shouldCollapseJourneyEntry,
	type UserJourneyEntry,
} from '../../shared/userJourney';

const NOW = new Date(2026, 9, 18, 14, 30).getTime();
const TODAY = new Date(2026, 9, 18, 14, 2).getTime();
const YESTERDAY = new Date(2026, 9, 17, 9, 15).getTime();

function entry(overrides: Partial<UserJourneyEntry>): UserJourneyEntry {
	return {
		ts: TODAY,
		agentId: 'agent-1',
		kind: 'file.open',
		target: '/repo/src/foo.ts',
		...overrides,
	};
}

describe('userJourney constants', () => {
	it('caps entries and retention', () => {
		expect(JOURNEY_MAX_ENTRIES_PER_AGENT).toBe(5000);
		expect(JOURNEY_RETENTION_DAYS).toBe(30);
	});
});

describe('sanitizeJourneyUrl', () => {
	it('drops the query string', () => {
		expect(sanitizeJourneyUrl('https://example.com/page?token=abc&x=1')).toBe(
			'https://example.com/page'
		);
	});

	it('drops the fragment', () => {
		expect(sanitizeJourneyUrl('https://docs.runmaestro.ai/cue#triggers')).toBe(
			'https://docs.runmaestro.ai/cue'
		);
	});

	it('drops a query and a fragment together', () => {
		expect(sanitizeJourneyUrl('https://example.com/a/b?q=1#frag')).toBe('https://example.com/a/b');
	});

	it('drops embedded credentials', () => {
		expect(sanitizeJourneyUrl('https://user:secret@example.com/x')).toBe('https://example.com/x');
	});

	it('returns an unparseable URL unchanged', () => {
		expect(sanitizeJourneyUrl('not a url')).toBe('not a url');
		expect(sanitizeJourneyUrl('')).toBe('');
	});

	it('leaves about:blank as it is', () => {
		expect(sanitizeJourneyUrl('about:blank')).toBe('about:blank');
	});
});

describe('isUserJourneyKind', () => {
	it('accepts the nine kinds and nothing else', () => {
		expect(USER_JOURNEY_KINDS).toHaveLength(9);
		for (const kind of USER_JOURNEY_KINDS) expect(isUserJourneyKind(kind)).toBe(true);
		expect(isUserJourneyKind('file.edit')).toBe(false);
		expect(isUserJourneyKind(42)).toBe(false);
	});
});

describe('normalizeJourneyEntry', () => {
	it('keeps the known fields of a well-formed entry', () => {
		const full = entry({
			kind: 'file.save',
			tabId: 't1',
			linesAdded: 4,
			linesRemoved: 0,
			sshRemoteId: 'remote-1',
		});
		expect(normalizeJourneyEntry(full)).toEqual(full);
	});

	it('drops unknown fields so file contents cannot slip in', () => {
		const normalized = normalizeJourneyEntry({ ...entry({}), content: 'body', diff: '+x' });
		expect(normalized).toEqual(entry({}));
	});

	it('sanitizes browser targets but leaves file paths alone', () => {
		expect(
			normalizeJourneyEntry(
				entry({ kind: 'browser.navigate', target: 'https://a.test/p?token=abc' })
			)?.target
		).toBe('https://a.test/p');
		expect(normalizeJourneyEntry(entry({ target: '/repo/a?b.ts' }))?.target).toBe('/repo/a?b.ts');
	});

	it('drops malformed optional fields', () => {
		const normalized = normalizeJourneyEntry({
			...entry({}),
			tabId: 7,
			title: '',
			dwellMs: -5,
			linesAdded: Number.NaN,
		});
		expect(normalized).toEqual(entry({}));
	});

	it('rejects entries missing a required field', () => {
		expect(normalizeJourneyEntry(null)).toBeNull();
		expect(normalizeJourneyEntry('x')).toBeNull();
		expect(normalizeJourneyEntry({ ...entry({}), ts: 'now' })).toBeNull();
		expect(normalizeJourneyEntry({ ...entry({}), agentId: '' })).toBeNull();
		expect(normalizeJourneyEntry({ ...entry({}), kind: 'file.edit' })).toBeNull();
		expect(normalizeJourneyEntry({ ...entry({}), target: '' })).toBeNull();
	});
});

describe('shouldCollapseJourneyEntry', () => {
	const nav = entry({
		kind: 'browser.navigate',
		target: 'https://example.com/a',
		tabId: 'tab-1',
	});

	it('collapses a navigate to the same URL on the same tab', () => {
		expect(shouldCollapseJourneyEntry(nav, { ...nav, ts: nav.ts + 10 })).toBe(true);
	});

	it('collapses a navigate that repeats the browser.open location', () => {
		expect(shouldCollapseJourneyEntry({ ...nav, kind: 'browser.open' }, nav)).toBe(true);
	});

	it('keeps a navigate to a different URL', () => {
		expect(shouldCollapseJourneyEntry(nav, { ...nav, target: 'https://example.com/b' })).toBe(
			false
		);
	});

	it('keeps a navigate on a different tab', () => {
		expect(shouldCollapseJourneyEntry(nav, { ...nav, tabId: 'tab-2' })).toBe(false);
	});

	it('keeps anything that is not a navigate', () => {
		expect(shouldCollapseJourneyEntry(nav, { ...nav, kind: 'browser.close' })).toBe(false);
		expect(shouldCollapseJourneyEntry(nav, { ...nav, kind: 'browser.open' })).toBe(false);
	});

	it('keeps a navigate after a non-browser entry with the same target', () => {
		expect(shouldCollapseJourneyEntry({ ...nav, kind: 'file.open' }, nav)).toBe(false);
	});

	it('keeps the first entry', () => {
		expect(shouldCollapseJourneyEntry(undefined, nav)).toBe(false);
	});
});

describe('journeyFileName', () => {
	it('sanitizes the agent id the same way history files do', () => {
		expect(journeyFileName('agent-1')).toBe('agent-1.jsonl');
		expect(journeyFileName('../evil')).not.toContain('/');
	});
});

describe('parseJourneyJsonl', () => {
	it('keeps valid lines in file order and skips torn, blank, and foreign lines', () => {
		const good = { ts: 1, agentId: 'a', kind: 'file.open', target: '/x' };
		const raw = [
			JSON.stringify(good),
			'',
			JSON.stringify({ ts: 2, agentId: 'a', kind: 'not.a.kind', target: '/y' }),
			JSON.stringify({ ...good, ts: 3, extra: 'dropped' }),
			'{"ts":',
		].join('\n');
		const entries = parseJourneyJsonl(`\uFEFF${raw}`);
		expect(entries.map((e) => e.ts)).toEqual([1, 3]);
		expect(entries[1]).not.toHaveProperty('extra');
	});
});

describe('applyJourneyLimits', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const now = 100 * DAY;

	it('drops entries older than retention', () => {
		const entries = [now - (JOURNEY_RETENTION_DAYS + 1) * DAY, now - DAY].map(
			(ts): UserJourneyEntry => ({ ts, agentId: 'a', kind: 'file.open', target: '/x' })
		);
		expect(applyJourneyLimits(entries, now).map((e) => e.ts)).toEqual([now - DAY]);
	});

	it('keeps only the newest entries past the cap', () => {
		const entries = Array.from(
			{ length: JOURNEY_MAX_ENTRIES_PER_AGENT + 2 },
			(_, i): UserJourneyEntry => ({
				ts: now - 1000 + i,
				agentId: 'a',
				kind: 'file.open',
				target: '/x',
			})
		);
		const kept = applyJourneyLimits(entries, now);
		expect(kept).toHaveLength(JOURNEY_MAX_ENTRIES_PER_AGENT);
		expect(kept[0].ts).toBe(entries[2].ts);
	});
});

describe('filterJourneyEntries', () => {
	const entries: UserJourneyEntry[] = [
		{ ts: 10, agentId: 'a', kind: 'file.open', target: '/x' },
		{ ts: 20, agentId: 'a', kind: 'file.save', target: '/x' },
		{ ts: 30, agentId: 'a', kind: 'browser.navigate', target: 'https://a.test/' },
	];

	it('returns everything with no options', () => {
		expect(filterJourneyEntries(entries)).toEqual(entries);
	});

	it('applies since, kinds, then tail', () => {
		expect(filterJourneyEntries(entries, { since: 20 }).map((e) => e.ts)).toEqual([20, 30]);
		expect(
			filterJourneyEntries(entries, { kinds: ['file.open', 'browser.navigate'] }).map((e) => e.ts)
		).toEqual([10, 30]);
		expect(
			filterJourneyEntries(entries, { kinds: ['file.open', 'file.save'], tail: 1 }).map((e) => e.ts)
		).toEqual([20]);
		expect(filterJourneyEntries(entries, { tail: 0 })).toEqual([]);
	});
});

describe('formatJourneyLine', () => {
	const time = formatTimestamp(TODAY, 'time');
	const cwd = '/repo';

	it('renders an open relative to cwd', () => {
		expect(formatJourneyLine(entry({}), NOW, { cwd })).toBe(`${time} opened src/foo.ts`);
	});

	it('keeps the absolute path without cwd or outside cwd', () => {
		expect(formatJourneyLine(entry({}), NOW)).toBe(`${time} opened /repo/src/foo.ts`);
		expect(formatJourneyLine(entry({ target: '/other/x.ts' }), NOW, { cwd })).toBe(
			`${time} opened /other/x.ts`
		);
		expect(formatJourneyLine(entry({ target: '/repo-two/x.ts' }), NOW, { cwd })).toBe(
			`${time} opened /repo-two/x.ts`
		);
	});

	it('renders a Windows path relative to cwd', () => {
		expect(
			formatJourneyLine(entry({ target: 'C:\\repo\\src\\foo.ts' }), NOW, { cwd: 'C:\\repo' })
		).toBe(`${time} opened src/foo.ts`);
	});

	it('renders a save with line counts', () => {
		expect(
			formatJourneyLine(entry({ kind: 'file.save', linesAdded: 12, linesRemoved: 3 }), NOW, {
				cwd,
			})
		).toBe(`${time} saved src/foo.ts (+12/-3)`);
	});

	it('renders a save without line counts', () => {
		expect(formatJourneyLine(entry({ kind: 'file.save' }), NOW, { cwd })).toBe(
			`${time} saved src/foo.ts`
		);
	});

	it('renders a close with dwell time', () => {
		expect(
			formatJourneyLine(entry({ kind: 'file.close', dwellMs: 5 * 60_000 }), NOW, { cwd })
		).toBe(`${time} closed src/foo.ts (5m)`);
	});

	it('renders create, rename, and delete', () => {
		expect(formatJourneyLine(entry({ kind: 'file.create' }), NOW, { cwd })).toBe(
			`${time} created src/foo.ts`
		);
		expect(
			formatJourneyLine(entry({ kind: 'file.rename', fromPath: '/repo/src/old.ts' }), NOW, { cwd })
		).toBe(`${time} renamed src/old.ts to src/foo.ts`);
		expect(formatJourneyLine(entry({ kind: 'file.delete' }), NOW, { cwd })).toBe(
			`${time} deleted src/foo.ts`
		);
	});

	it('renders browser entries without scheme or trailing slash', () => {
		expect(
			formatJourneyLine(
				entry({ kind: 'browser.navigate', target: 'https://docs.runmaestro.ai/cue' }),
				NOW
			)
		).toBe(`${time} browsed docs.runmaestro.ai/cue`);
		expect(
			formatJourneyLine(
				entry({ kind: 'browser.open', target: 'https://example.com/', title: 'Example' }),
				NOW
			)
		).toBe(`${time} opened browser example.com "Example"`);
		expect(
			formatJourneyLine(
				entry({ kind: 'browser.close', target: 'https://example.com/', dwellMs: 30_000 }),
				NOW
			)
		).toBe(`${time} closed browser example.com (30s)`);
	});

	it('adds the date for an entry from another day', () => {
		expect(formatJourneyLine(entry({ ts: YESTERDAY }), NOW, { cwd })).toBe(
			`${formatTimestamp(YESTERDAY, 'datetime')} opened src/foo.ts`
		);
	});
});

describe('recentJourneyReadOptions', () => {
	it('reads the last two hours, capped at the snapshot size', () => {
		expect(JOURNEY_RECENT_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
		expect(JOURNEY_RECENT_MAX_ENTRIES).toBe(15);
		expect(recentJourneyReadOptions(NOW)).toEqual({
			since: NOW - JOURNEY_RECENT_WINDOW_MS,
			tail: JOURNEY_RECENT_MAX_ENTRIES,
		});
	});
});

describe('formatRecentJourney', () => {
	const cwd = '/repo';

	it('reads "No recent activity." with no entries', () => {
		expect(JOURNEY_RECENT_EMPTY_TEXT).toBe('No recent activity.');
		expect(formatRecentJourney([], NOW)).toBe(JOURNEY_RECENT_EMPTY_TEXT);
	});

	it('renders one formatJourneyLine bullet per entry, oldest first', () => {
		const first = entry({});
		const second = entry({ kind: 'file.save', ts: TODAY + 1000, linesAdded: 1, linesRemoved: 2 });
		expect(formatRecentJourney([first, second], NOW, { cwd })).toBe(
			[first, second].map((e) => `- ${formatJourneyLine(e, NOW, { cwd })}`).join('\n')
		);
	});

	it('drops entries older than the window, even when the caller passed them', () => {
		const stale = entry({ ts: NOW - JOURNEY_RECENT_WINDOW_MS - 1 });
		expect(formatRecentJourney([stale], NOW)).toBe(JOURNEY_RECENT_EMPTY_TEXT);
	});

	it('keeps only the newest JOURNEY_RECENT_MAX_ENTRIES', () => {
		const entries = Array.from({ length: JOURNEY_RECENT_MAX_ENTRIES + 5 }, (_, i) =>
			entry({ ts: TODAY + i, target: `/repo/f${i}.ts` })
		);
		const lines = formatRecentJourney(entries, NOW, { cwd }).split('\n');
		expect(lines).toHaveLength(JOURNEY_RECENT_MAX_ENTRIES);
		expect(lines[0]).toContain('opened f5.ts');
		expect(lines[lines.length - 1]).toContain(`opened f${JOURNEY_RECENT_MAX_ENTRIES + 4}.ts`);
	});
});
