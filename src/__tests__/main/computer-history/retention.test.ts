import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	runRetention,
	deleteSegments,
	listSegmentFiles,
} from '../../../main/computer-history/retention';
import { createKeyedWriteQueue } from '../../../main/utils/atomic-json-store';
import { digestRelativePath, segmentRelativePath } from '../../../shared/computer-history/paths';
import { parseIndexText } from '../../../shared/computer-history/reader';

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
	return parseIndexText(fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf-8')).map((e) => e.file);
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
});
