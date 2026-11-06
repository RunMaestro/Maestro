import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { canonicalJson } from '../../../shared/canonicalJson';
import { configurePianolaScope } from '../../../main/pianola/pianola-legacy-migration';
import { spawn } from 'child_process';
import { once } from 'events';
import * as os from 'os';
import { NativeCurrentTurns } from '../../../main/pianola/current-turn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	PianolaDispatchAdmissionService,
	type PianolaDispatchAdmissionDeps,
} from '../../../main/pianola/pianola-dispatch-admission';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import {
	runPianolaScopeCycle,
	type PianolaScopeSnapshot,
} from '../../../shared/pianola/pianola-scope-cycle';
import {
	validatePianolaSupervisedTarget,
	type PianolaSupervisedTarget,
} from '../../../shared/pianola/storage';
import { validatePianolaDispatchAdmission } from '../../../shared/pianola/pianola-dispatch';

vi.mock('fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('fs')>()) }));

const scopeId = '11111111-1111-4111-8111-111111111111';
const dispatchId = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const root = os.tmpdir();
	fs.mkdirSync(root, { recursive: true });
	const dir = fs.mkdtempSync(path.join(root, 'admission-'));
	directories.push(dir);
	const store = createPianolaFsStore({
		resolveDir: () => dir,
		indent: 2,
		trailingNewline: true,
		decisionLockMode: 'try',
	});
	const scope: PianolaSupervisedTarget = {
		id: scopeId,
		kind: 'watch-scope',
		enabled: true,
		createdAt: 1,
		managerAgentId: 'manager',
		selection: {
			label: 'Workers',
			mode: 'agents-and-groups',
			agentIds: ['worker'],
			groupIds: [],
			excludedAgentIds: [],
		},
	};
	store.writeSupervisorTargets([scope]);
	const client = { cliAuthenticated: true };
	const controller = new AbortController();
	const caller = {
		run: { agentId: 'manager', tabId: 'manager-tab', spawnGeneration: 'spawn-1' },
		signal: controller.signal,
		unattended: true,
		assertActive() {
			if (controller.signal.aborted) throw new Error('Revoked');
		},
	};
	const snapshot: PianolaScopeSnapshot = {
		complete: true,
		capturedAt: 100,
		owners: [{ id: 'worker', cwd: process.cwd(), isPianola: false, remote: false, groupId: null }],
		tabs: [
			{
				agentId: 'worker',
				tabId: 'target',
				createdAt: 90,
				busy: false,
				paused: false,
				consult: false,
				ephemeral: false,
				cursorAvailable: true,
				cursor: null,
			},
		],
	};
	const release = vi.fn<PianolaDispatchAdmissionDeps['release']>(async (_receipt, guard) => {
		guard();
		return 'accepted';
	});
	const deps: PianolaDispatchAdmissionDeps = {
		store,
		callers: { resolve: (c) => (c === client ? caller : undefined) },
		featureEnabled: () => true,
		readSnapshot: async () => snapshot,
		ruleSetRevision: () => 'rules-1',
		assertTargetReady: () => {
			if (snapshot.tabs[0].paused) throw new Error('NativeTargetPaused');
		},
		release,
	};
	const service = new PianolaDispatchAdmissionService(deps);
	const request = {
		dispatchId,
		targetAgentId: 'worker',
		intent: { prompt: 'Implement the task', placement: 'new-tab' },
	};
	async function enroll() {
		await service.prepare(client, request);
		await service.bind(client, dispatchId, 'target');
		return service.enroll(client, dispatchId);
	}
	return {
		dir,
		store,
		scope,
		snapshot,
		deps,
		release,
		service,
		client,
		caller,
		controller,
		request,
		enroll,
	};
}

