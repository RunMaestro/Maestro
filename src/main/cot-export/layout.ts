/**
 * Chain of thought export: where a log lives on disk, and which folders may
 * hold one.
 *
 * The folder is chosen by the human. Inside it, one `.jsonl` file per turn:
 *
 *   <agentFolder>/YYYY/MM/DD/HH/HHmmss-<tab>-<turn>.jsonl
 *
 * The date parts are LOCAL time, filed under the hour the turn STARTED. The
 * person who reads these folders reads them on their own clock, so a UTC
 * name would read as the wrong hour to everyone outside UTC.
 *
 * `turnFileFolder`, `listTurnFiles` and `countTurnFilesOnDay` read that same
 * layout back, so the writer, the verifier and the store do not each hold a
 * copy of it.
 *
 * `validateAgentFolder` is the barrier that keeps a log out of any agent's
 * workspace and out of Maestro's own data directory. An agent searches its
 * workspace as a matter of course, and learns the data directory from its
 * environment, so a log inside either one is a log the agent finds.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isMacOS, isWindows } from '../../shared/platformDetection';
import type { CotFolderValidation } from '../../shared/cotExport/types';

/** Used in a file name when the turn has no tab. */
const NO_TAB_LABEL = 'notab';

/** How many characters of a tab id and a turn id go into a file name. */
const ID_PREFIX_LENGTH = 8;

/** Characters an id may keep in a file name. Anything else is dropped. */
const FILE_NAME_UNSAFE = /[^A-Za-z0-9_-]/g;

/**
 * The first `ID_PREFIX_LENGTH` characters of an id, with anything that is
 * not safe in a file name removed. An id that is empty after that gives
 * `fallback`.
 */
function idPrefix(id: string | undefined, fallback: string): string {
	const cleaned = (id ?? '').replace(FILE_NAME_UNSAFE, '').slice(0, ID_PREFIX_LENGTH);
	return cleaned.length > 0 ? cleaned : fallback;
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, '0');
}

/**
 * The file one turn is written to.
 *
 * All date parts come from the LOCAL clock (`getFullYear`, `getMonth`,
 * `getDate`, `getHours`). `turnStart` is the time the turn started, so a long
 * turn stays in the hour it began in.
 *
 * The tab and turn ids are cut to eight characters each. The turn id keeps
 * two turns that start in the same second apart.
 */
export function turnFilePath(
	agentFolder: string,
	turnStart: Date,
	tabId: string | undefined,
	turnId: string
): string {
	const year = pad(turnStart.getFullYear(), 4);
	const month = pad(turnStart.getMonth() + 1, 2);
	const day = pad(turnStart.getDate(), 2);
	const hour = pad(turnStart.getHours(), 2);
	const time = `${hour}${pad(turnStart.getMinutes(), 2)}${pad(turnStart.getSeconds(), 2)}`;
	const tab = idPrefix(tabId, NO_TAB_LABEL);
	const turn = idPrefix(turnId, 'noturn');
	return path.join(agentFolder, year, month, day, hour, `${time}-${tab}-${turn}.jsonl`);
}

/**
 * The agent folder a turn file lies in: the inverse of `turnFilePath`. A turn
 * file sits four folders down (year, month, day, hour), so this is five
 * levels up from the file.
 *
 * One folder holds one chain, so this is how a file names its chain.
 */
export function turnFileFolder(filePath: string): string {
	return path.resolve(filePath, '..', '..', '..', '..', '..');
}

const YEAR_FOLDER = /^\d{4}$/;
const TWO_DIGIT_FOLDER = /^\d{2}$/;
/** A turn file: `.jsonl`, and not a dotfile such as the write probe. */
const TURN_FILE = /^[^.].*\.jsonl$/;

/**
 * The names in `dir` that match `pattern`, newest first. Every name in the
 * layout is zero-padded, so name order is time order. A folder that does not
 * exist holds nothing. A symlink is not followed: Maestro creates none here.
 */
async function namesNewestFirst(
	dir: string,
	pattern: RegExp,
	kind: 'folder' | 'file'
): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return [];
		throw error;
	}
	return entries
		.filter((entry) => (kind === 'folder' ? entry.isDirectory() : entry.isFile()))
		.map((entry) => entry.name)
		.filter((name) => pattern.test(name))
		.sort()
		.reverse();
}

/**
 * Every turn file under `agentFolder`, newest first by the time its turn
 * started. Anything that is not part of the layout is left out.
 *
 * `newestHourFolders` stops the walk after that many hour folders that hold a
 * turn file, so a caller that needs only recent turns does not walk a year of
 * logs.
 */
