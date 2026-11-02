import { nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';
import { vi, afterEach, beforeEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CueReceiptLedger } from '../../../main/cue/cue-receipt-ledger';
import { cuePhysicalTable } from '../../../main/cue/cue-receipt-schema';
import * as cue from '../../../main/cue/cue-db';
import { fakeAnchor } from '../../helpers/mockAnchor';
import { AuthorizationStore } from '../../../main/plugins/authorization-ledger';
import { canonicalJson } from '../../../shared/canonicalJson';
import { createHash } from 'node:crypto';
import { receiptWorkerFixture } from '../../helpers/receiptWorkerFixture';
import { CueReceiptStore } from '../../../main/cue/cue-receipt-store';
import { PluginCueEvents } from '../../../main/plugins/plugin-cue-events';
import { PluginToolRunIdentity } from '../../../main/plugins/plugin-tool-run-identity';
import { configurePluginCueHost } from '../../../main/cue/triggers/cue-plugin-trigger-source';
import { createCueRunManager, type CueRunManagerDeps } from '../../../main/cue/cue-run-manager';
import { createCueQueuePersistence } from '../../../main/cue/cue-queue-persistence';
import type { PluginCueReceiptStore } from '../../../main/cue/cue-receipt-store';
import type { CueEvent } from '../../../shared/cue/contracts';
import type { CueTriggerSourceContext } from '../../../main/cue/triggers/cue-trigger-source';
vi.mock('../../../main/utils/sentry', () => ({ captureException() {} }));
const plugin = 'com.example.cue';
const identity = {
	contentHash: 'a'.repeat(64),
	signatureStatus: 'trusted' as const,
	signerKey: 'publisher',
};
let dir: string;
let file: string;
let anchor: ReturnType<typeof fakeAnchor>;
let store: CueReceiptLedger;
let auth: AuthorizationStore;
let authAnchor: ReturnType<typeof fakeAnchor>;
beforeEach(() => {
	fs.mkdirSync('.maestro/scratch', { recursive: true });
	dir = fs.mkdtempSync(path.resolve('.maestro/scratch/cue-receipt-'));
	file = path.join(dir, 'cue.db');
	anchor = fakeAnchor({ value: null });
	authAnchor = fakeAnchor({ value: null });
	auth = new AuthorizationStore({
		ledgerPath: path.join(dir, 'auth.sealed'),
		seal: {
			available: () => true,
			seal: (text) => Buffer.from(text),
			unseal: (bytes) => bytes.toString(),
		},
		anchor: authAnchor,
	});
	auth.mint(plugin, [], identity);
	cue.initCueDb(undefined, file);
	cue.pluginEventReceiptCapacityAvailable(plugin);
	store = new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor);
});
afterEach(() => {
	configurePluginCueHost(undefined);
	cue.closeCueDb();
	fs.rmSync(dir, { recursive: true, force: true });
});
const row = (id = 'b'.repeat(64)) => ({
	receiptId: id,
	payloadHash: 'c'.repeat(64),
	proof: 'd'.repeat(64),
});
const baseline = () => ({ rows: [], coverage: 'retained-authenticated-only' as const });
function admitted(key = 'event') {
	store.reserve(plugin, key, row(), 'attempt');
	store.dispatch(plugin, key, 'attempt');
	store.accepted(plugin, key, 'attempt');
}
describe('independent future Cue receipt completeness', () => {
	it('keeps the exact authorization unchanged and fences a pre-receipt cue.db snapshot', () => {
		cue.closeCueDb();
		const snapshot = fs.readFileSync(file);
		cue.initCueDb(undefined, file);
		const before = canonicalJson(authAnchor.read());
		store.prepare(plugin, baseline());
		admitted();
		expect(store.claim(plugin, 'event', row().receiptId, 'first-host', 'run1')).toBe(true);
		store.settle(plugin, 'event', row().receiptId, 'first-host', 'run1', true);
		cue.closeCueDb();
		fs.writeFileSync(file, snapshot);
		cue.initCueDb(undefined, file);
		const reopened = new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor);
		expect(reopened.read(plugin, 'event')?.receipt).toEqual(row());
		expect(reopened.claim(plugin, 'event', row().receiptId, 'restarted-host', 'new-run')).toBe(
			false
		);
		expect(canonicalJson(authAnchor.read())).toBe(before);
		auth.assertPluginPersistent(plugin, identity);
	});
	it('survives omission from both old tables and refuses missing backing schema', () => {
		store.prepare(plugin, baseline());
		admitted();
		const db = new Database(file);
		for (const name of ['cue_plugin_receipts', 'cue_plugin_legacy_receipts'] as const)
			db.prepare(`DELETE FROM ${cuePhysicalTable(db, name)}`).run();
		db.close();
		expect(store.read(plugin, 'event')?.receipt).toEqual(row());
		const broken = new Database(file);
		broken.exec('DROP TABLE cue_plugin_receipts_receipt_v1');
		broken.close();
		expect(() => store.read(plugin, 'new')).toThrow(/backing table missing/);
	});
	it('refuses rollback/deletion/row omission of the independently authenticated store', () => {
		store.prepare(plugin, baseline());
		const snapshot = fs.readFileSync(path.join(dir, 'receipts/receipts.sqlite'));
		admitted();
		fs.writeFileSync(path.join(dir, 'receipts/receipts.sqlite'), snapshot);
		expect(() => store.read(plugin, 'event')).toThrow(/rollback/);
	});
	it('keeps orphaned execution fences without retaining a physical outcome reservation', () => {
		store.prepare(plugin, baseline());
		admitted();
		store.claim(plugin, 'event', row().receiptId, 'dead-host', 'run1');
		const restarted = new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor);
		expect(restarted.read(plugin, 'event')).toMatchObject({
			outcomeReservation: false,
			execution: { owner: 'dead-host', runId: 'run1' },
		});
		expect(restarted.claim(plugin, 'event', row().receiptId, 'new-host', 'run2')).toBe(false);
		const db = new Database(path.join(dir, 'receipts/receipts.sqlite'));
		expect(
			JSON.parse(
				(
					db.prepare('SELECT value FROM entries WHERE key=?').get('system:counts') as {
						value: string;
					}
				).value
			).inflight
		).toBe(0);
		db.close();
	});
	it('uses an event claim across new run IDs and independent host instances', () => {
		store.prepare(plugin, baseline());
		admitted();
		expect(store.claim(plugin, 'event', row().receiptId, 'one', 'run1')).toBe(true);
		const other = new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor);
		expect(other.claim(plugin, 'event', row().receiptId, 'two', 'run2')).toBe(false);
		expect(other.claim(plugin, 'event', row().receiptId, 'one', 'run1')).toBe(true);
		expect(other.claim(plugin, 'event', 'e'.repeat(64), 'one', 'run1')).toBe(false);
	});
	it('releases a proven nonstart but an old restored queue cannot claim the replacement admission', () => {
		store.prepare(plugin, baseline());
		admitted();
		store.claim(plugin, 'event', row().receiptId, 'one', 'run1');
		store.settle(plugin, 'event', row().receiptId, 'one', 'run1', false);
		expect(store.read(plugin, 'event')).toBeNull();
		store.reserve(plugin, 'event', row('e'.repeat(64)), 'new-attempt');
		store.dispatch(plugin, 'event', 'new-attempt');
		store.accepted(plugin, 'event', 'new-attempt');
		expect(store.claim(plugin, 'event', row().receiptId, 'one', 'restored-old-queue')).toBe(false);
		expect(store.claim(plugin, 'event', 'e'.repeat(64), 'one', 'new-run')).toBe(true);
	});
	it('retains claimed uncertainty on restart and rejects unproven cancellation', () => {
		store.prepare(plugin, baseline());
		admitted();
		store.claim(plugin, 'event', row().receiptId, 'dead-host', 'run1');
		expect(() => store.cancelPublish(plugin, 'event', 'attempt')).toThrow(/uncertain/);
		expect(() => store.settle(plugin, 'event', row().receiptId, 'new-host', 'run1', false)).toThrow(
			/owner changed/
		);
		expect(
			new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor).claim(
				plugin,
				'event',
				row().receiptId,
				'new-host',
				'run2'
			)
		).toBe(false);
	});
	it('counts each event once across claim/settle and leaves duplicates readable at capacity', () => {
		store = new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor, {
			messages: 2,
			ownerMessages: 1,
		});
		store.prepare(plugin, baseline());
		admitted();
		store.claim(plugin, 'event', row().receiptId, 'one', 'run1');
		store.settle(plugin, 'event', row().receiptId, 'one', 'run1', true);
		expect(() => store.reserve(plugin, 'second', row(), 'attempt2')).toThrow(/owner capacity/);
		expect(store.read(plugin, 'event')?.receipt).toEqual(row());
		const other = 'com.example.second';
		store.prepare(other, baseline());
		store.reserve(other, 'second', row(), 'attempt2');
		store.dispatch(other, 'second', 'attempt2');
		store.accepted(other, 'second', 'attempt2');
		expect(() => store.reserve(other, 'third', row(), 'attempt3')).toThrow(/capacity/);
	});
	it('blocks old receipt lookup and queue restore even for empty tables and absent keys', () => {
		store.prepare(plugin, baseline());
		const old = new Database(file);
		for (const sql of [
			"SELECT * FROM cue_plugin_receipts WHERE plugin_id='absent'",
			'SELECT * FROM cue_event_queue',
		])
			expect(() => old.prepare(sql).all()).toThrow(/no such function/);
		old.close();
		cue.closeCueDb();
		cue.initCueDb(undefined, file);
		expect(cue.getQueuedEvents()).toEqual([]);
	});
	it('imports retained authenticated old receipts as replay-only, preserving original proof and identity', async () => {
		const id = createHash('sha256')
			.update(canonicalJson([plugin, identity, 'consumer', 'event']))
			.digest('hex');
		const receipt = {
			...row(),
			proof: auth.pluginEventProof(
				plugin,
				identity,
				{ id, receiptId: row().receiptId },
				{ payloadHash: row().payloadHash }
			),
		};
		cue.writePluginEventReceipt(plugin, id, receipt);
		const snapshot = await cue.authenticatedPluginReceiptBaseline(plugin, auth);
		expect(snapshot.coverage).toBe('retained-authenticated-only');
		expect(snapshot.rows).toHaveLength(1);
		store.prepare(plugin, snapshot);
		const imported = store.historical(plugin, ['legacy:' + id]);
		expect(imported).toHaveLength(1);
		expect((imported[0].value as { receipt: unknown }).receipt).toEqual(receipt);
		expect(store.claim(plugin, 'legacy:' + id, receipt.receiptId, 'new-host', 'new-run')).toBe(
			false
		);
	});
	it('refuses unknown historical identity without inventing a legacy baseline', async () => {
		cue.writePluginEventReceipt(plugin, 'f'.repeat(64), row());
		await expect(cue.authenticatedPluginReceiptBaseline(plugin, auth)).rejects.toThrow(
			expect.objectContaining({ code: 'PLUGIN_UNAVAILABLE' })
		);
		expect(store.transitionState(plugin)).toBeNull();
	});
	it('verifies a full retained baseline cooperatively with bounded native anchor reads and no authority mutation', async () => {
		const db = new Database(file);
		const insert = db.prepare('INSERT INTO cue_plugin_receipts VALUES(?,?,?,?,?)');
		db.transaction(() => {
			for (let i = 0; i < 4096; i++) {
				const id = createHash('sha256').update(String(i)).digest('hex');
				const receipt = row();
				receipt.proof = auth.pluginEventProof(
					plugin,
					identity,
					{ id, receiptId: receipt.receiptId },
					{ payloadHash: receipt.payloadHash }
				);
				insert.run(plugin, id, receipt.receiptId, receipt.payloadHash, receipt.proof);
			}
		})();
		db.close();
		const before = canonicalJson(authAnchor.read()),
			sealed = fs.readFileSync(path.join(dir, 'auth.sealed'));
		const reads = vi.spyOn(authAnchor, 'read');
		let turns = 0,
			active = true;
		const heartbeat = () => {
			if (active) {
				turns++;
				setImmediate(heartbeat);
			}
		};
		setImmediate(heartbeat);
		try {
			const result = await cue.authenticatedPluginReceiptBaseline(plugin, auth);
			expect(result.rows).toHaveLength(4096);
			expect(reads.mock.calls.length).toBeLessThanOrEqual(270);
			expect(turns).toBeGreaterThanOrEqual(256);
		} finally {
			active = false;
			reads.mockRestore();
		}
		expect(canonicalJson(authAnchor.read())).toBe(before);
		expect(fs.readFileSync(path.join(dir, 'auth.sealed'))).toEqual(sealed);
	});
	it('rejects an authorization epoch change during cooperative evidence verification even if the identity is reminted', async () => {
		const proof = row();
		const id = 'f'.repeat(64);
		proof.proof = auth.pluginEventProof(
			plugin,
			identity,
			{ id, receiptId: proof.receiptId },
			{ payloadHash: proof.payloadHash }
		);
		const pending = auth.authenticatePluginReceiptRows(plugin, identity, [
			{ id, row: proof, purpose: 'event' },
		]);
		auth.mint(plugin, [], identity);
		await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_CONFLICT' });
	});
	it('preserves independent fences through legacy namespace cleanup and restart', async () => {
		store.prepare(plugin, baseline());
		admitted();
		store.claim(plugin, 'event', row().receiptId, 'host', 'run1');
		store.settle(plugin, 'event', row().receiptId, 'host', 'run1', true);
		expect(() => cue.purgePluginEventReceipts(plugin, file)).not.toThrow();
		const restarted = new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor);
		expect(restarted.read(plugin, 'event')?.receipt).toEqual(row());
		expect(restarted.claim(plugin, 'event', row().receiptId, 'new-host', 'run2')).toBe(false);
	});
	it('will not replace a prepared baseline with an omitted-history snapshot', () => {
		const first = {
			rows: [{ key: 'old', row: row() }],
			coverage: 'retained-authenticated-only' as const,
		};
		const write = anchor.write;
		let count = 0;
		anchor.write = (value) => {
			if (++count === 5) throw Error('fixture cutover stop');
			write(value);
		};
		expect(() => store.prepare(plugin, first)).toThrow(/fixture cutover stop/);
		anchor.write = write;
		expect(() =>
			new CueReceiptLedger(path.join(dir, 'receipts'), file, anchor).prepare(plugin, baseline())
		).toThrow(/history changed/);
	});
});

