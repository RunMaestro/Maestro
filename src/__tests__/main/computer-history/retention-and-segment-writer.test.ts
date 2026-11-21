// Source: src/__tests__/main/computer-history/retention.test.ts
// Source: src/__tests__/main/computer-history/segment-writer.test.ts
// Source: src/__tests__/main/computer-history/digests-rollup.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runRetention } from '../../../main/computer-history/retention';
import { deleteSegments } from '../../../main/computer-history/retention';
import { listSegmentFiles } from '../../../main/computer-history/retention';
import { createKeyedWriteQueue } from '../../../main/utils/atomic-json-store';
import { digestRelativePath } from '../../../shared/computer-history/paths';
import { segmentRelativePath } from '../../../shared/computer-history/paths';
import { parseIndexText } from '../../../shared/computer-history/reader';
import { vi } from 'vitest';
import { SegmentWriter } from '../../../main/computer-history/segment-writer';
import { parseSegmentText } from '../../../shared/computer-history/reader';
import type { SegmentIndexEntry } from '../../../shared/computer-history/types';
import { DigestScheduler } from '../../../main/computer-history/digests';
import { MAX_PENDING_15M } from '../../../main/computer-history/digests';
import { defaultComputerHistoryConfig } from '../../../shared/computer-history/config';
import { digestFormatInstructions } from '../../../shared/computer-history/digestFormat';
import type { ComputerHistoryConfig } from '../../../shared/computer-history/types';
describeSourceSuite('retention', () => {
	let dir: string;
	const DAY = 86_400_000;
	const NOW = Date.parse('2026-10-03T14:10:00.000Z');

	function seg(startMs: number, bytes: number): string {
		const rel = segmentRelativePath(startMs);
		const abs = path.join(dir, ...rel.split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, 'x'.repeat(bytes));
		fs.appendFileSync(
			path.join(dir, 'index.jsonl'),
			JSON.stringify({ file: rel, start: '', end: '', events: 1, bytes, apps: {} }) + '\n'
		);
		return rel;
	}

	function digest(startMs: number) {
		const rel = digestRelativePath(startMs);
		const abs = path.join(dir, ...rel.split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, '# d');
		return abs;
	}

	function indexFiles(): string[] {
		return parseIndexText(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf-8')).map(
			(e) => e.file
		);
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-retention-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('runRetention', () => {
		it('deletes segments (and their digests) older than retentionDays, keeps the rest', async () => {
			const old = seg(NOW - 40 * DAY, 10);
			const oldDigest = digest(NOW - 40 * DAY);
			const recent = seg(NOW - 2 * DAY, 10);
			const result = await runRetention({
				storeDir: dir,
				retentionDays: 30,
				maxBytes: 1e12,
				nowMs: NOW,
				queue: createKeyedWriteQueue(),
			});
			expect(result.deletedSegments).toBe(1);
			expect(fs.existsSync(path.join(dir, ...old.split('/')))).toBe(false);
			expect(fs.existsSync(oldDigest)).toBe(false);
			expect(indexFiles()).toEqual([recent]);
			// The emptied day folder is removed.
			expect(fs.existsSync(path.join(dir, 'segments', old.split('/')[1]))).toBe(false);
		});

		it('deletes oldest first until under maxBytes, never the open segment', async () => {
			const a = seg(NOW - 3 * DAY, 100);
			const b = seg(NOW - 2 * DAY, 100);
			const c = seg(NOW - DAY, 100);
			const open = seg(NOW, 100);
			const result = await runRetention({
				storeDir: dir,
				retentionDays: 90,
				maxBytes: 150,
				nowMs: NOW,
				queue: createKeyedWriteQueue(),
				protectFile: open,
			});
			// 400 bytes -> delete a, b, c (oldest first); the open segment is protected.
			expect(result.deletedSegments).toBe(3);
			expect(result.freedBytes).toBe(300);
			expect((await listSegmentFiles(dir)).map((f) => f.file)).toEqual([open]);
			expect(indexFiles()).toEqual([open]);
			expect([a, b, c].every((f) => !fs.existsSync(path.join(dir, ...f.split('/'))))).toBe(true);
		});

		it('stops deleting as soon as the store fits', async () => {
			seg(NOW - 3 * DAY, 100);
			const b = seg(NOW - 2 * DAY, 100);
			const result = await runRetention({
				storeDir: dir,
				retentionDays: 90,
				maxBytes: 150,
				nowMs: NOW,
				queue: createKeyedWriteQueue(),
			});
			expect(result.deletedSegments).toBe(1);
			expect(indexFiles()).toEqual([b]);
		});

		it('deleteSegments compacts the index and tolerates a missing index', async () => {
			const a = seg(NOW, 5);
			fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"torn":\n');
			const files = await listSegmentFiles(dir);
			expect(await deleteSegments(dir, files, createKeyedWriteQueue())).toBe(5);
			expect(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf-8')).toBe('');
			expect(a).toBeTruthy();
			fs.rmSync(path.join(dir, 'index.jsonl'));
			await expect(deleteSegments(dir, [], createKeyedWriteQueue())).resolves.toBe(0);
		});

		it('prunes 6-hour roll-ups with their day under the same retention rule', async () => {
			seg(NOW - 2 * DAY, 10);
			const oldDay = new Date(NOW - 40 * DAY).toISOString().slice(0, 10);
			const newDay = new Date(NOW - 2 * DAY).toISOString().slice(0, 10);
			for (const day of [oldDay, newDay]) {
				fs.mkdirSync(path.join(dir, 'digests', day), { recursive: true });
				fs.writeFileSync(path.join(dir, 'digests', day, '6h-0600Z.md'), '# r');
			}
			await runRetention({
				storeDir: dir,
				retentionDays: 30,
				maxBytes: 1e12,
				nowMs: NOW,
				queue: createKeyedWriteQueue(),
			});
			expect(fs.existsSync(path.join(dir, 'digests', oldDay, '6h-0600Z.md'))).toBe(false);
			expect(fs.existsSync(path.join(dir, 'digests', newDay, '6h-0600Z.md'))).toBe(true);
		});
	});
});
describeSourceSuite('segment-writer', () => {
	let dir: string;
	const T0 = Date.parse('2026-10-03T14:15:00.000Z');

	function input(ts: number, appId = 'com.tinyspeck.slackmacgap') {
		return {
			v: 1,
			ts: new Date(ts).toISOString(),
			kind: 'text.committed' as const,
			app: { id: appId, name: 'App', pid: 1 },
			text: 'hello',
		};
	}

	function readIndex(): SegmentIndexEntry[] {
		const p = path.join(dir, 'index.jsonl');
		return fs.existsSync(p) ? parseIndexText(fs.readFileSync(p, 'utf-8')) : [];
	}

	function readSeg(rel: string) {
		return parseSegmentText(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf-8'));
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-writer-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('SegmentWriter', () => {
		it('assigns seq per segment and writes to the 15-minute UTC window file', async () => {
			let now = T0;
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => now,
			});
			const a = await writer.append(input(T0 + 1000));
			const b = await writer.append(input(T0 + 2000));
			expect([a.seq, b.seq]).toEqual([0, 1]);
			expect(writer.currentInfo()).toEqual({ file: 'segments/2026-10-03/1415Z.jsonl', events: 2 });
			expect(readSeg('segments/2026-10-03/1415Z.jsonl').map((e) => e.seq)).toEqual([0, 1]);
			// Not closed yet: no index line.
			expect(readIndex()).toEqual([]);
			now = T0 + 5000;
		});

		it('rolls over on a later window: closes the old segment with an index line and restarts seq', async () => {
			const closed = vi.fn();
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => T0,
				onSegmentClosed: closed,
			});
			await writer.append(input(T0 + 1000));
			await writer.append(input(T0 + 2000, 'com.google.chrome'));
			const next = await writer.append(input(T0 + 900_500));
			expect(next.seq).toBe(0);
			const idx = readIndex();
			expect(idx).toHaveLength(1);
			expect(idx[0]).toMatchObject({
				file: 'segments/2026-10-03/1415Z.jsonl',
				events: 2,
				start: new Date(T0 + 1000).toISOString(),
				end: new Date(T0 + 2000).toISOString(),
				apps: { 'com.tinyspeck.slackmacgap': 1, 'com.google.chrome': 1 },
			});
			expect(idx[0].bytes).toBeGreaterThan(0);
			// Names and foreground time ride the index line, so the viewer never
			// has to open closed segments to list apps.
			expect(idx[0].names).toEqual({
				'com.tinyspeck.slackmacgap': 'App',
				'com.google.chrome': 'App',
			});
			expect(idx[0].activeMs).toEqual({
				'com.tinyspeck.slackmacgap': 1000,
				'com.google.chrome': 0,
			});
			expect(closed).toHaveBeenCalledWith(expect.objectContaining({ events: 2 }), T0);
			expect(writer.currentInfo()?.file).toBe('segments/2026-10-03/1430Z.jsonl');
		});

		it('closes an expired window on the timer check, and on close()', async () => {
			let now = T0;
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => now,
			});
			await writer.append(input(T0 + 1000));
			expect(await writer.closeIfExpired()).toBe(false);
			now = T0 + 900_000 + 5000;
			expect(await writer.closeIfExpired()).toBe(true);
			expect(readIndex()).toHaveLength(1);
			await writer.append(input(now));
			await writer.close();
			expect(readIndex()).toHaveLength(2);
			expect(writer.currentInfo()).toBeNull();
		});

		it('writes late (older-window) events into the open segment instead of reopening a closed one', async () => {
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => T0,
			});
			await writer.append(input(T0 + 900_100));
			const late = await writer.append(input(T0 + 5));
			expect(late.seq).toBe(1);
			expect(writer.currentInfo()?.file).toBe('segments/2026-10-03/1430Z.jsonl');
		});

		it('continues seq when reopening an existing file after a restart', async () => {
			const q = createKeyedWriteQueue();
			const first = new SegmentWriter({ storeDir: dir, queue: q, now: () => T0 });
			await first.append(input(T0 + 1));
			await first.append(input(T0 + 2));
			const second = new SegmentWriter({ storeDir: dir, queue: q, now: () => T0 });
			const e = await second.append(input(T0 + 3));
			expect(e.seq).toBe(2);
			expect(second.currentInfo()?.events).toBe(3);
		});

		it('start() indexes segments a crash left unclosed, but not the current window', async () => {
			const q = createKeyedWriteQueue();
			const crashed = new SegmentWriter({ storeDir: dir, queue: q, now: () => T0 });
			await crashed.append(input(T0 + 1));
			// "Crash": never closed. Restart 20 minutes later.
			const later = T0 + 1_200_000;
			const current = new SegmentWriter({ storeDir: dir, queue: q, now: () => later });
			await current.append(input(later + 1));
			const restarted = new SegmentWriter({ storeDir: dir, queue: q, now: () => later });
			expect(await restarted.start()).toBe(1);
			expect(readIndex().map((e) => e.file)).toEqual(['segments/2026-10-03/1415Z.jsonl']);
			expect(await restarted.start()).toBe(0);
		});

		it('never writes an index line for an empty segment', async () => {
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => T0,
			});
			await writer.close();
			expect(fs.existsSync(path.join(dir, 'index.jsonl'))).toBe(false);
		});

		it('terminates a torn tail line (crash mid-append) before appending, in segments and the index', async () => {
			const q = createKeyedWriteQueue();
			const first = new SegmentWriter({ storeDir: dir, queue: q, now: () => T0 });
			await first.append(input(T0 + 1));
			await first.close();
			const seg = path.join(dir, 'segments', '2026-10-03', '1415Z.jsonl');
			fs.appendFileSync(seg, '{"v":1,"seq":1,"ts":"2026-10-03T14:1');
			fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"file":"segm');
			const second = new SegmentWriter({ storeDir: dir, queue: q, now: () => T0 });
			const e = await second.append(input(T0 + 2));
			expect(e?.seq).toBe(1);
			expect(readSeg('segments/2026-10-03/1415Z.jsonl').map((x) => x.seq)).toEqual([0, 1]);
			await second.close();
			// Both closes survive: the torn index fragment did not swallow the new line.
			expect(readIndex().map((x) => x.events)).toEqual([2]);
			expect(
				fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf-8').split('\n').filter(Boolean)
			).toHaveLength(3);
		});

		it('drops snapshots past the per-segment byte cap, everything past twice it, and counts drops in the index', async () => {
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => T0,
				maxSegmentBytes: 1000,
			});
			const snapshot = (n: number) => ({
				...input(T0 + n),
				kind: 'content.snapshot' as const,
				text: 'x'.repeat(200),
			});
			expect(await writer.append(snapshot(1))).not.toBeNull();
			expect(await writer.append(snapshot(2))).not.toBeNull();
			expect(await writer.append(snapshot(3))).toBeNull();
			// Text events still land until twice the cap.
			expect(await writer.append({ ...input(T0 + 4), text: 'y'.repeat(200) })).not.toBeNull();
			expect(await writer.append({ ...input(T0 + 5), text: 'y'.repeat(1500) })).toBeNull();
			await writer.close();
			expect(readIndex()[0]).toMatchObject({ events: 3, dropped: 2 });
		});

		it('creates the store owner-only (POSIX)', async () => {
			if (process.platform === 'win32') return;
			const writer = new SegmentWriter({
				storeDir: dir,
				queue: createKeyedWriteQueue(),
				now: () => T0,
			});
			await writer.append(input(T0 + 1));
			await writer.close();
			const mode = (p: string) => fs.statSync(path.join(dir, p)).mode & 0o777;
			expect(mode('segments')).toBe(0o700);
			expect(mode('segments/2026-10-03')).toBe(0o700);
			expect(mode('segments/2026-10-03/1415Z.jsonl')).toBe(0o600);
			expect(mode('index.jsonl')).toBe(0o600);
		});
	});
});
describeSourceSuite('digests-rollup', () => {
	const MIN = 60_000;
	const BLOCK = Date.parse('2026-10-03T12:00:00.000Z');
	const LAST_WINDOW = BLOCK + 6 * 60 * MIN - 15 * MIN; // 17:45
	const ROLLUP_FILE = ['digests', '2026-10-03', '6h-1200Z.md'];

	let dir: string;
	let config: ComputerHistoryConfig;
	let now: number;

	type Answer = { success: boolean; answer?: string; error?: string };

	function entryFor(startMs: number, events = 5) {
		return { file: segmentRelativePath(startMs), start: '', end: '', events, bytes: 10, apps: {} };
	}

	function writeSegment(startMs: number) {
		const abs = path.join(dir, ...segmentRelativePath(startMs).split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, '{}\n');
	}

	function writeDigest(startMs: number, text = '- did things') {
		const abs = path.join(dir, ...digestRelativePath(startMs).split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
		return abs;
	}

	function scheduler(consult: (p: { question: string }) => Promise<Answer>) {
		const s = new DigestScheduler({
			storeDir: dir,
			getConfig: () => config,
			getConsult: () => consult as never,
			now: () => now,
		});
		s.start();
		return s;
	}

	const isRollup = (q: string) => q.startsWith('You are writing a 6-hour');
	const flush = () => new Promise((r) => setTimeout(r, 30));

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rollup-'));
		config = defaultComputerHistoryConfig();
		config.digests = { enabled: true, agentId: 'agent-1', rollup: true };
		now = BLOCK + 6 * 60 * MIN + 20_000; // 18:00:20, just after the block ends
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('6-hour roll-up', () => {
		it('the last window close queues its 15-minute digest, then the roll-up from the block digest FILES', async () => {
			const early = writeDigest(BLOCK, '- morning work');
			writeSegment(LAST_WINDOW);
			const order: string[] = [];
			const consult = vi.fn(async ({ question }: { question: string }) => {
				order.push(isRollup(question) ? '6h' : '15m');
				return isRollup(question)
					? { success: true, answer: '- the block; key sk-ABCDEFGHIJKLMNOP1234' }
					: { success: true, answer: '- last window' };
			});
			const s = scheduler(consult);
			s.onSegmentClosed(entryFor(LAST_WINDOW), LAST_WINDOW);
			const out = path.join(dir, ...ROLLUP_FILE);
			await vi.waitFor(() => expect(fs.existsSync(out)).toBe(true));
			expect(order).toEqual(['15m', '6h']);
			const rollupQuestion = consult.mock.calls[1][0].question;
			// Paths, never contents, plus the untrusted rule.
			expect(rollupQuestion).toContain(early);
			expect(rollupQuestion).toContain(
				path.join(dir, ...digestRelativePath(LAST_WINDOW).split('/'))
			);
			expect(rollupQuestion).not.toContain('morning work');
			expect(rollupQuestion).toMatch(/UNTRUSTED/);
			const body = fs.readFileSync(out, 'utf-8');
			expect(body).toContain('6-hour roll-up');
			expect(body).toContain('[REDACTED_API_KEY]');
			// The scheduler, not the writer, lists the digests the roll-up came from.
			expect(body.trimEnd()).toMatch(
				/### Sources\n\n- `digests\/2026-10-03\/1200Z\.md`\n- `digests\/2026-10-03\/1745Z\.md`$/
			);
			expect(rollupQuestion).toContain(digestFormatInstructions('6h'));
			if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
			expect(s.status().lastRollupFile).toBe('digests/2026-10-03/6h-1200Z.md');
			expect(s.status().lastRollupAt).not.toBeNull();
		});

		it('skips a block with no 15-minute digests', async () => {
			const consult = vi.fn(async () => ({ success: true, answer: 'x' }));
			const s = scheduler(consult);
			s.tick(null);
			await flush();
			expect(consult).not.toHaveBeenCalled();
			expect(fs.existsSync(path.join(dir, ...ROLLUP_FILE))).toBe(false);
		});

		it('tick triggers the roll-up when the last window was empty, but waits while a block segment is open', async () => {
			writeDigest(BLOCK + 60 * MIN);
			const consult = vi.fn(async () => ({ success: true, answer: '- summary' }));
			const s = scheduler(consult);
			s.tick(LAST_WINDOW); // the last window is still open: its close will trigger
			await flush();
			expect(consult).not.toHaveBeenCalled();
			s.tick(null);
			await vi.waitFor(() => expect(fs.existsSync(path.join(dir, ...ROLLUP_FILE))).toBe(true));
			// Queued at most once per block.
			s.tick(null);
			s.onSegmentClosed(entryFor(LAST_WINDOW, 0), LAST_WINDOW);
			await flush();
			expect(consult).toHaveBeenCalledTimes(1);
		});

		it('respects digests.rollup = false', async () => {
			config.digests.rollup = false;
			writeDigest(BLOCK);
			const consult = vi.fn(async () => ({ success: true, answer: 'x' }));
			const s = scheduler(consult);
			s.tick(null);
			await flush();
			expect(consult).not.toHaveBeenCalled();
		});

		it('clear (cancel) and stop discard an in-flight roll-up; removed inputs do too', async () => {
			writeDigest(BLOCK);
			let release: (a: Answer) => void = () => {};
			const consult = vi.fn(() => new Promise<Answer>((r) => (release = r)));
			const out = path.join(dir, ...ROLLUP_FILE);

			const a = scheduler(consult);
			a.tick(null);
			await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(1));
			a.cancel({ sinceMs: BLOCK + 3 * 60 * MIN });
			release({ success: true, answer: 'x' });
			await flush();
			expect(fs.existsSync(out)).toBe(false);

			const b = scheduler(consult);
			b.tick(null);
			await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(2));
			b.stop();
			release({ success: true, answer: 'x' });
			await flush();
			expect(fs.existsSync(out)).toBe(false);
			// Nothing is queued after stop.
			b.onSegmentClosed(entryFor(LAST_WINDOW), LAST_WINDOW);
			await flush();
			expect(consult).toHaveBeenCalledTimes(2);

			const c = scheduler(consult);
			c.tick(null);
			await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(3));
			fs.rmSync(path.join(dir, 'digests'), { recursive: true, force: true });
			release({ success: true, answer: 'x' });
			await flush();
			expect(fs.existsSync(out)).toBe(false);
		});

		it('cancel({all}) drops a queued roll-up behind a 15-minute digest', async () => {
			writeDigest(BLOCK);
			writeSegment(LAST_WINDOW);
			let release: (a: Answer) => void = () => {};
			const consult = vi.fn(() => new Promise<Answer>((r) => (release = r)));
			const s = scheduler(consult);
			s.onSegmentClosed(entryFor(LAST_WINDOW), LAST_WINDOW);
			await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(1));
			expect(s.status().pending).toBe(1); // the roll-up waits behind the 15m digest
			s.cancel({ all: true });
			expect(s.status().pending).toBe(0);
			release({ success: true, answer: 'x' });
			await flush();
			expect(consult).toHaveBeenCalledTimes(1);
		});
	});

	describe('catch-up on start', () => {
		it('queues missing 15-minute digests of the last 6 h (bounded) and missing roll-ups of the last 24 h', async () => {
			now = Date.parse('2026-10-03T18:05:00.000Z');
			// 30 closed segments in the last 6 h, none digested.
			const lines: string[] = [];
			for (let i = 1; i <= 30; i++) {
				const start = BLOCK + 6 * 60 * MIN - i * 15 * MIN;
				writeSegment(start);
				lines.push(JSON.stringify(entryFor(start)));
			}
			// An older block (06:00-12:00) that has 15-minute digests but no roll-up.
			writeDigest(Date.parse('2026-10-03T07:00:00.000Z'));
			// A block that already has its roll-up.
			writeDigest(Date.parse('2026-10-03T01:00:00.000Z'));
			fs.writeFileSync(path.join(dir, 'digests', '2026-10-03', '6h-0000Z.md'), '# done');
			fs.writeFileSync(path.join(dir, 'index.jsonl'), lines.join('\n') + '\n');
			const consult = vi.fn(() => new Promise<Answer>(() => {}));
			const s = scheduler(consult);
			const result = await s.catchUp();
			// Only windows starting inside the last 6 h count (12:15 through 17:45).
			expect(result.queued15m).toBe(23);
			expect(result.queued15m).toBeLessThanOrEqual(MAX_PENDING_15M);
			// 06:00 (has digests) and 12:00 (15-minute digests are queued for it).
			expect(result.queuedRollups).toBe(2);
		});

		it('does nothing when digests are off', async () => {
			config.digests.enabled = false;
			const s = scheduler(vi.fn());
			expect(await s.catchUp()).toEqual({ queued15m: 0, queuedRollups: 0 });
		});

		it('bounds the 15-minute backlog when closes pile up behind a slow agent', async () => {
			const consult = vi.fn(() => new Promise<Answer>(() => {}));
			const s = scheduler(consult);
			for (let i = 0; i < 40; i++) {
				const start = BLOCK + i * 15 * MIN;
				writeSegment(start);
				s.onSegmentClosed(entryFor(start), start);
			}
			await flush();
			// One in flight, the rest queued; never more than the cap (plus roll-ups).
			const queued15m = s.status().pending;
			expect(queued15m).toBeLessThanOrEqual(MAX_PENDING_15M + 2);
		});
	});
});
