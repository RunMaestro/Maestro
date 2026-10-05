import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaProgram, PianolaAsk } from '../../../shared/pianola/pianola-programs';

// `fs` is an ESM namespace here, so its exports cannot be spied on. The store's
// rename is routed through this override so one test can interleave a second
// write in the middle of the first (the overlap that a fixed temp name lost).
let renameOverride: ((from: fs.PathLike, to: fs.PathLike) => void) | null = null;
vi.mock('fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('fs')>();
	const renameSync: typeof real.renameSync = (from, to) =>
		renameOverride ? renameOverride(from, to) : real.renameSync(from, to);
	return { ...real, renameSync, default: { ...real, renameSync } };
});

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('portfolio files', () => {
	it('uses independent temporary files when writes overlap, even in the same millisecond', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-atomic-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const program: PianolaProgram = {
			id: 'outer',
			title: 'Outer',
			root: '/tmp/product',
			roles: {},
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		vi.spyOn(Date, 'now').mockReturnValue(1234);
		const tempNames = new Set<string>();
		let nested = false;
		renameOverride = (from, to) => {
			tempNames.add(String(from));
			if (!nested) {
				nested = true;
				// A second writer lands while the first is between write and rename.
				store.writePrograms([{ ...program, id: 'inner', title: 'Inner' }]);
			}
			renameOverride = null;
			fs.renameSync(from, to);
		};
		try {
			store.writePrograms([program]);
		} finally {
			renameOverride = null;
		}
		expect(store.readPrograms()).toEqual([program]);
		expect(tempNames.size).toBe(2);
		expect(fs.readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
	});
	it('releases the asks lock after a failed mutation and recovers an abandoned stale lock', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-asks-lock-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const lock = path.join(dir, 'maestro-pianola-asks.json.lock');
		expect(() =>
			store.updateAsks(() => {
				throw new Error('Rejected mutation');
			})
		).toThrow('Rejected mutation');
		expect(fs.existsSync(lock)).toBe(false);
		fs.writeFileSync(lock, 'abandoned');
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		expect(store.updateAsks(() => [])).toEqual([]);
		expect(fs.existsSync(lock)).toBe(false);
		expect(store.readAsks()).toEqual([]);
	});
	it('times out without reclaiming a stale lock still owned by a live process', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-live-lock-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const lock = path.join(dir, 'maestro-pianola-asks.json.lock');
		const owner = process.pid + '.0.live';
		fs.writeFileSync(lock, owner);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		let clock = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));
		expect(() => store.writeAsks([])).toThrow('Timed out waiting for Pianola asks lock');
		expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
	});
	it('shares valid programs and asks across store instances, dropping malformed records in each file', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-portfolio-'));
		dirs.push(dir);
		const first = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const second = createPianolaFsStore({
			resolveDir: () => dir,
			indent: '\t',
			trailingNewline: false,
		});
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: '/tmp/product',
			roles: {},
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const ask: PianolaAsk = {
			id: 'ask',
			title: 'Approve',
			detail: 'Can we proceed?',
			severity: 'high',
			status: 'open',
			dedupeKey: 'unknown:product',
			programId: 'product',
			createdAt: '2026-10-01T00:00:00Z',
			updatedAt: '2026-10-01T00:00:00Z',
		};
		first.upsertProgram(program);
		first.writeAsks([ask]);
		expect(second.readPrograms()).toEqual([program]);
		expect(second.readAsks()).toEqual([ask]);
		fs.writeFileSync(
			path.join(dir, 'maestro-pianola-programs.json'),
			JSON.stringify({
				programs: [program, { ...program, id: 'bad', roles: { lead: { name: 42 } } }],
			})
		);
		fs.writeFileSync(
			path.join(dir, 'maestro-pianola-asks.json'),
			JSON.stringify({ asks: [ask, { ...ask, id: 'bad', severity: 'catastrophic' }] })
		);
		expect(first.readPrograms()).toEqual([program]);
		expect(first.readAsks()).toEqual([ask]);
	});
});
