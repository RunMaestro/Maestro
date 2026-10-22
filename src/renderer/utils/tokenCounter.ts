/**
 * Token Counter Utilities
 *
 * Provides accurate token counting using tiktoken's cl100k_base encoding
 * (the same tokenizer used by Claude and GPT-4).
 *
 * Uses lazy loading to avoid loading the tokenizer until it's needed.
 */

import type { Tiktoken } from 'js-tiktoken';
import { estimateTokenCount } from '../../shared/formatters';
import { logger } from './logger';
import type { TokenCountRequest, TokenCountResponse } from '../workers/tokenCount.worker';

// Lazy-loaded tokenizer encoder (cl100k_base is used by Claude/GPT-4)
let encoderPromise: Promise<Tiktoken> | null = null;

/**
 * Get the tiktoken encoder instance (lazy-loaded).
 * Uses cl100k_base encoding which is compatible with Claude and GPT-4.
 */
export function getEncoder(): Promise<Tiktoken> {
	if (!encoderPromise) {
		encoderPromise = import('js-tiktoken').then(({ getEncoding }) => getEncoding('cl100k_base'));
	}
	return encoderPromise;
}

// The worker that owns the encoder (see workers/tokenCount.worker.ts). `null`
// until first use; `false` once it is known not to work here (no Worker in the
// environment, or it failed), after which counting stays on the UI thread.
let worker: Worker | null | false = null;
let nextRequestId = 0;
const pendingCounts = new Map<
	number,
	{ resolve: (count: number) => void; reject: (error: Error) => void }
>();

function failWorker(error: Error): void {
	if (worker) worker.terminate();
	worker = false;
	for (const pending of pendingCounts.values()) pending.reject(error);
	pendingCounts.clear();
}

function getWorker(): Worker | null {
	if (worker === false) return null;
	if (worker) return worker;
	if (typeof Worker === 'undefined') {
		worker = false;
		return null;
	}
	try {
		const created = new Worker(new URL('../workers/tokenCount.worker.ts', import.meta.url), {
			type: 'module',
		});
		created.onmessage = (event: MessageEvent<TokenCountResponse>) => {
			const pending = pendingCounts.get(event.data.id);
			if (!pending) return;
			pendingCounts.delete(event.data.id);
			if ('count' in event.data) pending.resolve(event.data.count);
			else pending.reject(new Error(event.data.error));
		};
		created.onerror = (event) => {
			event.preventDefault();
			failWorker(new Error(event.message || 'Token count worker failed'));
		};
		worker = created;
		return created;
	} catch {
		worker = false;
		return null;
	}
}

/** Count in the worker, or null when no worker is available. */
function countTokensInWorker(text: string): Promise<number> | null {
	const target = getWorker();
	if (!target) return null;
	const id = ++nextRequestId;
	return new Promise<number>((resolve, reject) => {
		pendingCounts.set(id, { resolve, reject });
		target.postMessage({ id, text } satisfies TokenCountRequest);
	});
}

/**
 * Count tokens in text using the tiktoken encoder.
 *
 * Runs in a worker when one is available, so neither building the encoder nor
 * encoding a long document blocks the UI thread. Prefer this over calling
 * `getEncoder()` directly from a component.
 *
 * @param text - The text to count tokens for
 * @returns Promise resolving to the token count
 *
 * @example
 * const count = await countTokens("Hello, world!");
 * logger.info(`Text has ${count} tokens`);
 */
export async function countTokens(text: string): Promise<number> {
	try {
		const offThread = countTokensInWorker(text);
		if (offThread) {
			try {
				return await offThread;
			} catch (error) {
				// The worker is gone (failed to load or crashed); count here instead.
				logger.warn('Token count worker failed; counting on the UI thread', undefined, error);
			}
		}
		const encoder = await getEncoder();
		return encoder.encode(text).length;
	} catch (error) {
		logger.error('Failed to count tokens:', undefined, error);
		// Fall back to character-based estimate if tokenizer fails
		return estimateTokens(text);
	}
}

/**
 * Synchronous token estimation using character-based heuristic.
 * Re-exports estimateTokenCount from shared/formatters for backwards compatibility.
 */
export const estimateTokens = (text: string): number => estimateTokenCount(text);

/**
 * Format a token count for display with appropriate suffix.
 *
 * @param count - The token count to format
 * @returns Formatted string (e.g., "1.2k", "15k", "1.5M")
 */
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	return count.toString();
}
