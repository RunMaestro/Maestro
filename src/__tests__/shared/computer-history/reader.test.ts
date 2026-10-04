import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	compileGrep,
	listDigests,
	listSegments,
	readDigest,
	parseIndexText,
	queryEvents,
	readActivity,
	readRecentDigests,
	readStoreStats,
	summarizeApps,
} from '../../../shared/computer-history/reader';
import { segmentRelativePath } from '../../../shared/computer-history/paths';
import type { StoredEvent } from '../../../shared/computer-history/types';

let dir: string;

const T0 = Date.parse('2026-10-03T14:15:00.000Z');

function event(seq: number, ts: number, partial: Partial<StoredEvent> = {}): StoredEvent {
	return {
		v: 1,
		seq,
		ts: new Date(ts).toISOString(),
		kind: 'text.committed',
		app: { id: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 1 },
		text: `message ${seq}`,
		...partial,
	};
}

function writeSegment(startMs: number, events: StoredEvent[], extra = ''): string {
	const rel = segmentRelativePath(startMs);
	const abs = path.join(dir, ...rel.split('/'));
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, events.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra);
	return rel;
}

function index(rel: string, events: number, apps: Record<string, number> = {}) {
	fs.appendFileSync(
		path.join(dir, 'index.jsonl'),
		JSON.stringify({ file: rel, start: '', end: '', events, bytes: 10, apps }) + '\n'
	);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-reader-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('reader', () => {
	it('returns nothing for a store that does not exist', async () => {
		const missing = path.join(dir, 'nope');
		expect(await listSegments(missing)).toEqual([]);
		expect((await queryEvents(missing)).events).toEqual([]);
		expect((await readStoreStats(missing)).exists).toBe(false);
	});

	it('lists indexed segments plus the open (unindexed) segment, by time range', async () => {
		const a = writeSegment(T0, [event(0, T0 + 1000)]);
		index(a, 1, { 'com.tinyspeck.slackmacgap': 1 });
		const b = writeSegment(T0 + 900_000, [event(0, T0 + 901_000)]);
		const all = await listSegments(dir);
		expect(all.map((s) => [s.file, s.indexed])).toEqual([
			[a, true],
			[b, false],
		]);
		const later = await listSegments(dir, { sinceMs: T0 + 900_000 });
		expect(later.map((s) => s.file)).toEqual([b]);
		const earlier = await listSegments(dir, { untilMs: T0 + 599_999 });
		expect(earlier.map((s) => s.file)).toEqual([a]);
	});

	it('skips torn and invalid lines', async () => {
		writeSegment(T0, [event(0, T0 + 1), event(1, T0 + 2)], '{"v":1,"seq":2,"ts":"2026-10-03T14:1');
		fs.appendFileSync(
			path.join(dir, 'segments/2026-10-03/1415Z.jsonl'),
			'\n{"kind":"helper.status","ts":"2026-10-03T14:10:00Z"}\nnot json\n'
		);
		const { events } = await queryEvents(dir);
		expect(events.map((e) => e.seq)).toEqual([0, 1]);
	});

	it('filters by app (id or name substring), kind, grep, and time', async () => {
		writeSegment(T0, [
			event(0, T0 + 1000, { text: 'invoice 42 attached' }),
			event(1, T0 + 2000, {
				kind: 'content.snapshot',
				app: { id: 'com.google.chrome', name: 'Google Chrome', pid: 2 },
				window: { title: 'Invoices - Acme', url: 'https://acme.test/invoices' },
				text: 'a page',
			}),
			event(2, T0 + 3000, { text: 'lunch?' }),
		]);
		const byApp = await queryEvents(dir, { apps: ['chrome'] });
		expect(byApp.events.map((e) => e.seq)).toEqual([1]);
		const byKind = await queryEvents(dir, { kinds: ['text.committed'] });
		expect(byKind.events.map((e) => e.seq)).toEqual([0, 2]);
		const byGrep = await queryEvents(dir, { grep: compileGrep('invoice') });
		expect(byGrep.events.map((e) => e.seq)).toEqual([0, 1]);
		const byTime = await queryEvents(dir, { sinceMs: T0 + 2500 });
		expect(byTime.events.map((e) => e.seq)).toEqual([2]);
	});

	it('limit returns the most recent matches in time order and reports the cut', async () => {
		const a = writeSegment(T0, [event(0, T0 + 1), event(1, T0 + 2)]);
		index(a, 2);
		writeSegment(T0 + 900_000, [event(0, T0 + 900_001), event(1, T0 + 900_002)]);
		const r = await queryEvents(dir, { limit: 3 });
		expect(r.events.map((e) => e.ts)).toEqual([
			new Date(T0 + 2).toISOString(),
			new Date(T0 + 900_001).toISOString(),
			new Date(T0 + 900_002).toISOString(),
		]);
		expect(r.limited).toBe(true);
		const all = await queryEvents(dir, { limit: 10 });
		expect(all.events).toHaveLength(4);
		expect(all.limited).toBe(false);
	});

	it('index: last line for a file wins; torn lines and foreign paths are skipped', () => {
		const rel = 'segments/2026-10-03/1415Z.jsonl';
		const text = [
			JSON.stringify({ file: rel, events: 1 }),
			'{"file":"segm',
			JSON.stringify({ file: '../../etc/passwd', events: 1 }),
			JSON.stringify({ file: rel, events: 5 }),
		].join('\n');
		const entries = parseIndexText(text);
		expect(entries).toHaveLength(1);
		expect(entries[0].events).toBe(5);
	});

	it('summarizeApps attributes time from event spacing with an idle cap', async () => {
		writeSegment(T0, [
			event(0, T0, { kind: 'app.activated' }),
			event(1, T0 + 60_000, {
				kind: 'app.activated',
				app: { id: 'com.google.chrome', name: 'Chrome', pid: 2 },
			}),
			// 9 minutes later: capped to 5 minutes of Chrome time.
			event(2, T0 + 900_000 - 1, { kind: 'app.activated' }),
		]);
		const apps = await summarizeApps(dir);
		const chrome = apps.find((a) => a.id === 'com.google.chrome')!;
		const slack = apps.find((a) => a.id === 'com.tinyspeck.slackmacgap')!;
		expect(chrome.activeMs).toBe(5 * 60_000);
		expect(slack.activeMs).toBe(60_000);
		expect(slack.events).toBe(2);
		expect(apps[0].id).toBe('com.google.chrome');
	});

	it('compileGrep falls back to a literal for an invalid regex', () => {
		expect(compileGrep('a(b')!.test('xa(by')).toBe(true);
		expect(compileGrep(undefined)).toBeUndefined();
	});

	it('listDigests returns 15-minute digests and roll-ups by window, filtered by kind and range', async () => {
		const day = path.join(dir, 'digests', '2026-10-03');
		fs.mkdirSync(day, { recursive: true });
		for (const name of ['1200Z.md', '1215Z.md', '6h-1200Z.md', '1815Z.md', 'notes.txt']) {
			fs.writeFileSync(path.join(day, name), `# ${name}`);
		}
		const all = await listDigests(dir);
		expect(all.map((d) => d.file.split('/').pop())).toEqual([
			'1200Z.md',
			'6h-1200Z.md',
			'1215Z.md',
			'1815Z.md',
		]);
		const rollups = await listDigests(dir, { kind: '6h' });
		expect(rollups).toEqual([
			expect.objectContaining({
				kind: '6h',
				startMs: Date.parse('2026-10-03T12:00:00Z'),
				endMs: Date.parse('2026-10-03T18:00:00Z'),
			}),
		]);
		const late = await listDigests(dir, { sinceMs: Date.parse('2026-10-03T17:00:00Z') });
		expect(late.map((d) => d.file.split('/').pop())).toEqual(['6h-1200Z.md', '1815Z.md']);
		expect(await readDigest(dir, 'digests/2026-10-03/1215Z.md')).toBe('# 1215Z.md');
	});

	it('readActivity folds indexed windows and the open segment into buckets and app totals', async () => {
		const closed = segmentRelativePath(T0);
		writeSegment(T0, [event(0, T0)]);
		fs.appendFileSync(
			path.join(dir, 'index.jsonl'),
			JSON.stringify({
				file: closed,
				start: '',
				end: '',
				events: 3,
				bytes: 10,
				apps: { 'com.tinyspeck.slackmacgap': 2, 'com.google.chrome': 1 },
				names: { 'com.google.chrome': 'Chrome' },
				activeMs: { 'com.tinyspeck.slackmacgap': 120_000, 'com.google.chrome': 30_000 },
			}) + '\n'
		);
		// The open segment has no index line: read and folded the same way.
		const open = T0 + 900_000;
		writeSegment(open, [
			event(0, open),
			event(1, open + 90_000, { app: { id: 'com.google.chrome', name: 'Chrome', pid: 2 } }),
		]);
		const summary = await readActivity(dir, { sinceMs: T0 });
		expect(summary.totalEvents).toBe(5);
		expect(summary.buckets.map((b) => b.startMs)).toEqual([T0, open]);
		expect(summary.buckets[1].activeMs).toEqual({
			'com.tinyspeck.slackmacgap': 90_000,
			'com.google.chrome': 0,
		});
		expect(summary.apps[0]).toMatchObject({
			id: 'com.tinyspeck.slackmacgap',
			name: 'Slack',
			events: 3,
			activeMs: 210_000,
			lastWindowMs: open,
		});
		expect(summary.apps[1]).toMatchObject({ id: 'com.google.chrome', name: 'Chrome', events: 2 });
	});

	it('readRecentDigests returns the newest bodies first, capped by limit', async () => {
		const day = path.join(dir, 'digests', '2026-10-03');
		fs.mkdirSync(day, { recursive: true });
		for (const name of ['1200Z.md', '1215Z.md', '1230Z.md']) {
			fs.writeFileSync(path.join(day, name), `# ${name}`);
		}
		const recent = await readRecentDigests(dir, { limit: 2 });
		expect(recent.map((d) => d.body)).toEqual(['# 1230Z.md', '# 1215Z.md']);
	});
});
