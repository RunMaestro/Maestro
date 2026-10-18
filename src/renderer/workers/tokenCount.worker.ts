/**
 * Token counting off the renderer UI thread.
 *
 * Building the cl100k_base encoder decodes a multi-megabyte rank table (~100ms
 * of blocking work on first use), and encoding a long document costs tens of
 * milliseconds more. Both ran on the UI thread every time an Auto Run document
 * or file preview changed, which a field trace caught as a 118ms long task.
 * Here they run in a worker; `countTokens()` in utils/tokenCounter.ts is the
 * only client.
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken';

export interface TokenCountRequest {
	id: number;
	text: string;
}

export type TokenCountResponse = { id: number; count: number } | { id: number; error: string };

// Typed locally: the renderer tsconfig uses the DOM lib, whose `self` is a
// Window with a different postMessage signature.
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<TokenCountRequest>) => void) | null;
	postMessage: (message: TokenCountResponse) => void;
};

let encoder: Tiktoken | null = null;

scope.onmessage = (event) => {
	const { id, text } = event.data;
	try {
		encoder ??= getEncoding('cl100k_base');
		scope.postMessage({ id, count: encoder.encode(text).length });
	} catch (error) {
		scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
};
