/**
 * TTSR config repository - single owner of `.maestro/ttsr.yaml` and the
 * `.maestro/rules/` directory on disk. All filesystem reads, writes, deletes,
 * and watches for TTSR config files flow through this module so path
 * resolution and directory creation live in exactly one place.
 *
 * Mirrors `src/main/cue/config/cue-config-repository.ts`. Callers should NOT
 * touch fs/path directly for TTSR files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import { MAESTRO_DIR, TTSR_CONFIG_PATH, TTSR_RULES_DIR } from '../../../shared/maestro-paths';
import { captureException } from '../../utils/sentry';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'TtsrConfig';

/**
 * Resolve the TTSR config file path. Returns `null` when the project has no
 * `.maestro/ttsr.yaml` (which is fine - rules alone are a valid setup).
 */
export function resolveTtsrConfigPath(projectRoot: string): string | null {
	const canonical = path.join(projectRoot, TTSR_CONFIG_PATH);
	return fs.existsSync(canonical) ? canonical : null;
}

/**
 * Read the raw YAML for a project's TTSR config. Returns `null` when the file
 * does not exist. Throws on filesystem read errors other than a missing file.
 */
export function readTtsrConfigFile(projectRoot: string): { filePath: string; raw: string } | null {
	const filePath = resolveTtsrConfigPath(projectRoot);
	if (!filePath) return null;
	return { filePath, raw: fs.readFileSync(filePath, 'utf-8') };
}

/**
 * Write the raw YAML for a project's TTSR config. Creates `.maestro/` if
 * needed. Returns the absolute path written.
 */
export function writeTtsrConfigFile(projectRoot: string, content: string): string {
	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}
	const filePath = path.join(projectRoot, TTSR_CONFIG_PATH);
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

/**
 * Delete a project's TTSR config file. Returns `true` when a file was removed.
 */
export function deleteTtsrConfigFile(projectRoot: string): boolean {
	const filePath = resolveTtsrConfigPath(projectRoot);
	if (!filePath) return false;
	fs.unlinkSync(filePath);
	return true;
}

/**
 * Resolve a project-relative rule path to an absolute path inside
 * `.maestro/rules/`, or `null` when it escapes the directory or is not a
 * `.md` file. The path-containment check is the trust boundary for every
 * rule read/write.
 */
function resolveRulePathInside(projectRoot: string, relativePath: string): string | null {
	if (path.isAbsolute(relativePath)) return null;
	const rulesDir = path.resolve(path.join(projectRoot, TTSR_RULES_DIR));
	const absPath = path.resolve(path.join(projectRoot, relativePath));
	if (!absPath.startsWith(rulesDir + path.sep)) return null;
	if (path.extname(absPath).toLowerCase() !== '.md') return null;
	return absPath;
}

/**
 * List every rule file in `.maestro/rules/`, as project-relative paths sorted
 * by filename. Sort order is what makes the loader's name-collision
 * "first-wins" precedence deterministic across platforms.
 *
 * Returns `[]` when the directory does not exist.
 */
export function listTtsrRuleFiles(projectRoot: string): string[] {
	const rulesDir = path.join(projectRoot, TTSR_RULES_DIR);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(rulesDir, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return [];
		throw err;
	}

	return entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b))
		.map((name) => `${TTSR_RULES_DIR}/${name}`);
}

/**
 * Read a rule file's content. Returns `null` when the file is missing or the
 * path resolves outside `.maestro/rules/`.
 */
export function readTtsrRuleFile(projectRoot: string, relativePath: string): string | null {
	const absPath = resolveRulePathInside(projectRoot, relativePath);
	if (!absPath) return null;
	try {
		return fs.readFileSync(absPath, 'utf-8');
	} catch {
		return null;
	}
}

/**
 * Write a rule file under `.maestro/rules/`. Creates the directory as needed.
 * Throws when `relativePath` escapes the rules directory or is not `.md`.
 */
