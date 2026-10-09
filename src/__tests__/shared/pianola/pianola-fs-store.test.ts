import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaProgram, PianolaAsk } from '../../../shared/pianola/pianola-programs';
import { revisePlanTask } from '../../../shared/pianola/pianola-tasks';

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
	it('lets timers progress while waiting for a live lock owner and updates after release', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-async-lock-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const lock = path.join(dir, 'maestro-pianola-asks.json.lock');
		const owner = process.pid + '.0.live-owner';
		fs.writeFileSync(lock, owner);
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		const update = vi.fn(() => []);
		let settled = false;
		const pending = store.updateAsksAsync(update);
		const outcome = pending.then(
			(value) => {
				settled = true;
				return { value };
			},
			(error: unknown) => {
				settled = true;
				return { error };
			}
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		expect(update).not.toHaveBeenCalled();
		expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
		fs.rmSync(lock);
		expect(await outcome).toEqual({ value: [] });
		expect(update).toHaveBeenCalledOnce();
		expect(fs.existsSync(lock)).toBe(false);
		expect(store.readAsks()).toEqual([]);
	});
	it.each(['write asks', 'targets', 'memo'])(
		'keeps the event loop responsive while waiting to persist %s',
		async (kind) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-async-store-'));
			dirs.push(dir);
			const store = createPianolaFsStore({
				resolveDir: () => dir,
				indent: 2,
				trailingNewline: true,
			});
			const filename =
				kind === 'memo'
					? 'maestro-pianola-program-loop.json'
					: kind === 'targets'
						? 'maestro-pianola-supervisor.json'
						: 'maestro-pianola-asks.json';
			const lock = path.join(dir, filename + '.lock');
			fs.writeFileSync(lock, process.pid + '.0.live');
			const target = {
				id: 'watch',
				kind: 'watch' as const,
				tabId: 'tab',
				agentId: 'lead',
				enabled: true,
				createdAt: 1,
			};
			const pending =
				kind === 'memo'
					? store.updateProgramLoopMemoAsync('product', { notifiedTaskIds: ['plan:task'] })
					: kind === 'targets'
						? store.updateSupervisorTargetsAsync(() => [target])
						: store.writeAsksAsync([]);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(fs.existsSync(path.join(dir, filename))).toBe(false);
			fs.rmSync(lock);
			await pending;
			expect(fs.existsSync(lock)).toBe(false);
			if (kind === 'memo')
				expect(store.readProgramLoopMemo()).toEqual({
					product: { notifiedTaskIds: ['plan:task'] },
				});
			else if (kind === 'targets') expect(store.readSupervisorTargets()).toEqual([target]);
			else expect(store.readAsks()).toEqual([]);
		}
	);
	it('bounds async waits without stealing live locks and releases after failed mutations', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-async-timeout-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const lock = path.join(dir, 'maestro-pianola-asks.json.lock');
		const owner = process.pid + '.0.live';
		fs.writeFileSync(lock, owner);
		let clock = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));
		await expect(store.writeAsksAsync([])).rejects.toThrow(
			'Timed out waiting for Pianola asks lock'
		);
		expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
		vi.restoreAllMocks();
		fs.writeFileSync(lock, 'abandoned');
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		await expect(
			store.updateAsksAsync(() => {
				throw new Error('Rejected mutation');
			})
		).rejects.toThrow('Rejected mutation');
		expect(fs.existsSync(lock)).toBe(false);
		await expect(store.writeAsksAsync([])).resolves.toEqual([]);
	});
	it('restores a replacement live owner instead of stealing it during stale reclaim', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-lock-replace-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const lock = path.join(dir, 'maestro-pianola-asks.json.lock');
		fs.writeFileSync(lock, 'abandoned');
		const old = new Date(Date.now() - 60_000);
		fs.utimesSync(lock, old, old);
		const owner = process.pid + '.0.live-new-owner';
		let clock = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => (clock += 500));
		const update = vi.fn(() => []);
		renameOverride = (from, to) => {
			renameOverride = null;
			fs.writeFileSync(lock, owner);
			fs.renameSync(from, to);
		};
		try {
			expect(() => store.updateAsks(update)).toThrow('Timed out waiting for Pianola asks lock');
			expect(update).not.toHaveBeenCalled();
			expect(fs.readFileSync(lock, 'utf8')).toBe(owner);
		} finally {
			renameOverride = null;
		}
	});
	it('round-trips memo keys that coincide with Object prototype names', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-memo-keys-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		expect(store.readProgramLoopMemo()['constructor']).toBeUndefined();
		store.updateProgramLoopMemo('__proto__', { notifiedTaskIds: ['plan:task'] });
		expect(Object.keys(store.readProgramLoopMemo())).toEqual(['__proto__']);
		expect(store.readProgramLoopMemo()['__proto__'].notifiedTaskIds).toEqual(['plan:task']);
	});
	it.each(['memo', 'targets', 'plans', 'programs'])(
		'serializes %s updates across two independent processes',
		async (kind) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-memo-processes-'));
			dirs.push(dir);
			const entry = path.join(dir, 'store.cjs');
			buildSync({
				entryPoints: [path.resolve(__dirname, '../../../shared/pianola/fs-store.ts')],
				outfile: entry,
				bundle: true,
				platform: 'node',
				format: 'cjs',
			});
			const initial = createPianolaFsStore({
				resolveDir: () => dir,
				indent: 2,
				trailingNewline: true,
			});
			if (kind === 'memo') initial.writeProgramLoopMemo({});
			else if (kind === 'targets') initial.writeSupervisorTargets([]);
			else if (kind === 'plans') initial.writePlans([]);
			else initial.writePrograms([]);
			const workers = ['one', 'two'].map((id) => {
				const filename =
					kind === 'memo'
						? 'maestro-pianola-program-loop.json'
						: kind === 'targets'
							? 'maestro-pianola-supervisor.json'
							: kind === 'plans'
								? 'maestro-pianola-plans.json'
								: 'maestro-pianola-programs.json';
				const script = [
					'const fs = require("fs");',
					'const store = require(' +
						JSON.stringify(entry) +
						').createPianolaFsStore({ resolveDir: () => ' +
						JSON.stringify(dir) +
						', indent: 2, trailingNewline: true });',
					'const read = fs.readFileSync; fs.readFileSync = (file, ...args) => { const value = read.call(fs, file, ...args); if (String(file).endsWith(' +
						JSON.stringify(filename) +
						')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); return value; };',
					'console.log("ready");',
					kind === 'memo'
						? 'process.stdin.once("data", () => { store.updateProgramLoopMemo(' +
							JSON.stringify(id) +
							', { notifiedTaskIds: [' +
							JSON.stringify(id + ':task') +
							'] }); process.stdin.destroy(); });'
						: kind === 'targets'
							? 'process.stdin.once("data", () => { store.upsertSupervisorTarget(' +
								JSON.stringify({
									id,
									kind: 'watch',
									agentId: id,
									tabId: id,
									enabled: true,
									createdAt: 1,
								}) +
								'); process.stdin.destroy(); });'
							: 'process.stdin.once("data", () => { store.' +
								(kind === 'plans' ? 'upsertPlan' : 'upsertProgram') +
								'(' +
								JSON.stringify(
									kind === 'plans'
										? {
												id,
												title: id,
												createdAt: 1,
												tasks: [
													{
														id: 'task',
														title: id,
														prompt: 'Work',
														dependsOn: [],
														status: 'running',
														agentId: id,
														tabId: id,
													},
												],
											}
										: {
												id,
												title: id,
												root: '/product',
												roles: {},
												charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
												status: 'paused',
												createdAt: 1,
												updatedAt: 2,
											}
								) +
								'); process.stdin.destroy(); });',
				].join('\n');
				const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
				let errors = '';
				child.stderr.on('data', (chunk) => {
					errors += String(chunk);
				});
				const ready = new Promise<void>((resolve, reject) => {
					child.stdout.on('data', (chunk) => {
						if (String(chunk).includes('ready')) resolve();
					});
					child.once('error', reject);
					child.once('close', (code) => {
						if (code !== 0) reject(new Error(errors));
					});
				});
				const done = new Promise<void>((resolve, reject) => {
					child.once('error', reject);
					child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(errors))));
				});
				return { child, ready, done };
			});
			try {
				const done = Promise.all(workers.map((worker) => worker.done));
				await Promise.all(workers.map((worker) => worker.ready));
				for (const worker of workers) worker.child.stdin.write('go');
				await done;
				const store = createPianolaFsStore({
					resolveDir: () => dir,
					indent: 2,
					trailingNewline: true,
				});
				if (kind === 'memo')
					expect(store.readProgramLoopMemo()).toEqual({
						one: { notifiedTaskIds: ['one:task'] },
						two: { notifiedTaskIds: ['two:task'] },
					});
				else if (kind === 'targets')
					expect(
						store
							.readSupervisorTargets()
							.map((target) => target.id)
							.sort()
					).toEqual(['one', 'two']);
				else if (kind === 'plans') {
					expect(
						store
							.readPlans()
							.map((plan) => plan.id)
							.sort()
					).toEqual(['one', 'two']);
					for (const plan of store.readPlans())
						expect(plan.tasks[0]).toMatchObject({
							status: 'running',
							agentId: plan.id,
							tabId: plan.id,
						});
				} else {
					expect(
						store
							.readPrograms()
							.map((program) => program.id)
							.sort()
					).toEqual(['one', 'two']);
					for (const program of store.readPrograms()) expect(program.status).toBe('paused');
				}
			} finally {
				for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
			}
		},
		15_000
	);
	it('merges memo updates from independent program loops', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-memo-'));
		dirs.push(dir);
		const first = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const second = createPianolaFsStore({
			resolveDir: () => dir,
			indent: 2,
			trailingNewline: true,
		});
		expect(first.readProgramLoopMemo()).toEqual({});
		expect(second.readProgramLoopMemo()).toEqual({});
		first.updateProgramLoopMemo('one', { notifiedTaskIds: ['p:t'] });
		second.updateProgramLoopMemo('two', { notifiedTaskIds: ['q:u'] });
		first.updateProgramLoopMemo('one', { notifiedTaskIds: ['p:t'], lastLoggedReason: 'idle' });
		expect(second.readProgramLoopMemo()).toEqual({
			one: { notifiedTaskIds: ['p:t'], lastLoggedReason: 'idle' },
			two: { notifiedTaskIds: ['q:u'] },
		});
	});
	it('uses unique temporary files for serialized writes in the same millisecond', async () => {
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
		const recordRename = (from: fs.PathLike, to: fs.PathLike): void => {
			tempNames.add(String(from));
			renameOverride = null;
			try {
				fs.renameSync(from, to);
			} finally {
				renameOverride = recordRename;
			}
		};
		renameOverride = recordRename;
		try {
			await Promise.all([
				store.upsertProgramAsync(program),
				store.upsertProgramAsync({ ...program, id: 'inner' }),
			]);
		} finally {
			renameOverride = null;
		}
		expect(store.readPrograms().map((entry) => entry.id)).toEqual(['outer', 'inner']);
		expect(tempNames.size).toBe(2);
		expect(fs.readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([]);
	});
	it('serializes a founder revision after an in-flight tick so the tick cannot overwrite it', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-revision-lock-'));
		dirs.push(dir);
		const config = { resolveDir: () => dir, indent: 2, trailingNewline: true };
		const orchestrator = createPianolaFsStore(config);
		const lead = createPianolaFsStore(config);
		orchestrator.writePlans([
			{
				id: 'plan',
				title: 'Plan',
				createdAt: 1,
				tasks: [
					{
						id: 'done',
						title: 'Done',
						prompt: 'Done',
						dependsOn: [],
						status: 'done',
						runId: 'verified',
					},
					{
						id: 'reviewed',
						title: 'Answer',
						prompt: 'Old prompt',
						dependsOn: ['done'],
						status: 'needs_review',
					},
				],
			},
		]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tick = orchestrator.withPlanLock('plan', async () => {
			const snapshot = orchestrator.getPlan('plan')!;
			await gate;
			orchestrator.upsertPlan(snapshot);
		});
		vi.useFakeTimers({ toFake: ['Date'] });
		let settled = false;
		const revision = lead
			.withPlanLock(
				'plan',
				async () => {
					lead.updatePlans((plans) =>
						plans.map((entry) => revisePlanTask(entry, 'reviewed', 'Founder correction'))
					);
				},
				{ waitForTurn: true }
			)
			.then(
				() => {
					settled = true;
					return { success: true };
				},
				(error: unknown) => {
					settled = true;
					return { error };
				}
			);
		try {
			vi.setSystemTime(Date.now() + 5100);
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			expect(settled).toBe(false);
			expect(lead.getPlan('plan')!.tasks[1]).toMatchObject({
				prompt: 'Old prompt',
				status: 'needs_review',
			});
		} finally {
			vi.useRealTimers();
			release();
		}
		await Promise.all([tick, revision]);
		expect(await revision).toEqual({ success: true });
		expect(lead.getPlan('plan')!.tasks).toEqual([
			{
				id: 'done',
				title: 'Done',
				prompt: 'Done',
				dependsOn: [],
				status: 'done',
				runId: 'verified',
			},
			{
				id: 'reviewed',
				title: 'Answer',
				prompt: 'Founder correction',
				dependsOn: ['done'],
				status: 'pending',
			},
		]);
	});

	it('holds per-program loop ownership through awaits and releases rejected operations', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-loop-lock-'));
		dirs.push(dir);
		const store = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = store.withProgramLoopLock('../unsafe/id', async () => {
			await gate;
			return 1;
		});
		const secondOperation = vi.fn(async () => 2);
		const second = store.withProgramLoopLock('../unsafe/id', secondOperation);
		expect(await store.withProgramLoopLock('other', async () => 3)).toBe(3);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(secondOperation).not.toHaveBeenCalled();
		expect(fs.readdirSync(dir)).toEqual([
			expect.stringMatching(/^pianola-program-loop-[a-f0-9]{64}\.lock$/),
		]);
		release();
		expect(await Promise.all([first, second])).toEqual([1, 2]);
		await expect(
			store.withProgramLoopLock('../unsafe/id', async () => {
				throw new Error('failed');
			})
		).rejects.toThrow('failed');
		expect(await store.withProgramLoopLock('../unsafe/id', async () => 4)).toBe(4);
		expect(fs.readdirSync(dir)).toEqual([]);
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
