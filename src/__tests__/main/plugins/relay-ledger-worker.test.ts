import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { receiptWorkerFixture } from '../../helpers/receiptWorkerFixture';
import { RelayLedgerClient } from '../../../main/plugins/relay-ledger-client';
let dir: string;
let script: string;
let killFile: string;
beforeAll(async () => {
	fs.mkdirSync('.maestro/scratch', { recursive: true });
	dir = fs.mkdtempSync(path.resolve('.maestro/scratch/relay-worker-'));
	killFile = path.join(dir, 'kill-mode');
	script = await receiptWorkerFixture(dir, 'src/main/plugins/relay-ledger-worker.ts');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
describe('real Relay worker transport', () => {
	it('persists through worker restart and bounds its pending queue without inline fallback', async () => {
		const base = path.join(dir, 'receipts');
		const first = new RelayLedgerClient(base, { responseCount: 1 }, script);
		try {
			await first.set(
				'm1',
				JSON.stringify({
					promptHash: 'h',
					messageId: '1',
					result: { success: true, response: 'one' },
				})
			);
			await first.set(
				'm2',
				JSON.stringify({
					promptHash: 'h',
					messageId: '2',
					result: { success: true, response: 'two' },
				})
			);
		} finally {
			await first.dispose();
		}
		const restarted = new RelayLedgerClient(base, undefined, script);
		try {
			expect(JSON.parse((await restarted.get('m1'))!).result).toMatchObject({
				success: true,
				response: null,
			});
			const pending = Array.from({ length: 129 }, () => restarted.get('m1'));
			const results = await Promise.allSettled(pending);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(128);
			expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
		} finally {
			await restarted.dispose();
		}
	});
	it('rejects worker loading failure instead of resetting stored execution state', async () => {
		const client = new RelayLedgerClient(
			path.join(dir, 'receipts'),
			undefined,
			path.join(dir, 'missing.cjs')
		);
		try {
			await expect(client.get('m1')).rejects.toThrow(/worker unavailable/);
		} finally {
			await client.dispose();
		}
	});
	it.each(['prepared-after', 'stable-before', 'stable-after'])(
		'recovers real worker termination at %s without acknowledging an unsafe admission',
		async (stage) => {
			const base = path.join(dir, stage);
			const client = new RelayLedgerClient(base, undefined, script);
			await client.set(
				'baseline',
				JSON.stringify({
					promptHash: 'h',
					messageId: 'old',
					result: { success: true, response: 'old' },
				})
			);
			fs.writeFileSync(killFile, stage);
			let providerStarts = 0;
			try {
				await expect(
					client
						.reserveTurn('pending', JSON.stringify({ promptHash: 'h', messageId: 'new' }))
						.then(() => {
							providerStarts++;
						})
				).rejects.toThrow(/worker unavailable/);
			} finally {
				fs.rmSync(killFile, { force: true });
				await client.dispose();
			}
			expect(providerStarts).toBe(0);
			const restarted = new RelayLedgerClient(base, undefined, script);
			try {
				const receipt = await restarted.get('pending');
				if (stage === 'prepared-after') expect(receipt).toBeNull();
				else
					expect(JSON.parse(receipt!)).toMatchObject({
						providerReservation: true,
						messageId: 'new',
					});
				expect(await restarted.get('baseline')).not.toBeNull();
			} finally {
				await restarted.dispose();
			}
		}
	);
	it('serializes independent workers through checkpoint finalization and admits one copy of a message', async () => {
		const base = path.join(dir, 'parallel');
		const first = new RelayLedgerClient(base, undefined, script),
			second = new RelayLedgerClient(base, undefined, script);
		try {
			await first.set('baseline', JSON.stringify({ promptHash: 'h', messageId: 'base' }));
			expect(await second.get('baseline')).not.toBeNull();
			fs.writeFileSync(path.join(dir, 'pause-prepared'), '1');
			const admission = first.reserveTurn(
				'one',
				JSON.stringify({ promptHash: 'h', messageId: 'one' })
			);
			for (let n = 0; !fs.existsSync(path.join(dir, 'prepared-marker')); n++) {
				if (n > 100) throw Error('prepared marker timeout');
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			let completed = false;
			const concurrent = second.get('one').then((value) => {
				completed = true;
				return value;
			});
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(completed).toBe(false);
			fs.rmSync(path.join(dir, 'pause-prepared'), { force: true });
			await admission;
			expect(JSON.parse((await concurrent)!)).toMatchObject({ messageId: 'one' });
			const outcomes = await Promise.allSettled([
				first.reserveTurn('same', JSON.stringify({ promptHash: 'h', messageId: 'same' })),
				second.reserveTurn('same', JSON.stringify({ promptHash: 'h', messageId: 'same' })),
			]);
			expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
		} finally {
			fs.rmSync(path.join(dir, 'pause-prepared'), { force: true });
			await first.dispose();
			await second.dispose();
		}
	});
});
