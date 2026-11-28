/**
 * The restart record of durable SSH turns: written at a turn's start and at
 * a detach, removed at its settle, read back by the next launch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dataDir = '';
vi.mock('../../../main/utils/app-user-data', () => ({ getAppUserDataDir: () => dataDir }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	__resetDurableTurnRecordsForTests,
	DURABLE_OFFSETS_PERSIST_MS,
	forgetDurableTurn,
	keepDurableOffsetsCurrent,
	noteDurableTurn,
	recordedDurableTurns,
	updateDurableTurn,
	type DurableTurnRecord,
} from '../../../main/process-manager/durable-turn-records';

const DIR = '/tmp/maestro-turn-0b5c6a52-4bb4-4f6f-8f0e-1f2a3b4c5d6e';

function record(overrides: Partial<DurableTurnRecord> = {}): DurableTurnRecord {
	return {
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'claude-code',
		cwd: '/home/me',
		sshCommand: '/usr/bin/ssh',
		sshArgs: ['-o', 'BatchMode=yes', 'me@host', '/bin/bash', '--norc', '--noprofile', '-s'],
		dir: DIR,
		pidFile: '/tmp/maestro-agent-0b5c6a52-4bb4-4f6f-8f0e-1f2a3b4c5d6e.pid',
		outOffset: 0,
		errOffset: 0,
		isStreamJsonMode: true,
		isBatchMode: true,
		tabId: 'tab-1',
		startTime: Date.now(),
		...overrides,
	};
}

const file = () => path.join(dataDir, 'durable-ssh-turns.json');

describe('durable SSH turn records', () => {
	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-records-'));
		__resetDurableTurnRecordsForTests();
	});
	afterEach(() => {
		// Clears a write retry before its fixture goes.
		__resetDurableTurnRecordsForTests();
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	it('a recorded turn is read back by the next launch, with its latest offsets', () => {
		noteDurableTurn(record());
		noteDurableTurn(record({ outOffset: 120, errOffset: 7 }));
		__resetDurableTurnRecordsForTests();
		expect(recordedDurableTurns()).toEqual([
			record({ outOffset: 120, errOffset: 7, startTime: expect.any(Number) }),
		]);
	});

	it('a settled turn leaves no file', () => {
		noteDurableTurn(record());
		expect(fs.existsSync(file())).toBe(true);
		forgetDurableTurn('agent-1-ai-tab-1', DIR);
		expect(fs.existsSync(file())).toBe(false);
		__resetDurableTurnRecordsForTests();
		expect(recordedDurableTurns()).toEqual([]);
	});

	it("an older turn's settle never removes the newer turn's record on the same tab", () => {
		const newer = '/tmp/maestro-turn-11111111-2222-3333-4444-555555555555';
		noteDurableTurn(record({ dir: newer }));
		forgetDurableTurn('agent-1-ai-tab-1', DIR);
		expect(recordedDurableTurns().map((r) => r.dir)).toEqual([newer]);
	});

	it('drops what it cannot trust: a torn file, a bad entry, a record older than a week', () => {
		fs.writeFileSync(file(), '{not json');
		expect(recordedDurableTurns()).toEqual([]);
		__resetDurableTurnRecordsForTests();
		fs.writeFileSync(
			file(),
			JSON.stringify([
				record({ sessionId: 'kept' }),
				{ ...record({ sessionId: 'bad' }), outOffset: -1 },
				record({ sessionId: 'old', startTime: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
			])
		);
		expect(recordedDurableTurns().map((r) => r.sessionId)).toEqual(['kept']);
	});

	describe('keepDurableOffsetsCurrent', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		function running() {
			let settle!: () => void;
			const done = new Promise<void>((resolve) => (settle = resolve));
			const offsets = { outOffset: 0, errOffset: 0 };
			return { turn: { done, restartOffsets: () => ({ ...offsets }) }, offsets, settle };
		}

		it('writes the offsets while they move, and stops when the turn settles', async () => {
			const { turn, offsets, settle } = running();
			const write = vi.fn(() => true);
			keepDurableOffsetsCurrent(turn, { outOffset: 0, errOffset: 0 }, write, () => false);
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(write).not.toHaveBeenCalled();
			offsets.outOffset = 120;
			offsets.errOffset = 4;
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(write).toHaveBeenCalledExactlyOnceWith({ outOffset: 120, errOffset: 4 });
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(write).toHaveBeenCalledTimes(1);
			settle();
			await Promise.resolve();
			offsets.outOffset = 200;
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS * 3);
			expect(write).toHaveBeenCalledTimes(1);
		});

		it('leaves the record to the detach once the app quits', () => {
			const { turn, offsets } = running();
			const write = vi.fn(() => true);
			let detached = false;
			keepDurableOffsetsCurrent(turn, { outOffset: 0, errOffset: 0 }, write, () => detached);
			detached = true;
			offsets.outOffset = 50;
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS * 2);
			expect(write).not.toHaveBeenCalled();
		});

		it('a crash keeps the last offsets written: the next launch resumes there, not at 0', () => {
			const { turn, offsets } = running();
			noteDurableTurn(record());
			keepDurableOffsetsCurrent(
				turn,
				{ outOffset: 0, errOffset: 0 },
				(o) => updateDurableTurn(record(o)),
				() => false
			);
			offsets.outOffset = 4096;
			offsets.errOffset = 9;
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			// The app dies here: nothing settles, nothing detaches.
			__resetDurableTurnRecordsForTests();
			expect(recordedDurableTurns()[0]).toMatchObject({ outOffset: 4096, errOffset: 9 });
		});

		it('a write that failed is tried again on the next tick, even when the offsets stay put', () => {
			const { turn, offsets } = running();
			const write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
			keepDurableOffsetsCurrent(turn, { outOffset: 0, errOffset: 0 }, write, () => false);
			offsets.outOffset = 300;
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(write).toHaveBeenCalledTimes(1);
			// The remote went quiet: the same offsets, written again because the first write failed.
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(write).toHaveBeenCalledTimes(2);
			expect(write).toHaveBeenLastCalledWith({ outOffset: 300, errOffset: 0 });
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(write).toHaveBeenCalledTimes(2);
		});
	});

	describe('a write that failed', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it("is tried again until it lands, so a silent turn's first record still reaches the disk", () => {
			// The data dir is gone when the turn starts: the first write fails.
			fs.rmSync(dataDir, { recursive: true, force: true });
			noteDurableTurn(record());
			expect(fs.existsSync(file())).toBe(false);
			fs.mkdirSync(dataDir, { recursive: true });
			// No offset moves (the agent is quiet): the retry alone writes it.
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			__resetDurableTurnRecordsForTests();
			expect(recordedDurableTurns()).toEqual([expect.objectContaining({ dir: DIR })]);
		});

		it("is tried again for a settled turn's removal, so the next launch never restores it", () => {
			noteDurableTurn(record());
			// The record's path cannot be unlinked when the turn settles (a
			// directory stands there, which no user, root included, can unlink).
			fs.rmSync(file());
			fs.mkdirSync(file());
			forgetDurableTurn('agent-1-ai-tab-1', DIR);
			// The stale record is back on disk before the retry runs.
			fs.rmdirSync(file());
			fs.writeFileSync(file(), JSON.stringify([record()]));
			vi.advanceTimersByTime(DURABLE_OFFSETS_PERSIST_MS);
			expect(fs.existsSync(file())).toBe(false);
			__resetDurableTurnRecordsForTests();
			expect(recordedDurableTurns()).toEqual([]);
		});
	});

	describe('updateDurableTurn', () => {
		it("rewrites only the turn's own record: a stopped turn never overwrites its successor's", () => {
			const successorDir = '/tmp/maestro-turn-11111111-2222-4333-8444-555555555555';
			noteDurableTurn(record());
			// The next turn on the tab starts while the stopped one still drains.
			noteDurableTurn(record({ dir: successorDir }));
			expect(updateDurableTurn(record({ outOffset: 999 }))).toBe(true);
			__resetDurableTurnRecordsForTests();
			expect(recordedDurableTurns()).toEqual([
				expect.objectContaining({ dir: successorDir, outOffset: 0 }),
			]);
			// The successor's own rewrite lands.
			expect(updateDurableTurn(record({ dir: successorDir, outOffset: 50 }))).toBe(true);
			__resetDurableTurnRecordsForTests();
			expect(recordedDurableTurns()[0]).toMatchObject({ dir: successorDir, outOffset: 50 });
		});

		it('reports a write that failed, so its caller tries again', () => {
			noteDurableTurn(record());
			// The data dir is gone: the write cannot land.
			fs.rmSync(dataDir, { recursive: true, force: true });
			expect(updateDurableTurn(record({ outOffset: 10 }))).toBe(false);
		});
	});
});