export async function listTurnFiles(
	agentFolder: string,
	options: { newestHourFolders?: number } = {}
): Promise<string[]> {
	const limit = options.newestHourFolders ?? Infinity;
	const files: string[] = [];
	let hourFolders = 0;
	for (const year of await namesNewestFirst(agentFolder, YEAR_FOLDER, 'folder')) {
		const yearDir = path.join(agentFolder, year);
		for (const month of await namesNewestFirst(yearDir, TWO_DIGIT_FOLDER, 'folder')) {
			const monthDir = path.join(yearDir, month);
			for (const day of await namesNewestFirst(monthDir, TWO_DIGIT_FOLDER, 'folder')) {
				const dayDir = path.join(monthDir, day);
				for (const hour of await namesNewestFirst(dayDir, TWO_DIGIT_FOLDER, 'folder')) {
					const hourDir = path.join(dayDir, hour);
					const names = await namesNewestFirst(hourDir, TURN_FILE, 'file');
					if (names.length === 0) continue;
					for (const name of names) files.push(path.join(hourDir, name));
					hourFolders += 1;
					if (hourFolders >= limit) return files;
				}
			}
		}
	}
	return files;
}

/**
 * The turn files filed under the date of `day`, on the LOCAL clock: those in
 * that day's hour folders. A day with no folder has none.
 *
 * It throws when a folder exists and cannot be read.
 */
export async function listTurnFilesOnDay(agentFolder: string, day: Date): Promise<string[]> {
	const dayDir = path.join(
		agentFolder,
		pad(day.getFullYear(), 4),
		pad(day.getMonth() + 1, 2),
		pad(day.getDate(), 2)
	);
	const files: string[] = [];
	for (const hour of await namesNewestFirst(dayDir, TWO_DIGIT_FOLDER, 'folder')) {
		const hourDir = path.join(dayDir, hour);
		for (const name of await namesNewestFirst(hourDir, TURN_FILE, 'file')) {
			files.push(path.join(hourDir, name));
		}
	}
	return files;
}

/**
 * How many turns are filed under the date of `day`, on the LOCAL clock. A day
 * with no folder has none. It throws when a folder exists and cannot be read.
 */
export async function countTurnFilesOnDay(agentFolder: string, day: Date): Promise<number> {
	return (await listTurnFilesOnDay(agentFolder, day)).length;
}

/**
 * Whether a file carries the name `turnFilePath` gives the turn `turnId`,
 * whatever time it is filed under. A name holds only the first characters of
 * a turn id, so this can be true for another turn: a caller that must be sure
 * reads the file.
 */
export function isTurnFileNameOf(filePath: string, turnId: string): boolean {
	return path.basename(filePath).endsWith(`-${idPrefix(turnId, 'noturn')}.jsonl`);
}

/** A folder an agent works in, with the agent's name so a refusal can say whose it is. */
export interface AgentWorkspace {
	path: string;
	agentName: string;
}

/** What `validateAgentFolder` needs to know about the machine. */
export interface AgentFolderContext {
	/**
	 * Every folder a local agent works in, not only those of the agent being
	 * set up. A bare path is a workspace whose agent has no name to show.
	 */
	agentDirs: ReadonlyArray<string | AgentWorkspace>;
	/** Maestro's user data directory. */
	userDataPath: string;
	/**
	 * The folder the agent list and the settings were moved to, when the person
	 * moved them out of the data directory. An agent reads those files too.
	 */
	syncPath?: string;
	/** The user's home directory. */
	homeDir: string;
}

/**
 * The real path of `target`, with symlinks followed, for a path that may not
 * exist yet.
 *
 * It walks up to the nearest ancestor that exists, resolves that, and puts
 * the missing part back. A folder that does not exist yet is checked at the
 * place it WOULD be created, before anything is created there.
 */
function resolveRealPath(target: string): string {
	const absolute = path.resolve(target);
	let existing = absolute;
	const missing: string[] = [];
	while (!fs.existsSync(existing)) {
		const parent = path.dirname(existing);
		if (parent === existing) break;
		missing.unshift(path.basename(existing));
		existing = parent;
	}
	let real = existing;
	try {
		real = fs.realpathSync.native(existing);
	} catch {
		// The ancestor vanished between the check and the call. The absolute
		// path is the best answer left, and the containment checks still run.
	}
	return missing.length > 0 ? path.join(real, ...missing) : real;
}

/**
 * macOS and Windows file systems are case-insensitive by default, so
 * `/Users/me/Work` and `/users/me/work` are one folder there. Linux is not.
 */
function foldCase(p: string): string {
	return isMacOS() || isWindows() ? p.toLowerCase() : p;
}

/**
 * True when two paths name one folder, by the case rule of this machine's file
 * system. It compares the paths as written and follows no symlink, so give it
 * real paths (`validateAgentFolder` returns one).
 *
 * One folder holds one chain, so this is the test for "the same chain".
 */
export function isSameFolder(a: string, b: string): boolean {
	return a === b || foldCase(path.resolve(a)) === foldCase(path.resolve(b));
}

/**
 * True when `child` is `parent` or lies inside it. `path.relative` decides,
 * not a string prefix, so `/a/work` does not contain `/a/workshop`.
 */
