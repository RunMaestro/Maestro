import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DigestScheduler, MAX_PENDING_15M } from '../../../main/computer-history/digests';
import { defaultComputerHistoryConfig } from '../../../shared/computer-history/config';
import { digestRelativePath, segmentRelativePath } from '../../../shared/computer-history/paths';
import type { ComputerHistoryConfig } from '../../../shared/computer-history/types';

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
		expect(rollupQuestion).toContain(path.join(dir, ...digestRelativePath(LAST_WINDOW).split('/')));
		expect(rollupQuestion).not.toContain('morning work');
		expect(rollupQuestion).toMatch(/UNTRUSTED/);
		const body = fs.readFileSync(out, 'utf-8');
		expect(body).toContain('6-hour roll-up');
		expect(body).toContain('[REDACTED_API_KEY]');
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
