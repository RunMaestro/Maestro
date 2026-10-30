/**
 * Whether an absolute path exists, answered from a cache and filled over IPC.
 *
 * The file-link patterns guess where a path ENDS. For a path with no spaces in
 * it the guess is safe, but once a segment may hold a space the same text can
 * be a real folder (`/Users/me/Meeting Notes/a.md`) or a sentence that happens
 * to run into a file name. Only the filesystem can tell those apart, and a
 * remark plugin runs synchronously, so the plugin asks this cache: a known
 * answer comes back at once, an unknown one comes back `undefined` and is
 * fetched in the background. Subscribers are told when the answer lands so the
 * surface that asked can render again.
 *
 * Keys carry the SSH remote id: an agent on a remote host names paths on that
 * host, and `fs:stat` answers for whichever machine it is told to ask.
 */

/** Concurrent stats in flight. SSH remotes open a connection per stat. */
const MAX_IN_FLIGHT = 4;
/** Entries kept; the renderer runs for days, so the cache must stay bounded. */
const MAX_ENTRIES = 1000;
/** A missing path may be created moments later, so a "no" is re-asked after this. */
const NEGATIVE_TTL_MS = 15_000;

interface Entry {
	exists: boolean;
	checkedAt: number;
}

const entries = new Map<string, Entry>();
const pending = new Set<string>();
const queue: string[] = [];
const listeners = new Set<(key: string) => void>();
let inFlight = 0;
/** Bumped by a reset so checks started before it cannot touch the new state. */
let generation = 0;

/** The cache key for a path on the local machine or on one SSH remote. */
export function pathExistenceKey(absolutePath: string, sshRemoteId?: string): string {
	return `${sshRemoteId ?? ''}\u0000${absolutePath}`;
}

function splitKey(key: string): { absolutePath: string; sshRemoteId?: string } {
	const separator = key.indexOf('\u0000');
	const sshRemoteId = key.slice(0, separator);
	return { absolutePath: key.slice(separator + 1), sshRemoteId: sshRemoteId || undefined };
}

function remember(key: string, exists: boolean): void {
	entries.delete(key);
	entries.set(key, { exists, checkedAt: Date.now() });
	while (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next().value;
		if (oldest === undefined) break;
		entries.delete(oldest);
	}
	listeners.forEach((listener) => listener(key));
}

function pump(): void {
	const stat = typeof window !== 'undefined' ? window.maestro?.fs?.stat : undefined;
	while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
		const key = queue.shift()!;
		if (!stat) {
			pending.delete(key);
			continue;
		}
		const { absolutePath, sshRemoteId } = splitKey(key);
		const startedIn = generation;
		inFlight++;
		stat(absolutePath, sshRemoteId)
			// A path the handler cannot stat (permission, name too long, remote
			// unreachable) is not one we can link to, so every failure is a "no".
			.then(
				(result) => startedIn === generation && remember(key, result != null),
				() => startedIn === generation && remember(key, false)
			)
			.finally(() => {
				if (startedIn !== generation) return;
				pending.delete(key);
				inFlight--;
				pump();
			});
	}
}

/**
 * The known answer for a path, or `undefined` when it has not been checked (or
 * a "no" has gone stale). An unknown path is queued for a check; listen with
 * `subscribePathExistence` to learn when it lands.
 */
export function checkPathExists(absolutePath: string, sshRemoteId?: string): boolean | undefined {
	const key = pathExistenceKey(absolutePath, sshRemoteId);
	const entry = entries.get(key);
	if (entry && (entry.exists || Date.now() - entry.checkedAt < NEGATIVE_TTL_MS)) {
		return entry.exists;
	}
	if (!pending.has(key)) {
		pending.add(key);
		queue.push(key);
		pump();
	}
	return entry ? entry.exists : undefined;
}

/** Called with the key of every path whose answer has just landed. */
export function subscribePathExistence(listener: (key: string) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test seam: forget every answer and every queued check. */
export function resetPathExistenceCache(): void {
	entries.clear();
	pending.clear();
	queue.length = 0;
	inFlight = 0;
	generation++;
}