function isSameOrInside(child: string, parent: string): boolean {
	const rel = path.relative(foldCase(parent), foldCase(child));
	if (rel === '') return true;
	if (path.isAbsolute(rel)) return false; // another drive on Windows
	return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** The reason `resolved` must not hold a log, or null when it may. */
function rejectionFor(resolved: string, ctx: AgentFolderContext): string | null {
	if (path.parse(resolved).root === resolved) {
		return 'The folder is the root of a drive, which is too broad to hold an agent log.';
	}
	// Only the home folder ITSELF is refused. A folder inside it is the normal
	// choice, and the workspace and data folder checks below cover the rest.
	if (ctx.homeDir && foldCase(resolved) === foldCase(resolveRealPath(ctx.homeDir))) {
		return 'The folder is your home folder, which is too broad to hold an agent log.';
	}
	// Both ways round. A log folder that CONTAINS a workspace or the data
	// folder puts its year folders beside them, where one `ls ..` lists them.
	for (const dataDir of [ctx.userDataPath, ctx.syncPath]) {
		if (!dataDir) continue;
		const real = resolveRealPath(dataDir);
		if (isSameOrInside(resolved, real)) {
			return 'The folder is inside the Maestro data folder, which agents can find from their environment.';
		}
		if (isSameOrInside(real, resolved)) {
			return 'The folder contains the Maestro data folder, so the log would lie right beside it.';
		}
	}
	const home = ctx.homeDir ? foldCase(resolveRealPath(ctx.homeDir)) : null;
	for (const entry of ctx.agentDirs) {
		const dir = typeof entry === 'string' ? entry : entry.path;
		if (!dir) continue;
		const real = resolveRealPath(dir);
		const whose =
			typeof entry === 'string' || !entry.agentName.trim()
				? 'an agent workspace'
				: `the workspace of ${entry.agentName.trim()} (${real})`;
		// An agent that works in the home folder or at a drive root would fence
		// off every folder a log can sensibly go in. Such a workspace is as
		// broad as the home folder, so it is judged by the home rule above: only
		// the folder itself is refused, not the folders inside it.
		const tooBroad = path.parse(real).root === real || foldCase(real) === home;
		if (!tooBroad && isSameOrInside(resolved, real)) {
			return `The folder is inside ${whose}, where that agent could read it.`;
		}
		if (isSameOrInside(real, resolved)) {
			return `The folder contains ${whose}, so the log would lie right beside it.`;
		}
	}
	return null;
}

/** Why a folder could not be created or written, in one sentence. */
function describeFsError(action: string, error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code ? `Maestro could not ${action} (${code}).` : `Maestro could not ${action}.`;
}

/**
 * Whether `candidate` may hold an agent's log, and the real path to store.
 *
 * It rejects a relative path, the root of a drive, the home folder itself,
 * any folder equal to or inside a folder ANY agent works in (an agent can
 * read another agent's workspace; a workspace that is the home folder or a
 * drive root fences off only itself), any folder equal to or inside Maestro's
 * data directory or the folder its agent list was moved to, and any folder
 * that contains one of those.
 *
 * Symlinks are followed before the checks, so a link that points into a
 * workspace is judged by where it lands. The folder is created when it does
 * not exist, but only after the checks pass on the place it would be created.
 * The final real path is checked once more after creation. The folder must
 * also be writable, which is probed by creating and removing a scratch file.
 * That file is never a log, so removing it does not break the rule that
 * Maestro never deletes a log file.
 */
export function validateAgentFolder(
	candidate: string,
	ctx: AgentFolderContext
): CotFolderValidation {
	if (typeof candidate !== 'string' || candidate.trim() === '') {
		return { ok: false, reason: 'Choose a folder to hold the log.' };
	}
	if (!path.isAbsolute(candidate)) {
		return { ok: false, reason: 'The folder must be an absolute path, not a relative one.' };
	}

	const planned = resolveRealPath(candidate);
	const plannedRejection = rejectionFor(planned, ctx);
	if (plannedRejection) return { ok: false, reason: plannedRejection };

	try {
		fs.mkdirSync(planned, { recursive: true });
	} catch (error) {
		// A file at that path (or at one of its parents) is the realistic cause.
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === 'EEXIST' || code === 'ENOTDIR') {
			return { ok: false, reason: 'That path is a file, not a folder.' };
		}
		return { ok: false, reason: describeFsError('create the folder', error) };
	}

	let resolved: string;
	try {
		resolved = fs.realpathSync.native(planned);
		if (!fs.statSync(resolved).isDirectory()) {
			return { ok: false, reason: 'That path is a file, not a folder.' };
		}
	} catch (error) {
		return { ok: false, reason: describeFsError('read the folder', error) };
	}

	const finalRejection = rejectionFor(resolved, ctx);
	if (finalRejection) return { ok: false, reason: finalRejection };

	const probe = path.join(
		resolved,
		`.maestro-write-probe-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
	);
	try {
		fs.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
		fs.unlinkSync(probe);
	} catch (error) {
		return { ok: false, reason: describeFsError('write to the folder', error) };
	}

	return { ok: true, resolved };
}
