/**
 * Resolve Maestro's app-level data directory (where `maestro-sessions.json`,
 * `cue.db`, and every other per-installation store live) WITHOUT depending on
 * Electron's `app.getPath('userData')`.
 *
 * This is the platform-resolution half of `maestro-cli`'s `getConfigDir()`
 * (`src/cli/services/storage.ts`), extracted so a second caller that also
 * cannot assume a running Electron `app` - the standalone Cue engine runner -
 * can resolve the SAME directory the desktop app uses without importing
 * `electron` at all. `getConfigDir()` now delegates here; this module is the
 * canonical implementation, not a parallel copy.
 *
 * Two things make this safe to share with the desktop app's own resolution:
 *
 *  - `MAESTRO_USER_DATA` is honored FIRST, and the desktop main process stamps
 *    this env var with `app.getPath('userData')` early in startup
 *    (`src/main/index.ts`) - before Cue's engine boots. A CLI subcommand or a
 *    standalone engine invoked from a dev shell that also has this var set
 *    (or that sets it itself before booting) agrees with the desktop app by
 *    construction, not by coincidence.
 *  - Absent that override, the per-platform fallback below hard-codes the
 *    exact directory Electron's own `app.getPath('userData')` resolves to for
 *    an app named "Maestro" (verified against Electron's documented default:
 *    `~/Library/Application Support/<Name>` on macOS, `%APPDATA%\<Name>` on
 *    Windows, `$XDG_CONFIG_HOME/<Name>` or `~/.config/<Name>` on Linux). If
 *    Electron's own resolution for this app ever changes, both copies must
 *    change together - there is only one copy now.
 */

import * as path from 'path';
import * as os from 'os';

/**
 * Resolve Maestro's app-level data directory. Never touches `electron` - safe
 * to import from a plain Node process (a `maestro-cli` command, the
 * standalone Cue engine runner) as well as from the Electron main process.
 */
export function resolveMaestroUserDataDir(): string {
	if (process.env.MAESTRO_USER_DATA) {
		return path.resolve(process.env.MAESTRO_USER_DATA);
	}

	const platform = os.platform();
	const home = os.homedir();

	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'Maestro');
	} else if (platform === 'win32') {
		return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Maestro');
	}
	return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Maestro');
}