export function writeTtsrRuleFile(
	projectRoot: string,
	relativePath: string,
	content: string
): string {
	const absPath = resolveRulePathInside(projectRoot, relativePath);
	if (!absPath) {
		throw new Error(
			`writeTtsrRuleFile: path "${relativePath}" must be a relative .md path inside ${TTSR_RULES_DIR}`
		);
	}
	const dir = path.dirname(absPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(absPath, content, 'utf-8');
	return absPath;
}

/**
 * Delete a rule file. Returns `true` when a file was removed, `false` when it
 * was missing or the path resolved outside `.maestro/rules/`.
 */
export function deleteTtsrRuleFile(projectRoot: string, relativePath: string): boolean {
	const absPath = resolveRulePathInside(projectRoot, relativePath);
	if (!absPath || !fs.existsSync(absPath)) return false;
	try {
		fs.unlinkSync(absPath);
		return true;
	} catch (err) {
		captureException(err, { operation: 'deleteTtsrRuleFile', file: absPath });
		return false;
	}
}

/**
 * Watch `.maestro/ttsr.yaml` plus every `.md` file directly under
 * `.maestro/rules/`, debouncing `onChange` by 1 second.
 *
 * The watch is anchored on the `.maestro` directory rather than on those two
 * targets directly, because chokidar 3 silently watches NOTHING when it is
 * handed a path that does not exist yet inside a dot-directory - and one such
 * path poisons every sibling passed in the same call. `.maestro/ttsr.yaml` is
 * optional (rules alone are a valid setup), so listing it meant the common
 * project got no rule-file events at all and edits never reloaded. The
 * `ignored` predicate keeps the watch as narrow as the old path list: the rest
 * of `.maestro` (Working docs, cue.yaml, diagrams) is never traversed.
 *
 * The anchor itself gets the same treatment: chokidar cannot watch a path that
 * does not exist when the watcher is created, and the runtime arms this watcher
 * once per project and never re-arms it. In a project with no `.maestro` yet
 * (the fresh-repo case, where the agent authoring the FIRST rule is the primary
 * flow and writes with its own file tools, never through IPC), the watcher
 * would be born dead and stay dead for the life of the app. So the directory is
 * created up front - the same `mkdir -p` the write paths above already do. A
 * project where that fails (read-only checkout) throws out to the runtime's
 * existing unwatchable-project handling.
 *
 * Uses the same `torn` guard as the Cue watcher so an event that slips past
 * `close()` cannot trigger a refresh on a torn-down session.
 *
 * `opts.onReady` fires once chokidar finishes its initial scan - tests use it
 * instead of sleeping on a timer.
 */
export function watchTtsrConfigFiles(
	projectRoot: string,
	onChange: () => void,
	opts?: { onReady?: () => void }
): () => void {
	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	const configPath = path.join(projectRoot, TTSR_CONFIG_PATH);
	const rulesDir = path.join(projectRoot, TTSR_RULES_DIR);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let torn = false;

	// A missing anchor means a watcher that never fires (see the doc comment).
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}

	const isWatched = (filePath: string): boolean => {
		if (filePath === maestroDir || filePath === rulesDir || filePath === configPath) return true;
		return path.dirname(filePath) === rulesDir && path.extname(filePath).toLowerCase() === '.md';
	};

	const watcher = chokidar.watch(maestroDir, {
		persistent: true,
		ignoreInitial: true,
		// `.maestro/rules/*.md` is one level below the anchor.
		depth: 1,
		ignored: (filePath: string) => !isWatched(filePath),
	});

	// Without an error listener, chokidar failures (EISDIR on WSL network
	// paths, ENOENT races) bubble as unhandled rejections and crash main.
	watcher.on('error', (error) => {
		logger.warn(`Rule watcher error for ${projectRoot}: ${String(error)}`, LOG_CONTEXT);
	});

	const debouncedOnChange = () => {
		if (torn) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			if (torn) return;
			onChange();
		}, 1000);
	};

	watcher.on('add', debouncedOnChange);
	watcher.on('change', debouncedOnChange);
	watcher.on('unlink', debouncedOnChange);
	if (opts?.onReady) watcher.once('ready', opts.onReady);

	return () => {
		torn = true;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		watcher.close();
	};
}
