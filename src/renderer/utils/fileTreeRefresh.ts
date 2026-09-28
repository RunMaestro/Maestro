/**
 * Ask the Files panel to re-read an agent's working directory.
 *
 * The panel refreshes on its own timer, so anything that puts a file on disk
 * outside that cadence (a save, a delete, an image written into the project)
 * leaves the tree describing a directory that no longer exists until the next
 * tick. Every such path nudges it through one app-level CustomEvent rather than
 * prop-drilling `refreshFileTree` down into whichever hook happened to do the
 * write - `useAppRemoteEventListeners` owns the single listener.
 *
 * The event is the same one the CLI and web bridges raise, so an agent writing
 * a file and a user saving one converge on one code path.
 */

/** Event name the app-level listener in `useAppRemoteEventListeners` binds. */
export const FILE_TREE_REFRESH_EVENT = 'maestro:refreshFileTree';

/**
 * Refresh the Files panel for `sessionId`. A missing id is a no-op rather than
 * a thrown error: callers write files from surfaces that may have no agent
 * (the wizard), and failing to refresh a tree nobody is looking at is not worth
 * a crash.
 */
export function requestFileTreeRefresh(sessionId: string | undefined | null): void {
	if (!sessionId) return;
	window.dispatchEvent(new CustomEvent(FILE_TREE_REFRESH_EVENT, { detail: { sessionId } }));
}
