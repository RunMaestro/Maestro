import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';

const writers = createKeyedWriteQueue();
const reservations = new Map<string, number>();
const activeBindings = new Map<string, (providerSessionId: string) => void>();

/** Attach an announced first-turn provider id to its already active tab lease. */
export function bindProviderSessionWriter(processId: string, providerSessionId: string): void {
	activeBindings.get(processId)?.(providerSessionId);
}

export function hasProviderSessionWriter(
	provider: string,
	processId: string,
	providerSessionId?: string | null
): boolean {
	return (
		reservations.has(`tab:${processId}`) ||
		(!!providerSessionId && reservations.has(`provider:${provider}:${providerSessionId}`))
	);
}

/** Reserve both identities before starting a provider turn. Hold until process close,
 * including final output reconciliation, rather than releasing on spawn or OS exit.
 * The tab key also protects a first turn that has no provider session id yet.
 * A current-id resolver retries the entire acquisition if a preceding writer
 * changed that identity while we waited; it must read authoritative state synchronously.
 */
export async function acquireProviderSessionWriter(
	provider: string,
	processId: string,
	providerSessionId?: string | null,
	signal?: AbortSignal,
	resolveCurrentSessionId?: () => string | null | undefined
): Promise<() => void> {
	const keys = [`tab:${processId}`];
	if (providerSessionId) keys.push(`provider:${provider}:${providerSessionId}`);
	const releases: Array<() => void> = [];
	for (const key of keys) reservations.set(key, (reservations.get(key) ?? 0) + 1);
	let released = false;
	const releaseAll = () => {
		if (released) return;
		released = true;
		if (activeBindings.get(processId) === bind) activeBindings.delete(processId);
		releases
			.splice(0)
			.reverse()
			.forEach((release) => release());
		for (const key of keys) {
			const count = (reservations.get(key) ?? 1) - 1;
			if (count) reservations.set(key, count);
			else reservations.delete(key);
		}
	};
	try {
		for (const key of keys.sort()) {
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(new Error('Provider writer wait cancelled'));
				if (signal?.aborted) {
					abort();
					return;
				}
				signal?.addEventListener('abort', abort, { once: true });
				void writers.enqueue(
					key,
					() =>
						new Promise<void>((release) => {
							signal?.removeEventListener('abort', abort);
							if (signal?.aborted) {
								release();
								return;
							}
							releases.push(release);
							resolve();
						})
				);
			});
		}
		if (resolveCurrentSessionId) {
			const currentId = resolveCurrentSessionId();
			if ((currentId ?? undefined) !== (providerSessionId ?? undefined)) {
				// Release every stale key before retrying the same global lock order.
				// Binding alone would enqueue behind an existing writer without waiting.
				releaseAll();
				return acquireProviderSessionWriter(
					provider,
					processId,
					currentId,
					signal,
					resolveCurrentSessionId
				);
			}
		}
	} catch (error) {
		releaseAll();
		throw error;
	}
	function bind(id: string): void {
		const key = `provider:${provider}:${id}`;
		if (released || keys.includes(key)) return;
		keys.push(key);
		reservations.set(key, (reservations.get(key) ?? 0) + 1);
		// Enqueue synchronously in the announcement callback. A client learning
		// the id cannot enter the host before this reservation is in its queue.
		void writers.enqueue(
			key,
			() =>
				new Promise<void>((release) => {
					if (released) release();
					else releases.push(release);
				})
		);
	}
	activeBindings.set(processId, bind);
	return releaseAll;
}
