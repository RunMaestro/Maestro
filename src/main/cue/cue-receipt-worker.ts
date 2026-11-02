/** Receipt I/O, Merkle checks and native checkpoints stay off the main thread. */
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CueReceiptLedger } from './cue-receipt-ledger';
import { createKeyringAnchor } from '../utils/keyring-anchor';
const port = parentPort;
if (!port) throw Error('Cue receipt worker requires a parent');
const ledger = new CueReceiptLedger(
	workerData.baseDir,
	workerData.cueDbPath,
	createKeyringAnchor(
		'com.maestro.cue-receipts',
		createHash('sha256').update(path.resolve(workerData.baseDir)).digest('hex')
	),
	workerData.limits
);
const methods = [
	'transitionState',
	'prepare',
	'ready',
	'read',
	'historical',
	'reserve',
	'dispatch',
	'accepted',
	'cancelPublish',
	'claim',
	'settle',
] as const;
port.on('message', (request: { id: number; method: string; args: unknown[] }) => {
	try {
		if (!methods.includes(request.method as (typeof methods)[number]))
			throw Error('Invalid Cue receipt operation');
		const method = ledger[request.method as (typeof methods)[number]] as (
			...args: unknown[]
		) => unknown;
		port.postMessage({ id: request.id, value: method.apply(ledger, request.args) });
	} catch (error) {
		port.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : 'Cue receipts unavailable',
		});
	}
});
