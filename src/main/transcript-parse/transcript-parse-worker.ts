/**
 * Worker thread entry for the transcript parse pool. Runs one task at a time;
 * the pool never sends a second request before the first is answered.
 *
 * Nothing here, or reachable from here, may import `electron` - see the note at
 * the top of `transcript-parse-tasks.ts`.
 */

import { parentPort } from 'worker_threads';
import { runTranscriptParseTask } from './transcript-parse-tasks';
import {
	serializeParseError,
	type TranscriptParseRequest,
	type TranscriptParseResponse,
} from './transcript-parse-protocol';

const port = parentPort;
if (!port) {
	throw new Error('transcript-parse-worker must be started as a worker thread');
}

port.on('message', (request: TranscriptParseRequest) => {
	runTranscriptParseTask(request.task).then(
		(result) => {
			const response: TranscriptParseResponse = { id: request.id, ok: true, result };
			port.postMessage(response);
		},
		(error: unknown) => {
			const response: TranscriptParseResponse = {
				id: request.id,
				ok: false,
				error: serializeParseError(error),
			};
			port.postMessage(response);
		}
	);
});
