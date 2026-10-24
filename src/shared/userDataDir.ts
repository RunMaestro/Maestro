/**
 * Maestro's data directory, resolved without Electron.
 *
 * The desktop app gets this from `app.getPath('userData')`. A process that has
 * no Electron - the CLI, and the standalone Cue runner this exists for - has to
 * arrive at the SAME directory, or the two disagree about what state exists.
 *
 * The app's own rule, mirrored here:
 *   1. `MAESTRO_USER_DATA` wins. The app sets it on its OWN process env at
 *      startup (`src/main/index.ts`), so anything the app spawns inherits it and
 *      lands in the right place by construction. A CLI the user starts from
 *      their own terminal does NOT inherit it and falls through to step 2.
 *   2. Otherwise the platform default plus the app name, and the app name is
 *      NOT constant: Electron uses `package.json` `name` ("maestro") when
 *      running unpackaged and the bundle's `productName` ("Maestro") once
 *      packaged. Linux is the exception: a packaged Linux app writes the
 *      lowercase name too (`productName` only sits under `build`, #1813), so
 *      there the guess is lowercase either way. Both spellings exist in the
 *      wild, which is why the fallbacks scattered around this repo disagreed
 *      with each other. The guess is checked against the disk:
 *        - when both spellings exist (only possible on a case-sensitive
 *          filesystem), the one holding the app's state wins; see
 *          `APP_STATE_MARKERS`. When both or neither hold it, the guess stands.
 *        - when only the other spelling exists, it wins.
 *   3. Development adds one more hop: the app redirects to a sibling
 *      `maestro-dev` directory unless `USE_PROD_DATA` is set.
 *
 * Everything is injectable so the branches can be tested without pretending to
 * be another OS.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Directory name Electron derives from `package.json` `name`, unpackaged. */
const UNPACKAGED_APP_NAME = 'maestro';
/** Directory name Electron derives from `build.productName`, once packaged. */
const PACKAGED_APP_NAME = 'Maestro';
/** Sibling directory the app redirects to in development. */
const DEV_APP_NAME = 'maestro-dev';

/**
 * Files only the desktop app writes into its data directory, all on its first
 * launch, which is what tells the real directory from an empty twin. The CLI
 * and the headless Cue runner never write them (they DO write
 * `maestro-settings.json`, `maestro-agent-configs.json` and `cue.db`, so
 * those prove nothing). The sessions store moves out with a custom Storage
 * Location; the window state never does. `cli-server.json` is no use: it only
 * exists while the app runs, and it is always written to the lowercase name.
 */
const APP_STATE_MARKERS = ['maestro-sessions.json', 'maestro-window-state.json'];

export interface UserDataDirOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	homedir?: string;
	/**
	 * Whether this is a packaged install. Defaults to a probe that does not
	 * import Electron: under Electron, `process.defaultApp` is set only when it
	 * was launched as `electron .`; outside Electron there is no app bundle to
	 * be unpackaged, so the installed spelling is the right assumption (it is
	 * also what `maestro-cli` has always used).
	 */
	isPackaged?: boolean;
	/** Whether this is a development run. Defaults to `NODE_ENV`. */
	isDevelopment?: boolean;
}

function platformRoot(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
	if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
	if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
	return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

/**
 * `existsSync` is true for a regular file too, which is not a data directory.
 *
 * Only a missing path answers "no". A permission or I/O error must not come back
 * as an absent directory: the path is right, `MAESTRO_USER_DATA` would not fix
 * it, and the caller needs the real errno to know that.
 */
function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return false;
		throw error;
	}
}

function probeIsPackaged(): boolean {
	const electronProcess = process as NodeJS.Process & { defaultApp?: boolean };
	if (process.versions.electron) return !electronProcess.defaultApp;
	return true;
}

/**
 * The directory the desktop app stores its data in.
 *
 * Callers that can reach Electron should keep using `app.getPath('userData')`:
 * this is for the ones that cannot.
 *
 * A process with no Electron cannot tell a dev checkout's `maestro` from an
 * installed `Maestro` (macOS, Windows), so it assumes the installed spelling.
 * A standalone runner must therefore check the directory it got (see
 * `assertUserDataDirExists`) rather than open whatever database happens to be
 * at the computed path.
 */
