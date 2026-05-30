/**
 * Bounded-concurrency helpers for fan-out work, primarily SSH-backed reads.
 *
 * Background: OpenSSH's default `MaxStartups` is 10:30:100 — past 10 unauthenticated
 * connections, sshd starts probabilistically dropping new attempts. Listing N remote
 * sessions naively via `Promise.all(sessions.map(...))` opens N×K simultaneous
 * connections (where K is the number of SSH calls per session) and silently loses
 * results once it crosses that threshold. Capping concurrency well below 10 keeps
 * the burst safe across providers.
 */

/**
 * Cap on parallel per-session SSH reads when listing remote sessions. Must stay
 * well below OpenSSH's default `MaxStartups` threshold (10 unauthenticated
 * connections before drops begin) so pages with many sessions don't silently
 * lose entries to rejected connections.
 */
export const REMOTE_SESSION_READ_CONCURRENCY = 6;

/**
 * Map `items` with a bounded concurrency.
 *
 * Spawns up to `limit` workers that pull from a shared cursor; results are
 * placed back into the original index positions so the output matches the
 * input ordering even when individual tasks finish out of order.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const workerCount = Math.min(Math.max(1, limit), items.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
