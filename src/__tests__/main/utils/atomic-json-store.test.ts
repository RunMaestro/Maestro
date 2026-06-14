import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteJson, createKeyedWriteQueue } from '../../../main/utils/atomic-json-store';

describe('atomicWriteJson', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-json-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('writes JSON that round-trips', async () => {
		const file = path.join(dir, 'data.json');
		await atomicWriteJson(file, { a: 1, b: [2, 3] });
		expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ a: 1, b: [2, 3] });
	});

	it('leaves no .tmp file behind', async () => {
		const file = path.join(dir, 'data.json');
		await atomicWriteJson(file, { ok: true });
		const files = await fs.readdir(dir);
		expect(files).toEqual(['data.json']);
	});

	it('overwrites an existing file wholesale (no concatenation)', async () => {
		const file = path.join(dir, 'data.json');
		await atomicWriteJson(file, { entries: [1, 2, 3, 4, 5] });
		// A shorter payload must fully replace the longer one, never leave a tail.
		await atomicWriteJson(file, { entries: [9] });
		const raw = await fs.readFile(file, 'utf-8');
		expect(() => JSON.parse(raw)).not.toThrow();
		expect(JSON.parse(raw)).toEqual({ entries: [9] });
	});

	it('refuses to write undefined and leaves an existing file intact', async () => {
		const file = path.join(dir, 'data.json');
		await atomicWriteJson(file, { good: true });
		// JSON.stringify(undefined) === undefined → must be rejected before any
		// file I/O so the good file survives.
		await expect(atomicWriteJson(file, undefined)).rejects.toThrow(/empty\/undefined/);
		expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({ good: true });
		// No temp file left behind by the rejected write.
		expect(await fs.readdir(dir)).toEqual(['data.json']);
	});
});

describe('createKeyedWriteQueue', () => {
	it('serializes callbacks sharing a key (no interleave)', async () => {
		const queue = createKeyedWriteQueue();
		const events: string[] = [];
		const task = (label: string) => async () => {
			events.push(`${label}:start`);
			await new Promise((r) => setTimeout(r, 5));
			events.push(`${label}:end`);
		};

		// Fire both without awaiting between them - they share a key.
		const p1 = queue.enqueue('k', task('A'));
		const p2 = queue.enqueue('k', task('B'));
		await Promise.all([p1, p2]);

		// B must not start until A has finished.
		expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
	});

	it('runs different keys concurrently', async () => {
		const queue = createKeyedWriteQueue();
		const order: string[] = [];
		const slow = async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push('slow');
		};
		const fast = async () => {
			order.push('fast');
		};
		await Promise.all([queue.enqueue('a', slow), queue.enqueue('b', fast)]);
		// Different keys don't block each other - fast finishes first.
		expect(order).toEqual(['fast', 'slow']);
	});

	it('runs the next task even if the previous one rejects', async () => {
		const queue = createKeyedWriteQueue();
		const ran: string[] = [];
		const p1 = queue.enqueue('k', async () => {
			ran.push('first');
			throw new Error('boom');
		});
		const p2 = queue.enqueue('k', async () => {
			ran.push('second');
		});
		await expect(p1).rejects.toThrow('boom');
		await p2;
		expect(ran).toEqual(['first', 'second']);
	});

	it('serializes read-modify-write so concurrent appends never lose entries', async () => {
		// Reproduces the history-manager corruption shape: a read-modify-write
		// against a shared file. Without serialization, concurrent callers read
		// the same base and the later write clobbers the earlier entry.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmw-'));
		const file = path.join(dir, 'list.json');
		await atomicWriteJson(file, { entries: [] as number[] });
		const queue = createKeyedWriteQueue();

		const append = (n: number) =>
			queue.enqueue(file, async () => {
				const cur = JSON.parse(await fs.readFile(file, 'utf-8')) as { entries: number[] };
				// Yield to maximize interleave opportunity if serialization failed.
				await new Promise((r) => setTimeout(r, 1));
				cur.entries.push(n);
				await atomicWriteJson(file, cur);
			});

		await Promise.all(Array.from({ length: 25 }, (_, i) => append(i)));

		const final = JSON.parse(await fs.readFile(file, 'utf-8')) as { entries: number[] };
		expect(final.entries.length).toBe(25);
		expect([...final.entries].sort((a, b) => a - b)).toEqual(
			Array.from({ length: 25 }, (_, i) => i)
		);
		await fs.rm(dir, { recursive: true, force: true });
	});
});