export function resolveUserDataDir(options: UserDataDirOptions = {}): string {
	const env = options.env ?? process.env;
	if (env.MAESTRO_USER_DATA) return path.resolve(env.MAESTRO_USER_DATA);

	const platform = options.platform ?? os.platform();
	const home = options.homedir ?? os.homedir();
	const isPackaged = options.isPackaged ?? probeIsPackaged();
	const isDevelopment = options.isDevelopment ?? env.NODE_ENV === 'development';

	const root = platformRoot(platform, home, env);
	if (!isPackaged && isDevelopment && !env.USE_PROD_DATA) {
		return path.join(root, DEV_APP_NAME);
	}
	// Guessing lowercase on Linux also keeps a CLI write made before the app's
	// first launch from creating a second, capitalized directory.
	const guessCapitalized = isPackaged && platform !== 'linux';
	const preferred = path.join(root, guessCapitalized ? PACKAGED_APP_NAME : UNPACKAGED_APP_NAME);
	const other = path.join(root, guessCapitalized ? UNPACKAGED_APP_NAME : PACKAGED_APP_NAME);
	// The guessed spelling is only a guess. On a case-sensitive filesystem the
	// wrong one is a different directory, and any CLI write creates it, so mere
	// existence cannot settle it: prefer the one the app has written. A
	// case-insensitive volume answers the same for both and keeps the guess.
	if (holdsAppState(other) && !holdsAppState(preferred)) return other;
	if (!isExistingDirectory(preferred) && isExistingDirectory(other)) return other;
	return preferred;
}

/** Whether `candidate` holds a file only the desktop app writes. */
function holdsAppState(candidate: string): boolean {
	return APP_STATE_MARKERS.some((marker) => isExistingFile(path.join(candidate, marker)));
}

/** A probe, like `isExistingDirectory`: anything unreadable answers no. */
function isExistingFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** `isDirectory` for a probe: an unreadable candidate is not one to pick. */
function isExistingDirectory(candidate: string): boolean {
	try {
		return isDirectory(candidate);
	} catch {
		return false;
	}
}

/**
 * Refuse to proceed when the resolved directory is not Maestro's.
 *
 * For a process that starts with no app running, an absent directory means the
 * spelling was guessed wrong (a dev checkout and a Linux install write
 * `maestro`, a macOS or Windows install writes `Maestro`), and creating it
 * would open an empty database beside the real one instead of failing.
 * Callers that legitimately create the directory - the app itself, and the
 * CLI's first write - must not call this.
 *
 * Throws with the other candidates it can see, so the fix (`MAESTRO_USER_DATA`)
 * is obvious from the message.
 */
export function assertUserDataDirExists(dir: string, options: UserDataDirOptions = {}): string {
	if (isDirectory(dir)) return dir;

	const env = options.env ?? process.env;
	const platform = options.platform ?? os.platform();
	const home = options.homedir ?? os.homedir();
	const root = platformRoot(platform, home, env);
	const alternatives = [PACKAGED_APP_NAME, UNPACKAGED_APP_NAME, DEV_APP_NAME]
		.map((name) => path.join(root, name))
		.filter((candidate) => {
			if (candidate === dir) return false;
			// Asymmetric on purpose: the directory we were ASKED about must report a
			// real error, but a sibling we cannot stat is just not worth naming, and
			// throwing here would replace a good diagnostic with an unrelated one.
			try {
				return isDirectory(candidate);
			} catch {
				return false;
			}
		});

	// A file at the path is a different mistake from nothing at all, and saying
	// "not found" about something the user can see would send them hunting.
	const problem = fs.existsSync(dir) ? 'is not a directory' : 'not found at';

	throw new Error(
		`Maestro data directory ${problem} ${dir}.` +
			(alternatives.length ? ` Found instead: ${alternatives.join(', ')}.` : '') +
			` Set MAESTRO_USER_DATA to the directory the desktop app uses.`
	);
}
