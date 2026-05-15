/**
 * @file jsonl-tailer.test.ts
 * @description Tests for the JsonlTailer used by maestro-p run mode to read
 * claude's session jsonl instead of screen-scraping the TUI.
 *
 * Covers:
 *   - Entries already in the file when start() is called are emitted in order.
 *   - Lines appended after start() are picked up on the next poll.
 *   - Partial lines (no trailing \n yet) are buffered and emitted when completed.
 *   - Empty lines are skipped silently.
 *   - Malformed lines emit `parse-error` rather than `error` (the tailer keeps
 *     running).
 *   - skipExisting: existing content is ignored; only post-start writes emit.
 *   - File-not-yet-existing: poll silently retries until the file appears.
 *   - stop() halts polling; later appends are not emitted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { JsonlTailer } from '../../maestro-p/jsonl-tailer';

const POLL_MS = 25;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectEntries(
	tailer: JsonlTailer,
	expectedCount: number,
	timeoutMs = 1500
): Promise<unknown[]> {
	const entries: unknown[] = [];
	tailer.on('entry', (entry) => {
		entries.push(entry);
	});
	const deadline = Date.now() + timeoutMs;
	while (entries.length < expectedCount && Date.now() < deadline) {
		await sleep(POLL_MS);
	}
	return entries;
}

describe('JsonlTailer', () => {
	let tmpDir: string;
	let filePath: string;
	let tailer: JsonlTailer | null = null;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-tailer-'));
		filePath = path.join(tmpDir, 'session.jsonl');
	});

	afterEach(async () => {
		if (tailer) {
			tailer.stop();
			tailer = null;
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it('emits entries already present in the file when start() is called', async () => {
		await fs.writeFile(
			filePath,
			'{"type":"user","message":{"role":"user","content":"hi"}}\n{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn"}}\n'
		);

		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const entries = (await collectEntries(tailer, 2)) as Array<{ type: string }>;
		tailer.start();
		const collected = (await collectEntries(tailer, 2)) as Array<{ type: string }>;

		expect(collected).toHaveLength(2);
		expect(collected[0].type).toBe('user');
		expect(collected[1].type).toBe('assistant');
		void entries; // unused — the second collectEntries after start() is the real check
	});

	it('picks up lines appended after start()', async () => {
		await fs.writeFile(filePath, '');
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const collected: unknown[] = [];
		tailer.on('entry', (e) => collected.push(e));
		tailer.start();

		await sleep(POLL_MS * 2);
		await fs.appendFile(filePath, '{"type":"assistant","seq":1}\n');
		await sleep(POLL_MS * 3);
		await fs.appendFile(filePath, '{"type":"assistant","seq":2}\n');
		await sleep(POLL_MS * 3);

		expect(collected).toHaveLength(2);
		expect((collected[0] as { seq: number }).seq).toBe(1);
		expect((collected[1] as { seq: number }).seq).toBe(2);
	});

	it('buffers a partial line until the next poll completes it', async () => {
		await fs.writeFile(filePath, '');
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const collected: unknown[] = [];
		tailer.on('entry', (e) => collected.push(e));
		tailer.start();

		// Write the entry in two slices — first half has no trailing newline.
		await fs.appendFile(filePath, '{"type":"assistant","par');
		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(0);

		await fs.appendFile(filePath, 'tial":true}\n');
		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(1);
		expect((collected[0] as { partial: boolean }).partial).toBe(true);
	});

	it('skips empty lines silently', async () => {
		await fs.writeFile(filePath, '\n\n{"type":"assistant"}\n\n');
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const collected: unknown[] = [];
		tailer.on('entry', (e) => collected.push(e));
		tailer.on('parse-error', () => {
			throw new Error('empty line should not produce a parse-error');
		});
		tailer.start();
		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(1);
	});

	it('emits parse-error (not error) for malformed lines, then keeps reading', async () => {
		await fs.writeFile(filePath, '{"type":"good","seq":1}\nNOT JSON\n{"type":"good","seq":2}\n');
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const entries: unknown[] = [];
		const parseErrors: unknown[] = [];
		tailer.on('entry', (e) => entries.push(e));
		tailer.on('parse-error', (e) => parseErrors.push(e));
		tailer.start();
		await sleep(POLL_MS * 4);

		expect(entries).toHaveLength(2);
		expect(parseErrors).toHaveLength(1);
		expect((entries[0] as { seq: number }).seq).toBe(1);
		expect((entries[1] as { seq: number }).seq).toBe(2);
	});

	it('skipExisting=true ignores pre-existing content and only emits post-start writes', async () => {
		await fs.writeFile(filePath, '{"type":"old","seq":1}\n{"type":"old","seq":2}\n');
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS, skipExisting: true });
		const collected: unknown[] = [];
		tailer.on('entry', (e) => collected.push(e));
		tailer.start();

		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(0);

		await fs.appendFile(filePath, '{"type":"new","seq":3}\n');
		await sleep(POLL_MS * 3);

		expect(collected).toHaveLength(1);
		expect((collected[0] as { seq: number }).seq).toBe(3);
	});

	it('silently retries while the file does not yet exist, then picks up content when it appears', async () => {
		// File does not exist yet.
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const collected: unknown[] = [];
		const errors: unknown[] = [];
		tailer.on('entry', (e) => collected.push(e));
		tailer.on('error', (e) => errors.push(e));
		tailer.start();

		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(0);
		expect(errors).toHaveLength(0);

		await fs.writeFile(filePath, '{"type":"first","seq":1}\n');
		await sleep(POLL_MS * 3);

		expect(collected).toHaveLength(1);
		expect((collected[0] as { seq: number }).seq).toBe(1);
	});

	it('stop() halts polling; later appends are not emitted', async () => {
		await fs.writeFile(filePath, '');
		tailer = new JsonlTailer({ filePath, pollMs: POLL_MS });
		const collected: unknown[] = [];
		tailer.on('entry', (e) => collected.push(e));
		tailer.start();

		await fs.appendFile(filePath, '{"seq":1}\n');
		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(1);

		tailer.stop();
		await fs.appendFile(filePath, '{"seq":2}\n');
		await sleep(POLL_MS * 3);
		expect(collected).toHaveLength(1); // still 1
	});
});
