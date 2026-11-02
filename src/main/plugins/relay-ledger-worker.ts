/** No Electron imports: filesystem, SQLite, hashing and native receipt checkpoints stay off main. */
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { RelayLedger } from './relay-ledger';
import { createKeyringAnchor } from '../utils/keyring-anchor';
const port = parentPort;
if (!port) throw Error('Relay ledger worker requires a parent');
const ledger = new RelayLedger(
	workerData.baseDir,
	createKeyringAnchor(
		'com.maestro.relay-receipts',
		createHash('sha256').update(path.resolve(workerData.baseDir)).digest('hex')
	),
	workerData.limits
);
const methods = [
	'get',
	'set',
	'reserveTurn',
	'finishTurn',
	'settleTurn',
	'mappingKeys',
	'assertProviderAvailable',
	'deletePending',
	'purgeMappings',
] as const;
port.on('message', (request: { id: number; method: string; args: unknown[] }) => {
	try {
		if (!methods.includes(request.method as (typeof methods)[number]))
			throw Error('Invalid receipt operation');
		const method = ledger[request.method as (typeof methods)[number]] as (
			...args: unknown[]
		) => unknown;
		const value = method.apply(ledger, request.args);
		port.postMessage({ id: request.id, value });
	} catch (error) {
		port.postMessage({
			id: request.id,
			error: error instanceof Error ? error.message : 'Relay receipts unavailable',
		});
	}
});
