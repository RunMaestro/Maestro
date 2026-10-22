/**
 * What a hosting process hands the runtime so it can run turns, found beside the running bundle.
 *
 * The TUI and `maestro-cli host` both host the runtime and both ship next to the same files, so the
 * lookup lives here rather than in either: the `maestro-cli.js` agents are told to call (PA6) and
 * the `maestro-p` script a Claude agent on the TUI token source runs through. `dist/cli` holds both
 * in a checkout and `Resources/` once installed, so a sibling that is not there is simply absent
 * (the turn degrades: no CLI path in the template, Claude over `--print`). SQLite is the CLI's
 * loader, which proves the module loads in this runtime or says how to fix it; the runtime logs
 * that once and skips only the usage row.
 */

import * as fs from 'fs';
import * as path from 'path';

import { loadBetterSqlite3 } from '../store/native-sqlite';
import type { StatsConnectionConstructor } from '../turns/stats';
import type { RuntimeTurnOptions } from './turns';

export function resolveRuntimeTurnOptions(
	moduleDirectory: string,
	exists: (file: string) => boolean = fs.existsSync
): RuntimeTurnOptions {
	const beside = (name: string): string | undefined => {
		const candidate = path.join(moduleDirectory, name);
		return exists(candidate) ? candidate : undefined;
	};
	return {
		// The loader types its result as the one method it proves (`close`); the real constructor is
		// `better-sqlite3`'s, which is what `StatsConnectionConstructor` names.
		loadSqlite: () => loadBetterSqlite3() as unknown as StatsConnectionConstructor,
		moduleDirectory,
		maestroCliPath: beside('maestro-cli.js'),
		maestroPBinPath: beside('maestro-p.js') ?? null,
	};
}
