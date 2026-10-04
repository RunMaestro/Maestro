import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SegmentWriter } from '../../../main/computer-history/segment-writer';
import { createKeyedWriteQueue } from '../../../main/utils/atomic-json-store';
import { parseIndexText, parseSegmentText } from '../../../shared/computer-history/reader';
import type { SegmentIndexEntry } from '../../../shared/computer-history/types';

let dir: string;
const T0 = Date.parse('2026-10-03T14:10:00.000Z');

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
	it('assigns seq per segment and writes to the 10-minute UTC window file', async () => {
		let now = T0;
		const writer = new SegmentWriter({
			storeDir: dir,
			queue: createKeyedWriteQueue(),
			now: () => now,
		});
		const a = await writer.append(input(T0 + 1000));
		const b = await writer.append(input(T0 + 2000));
		expect([a.seq, b.seq]).toEqual([0, 1]);
		expect(writer.currentInfo()).toEqual({ file: 'segments/2026-10-03/1410Z.jsonl', events: 2 });
		expect(readSeg('segments/2026-10-03/1410Z.jsonl').map((e) => e.seq)).toEqual([0, 1]);
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
		const next = await writer.append(input(T0 + 600_500));
		expect(next.seq).toBe(0);
		const idx = readIndex();
		expect(idx).toHaveLength(1);
		expect(idx[0]).toMatchObject({
			file: 'segments/2026-10-03/1410Z.jsonl',
			events: 2,
			start: new Date(T0 + 1000).toISOString(),
			end: new Date(T0 + 2000).toISOString(),
			apps: { 'com.tinyspeck.slackmacgap': 1, 'com.google.chrome': 1 },
		});
		expect(idx[0].bytes).toBeGreaterThan(0);
		expect(closed).toHaveBeenCalledWith(expect.objectContaining({ events: 2 }), T0);
		expect(writer.currentInfo()?.file).toBe('segments/2026-10-03/1420Z.jsonl');
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
		now = T0 + 600_000 + 5000;
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
		await writer.append(input(T0 + 600_100));
		const late = await writer.append(input(T0 + 5));
		expect(late.seq).toBe(1);
		expect(writer.currentInfo()?.file).toBe('segments/2026-10-03/1420Z.jsonl');
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
		expect(readIndex().map((e) => e.file)).toEqual(['segments/2026-10-03/1410Z.jsonl']);
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
});
