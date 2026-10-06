/**
 * `--data-dir <path>`: point a command at an explicit Maestro data directory.
 *
 * Every reader of the data directory - the Cue engine lock, `cue.db`, the
 * trigger inbox, the session and agent-config readers, the CLI server
 * discovery file, and the bundled electron shim - resolves it through
 * `resolveUserDataDir()`, which answers `MAESTRO_USER_DATA` first. So the flag
 * is applied by writing that variable before anything reads it, not by
 * threading a path through every reader: one source of truth, and processes
 * the engine spawns inherit it (server mode keeps `MAESTRO_*`, see
 * `filterServerProcessEnv`), so a `maestro-cli` an agent calls lands on the
 * same folder.
 *
 * The flag wins over an inherited `MAESTRO_USER_DATA`: an operator who typed a
 * path meant that path. This never creates the directory; the command's own
 * `assertUserDataDirExists` check refuses a missing one.
 */

import { resolveCliPath } from '../utils/parse';
import { assertUserDataDirExists, resolveUserDataDir } from '../../shared/userDataDir';

export type DataDirSource = 'flag' | 'env' | 'default';

export interface ResolvedDataDir {
	dir: string;
	source: DataDirSource;
}

/**
 * Apply `--data-dir` (when given) and report where the directory came from.
 * Call it first in a command's action, before anything touches disk.
 */
export function applyDataDirOption(
	dataDir: string | undefined,
	env: NodeJS.ProcessEnv = process.env
): ResolvedDataDir {
	if (dataDir !== undefined && dataDir.trim() !== '') {
		const dir = resolveCliPath(dataDir);
		env.MAESTRO_USER_DATA = dir;
		return { dir, source: 'flag' };
	}
	return {
		dir: resolveUserDataDir({ env }),
		source: env.MAESTRO_USER_DATA ? 'env' : 'default',
	};
}

/** How a source reads in the startup log line. */
export function describeDataDirSource(source: DataDirSource): string {
	if (source === 'flag') return '--data-dir';
	if (source === 'env') return 'MAESTRO_USER_DATA';
	return 'platform default';
}

export interface RequireDataDirOptions {
	json?: boolean;
	/** Where a non-JSON failure is reported (the command's log sink). Defaults to `[Cue] ...` on stderr. */
	log?: (level: string, message: string) => void;
}

/**
 * Refuse to run against a data directory that does not exist, and exit 1.
 *
 * With no `--data-dir` and no `MAESTRO_USER_DATA` the directory is a GUESS (an
 * install writes `Maestro`, a dev checkout `maestro` or `maestro-dev`), and a
 * command that went ahead would answer from the wrong folder without
 * complaint: `cue engine start` would create it and run a healthy-looking
 * engine over zero agents. With `--data-dir` the path is explicit, and a typo
 * must not provision an empty data directory beside the real one. The error
 * names the folders that do exist.
 *
 * Only a missing directory is reported here; a permission or I/O error is a
 * different problem and propagates as itself.
 */
export function requireDataDirOrExit(options: RequireDataDirOptions = {}): void {
	try {
		assertUserDataDirExists(resolveUserDataDir());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message, code: 'DATA_DIR_NOT_FOUND' }));
		} else if (options.log) {
			options.log('error', message);
		} else {
			console.error(`[Cue] ${message}`);
		}
		process.exit(1);
	}
}
