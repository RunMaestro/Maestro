/**
 * Per-session spawn generations.
 *
 * ## Why an identity check against the process map is not enough
 *
 * Everything downstream of a spawn is keyed by `sessionId` alone, but a session
 * id is reused: `spawn()` kills the predecessor and immediately registers a
 * replacement under the same key. A killed process keeps emitting stdio and
 * fires `close` well after that, so late events have to be told apart from live
 * ones.
 *
 * The obvious test - "is `processes.get(sessionId)` still me?" - has a hole. It
 * can only answer while an entry EXISTS. Once the replacement finishes and
 * deletes its own entry, the lookup returns `undefined`, the comparison stops
 * failing, and a predecessor still draining is treated as current again: its
 * late output is forwarded to a session that moved on, its SIGTERM `close`
 * emits a second exit, and the renderer and Cue both run completion effects
 * twice.
 *
 * A generation number closes that hole because it is a property of the SESSION,
 * not of a live entry. It only ever counts up, so "am I still the newest spawn?"
 * stays answerable after every entry for that session is gone.
 *
 * The counter is deliberately never deleted. It is two small numbers per session
 * id, and forgetting one would reset the sequence and make a stale process look
 * current again - exactly the bug this exists to prevent.
 */

/** Newest generation issued per session id. Monotonic; never reset or deleted. */
const generations = new Map<string, number>();

/**
 * Claim the next generation for a session. Called once per spawn, before the
 * process is registered, so the value can be stamped onto the managed process.
 */
export function nextSpawnGeneration(sessionId: string): number {
	const next = (generations.get(sessionId) ?? 0) + 1;
	generations.set(sessionId, next);
	return next;
}

/** The newest generation issued for a session, or 0 if it has never spawned. */
export function currentSpawnGeneration(sessionId: string): number {
	return generations.get(sessionId) ?? 0;
}

/**
 * True when `generation` has been superseded by a newer spawn on the same
 * session - i.e. this event belongs to a process the user has already replaced.
 *
 * An undefined generation means the process predates this tracking (or was
 * created by a path that does not stamp one). Those are treated as current, so
 * the guard can never suppress an event it does not understand.
 */
export function isSupersededGeneration(sessionId: string, generation: number | undefined): boolean {
	if (generation === undefined) return false;
	return generation < currentSpawnGeneration(sessionId);
}

/** Test-only: drop all generation state. */
export function resetSpawnGenerationsForTest(): void {
	generations.clear();
}