describe('host Pianola dispatch admission', () => {
	async function payloadFixture() {
		const f = fixture();
		await f.service.prepare(f.client, f.request);
		await f.service.bind(f.client, dispatchId, 'target', 'row');
		const record = f.store.readDispatchAdmission(dispatchId)!;
		record.phase = 'settled';
		record.outcome = 'accepted';
		record.queuePrepare = {
			phase: 'durable',
			item: {
				id: 'row',
				tabId: 'target',
				pendingAdmissionId: dispatchId,
				type: 'message',
				timestamp: 100,
				text: 'PROMPT-BEGIN' + '😀\n\"'.repeat(20000) + 'PROMPT-END',
				crossAgentMention: true,
			},
		};
		record.queueAuthority = {
			acceptedAt: 100,
			expiresAt: 1000,
			bindingFingerprint: 'a'.repeat(64),
			createdAt: 90,
		};
		record.queueRelease = { generation: '44444444-4444-4444-8444-444444444444', baseline: null };
		record.queueRouting = {
			routing: 'only',
			targets: [
				{ agentId: 'peer-a', fingerprint: 'b'.repeat(64) },
				{ agentId: 'peer-b', fingerprint: 'c'.repeat(64) },
			],
			steps: ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'].map(
				(requestId, index) => ({
					kind: 'consult',
					requestId,
					targetAgentId: index === 0 ? 'peer-a' : 'peer-b',
					status: 'settled',
					processId: 'cross-agent-' + requestId,
					runId: 'run-' + index,
					terminal: { text: 'BEGIN-' + index + '😀\n\"'.repeat(20000) + 'END-' + index },
				})
			),
		};
		f.store.writeDispatchAdmission(record);
		const journal = path.join(f.dir, `maestro-pianola-dispatch-${dispatchId}.json`);
		const disk = () => JSON.parse(fs.readFileSync(journal, 'utf8'));
		const artifact = (ref: { sha256: string }) =>
			path.join(f.dir, `maestro-pianola-dispatch-${dispatchId}-${ref.sha256}.artifact.json`);
		return { ...f, record, journal, disk, artifact };
	}

	it('keeps the control journal bounded and preserves unreconciled artifacts and complete Unicode replies after restart', async () => {
		const f = await payloadFixture();
		expect(fs.statSync(f.journal).size).toBeLessThanOrEqual(16384);
		expect(fs.readFileSync(f.journal, 'utf8')).not.toContain('PROMPT-BEGIN');
		const reopened = createPianolaFsStore({
			resolveDir: () => f.dir,
			indent: '\t',
			trailingNewline: false,
		});
		expect(reopened.readDispatchAdmission(dispatchId)).toEqual(f.record);
		for (let i = 0; i < 8; i++) {
			f.record.queuePrepare!.callbackId = 'callback-' + i;
			f.store.writeDispatchAdmission(f.record);
		}
		await f.store.compactDispatchArtifacts();
		expect(fs.readdirSync(f.dir).filter((name) => name.endsWith('.artifact.json'))).toHaveLength(
			11
		);
		expect(reopened.readDispatchAdmission(dispatchId)).toEqual(f.record);
	});

	async function completedFixture(count = 40) {
		const f = await payloadFixture();
		const records = [];
		for (let i = 0; i < count; i++) {
			const id = `${(i + 10).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
			const record = structuredClone(f.record);
			record.dispatchId = id;
			record.queuePrepare!.item.pendingAdmissionId = id;
			record.queueRouting!.completed = true;
			record.queuePrepare!.callbackId = 'parent-' + i;
			f.store.writeDispatchAdmission(record);
			f.store.confirmDispatchCallback(id, 'parent-' + i);
			records.push(f.store.readDispatchAdmission(id)!);
		}
		return { ...f, records };
	}

	describe('completed payload retention', () => {
		let prepared: Awaited<ReturnType<typeof completedFixture>>;
		beforeEach(async ({ task }) => {
			// Durable historical records are fixture setup; keep the default test
			// timeout focused on real cleanup, restart readback and no-resend checks.
			prepared = await completedFixture(task.name.startsWith('bounds completed') ? 40 : 34);
		});

		it('bounds completed dispatch payloads across restart, preserves receipts and rejects stale resurrection', async () => {
			const f = prepared;
			const scans = vi.spyOn(fs, 'readdirSync');
			const reopened = createPianolaFsStore({
				resolveDir: () => f.dir,
				indent: 2,
				trailingNewline: true,
			});
			const cleanup = reopened.compactDispatchArtifacts();
			expect(reopened.compactDispatchArtifacts()).toBe(cleanup);
			await cleanup;
			expect(scans).not.toHaveBeenCalled();
			const results = f.records.map((r) => reopened.readDispatchAdmission(r.dispatchId)!);
			expect(results.filter((r) => r.payloadRetiredAt)).toHaveLength(8);
			expect(results.filter((r) => r.queuePrepare)).toHaveLength(32);
			for (const r of results) {
				expect(r.outcome).toBe('accepted');
				if (r.payloadRetiredAt) {
					expect(r.intentFingerprint).toBe(f.record.intentFingerprint);
					expect(() =>
						reopened.writeDispatchAdmission(
							f.records.find((old) => old.dispatchId === r.dispatchId)!
						)
					).toThrow(/retired/);
				}
			}
			expect(fs.readdirSync(f.dir).filter((n) => n.endsWith('.artifact.json'))).toHaveLength(
				33 * 3
			);
		});

		it.each(['unknown', 'active', 'missing-callback', 'unreconciled'] as const)(
			'retains %s payloads even under retention pressure',
			async (state) => {
				const f = prepared;
				const r = f.records[0];
				if (state === 'unknown') r.outcome = 'unknown';
				if (state === 'active') r.queueRouting!.steps[0].status = 'started';
				if (state === 'unreconciled') delete r.queueRouting!.completed;
				if (state === 'missing-callback') {
					delete r.callbackDeliveredAt;
					const journal = path.join(f.dir, `maestro-pianola-dispatch-${r.dispatchId}.json`);
					const disk = JSON.parse(fs.readFileSync(journal, 'utf8'));
					delete disk.callbackDeliveredAt;
					fs.writeFileSync(journal, JSON.stringify(disk));
				}
				f.store.writeDispatchAdmission(r);
				await f.store.compactDispatchArtifacts();
				expect(f.store.readDispatchAdmission(r.dispatchId)).toEqual(r);
			}
		);
	});

	it('cleans old first-write orphans at startup but preserves fresh orphans and lost journal acknowledgements', async () => {
		const f = await payloadFixture();
		const id = '77777777-7777-4777-8777-777777777777';
		const orphan = path.join(
			f.dir,
			`maestro-pianola-dispatch-${id}-${'a'.repeat(64)}.artifact.json`
		);
		fs.writeFileSync(orphan, 'orphan');
		await f.store.compactDispatchArtifacts();
		expect(fs.existsSync(orphan)).toBe(true);
		fs.utimesSync(orphan, new Date(1), new Date(1));
		await f.store.compactDispatchArtifacts();
		expect(fs.existsSync(orphan)).toBe(false);
		expect(f.store.readDispatchAdmission(dispatchId)).toEqual(f.record);
	});

	it('does not delete payloads when retirement journal durability is unconfirmed', async () => {
		const f = await completedFixture(34);
		const rename = fs.renameSync;
		vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
			rename(from, to);
			if (String(to).endsWith('.json') && !String(to).endsWith('.artifact.json'))
				throw new Error('Lost retirement ack');
		});
		await expect(f.store.compactDispatchArtifacts()).rejects.toThrow('Lost retirement ack');
		expect(fs.readdirSync(f.dir).filter((n) => n.endsWith('.artifact.json'))).toHaveLength(35 * 3);
		vi.restoreAllMocks();
		await f.store.compactDispatchArtifacts();
		for (const r of f.records) expect(f.store.readDispatchAdmission(r.dispatchId)).toBeTruthy();
	});

	it('revalidates a newer commit made during asynchronous candidate selection', async () => {
		const f = await completedFixture(34);
		const record = f.records[0];
		const read = fs.promises.readFile.bind(fs.promises);
		let changed = false;
		vi.spyOn(fs.promises, 'readFile').mockImplementation(
			async (...args: Parameters<typeof fs.promises.readFile>) => {
				const result = await read(...args);
				if (!changed && String(args[0]).endsWith(`dispatch-${record.dispatchId}.json`)) {
					changed = true;
					delete record.queueRouting!.completed;
					f.store.writeDispatchAdmission(record);
				}
				return result;
			}
		);
		await f.store.compactDispatchArtifacts();
		expect(changed).toBe(true);
		expect(f.store.readDispatchAdmission(record.dispatchId)).toEqual(record);
	});

	it('preserves references on ENOSPC during retirement and retries safely', async () => {
		const f = await completedFixture(34);
		vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
			throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
		});
		await expect(f.store.compactDispatchArtifacts()).rejects.toThrow('ENOSPC');
		vi.restoreAllMocks();
		for (const record of f.records)
			expect(f.store.readDispatchAdmission(record.dispatchId)).toEqual(record);
		await f.store.compactDispatchArtifacts();
	});

	it('keeps corrupted referenced payloads and rejects foreign callback acknowledgements', async () => {
		const f = await completedFixture(34);
		const r = f.records[0];
		expect(() => f.store.confirmDispatchCallback(r.dispatchId, 'foreign')).toThrow(/mismatch/);
		const journal = JSON.parse(
			fs.readFileSync(path.join(f.dir, `maestro-pianola-dispatch-${r.dispatchId}.json`), 'utf8')
		);
		const file = path.join(
			f.dir,
			`maestro-pianola-dispatch-${r.dispatchId}-${journal.payloads.terminals[r.queueRouting!.steps[0].requestId].sha256}.artifact.json`
		);
		fs.appendFileSync(file, 'tamper');
		await f.store.compactDispatchArtifacts();
		expect(fs.existsSync(file)).toBe(true);
		expect(() => f.store.readDispatchAdmission(r.dispatchId)).toThrow(/artifact/);
	});

	it('skips active admission locks when every artifact is still referenced', async () => {
		const f = await payloadFixture();
		await f.store.compactDispatchArtifacts();
		const writes = vi.spyOn(fs, 'writeFileSync');
		await f.store.compactDispatchArtifacts();
		expect(writes).not.toHaveBeenCalled();
		expect(f.store.readDispatchAdmission(dispatchId)).toEqual(f.record);
	});

	it('never takes an active admission lock to reclaim an obsolete prepare hash during a terminal write', async () => {
		const f = await payloadFixture();
		f.record.queueRouting!.steps[0].status = 'started';
		delete f.record.queueRouting!.steps[0].terminal;
		f.store.writeDispatchAdmission(f.record);
		f.record.queuePrepare!.phase = 'unknown';
		f.store.writeDispatchAdmission(f.record);
		const terminal = () => {
			f.record.queueRouting!.steps[0].status = 'settled';
			f.record.queueRouting!.steps[0].terminal = { text: 'Authentic terminal output' };
			f.store.writeDispatchAdmission(f.record);
		};
		const unlink = fs.promises.unlink.bind(fs.promises);
		vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
			terminal(); // Original regression: synchronous host write while cleanup owns the lock.
			await unlink(file);
		});
		const writes = vi.spyOn(fs, 'writeFileSync');
		const artifacts = fs.readdirSync(f.dir).filter((name) => name.endsWith('.artifact.json'));
		const reads = vi.spyOn(fs, 'readFileSync');
		await f.store.compactDispatchArtifacts();
		expect(writes.mock.calls.some(([file]) => String(file).endsWith('.lock'))).toBe(false);
		expect(
			reads.mock.calls.filter(([file]) => String(file).endsWith('.artifact.json'))
		).toHaveLength(0);
		expect(fs.readdirSync(f.dir).filter((name) => name.endsWith('.artifact.json'))).toEqual(
			artifacts
		);
		terminal();
		expect(f.store.readDispatchAdmission(dispatchId)!.queueRouting!.steps[0].terminal?.text).toBe(
			'Authentic terminal output'
		);
	});

	it('reads completed historical payloads asynchronously and keeps a hash reused during selection', async () => {
		const f = await payloadFixture();
		f.record.queueRouting!.completed = true;
		f.store.writeDispatchAdmission(f.record);
		const original = structuredClone(f.record);
		f.record.queuePrepare!.phase = 'unknown';
		f.store.writeDispatchAdmission(f.record);
		const read = fs.promises.readFile.bind(fs.promises);
		let reused = false;
		vi.spyOn(fs.promises, 'readFile').mockImplementation(
			async (...args: Parameters<typeof fs.promises.readFile>) => {
				const result = await read(...args);
				if (!reused && String(args[0]).endsWith('.artifact.json')) {
					reused = true;
					f.store.writeDispatchAdmission(original);
				}
				return result;
			}
		);
		await f.store.compactDispatchArtifacts();
		expect(reused).toBe(true);
		expect(f.store.readDispatchAdmission(dispatchId)).toEqual(original);
		vi.restoreAllMocks();
		const syncReads = vi.spyOn(fs, 'readFileSync');
		const asyncReads = vi.spyOn(fs.promises, 'readFile');
		await f.store.compactDispatchArtifacts();
		expect(
			syncReads.mock.calls.filter(([file]) => String(file).endsWith('.artifact.json'))
		).toHaveLength(0);
		expect(
			asyncReads.mock.calls.filter(([file]) => String(file).endsWith('.artifact.json'))
		).toHaveLength(3);
	});

	it('revalidates a new journal consumer before reclaiming old orphan artifacts', async () => {
		const f = await payloadFixture();
		fs.rmSync(f.journal);
		for (const name of fs.readdirSync(f.dir).filter((n) => n.endsWith('.artifact.json')))
			fs.utimesSync(path.join(f.dir, name), new Date(1), new Date(1));
		const lstat = fs.promises.lstat.bind(fs.promises);
		let restored = false;
		vi.spyOn(fs.promises, 'lstat').mockImplementation(
			async (...args: Parameters<typeof fs.promises.lstat>) => {
				try {
					return await lstat(...args);
				} catch (error) {
					if (!restored && String(args[0]) === f.journal) {
						restored = true;
						f.store.writeDispatchAdmission(f.record);
					}
					throw error;
				}
			}
		);
		await f.store.compactDispatchArtifacts();
		expect(restored).toBe(true);
		expect(f.store.readDispatchAdmission(dispatchId)).toEqual(f.record);
	});

	it.each(
		['unchanged', 'new-consumer', 'journal-change', 'directory-change', 'second-compactor'].flatMap(
			(change) => ['obsolete-first', 'mixed'].map((order) => ({ change, order }))
		)
	)(
		'bounds metadata batches and revalidates $change between unlocked event-loop turns ($order)',
		async ({ change, order }) => {
			const f = await payloadFixture();
			f.record.queueRouting!.completed = true;
			f.store.writeDispatchAdmission(f.record);
			if (change === 'new-consumer') fs.rmSync(f.journal);
			let dir = f.dir;
			const store = createPianolaFsStore({
				resolveDir: () => dir,
				indent: 2,
				trailingNewline: true,
			});
			const obsolete = Array.from({ length: 80 }, (_, i) => {
				const file = path.join(
					f.dir,
					`maestro-pianola-dispatch-${dispatchId}-${i.toString(16).padStart(64, '0')}.artifact.json`
				);
				fs.writeFileSync(file, 'obsolete');
				fs.utimesSync(file, new Date(1), new Date(1));
				return file;
			});
			// The budget counts examined names, including referenced or young files.
			// Replay real directory entries in two legal orders, independent of filesystem order.
			const referenced = fs
				.readdirSync(f.dir)
				.filter(
					(name) => name.endsWith('.artifact.json') && !obsolete.includes(path.join(f.dir, name))
				);
			expect(referenced).toHaveLength(3);
			const obsoleteNames = obsolete.map((file) => path.basename(file));
			const enumeration =
				order === 'mixed'
					? [...referenced.slice(0, 2), ...obsoleteNames, ...referenced.slice(2)]
					: [...obsoleteNames, ...referenced];
			const expectedFirstBatch = enumeration
				.slice(0, 16)
				.map((name) => path.join(f.dir, name))
				.filter((file) => obsolete.includes(file));
			expect(expectedFirstBatch).toHaveLength(order === 'mixed' ? 14 : 16);
			const rank = new Map(enumeration.map((name, index) => [name, index]));
			const opendir = fs.promises.opendir.bind(fs.promises);
			vi.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
				const directory = await opendir(...args);
				const entries: fs.Dirent[] = [];
				for await (const entry of directory) entries.push(entry);
				entries.sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity));
				return Object.assign(directory, {
					async *[Symbol.asyncIterator]() {
						yield* entries;
					},
				});
			});
			const unlink = fs.unlinkSync;
			const remove = fs.rmSync;
			let inTurn = 0;
			const turns: number[] = [];
			let progressed = false;
			let atYield: { locked: boolean; deleted: string[] } | undefined;
			let progress: Promise<void> | undefined;
			let otherCompaction: Promise<void> | undefined;
			vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
				if (String(file) === f.journal + '.lock') {
					turns.push(inTurn);
					inTurn = 0;
				}
				return remove(file, options);
			});
			vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
				if (String(file).endsWith('.artifact.json')) {
					inTurn++;
					if (!progress) {
						progress = yieldToEventLoop().then(() => {
							progressed = true;
							atYield = {
								locked: fs.existsSync(f.journal + '.lock'),
								deleted: obsolete.filter((name) => !fs.existsSync(name)),
							};
							if (change === 'new-consumer' || change === 'journal-change') {
								delete f.record.queueRouting!.completed;
								f.store.writeDispatchAdmission(f.record);
							}
							if (change === 'directory-change') dir = path.join(f.dir, 'moved');
							if (change === 'second-compactor')
								otherCompaction = f.store.compactDispatchArtifacts();
						});
					}
				}
				return unlink(file);
			});
			await store.compactDispatchArtifacts();
			await progress;
			await otherCompaction;
			expect(progressed).toBe(true);
			expect(atYield).toEqual({ locked: false, deleted: expectedFirstBatch });
			expect(Math.max(...turns)).toBeLessThanOrEqual(16);
			const deleted = obsolete.filter((name) => !fs.existsSync(name));
			expect(deleted).toEqual(
				['unchanged', 'second-compactor'].includes(change) ? obsolete : expectedFirstBatch
			);
			for (const name of referenced) expect(fs.existsSync(path.join(f.dir, name))).toBe(true);
			if (change !== 'directory-change')
				expect(f.store.readDispatchAdmission(dispatchId)).toEqual(f.record);
		}
	);

	it('keeps current references after a failed obsolete-file removal and retries safely', async () => {
		const f = await payloadFixture();
		f.record.queueRouting!.completed = true;
		f.store.writeDispatchAdmission(f.record);
		f.record.queuePrepare!.phase = 'unknown';
		f.store.writeDispatchAdmission(f.record);
		const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
			throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
		});
		await expect(f.store.compactDispatchArtifacts()).rejects.toThrow('EACCES');
		expect(f.store.readDispatchAdmission(dispatchId)).toEqual(f.record);
		unlink.mockRestore();
		await f.store.compactDispatchArtifacts();
		expect(f.store.readDispatchAdmission(dispatchId)).toEqual(f.record);
		expect(fs.readdirSync(f.dir).filter((n) => n.endsWith('.artifact.json'))).toHaveLength(3);
	});

	it('serializes independent store compactors without dangling references or duplicate deletion errors', async () => {
		const f = await completedFixture(34);
		for (const record of f.records.slice(0, 2)) {
			for (let i = 0; i < 80; i++) {
				fs.writeFileSync(
					path.join(
						f.dir,
						`maestro-pianola-dispatch-${record.dispatchId}-${i.toString(16).padStart(64, '0')}.artifact.json`
					),
					'obsolete'
				);
			}
		}
		const other = createPianolaFsStore({
			resolveDir: () => f.dir,
			indent: 2,
			trailingNewline: true,
		});
		await Promise.all([f.store.compactDispatchArtifacts(), other.compactDispatchArtifacts()]);
		for (const r of f.records) expect(other.readDispatchAdmission(r.dispatchId)).toBeTruthy();
		expect(fs.readdirSync(f.dir).filter((name) => name.endsWith('.artifact.json'))).toHaveLength(
			33 * 3
		);
	});

	it.each([
		'missing',
		'tamper',
		'foreign-reply',
		'generation',
		'run',
		'intent',
		'target',
		'version',
		'length',
		'path',
		'symlink',
	])('refuses %s artifacts without treating them as new admissions', async (fault) => {
		const f = await payloadFixture();
		const disk = f.disk();
		const [a, b] = disk.queueRouting.steps;
		const ref = disk.payloads.terminals[a.requestId];
		const file = f.artifact(ref);
		if (fault === 'missing') fs.rmSync(file);
		if (fault === 'tamper')
			fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('BEGIN-0', 'OTHER-0'));
		if (fault === 'foreign-reply')
			disk.payloads.terminals[a.requestId] = disk.payloads.terminals[b.requestId];
		if (fault === 'generation')
			disk.queueRelease.generation = '77777777-7777-4777-8777-777777777777';
		if (fault === 'run') a.runId = 'foreign-run';
		if (fault === 'intent') disk.intentFingerprint = 'd'.repeat(64);
		if (fault === 'target') a.targetAgentId = 'peer-b';
		if (fault === 'version') ref.version = 2;
		if (fault === 'length') ref.bytes++;
		if (fault === 'path') ref.sha256 = '../foreign';
		if (fault === 'symlink') {
			fs.rmSync(file);
			const target = f.artifact(disk.payloads.terminals[b.requestId]);
			// A directory junction needs no Windows symlink privilege and still
			// exercises the native reparse-point/non-file rejection at this boundary.
			fs.symlinkSync(
				process.platform === 'win32' ? path.dirname(target) : target,
				file,
				process.platform === 'win32' ? 'junction' : 'file'
			);
		}
		fs.writeFileSync(f.journal, JSON.stringify(disk));
		expect(() => f.store.readDispatchAdmission(dispatchId)).toThrow();
	});

	it.each(['artifact-enospc', 'artifact-ack', 'journal-ack'])(
		'preserves durable evidence and write-before-reference on %s',
		async (fault) => {
			const f = await payloadFixture();
			const before = f.store.readDispatchAdmission(dispatchId);
			f.record.queueRouting!.steps[0].terminal!.text = 'NEW-BEGIN' + 'z'.repeat(20000) + 'NEW-END';
			const rename = fs.renameSync;
			vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
				const artifact = String(to).endsWith('.artifact.json');
				if (!artifact) {
					const pending = JSON.parse(fs.readFileSync(from, 'utf8'));
					for (const ref of Object.values(pending.payloads.terminals) as { sha256: string }[])
						expect(fs.existsSync(f.artifact(ref))).toBe(true);
				}
				if (artifact && fault === 'artifact-enospc')
					throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
				rename(from, to);
				if ((artifact && fault === 'artifact-ack') || (!artifact && fault === 'journal-ack'))
					throw new Error('Write acknowledgement lost');
			});
			expect(() => f.store.writeDispatchAdmission(f.record)).toThrow();
			expect(f.store.readDispatchAdmission(dispatchId)).toEqual(
				fault === 'journal-ack' ? f.record : before
			);
			vi.restoreAllMocks();
			await f.store.compactDispatchArtifacts();
			expect(fs.readdirSync(f.dir).filter((name) => name.endsWith('.artifact.json'))).toHaveLength(
				fault === 'artifact-enospc' ? 3 : 4
			);
		}
	);

	it.each(['new-tab', 'existing-tab', 'queue'] as const)(
		'requires fresh owner policy for %s and never adopts old tasks',
		async (placement) => {
			const f = fixture();
			f.snapshot.owners.push({ ...f.snapshot.owners[0], id: 'manager', isPianola: true });
			f.deps.ruleSetRevision = () =>
				createHash('sha256').update(canonicalJson(f.store.readRules())).digest('hex');
			const configure = (owner: boolean) =>
				configurePianolaScope(f.scope, {
					store: f.store,
					snapshot: () => f.snapshot,
					canFence: () => true,
					featureEnabled: () => true,
					ownerAuthorized: () => owner,
					readRules: () => f.store.readRulesResult(),
				});
			expect((await configure(true)).status).toBe('registered');
			const originalPolicy = f.store.readSupervisorTargets()[0].delegationPolicy!;
			const oldRequest = { ...f.request, intent: { prompt: 'Implement the task', placement } };
			await f.service.prepare(f.client, oldRequest);
			await f.service.bind(
				f.client,
				dispatchId,
				'target',
				placement === 'queue' ? 'row' : undefined
			);
			const oldQueue =
				placement === 'queue'
					? await f.service.prepareQueue(f.client, dispatchId, {
							id: 'row',
							timestamp: 100,
							type: 'message',
							text: 'Implement the task',
							tabId: 'target',
							pendingAdmissionId: dispatchId,
						})
					: undefined;
			if (placement !== 'queue') await f.service.enroll(f.client, dispatchId);
			f.store.writeRules([
				{
					id: 'naming',
					enabled: true,
					scope: 'global',
					match: { kinds: ['question'], maxRisk: 'low' },
					action: 'auto_answer',
					answer: 'Use count.',
					priority: 1,
					createdAt: 1,
					updatedAt: 2,
				},
			]);
			const freshId = '33333333-3333-4333-8333-333333333333';
			const freshRequest = { ...oldRequest, dispatchId: freshId };
			await expect(f.service.prepare(f.client, freshRequest)).rejects.toThrow(
				'PianolaPolicyChanged'
			);
			// Outcome-only handles can finish readback across rule changes, never renew authority.
			if (oldQueue) await oldQueue.recordEvidence(true);
			expect((await configure(false)).status).toBe('NeedsConfiguration');
			expect(f.store.readSupervisorTargets()[0].delegationPolicy).toEqual(originalPolicy);
			expect((await configure(true)).status).toBe('registered');
			expect(f.store.readSupervisorTargets()[0].delegationPolicy).toMatchObject({
				revision: originalPolicy.revision + 1,
				ruleSetRevision: f.deps.ruleSetRevision(),
			});
			f.deps.queueSnapshot = () => f.snapshot;
			f.deps.releaseQueueItem = vi.fn(async (_request, commit) => commit(() => {}));
			if (placement === 'queue')
				await expect(f.service.releaseQueue(dispatchId)).rejects.toThrow('PianolaPolicyChanged');
			else
				await expect(f.service.release(f.client, dispatchId)).rejects.toThrow(
					'PianolaPolicyChanged'
				);
			expect(f.release).not.toHaveBeenCalled();
			expect(f.deps.releaseQueueItem).not.toHaveBeenCalled();
			const oldRecord = f.store.readDispatchAdmission(dispatchId);
			await f.service.prepare(f.client, freshRequest);
			await f.service.bind(
				f.client,
				freshId,
				'target',
				placement === 'queue' ? 'fresh-row' : undefined
			);
			if (placement === 'queue') {
				const prepared = await f.service.prepareQueue(f.client, freshId, {
					id: 'fresh-row',
					timestamp: 100,
					type: 'message',
					text: 'Implement the task',
					tabId: 'target',
					pendingAdmissionId: freshId,
				});
				await prepared.recordEvidence(true);
				await f.service.releaseQueue(freshId);
				expect(f.deps.releaseQueueItem).toHaveBeenCalledOnce();
			} else {
				await f.service.enroll(f.client, freshId);
				expect(await f.service.release(f.client, freshId)).toMatchObject({ outcome: 'accepted' });
				expect(f.release).toHaveBeenCalledOnce();
			}
			expect(f.store.readDispatchAdmission(dispatchId)).toEqual(oldRecord);
		}
	);

	it('preserves the native empty-creation barrier in pre-start dispatch enrollment', async () => {
		const f = fixture();
		const native = new NativeCurrentTurns();
		native.commit({
			sessionId: 'worker',
			tabId: 'target',
			field: 'logs',
			snapshot: true,
			upserts: [],
			removedIds: [],
			orderIds: [],
			runtime: { state: 'idle' },
			observation: {
				sourceGeneration: 'creator',
				sequence: 1,
				createdAt: 90,
				provider: 'codex',
				emptyCreation: true,
			},
		});
		const read = native.read({
			agentId: 'worker',
			tabId: 'target',
			createdAt: 90,
			provider: 'codex',
			agentSessionId: null,
			open: true,
		});
		expect(read.status).toBe('empty-enrollment');
		f.snapshot.tabs[0].enrollment = read.enrollment;
		await f.enroll();
		expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0]).toMatchObject({
			baseline: null,
			emptyEnrollment: read.enrollment,
		});
	});

	it('persists enrollment before release and observes a fast first question through the real scope cycle', async () => {
		const f = fixture();
		await f.enroll();
		const question = {
			id: 'first-question',
			role: 'assistant' as const,
			source: 'ai' as const,
			timestamp: '2026-11-04T00:00:00.000Z',
			content: 'Should I name it count or total?',
		};
		f.release.mockImplementation(async (_receipt, guard) => {
			guard();
			expect(f.store.readDispatchAdmission(dispatchId)?.outcome).toBe('unknown');
			expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].baseline).toBeNull();
			f.snapshot.capturedAt++;
			f.snapshot.tabs[0].cursor = {
				id: question.id,
				count: 1,
				textLength: question.content.length,
			};
			await runPianolaScopeCycle(
				scopeId,
				{
					store: f.store,
					readSnapshot: async () => f.snapshot,
					readTranscript: async () => ({
						agentId: 'worker',
						tabId: 'target',
						messages: [question],
					}),
					watch: {
						readRules: () => [],
						recordDecision: (r) => f.store.appendDecision(r),
						now: () => question.timestamp,
						genId: () => 'decision-1',
						log: vi.fn(),
						notify: vi.fn(),
					},
					dispatch: async () => ({ status: 'accepted' }),
				},
				{ dryRun: false }
			);
			expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].baseline).toBeNull();
			expect(f.store.readDecisions().some((r) => r.tabId === 'target')).toBe(true);
			return 'accepted';
		});
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({
			outcome: 'accepted',
			supervision: 'enrolled',
		});
	});

	it('serializes duplicate IDs, rejects changed intent/target, and never sends twice', async () => {
		const f = fixture();
		await Promise.all([
			f.service.prepare(f.client, f.request),
			f.service.prepare(f.client, f.request),
		]);
		await expect(
			f.service.prepare(f.client, { ...f.request, intent: 'different' })
		).rejects.toThrow('IntentMismatch');
		await f.service.bind(f.client, dispatchId, 'target');
		await expect(f.service.bind(f.client, dispatchId, 'other')).rejects.toThrow('TargetMismatch');
		await f.service.enroll(f.client, dispatchId);
		await Promise.all([
			f.service.release(f.client, dispatchId),
			f.service.release(f.client, dispatchId),
		]);
		expect(f.release).toHaveBeenCalledOnce();
		expect(f.service.status(f.client, dispatchId)).not.toHaveProperty('caller');
		expect(f.service.status(f.client, dispatchId)).not.toHaveProperty('intentFingerprint');
	});

	it.each([
		'current-baseline',
		'paused',
		'revoked',
		'feature-off',
		'suspended',
		'disk-full',
	] as const)(
		'yields behind a native checkpoint lock and revalidates %s before enrollment',
		async (change) => {
			const f = fixture();
			await f.service.prepare(f.client, f.request);
			await f.service.bind(f.client, dispatchId, 'target');
			const file = path.join(f.dir, `maestro-pianola-scope-${scopeId}.json`);
			const child = spawn(
				process.execPath,
				[
					'-e',
					`
				const fs = require('fs'); const file = process.argv[1];
				fs.writeFileSync(file + '.lock', process.pid + '.held', { flag: 'wx' });
				process.stdout.write('ready');
				process.stdin.once('data', (data) => {
					const value = JSON.parse(data.toString());
					if (value) fs.writeFileSync(file, JSON.stringify(value));
					fs.unlinkSync(file + '.lock'); process.exit(0);
				});
			`,
					file,
				],
				{ stdio: ['pipe', 'pipe', 'pipe'] }
			);
			try {
				await once(child.stdout, 'data');
				const wait = vi.spyOn(Atomics, 'wait');
				let settled = false;
				const pending = f.service.enroll(f.client, dispatchId);
				void pending.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					}
				);
				await new Promise<void>((resolve) => setTimeout(resolve, 30));
				expect(settled).toBe(false);
				expect(wait).not.toHaveBeenCalled();
				expect(f.store.readScopeCheckpoint(scopeId)).toBeNull();
				expect(f.store.readDispatchAdmission(dispatchId)?.phase).toBe('bound');
				expect(f.release).not.toHaveBeenCalled();
				f.snapshot.tabs[0].cursor = { id: 'after-wait', count: 1, textLength: 17 };
				if (change === 'paused') f.snapshot.tabs[0].busy = true;
				if (change === 'revoked') f.controller.abort();
				if (change === 'feature-off') f.deps.featureEnabled = () => false;
				if (change === 'disk-full') {
					vi.spyOn(fs, 'renameSync').mockImplementation(() => {
						throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
					});
				}
				const exited = once(child, 'exit');
				child.stdin.write(
					JSON.stringify(
						change === 'suspended'
							? {
									version: 1,
									scopeId,
									configurationFingerprint: 'a'.repeat(64),
									activatedAt: 100,
									status: 'suspended',
									tabs: [],
									enrollmentRevision: 2,
								}
							: null
					)
				);
				await exited;
				if (change === 'current-baseline') {
					await pending;
					expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].baseline?.id).toBe('after-wait');
					expect(f.store.readDispatchAdmission(dispatchId)?.phase).toBe('enrolled');
				} else {
					await expect(pending).rejects.toThrow();
					expect(f.store.readDispatchAdmission(dispatchId)?.phase).toBe('bound');
				}
				expect(f.release).not.toHaveBeenCalled();
				expect(wait).not.toHaveBeenCalled();
			} finally {
				if (child.exitCode === null) {
					child.kill();
					await once(child, 'exit');
				}
			}
		}
	);

	it('does not release after checkpoint persistence failure', async () => {
		const f = fixture();
		await f.service.prepare(f.client, f.request);
		await f.service.bind(f.client, dispatchId, 'target');
		vi.spyOn(f.store, 'withScopeCheckpointLockAsync').mockImplementation(() => {
			throw new Error('Disk full');
		});
		await expect(f.service.enroll(f.client, dispatchId)).rejects.toThrow('Disk full');
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('NotEnrolled');
		expect(f.release).not.toHaveBeenCalled();
	});

	it('does not release after the durable release-intent write fails', async () => {
		const f = fixture();
		await f.enroll();
		vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation(() => {
			throw new Error('Disk full');
		});
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Disk full');
		expect(f.release).not.toHaveBeenCalled();
	});

	it('keeps a durable unknown intent when storing the accepted outcome fails', async () => {
		const f = fixture();
		await f.enroll();
		const write = f.store.writeDispatchAdmission.bind(f.store);
		vi.spyOn(f.store, 'writeDispatchAdmission').mockImplementation((record) => {
			if (record.phase === 'settled') throw new Error('Outcome disk failure');
			write(record);
		});
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Outcome disk failure');
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({ outcome: 'unknown' });
		expect(f.release).toHaveBeenCalledOnce();
	});

	it.each(['accepted', 'unknown', 'queued'] as const)(
		'never retries %s after recreating the service',
		async (outcome) => {
			const f = fixture();
			await f.enroll();
			f.release.mockResolvedValue(outcome);
			await f.service.release(f.client, dispatchId);
			const restarted = new PianolaDispatchAdmissionService(f.deps);
			expect(await restarted.release(f.client, dispatchId)).toMatchObject({ outcome });
			expect(f.release).toHaveBeenCalledOnce();
		}
	);

	it('retains unknown on lost ack, then reconciles exact run without another send', async () => {
		const f = fixture();
		await f.enroll();
		f.release.mockRejectedValue(new Error('Ack lost'));
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Ack lost');
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({ outcome: 'unknown' });
		expect(await f.service.reconcile(dispatchId, 'accepted', 'actual-run')).toMatchObject({
			runId: 'actual-run',
		});
		await expect(f.service.reconcile(dispatchId, 'accepted', 'foreign-run')).rejects.toThrow(
			'RunMismatch'
		);
		await expect(f.service.reconcile(dispatchId, 'rejected')).rejects.toThrow('OutcomeConflict');
		expect(f.release).toHaveBeenCalledOnce();
	});

	it.each(['off', 'pause', 'excluded', 'manager', 'rules', 'policy'] as const)(
		'rechecks %s before releasing',
		async (change) => {
			const f = fixture();
			await f.enroll();
			if (change === 'off') f.deps.featureEnabled = () => false;
			if (change === 'pause') f.snapshot.tabs[0].paused = true;
			if (change === 'excluded') f.scope.selection!.excludedAgentIds.push('worker');
			if (change === 'manager') f.scope.managerAgentId = 'other-manager';
			if (change === 'rules') f.deps.ruleSetRevision = () => 'rules-2';
			if (change === 'policy')
				f.scope.delegationPolicy = {
					version: 1,
					revision: 2,
					enabled: false,
					managerAgentId: 'manager',
					coverage: 'selected-agents',
					ruleSetRevision: 'rules-1',
				};
			f.store.writeSupervisorTargets([f.scope]);
			await expect(f.service.release(f.client, dispatchId)).rejects.toThrow();
			expect(f.release).not.toHaveBeenCalled();
		}
	);

	it('fences a pause at the actual delayed transport boundary and never retries it', async () => {
		const f = fixture();
		await f.enroll();
		f.release.mockImplementation(async (_receipt, guard) => {
			f.snapshot.tabs[0].paused = true;
			guard();
			return 'accepted';
		});
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('NativeTargetPaused');
		expect(await f.service.release(f.client, dispatchId)).toMatchObject({ outcome: 'unknown' });
		expect(f.release).toHaveBeenCalledOnce();
	});

	it('rejects unbound clients and revoked callers', async () => {
		const f = fixture();
		await expect(f.service.prepare({ cliAuthenticated: true }, f.request)).rejects.toThrow(
			'CallerRunUnavailable'
		);
		await f.enroll();
		f.controller.abort();
		await expect(f.service.release(f.client, dispatchId)).rejects.toThrow('Revoked');
		expect(f.release).not.toHaveBeenCalled();
	});

	it('preserves pre-start enrollment when an older worker census writes its checkpoint', async () => {
		const f = fixture();
		await f.enroll();
		const stale = f.store.readScopeCheckpoint(scopeId)!;
		stale.tabs = [];
		f.store.writeScopeCheckpoint(stale);
		expect(f.store.readScopeCheckpoint(scopeId)?.tabs[0].dispatchEnrollmentId).toBe(dispatchId);
	});

	it('fails closed for corrupt disk records and unknown policy versions', async () => {
		const f = fixture();
		await f.enroll();
		const record = f.store.readDispatchAdmission(dispatchId)!;
		expect(
			validatePianolaDispatchAdmission({ ...record, phase: 'released', outcome: 'not-started' })
		).toBeNull();
		expect(
			validatePianolaSupervisedTarget({ ...f.scope, delegationPolicy: { version: 99 } })
		).toBeNull();
		fs.writeFileSync(path.join(f.dir, `maestro-pianola-dispatch-${dispatchId}.json`), '{broken');
		await expect(f.service.prepare(f.client, f.request)).rejects.toThrow();
		expect(f.release).not.toHaveBeenCalled();
	});
});
