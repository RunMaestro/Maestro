/**
 * What a hosting process hands the runtime so it can run turns, found beside the running bundle.
 *
 * The TUI and `maestro-cli host` both host the runtime and both ship next to the same files, so the
 * lookup lives here rather than in either: the `maestro-cli.js` agents are told to call (PA6) and
 * the `maestro-p` script a Claude agent on the TUI token source runs through. `dist/cli` holds both
 * in a checkout and `Resources/` once installed, so a sibling that is not there is simply absent
 * (the turn degrades: no CLI path in the template, Claude over `--print`). A host installed by Move
 * to Host has no maestro-p beside it, so it also looks where the maestro-p installer puts it. SQLite is the CLI's
 * loader, which proves the module loads in this runtime or says how to fix it; the runtime logs
 * that once and skips only the usage row.
 */

import * as fs from 'fs';
import * as path from 'path';

import { loadBetterSqlite3 } from '../store/native-sqlite';
import type { StatsConnectionConstructor } from '../turns/stats';
import type { RuntimeTurnOptions } from './turns';

/**
 * Where the maestro-p installer (`scripts/install-maestro-p/`) puts `maestro-p.js`, with the
 * `node-pty` it needs beside it: `MAESTRO_P_HOME`, else `/usr/local/lib/maestro-p` (POSIX) or
 * `%ProgramFiles%\maestro-p` (Windows). It is what an SSH remote installs so a Claude agent there
 * can run the TUI, and a host (`maestro-cli host`) on that remote runs its TUI turns through the
 * same install, so they can be steered as a desktop's are.
 */
export function installedMaestroPCandidates(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform
): string[] {
	const join = platform === 'win32' ? path.win32.join : path.posix.join;
	const homes = [
		env.MAESTRO_P_HOME?.trim(),
		platform === 'win32'
			? env.ProgramFiles?.trim() && join(env.ProgramFiles.trim(), 'maestro-p')
			: '/usr/local/lib/maestro-p',
	].filter((home): home is string => !!home);
	return homes.map((home) => join(home, 'bin', 'maestro-p.js'));
}

export function resolveRuntimeTurnOptions(
	moduleDirectory: string,
	exists: (file: string) => boolean = fs.existsSync,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform
): RuntimeTurnOptions {
	const beside = (name: string): string | undefined => {
		const candidate = path.join(moduleDirectory, name);
		return exists(candidate) ? candidate : undefined;
	};
	const installedMaestroP = installedMaestroPCandidates(env, platform).find((file) => exists(file));
	return {
		// The loader types its result as the one method it proves (`close`); the real constructor is
		// `better-sqlite3`'s, which is what `StatsConnectionConstructor` names.
		loadSqlite: () => loadBetterSqlite3() as unknown as StatsConnectionConstructor,
		moduleDirectory,
		maestroCliPath: beside('maestro-cli.js'),
		// The bundle's own sibling first (the app, a CLI build), then the installer's.
		maestroPBinPath: beside('maestro-p.js') ?? installedMaestroP ?? null,
	};
}
