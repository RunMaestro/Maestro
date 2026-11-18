/**
 * The file-tree scan an agent holds in memory, and the rule that keeps it there.
 *
 * `fileTree` and the fields describing its scan are a cache of the agent's
 * working directory. They are rebuilt on activation, so they are never stored
 * and never sent to a browser. One agent's tree can run to megabytes (a large
 * vault scanned 130K files into 15 MB), and a sessions file that kept them grew
 * past 100 MB. The web bootstrap then shipped 47 MB to a phone and the bridge
 * closed the socket with 1013 on every reconnect, so the browser showed "Could
 * not load your agents".
 *
 * The renderer resets these fields before it persists, but any writer that
 * hands `sessions:setMany` a raw agent bypasses that. So the main process
 * applies the same reset at its write boundary, at load, and in the browser
 * projection. Every one of those places uses this module, so a new scan field
 * added here is dropped by all of them.
 */

/**
 * The file-tree fields of an agent whose tree has not been scanned yet.
 *
 * Also the shape a stored agent has. The auto-loader decides "already loaded"
 * from `fileTreeLoadedCap` and `fileTreeStats`, so a scan marker kept beside an
 * empty tree makes it skip a folder it never scanned. Reset all of them together.
 */
export function unloadedFileTreeState() {
	return {
		fileTree: [] as never[],
		fileTreeStats: undefined,
		fileTreeTruncated: undefined,
		fileTreeLoadedCap: undefined,
		fileTreeLoading: false,
		fileTreeLoadingProgress: undefined,
		fileTreeLastScanTime: undefined,
		fileTreeError: undefined,
		fileTreeRetryAt: undefined,
	};
}

type FileTreeCacheKey = keyof ReturnType<typeof unloadedFileTreeState>;
const FILE_TREE_CACHE_KEYS = Object.keys(unloadedFileTreeState()) as FileTreeCacheKey[];

/** True when the agent carries any part of a file-tree scan. */
export function holdsFileTreeCache(session: object): boolean {
	const record = session as Partial<Record<FileTreeCacheKey, unknown>>;
	return FILE_TREE_CACHE_KEYS.some((key) => {
		const value = record[key];
		if (key === 'fileTree') return Array.isArray(value) && value.length > 0;
		if (key === 'fileTreeLoading') return value === true;
		return value !== undefined;
	});
}

/** The agent without its file-tree scan. Returns the same object when there is none. */
export function withoutFileTreeCache<T extends object>(session: T): T {
	return holdsFileTreeCache(session) ? { ...session, ...unloadedFileTreeState() } : session;
}