describe('real Cue publisher and durable run-manager execution boundary', () => {
	function pipeline(overrides: Partial<CueRunManagerDeps> = {}) {
		store.prepare(plugin, baseline());
		const invocation = new PluginToolRunIdentity();
		const lifetime = new AbortController();
		let diskValid = true;
		const receipts = new Proxy({} as PluginCueReceiptStore, {
			get(_target, name) {
				if (name === 'historical') return async () => null;
				return async (...args: unknown[]) => Reflect.apply(Reflect.get(store, name), store, args);
			},
		});
		const queue = createCueQueuePersistence({
			onLog() {},
			getSessionTimeoutMs: () => 60_000,
			knownSessionIds: () => new Set(['owner']),
			durableSourceState: () => 'ready',
		});
		const onCueRun = vi.fn<CueRunManagerDeps['onCueRun']>(async (request) => ({
			...request,
			sessionName: 'owner',
			status: 'completed',
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 0,
			startedAt: '',
			endedAt: '',
		}));
		const manager = createCueRunManager({
			getSessions: () => [{ id: 'owner', name: 'owner' }],
			getSessionSettings: () => ({ max_concurrent: 1, queue_size: 10 }),
			onLog() {},
			onCueRun,
			onStopCueRun: () => true,
			queuePersistence: queue,
			...overrides,
		});
		const events = new PluginCueEvents({
			store: auth,
			identity: invocation,
			identityFor: () => identity,
			prepareIdentityFor: async () => {
				if (!diskValid) throw Error('changed file identity');
				return identity;
			},
			generation: () => 'live',
			capture: () => ({
				generation: 'live',
				prepare: async () => {},
				signal: lifetime.signal,
				assertActive() {},
			}),
			assertAllowed() {},
			receipts,
		});
		configurePluginCueHost(events);
		const emitted: CueEvent[] = [];
		const context = {
			session: { id: 'owner' },
			subscription: { name: 'mail', event: 'plugin.event', enabled: true },
			enabled: () => true,
			onLog() {},
			emit(event: CueEvent) {
				emitted.push(event);
				return manager.execute('owner', 'synthetic mail', event, 'mail') === true ? 1 : 0;
			},
		} as unknown as CueTriggerSourceContext;
		events.register(context, { pluginId: plugin, topic: 'mail.received', config: {} });
		const consumerId = events.list(plugin, { topic: 'mail.received' })[0].consumerId;
		const publish = () =>
			events.publish(plugin, {
				invocationId: events.begin(plugin, { consumerId }).invocationId,
				eventId: 'same-message',
				metadata: { synthetic: true },
			});
		return {
			events,
			manager,
			onCueRun,
			emitted,
			publish,
			queue,
			invocation,
			receipts,
			lifetime,
			changeFiles: () => {
				diskValid = false;
			},
		};
	}
	it('never reexecutes a completed event from a restored actual queue snapshot or a publisher replay', async () => {
		const h = pipeline();
		try {
			h.manager.setDraining(true);
			const original = await h.publish();
			expect(cue.getQueuedEvents()).toHaveLength(1);
			cue.closeCueDb();
			const snapshot = fs.readFileSync(file);
			cue.initCueDb(undefined, file);
			h.manager.setDraining(false);
			h.manager.retainQueue('owner', () => null);
			await vi.waitFor(() => expect(h.onCueRun).toHaveBeenCalledTimes(1));
			await h.manager.whenIdle();
			expect(cue.getQueuedEvents()).toHaveLength(0);
			cue.closeCueDb();
			fs.writeFileSync(file, snapshot);
			cue.initCueDb(undefined, file);
			const restarted = pipeline();
			try {
				const restored = restarted.queue.restoreAll()!.get('owner')!;
				expect(restored).toHaveLength(1);
				restarted.manager.execute('owner', restored[0].prompt, restored[0].event, 'mail');
				await restarted.manager.whenIdle();
				expect(restarted.onCueRun).not.toHaveBeenCalled();
				expect(await restarted.publish()).toEqual({ ...original, status: 'duplicate' });
				expect(restarted.emitted).toHaveLength(0);
			} finally {
				restarted.manager.discardInMemory();
				restarted.invocation.stop();
			}
		} finally {
			h.manager.discardInMemory();
			h.invocation.stop();
		}
	});
	it.each([false, true])(
		'releases only a host-proven nonstart, including executionStarted=%s',
		async (started) => {
			const h = pipeline({
				onCueRun: async (request) => ({
					...request,
					sessionName: 'owner',
					status: 'failed',
					stdout: '',
					stderr: 'synthetic nonstart',
					exitCode: 1,
					durationMs: 0,
					startedAt: '',
					endedAt: '',
					executionStarted: started,
				}),
			});
			try {
				const first = await h.publish();
				await h.manager.whenIdle();
				const again = await h.publish();
				await h.manager.whenIdle();
				expect(again.status).toBe(started ? 'duplicate' : 'accepted');
				expect(again.receiptId === first.receiptId).toBe(started);
				expect(h.emitted).toHaveLength(started ? 1 : 2);
			} finally {
				h.manager.discardInMemory();
				h.invocation.stop();
			}
		}
	);
	it('retains uncertainty after an executor exception and denies new host/run claims', async () => {
		const h = pipeline({
			onCueRun: async () => {
				throw Error('unknown after dispatch');
			},
		});
		try {
			await h.publish();
			await h.manager.whenIdle();
			const restarted = pipeline();
			try {
				expect((await restarted.publish()).status).toBe('duplicate');
				restarted.manager.execute('owner', 'restored', h.emitted[0], 'mail');
				await restarted.manager.whenIdle();
				expect(restarted.onCueRun).not.toHaveBeenCalled();
			} finally {
				restarted.manager.discardInMemory();
				restarted.invocation.stop();
			}
		} finally {
			h.manager.discardInMemory();
			h.invocation.stop();
		}
	});
	it.each(['dispatch', 'claim'] as const)(
		'freshly rechecks disk identity after the %s receipt ACK',
		async (boundary) => {
			const h = pipeline();
			const previous = store[boundary].bind(store);
			store[boundary] = ((...args: unknown[]) => {
				const result = Reflect.apply(previous, store, args);
				h.changeFiles();
				return result;
			}) as (typeof store)[typeof boundary];
			try {
				if (boundary === 'dispatch')
					await expect(h.publish()).rejects.toThrow(/changed file identity/);
				else {
					await h.publish();
					await h.manager.whenIdle();
				}
				expect(h.onCueRun).not.toHaveBeenCalled();
			} finally {
				h.manager.discardInMemory();
				h.invocation.stop();
			}
		}
	);
	it('does not launch after cancellation while the durable claim ACK is pending', async () => {
		const h = pipeline();
		const nativeClaim = store.claim.bind(store);
		let claimed = false;
		store.claim = (...args) => {
			claimed = true;
			h.manager.stopRun(h.manager.getActiveRuns()[0].runId);
			return nativeClaim(...args);
		};
		try {
			await h.publish();
			await h.manager.whenIdle();
			expect(claimed).toBe(true);
			expect(h.onCueRun).not.toHaveBeenCalled();
		} finally {
			h.manager.discardInMemory();
			h.invocation.stop();
		}
	});
});

