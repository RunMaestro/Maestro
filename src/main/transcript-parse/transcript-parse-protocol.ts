/**
 * Message shapes between the transcript parse pool and its workers, plus the
 * error round trip.
 *
 * An `Error` does not survive `postMessage` as itself: structured clone keeps
 * the message but drops the class, and `code` (ENOENT, EACCES) rides along only
 * as a plain property. The call sites branch on exactly those two things -
 * `error instanceof RangeError` for a transcript too large for one V8 string,
 * and `isExpectedSessionReadError(error)` for a file that vanished - so a
 * worker failure is flattened here and rebuilt on the main side with its class
 * and code intact. Without that, every oversized transcript would be reported
 * to Sentry as a generic failure.
 *
 * Electron-free, like the tasks module: the worker imports it.
 */

import type { TranscriptParseTask } from './transcript-parse-tasks';

export interface TranscriptParseRequest {
	id: number;
	task: TranscriptParseTask;
}

export interface SerializedParseError {
	name: string;
	message: string;
	code?: string;
	stack?: string;
}

export type TranscriptParseResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; error: SerializedParseError };

export function serializeParseError(error: unknown): SerializedParseError {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			name: error.name,
			message: error.message,
			...(typeof code === 'string' ? { code } : {}),
			...(error.stack ? { stack: error.stack } : {}),
		};
	}
	return { name: 'Error', message: String(error) };
}

/** Rebuild an error with the class and `code` its handlers branch on. */
export function rehydrateParseError(serialized: SerializedParseError): Error {
	const error =
		serialized.name === 'RangeError'
			? new RangeError(serialized.message)
			: serialized.name === 'TypeError'
				? new TypeError(serialized.message)
				: new Error(serialized.message);
	if (serialized.name !== error.name) error.name = serialized.name;
	if (serialized.code) (error as NodeJS.ErrnoException).code = serialized.code;
	if (serialized.stack) error.stack = serialized.stack;
	return error;
}
