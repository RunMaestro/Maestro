/**
 * Module-level cache for the user's home directory.
 * Fetched once via IPC, then reused synchronously across all consumers.
 */

let cachedHomeDir: string | undefined;
let homeDirPromise: Promise<string> | undefined;

/**
 * Returns the cached home directory if already resolved, otherwise kicks off the IPC fetch.
 * Call this from a useState initializer for synchronous access on subsequent renders.
 */
export function getHomeDir(): string | undefined {
	if (cachedHomeDir) return cachedHomeDir;
	if (!homeDirPromise && typeof window !== 'undefined' && window.maestro?.fs?.homeDir) {
		homeDirPromise = window.maestro.fs.homeDir().then((dir) => {
			cachedHomeDir = dir;
			return dir;
		});
	}
	return undefined;
}

/**
 * Returns a promise that resolves to the home directory.
 * Use in useEffect to trigger a re-render when homeDir becomes available.
 */
export function getHomeDirAsync(): Promise<string> | undefined {
	// Ensure the fetch is kicked off
	getHomeDir();
	return homeDirPromise;
}

/**
 * The home directory, waiting for the IPC fetch when the cache is still empty.
 * Use this instead of `getHomeDir()` wherever a `~` path is about to be
 * expanded for real: the sync read returns undefined until something has
 * warmed the cache, and an unexpanded `~` then leaks into a spawn.
 */
export async function resolveHomeDir(): Promise<string | undefined> {
	return getHomeDir() ?? (await getHomeDirAsync());
}
