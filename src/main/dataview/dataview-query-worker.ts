/**
 * Worker thread entry for a Dataview query worker (`query-runner.ts`). One worker serves one vault root.
 *
 * Nothing here, or reachable from here, may import `electron` (see `query-worker-host.ts`).
 */

import { parentPort } from 'worker_threads';
import { createQueryWorkerHost } from './query-worker-host';
import type { QueryWorkerRequest } from './query-worker-protocol';

const port = parentPort;
if (!port) {
	throw new Error('dataview-query-worker must be started as a worker thread');
}

const handle = createQueryWorkerHost((response) => port.postMessage(response));
port.on('message', (request: QueryWorkerRequest) => handle(request));
