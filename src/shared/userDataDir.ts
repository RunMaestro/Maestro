/**
 * Maestro's data directory, resolved without Electron.
 *
 * The desktop app gets this from `app.getPath('userData')`. A process that has
 * no Electron - the CLI, and the standalone Cue runner this exists for - has to
 * arrive at the SAME directory, or the two disagree about what state exists.
 *
 * The app's own rule, mirrored here:
 *   1. `MAESTRO_USER_DATA` wins. The app publishes its resolved path into the
 *      environment at startup (`src/main/index.ts`), so anything it spawns, and
 *      any CLI run while it is up, lands in the right place by construction.
 *   2. Otherwise the platform default plus the app name, and the app name is
 *      NOT constant: Electron uses `package.json` `name` ("maestro") when
 *      running unpackaged and the bundle's `productName` ("Maestro") once
 *      packaged. Both spellings exist in the wild, which is why the fallbacks
 *      scattered around this repo disagree with each other.
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
 * installed `Maestro`, so it assumes the installed spelling. A standalone
 * runner must therefore check the directory it got (see
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
	return path.join(root, isPackaged ? PACKAGED_APP_NAME : UNPACKAGED_APP_NAME);
}

/**
 * Refuse to proceed when the resolved directory is not Maestro's.
 *
 * For a process that starts with no app running, an absent directory means the
 * spelling was guessed wrong (a dev checkout writes `maestro`, an install
 * writes `Maestro`), and creating it would open an empty database beside the
 * real one instead of failing. Callers that legitimately create the directory -
 * the app itself, and the CLI's first write - must not call this.
 *
 * Throws with the other candidates it can see, so the fix (`MAESTRO_USER_DATA`)
 * is obvious from the message.
 */
export function assertUserDataDirExists(dir: string, options: UserDataDirOptions = {}): string {
	if (fs.existsSync(dir)) return dir;

	const env = options.env ?? process.env;
	const platform = options.platform ?? os.platform();
	const home = options.homedir ?? os.homedir();
	const root = platformRoot(platform, home, env);
	const alternatives = [PACKAGED_APP_NAME, UNPACKAGED_APP_NAME, DEV_APP_NAME]
		.map((name) => path.join(root, name))
		.filter((candidate) => candidate !== dir && fs.existsSync(candidate));

	throw new Error(
		`Maestro data directory not found at ${dir}.` +
			(alternatives.length ? ` Found instead: ${alternatives.join(', ')}.` : '') +
			` Set MAESTRO_USER_DATA to the directory the desktop app uses.`
	);
}