describe('real Cue receipt worker checkpoint transport', () => {
	let workerDir: string;
	let script: string;
	beforeAll(async () => {
		fs.mkdirSync('.maestro/scratch', { recursive: true });
		workerDir = fs.mkdtempSync(path.resolve('.maestro/scratch/cue-receipt-worker-'));
		script = await receiptWorkerFixture(workerDir, 'src/main/cue/cue-receipt-worker.ts');
	});
	afterAll(() => fs.rmSync(workerDir, { recursive: true, force: true }));
	const client = () =>
		new CueReceiptStore(path.join(dir, 'worker-receipts'), file, auth, baseline, script);
	async function admit(c: CueReceiptStore) {
		await c.read(plugin, 'event');
		await c.reserve(plugin, 'event', row(), 'attempt');
		await c.dispatch(plugin, 'event', 'attempt');
		await c.accepted(plugin, 'event', 'attempt');
	}
	it('retains completed execution across worker restart and omission of both cue.db tables', async () => {
		const first = client();
		try {
			await admit(first);
			expect(await first.claim(plugin, 'event', row().receiptId, 'first', 'run1')).toBe(true);
			await first.settle(plugin, 'event', row().receiptId, 'first', 'run1', true);
		} finally {
			await first.dispose();
		}
		const db = new Database(file);
		for (const name of ['cue_plugin_receipts', 'cue_plugin_legacy_receipts'] as const)
			db.exec('DELETE FROM ' + cuePhysicalTable(db, name));
		db.close();
		const second = client();
		try {
			expect((await second.read(plugin, 'event'))?.receipt).toEqual(row());
			expect(await second.claim(plugin, 'event', row().receiptId, 'second', 'run2')).toBe(false);
		} finally {
			await second.dispose();
		}
	});
	it.each(['prepared-after', 'stable-before', 'stable-after'])(
		'recovers native admission checkpoint at %s with no acknowledged execution',
		async (stage) => {
			const first = client();
			await first.read(plugin, 'ready');
			fs.writeFileSync(path.join(workerDir, 'kill-mode'), stage);
			let started = 0;
			try {
				await expect(
					first.reserve(plugin, 'event', row(), 'attempt').then(() => {
						started++;
					})
				).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
			} finally {
				fs.rmSync(path.join(workerDir, 'kill-mode'), { force: true });
				await first.dispose();
			}
			expect(started).toBe(0);
			const second = client();
			try {
				const value = await second.read(plugin, 'event');
				if (stage === 'prepared-after') expect(value).toBeNull();
				else expect(value).toMatchObject({ phase: 'reserved', receipt: row() });
			} finally {
				await second.dispose();
			}
		}
	);
	it.each(['prepared-after', 'stable-before', 'stable-after'])(
		'retains an uncertain durable execution claim after native checkpoint loss at %s',
		async (stage) => {
			const first = client();
			await admit(first);
			fs.writeFileSync(path.join(workerDir, 'kill-mode'), stage);
			let started = 0;
			try {
				await expect(
					first.claim(plugin, 'event', row().receiptId, 'first', 'run1').then(() => {
						started++;
					})
				).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
			} finally {
				fs.rmSync(path.join(workerDir, 'kill-mode'), { force: true });
				await first.dispose();
			}
			expect(started).toBe(0);
			const second = client();
			try {
				expect(await second.claim(plugin, 'event', row().receiptId, 'second', 'run2')).toBe(
					stage === 'prepared-after'
				);
			} finally {
				await second.dispose();
			}
		}
	);
	it.each([1, 2, 3, 4, 5])(
		'recovers interrupted authenticated cutover at native checkpoint write %s',
		async (boundary) => {
			fs.writeFileSync(path.join(workerDir, 'kill-at'), String(boundary));
			const first = client();
			try {
				await expect(first.read(plugin, 'event')).rejects.toMatchObject({
					code: 'PLUGIN_UNAVAILABLE',
				});
			} finally {
				fs.rmSync(path.join(workerDir, 'kill-at'), { force: true });
				fs.rmSync(path.join(workerDir, 'kill-count'), { force: true });
				await first.dispose();
			}
			const second = client();
			try {
				expect(await second.read(plugin, 'event')).toBeNull();
				await second.reserve(plugin, 'event', row(), 'attempt');
				expect((await second.read(plugin, 'event'))?.phase).toBe('reserved');
			} finally {
				await second.dispose();
			}
		}
	);
	it.each([1, 2, 3, 4, 5, 6, 7])(
		'recovers retained authenticated migration after native checkpoint termination %s',
		async (boundary) => {
			const consumer = 'consumer',
				event = 'old-event';
			const id = createHash('sha256')
				.update(canonicalJson([plugin, identity, consumer, event]))
				.digest('hex');
			const receipt = row();
			receipt.proof = auth.pluginEventProof(
				plugin,
				identity,
				{ id, receiptId: receipt.receiptId },
				{ payloadHash: receipt.payloadHash }
			);
			cue.writePluginEventReceipt(plugin, id, receipt);
			const open = () =>
				new CueReceiptStore(
					path.join(dir, 'worker-receipts'),
					file,
					auth,
					(id) => cue.authenticatedPluginReceiptBaseline(id, auth),
					script
				);
			const first = open();
			fs.writeFileSync(path.join(workerDir, 'kill-at'), String(boundary));
			try {
				await expect(
					first.historical(plugin, identity, consumer, event, receipt.payloadHash)
				).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' });
				expect(fs.readFileSync(path.join(workerDir, 'kill-count'), 'utf8')).toBe(String(boundary));
			} finally {
				fs.rmSync(path.join(workerDir, 'kill-at'), { force: true });
				fs.rmSync(path.join(workerDir, 'kill-count'), { force: true });
				await first.dispose();
			}
			const second = open();
			try {
				expect(
					await second.historical(plugin, identity, consumer, event, receipt.payloadHash)
				).toBe(receipt.receiptId);
				expect(
					await second.claim(plugin, 'legacy:' + id, receipt.receiptId, 'new-host', 'new-run')
				).toBe(false);
			} finally {
				await second.dispose();
			}
		}
	);
	it('admits one copy and one executing owner across concurrent real workers', async () => {
		const first = client(),
			second = client();
		try {
			await first.read(plugin, 'ready');
			await second.read(plugin, 'ready');
			const admitted = await Promise.allSettled([
				first.reserve(plugin, 'event', row(), 'one'),
				second.reserve(plugin, 'event', row(), 'two'),
			]);
			expect(admitted.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			expect(admitted.filter((r) => r.status === 'rejected')).toHaveLength(1);
			const attempt = (await first.read(plugin, 'event'))!.attempt;
			await first.dispatch(plugin, 'event', attempt);
			await first.accepted(plugin, 'event', attempt);
			const claims = await Promise.allSettled([
				first.claim(plugin, 'event', row().receiptId, 'one', 'run1'),
				second.claim(plugin, 'event', row().receiptId, 'two', 'run2'),
			]);
			expect(claims.filter((r) => r.status === 'fulfilled' && r.value)).toHaveLength(1);
			expect(claims.filter((r) => r.status === 'rejected' || !r.value)).toHaveLength(1);
		} finally {
			await first.dispose();
			await second.dispose();
		}
	});
});
