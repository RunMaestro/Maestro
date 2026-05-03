/**
 * Cue config repository — single owner of `.maestro/cue.yaml` and the
 * `.maestro/prompts/` directory on disk. All filesystem reads, writes, deletes,
 * and watches for Cue config files flow through this module so that path
 * resolution, directory creation, and the canonical-vs-legacy fallback are
 * encoded in exactly one place.
 *
 * Callers should NOT touch fs/path directly for `.maestro/cue.yaml` files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import {
	CUE_CONFIG_PATH,
	CUE_PROMPTS_DIR,
	LEGACY_CUE_CONFIG_PATH,
	MAESTRO_DIR,
} from '../../../shared/maestro-paths';
import { captureException } from '../../utils/sentry';
import { logger } from '../../utils/logger';

/**
 * Resolve the cue config file path, preferring `.maestro/cue.yaml`
 * with fallback to legacy `maestro-cue.yaml`. Returns `null` if neither exists.
 */
export function resolveCueConfigPath(projectRoot: string): string | null {
	const canonical = path.join(projectRoot, CUE_CONFIG_PATH);
	if (fs.existsSync(canonical)) return canonical;
	const legacy = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	if (fs.existsSync(legacy)) return legacy;
	return null;
}

/**
 * Read the raw YAML for a project's Cue config. Returns `null` if no config
 * file exists. Throws on filesystem read errors (other than missing file).
 */
export function readCueConfigFile(projectRoot: string): { filePath: string; raw: string } | null {
	const filePath = resolveCueConfigPath(projectRoot);
	if (!filePath) {
		return null;
	}

	return {
		filePath,
		raw: fs.readFileSync(filePath, 'utf-8'),
	};
}

/**
 * Write the raw YAML for a project's Cue config to the canonical path.
 * Creates `.maestro/` if it does not exist. Returns the absolute path written.
 *
 * Note: this always writes to the canonical `.maestro/cue.yaml`, never the
 * legacy `maestro-cue.yaml` location, so saves implicitly migrate the file.
 */
export function writeCueConfigFile(projectRoot: string, content: string): string {
	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}
	const filePath = path.join(projectRoot, CUE_CONFIG_PATH);
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

/**
 * Delete a project's Cue config file (canonical or legacy, whichever exists).
 * Returns `true` if a file was deleted, `false` if there was nothing to delete.
 */
export function deleteCueConfigFile(projectRoot: string): boolean {
	const filePath = resolveCueConfigPath(projectRoot);
	if (!filePath) {
		return false;
	}
	fs.unlinkSync(filePath);
	return true;
}

/**
 * Remove `.maestro/prompts/` if it exists and contains no files. Called
 * after pruning with an empty keep-set (e.g. from `cue:deleteYaml`) so
 * the project's `.maestro` footprint collapses cleanly. Non-empty
 * directories are left alone — a non-`.md` file the user placed here
 * manually is none of Cue's business.
 *
 * Returns `true` if the directory was removed, `false` otherwise. Swallows
 * errors (reports to Sentry) so callers can run this as best-effort
 * cleanup without failing the surrounding operation.
 */
export function removeEmptyPromptsDir(projectRoot: string): boolean {
	const promptsDir = path.resolve(path.join(projectRoot, CUE_PROMPTS_DIR));
	if (!fs.existsSync(promptsDir)) return false;
	try {
		const entries = fs.readdirSync(promptsDir);
		if (entries.length > 0) return false;
		fs.rmdirSync(promptsDir);
		return true;
	} catch (err) {
		captureException(err, {
			operation: 'removeEmptyPromptsDir',
			dir: promptsDir,
		});
		return false;
	}
}

/**
 * Remove `.maestro/` if it exists and is completely empty. Called after
 * deleting `cue.yaml` (and after pruning prompts) so the project's footprint
 * collapses fully when there is nothing left to own. Non-empty directories
 * are left untouched — user-placed files (memories, other configs) are none
 * of Cue's business.
 *
 * Returns `true` if the directory was removed, `false` otherwise. Swallows
 * errors (reports to Sentry) so callers can use this as best-effort cleanup.
 */
export function removeEmptyMaestroDir(projectRoot: string): boolean {
	const maestroDir = path.resolve(path.join(projectRoot, MAESTRO_DIR));
	if (!fs.existsSync(maestroDir)) return false;
	try {
		const entries = fs.readdirSync(maestroDir);
		if (entries.length > 0) return false;
		fs.rmdirSync(maestroDir);
		return true;
	} catch (err) {
		captureException(err, {
			operation: 'removeEmptyMaestroDir',
			dir: maestroDir,
		});
		return false;
	}
}

/**
 * Write a Cue prompt file (a .md file referenced by `prompt_file:` in YAML).
 *
 * `relativePath` is interpreted relative to `projectRoot`. Parent directories
 * are created as needed. Callers typically pass paths under `.maestro/prompts/`
 * (see {@link CUE_PROMPTS_DIR}).
 */
export function writeCuePromptFile(
	projectRoot: string,
	relativePath: string,
	content: string
): string {
	if (path.isAbsolute(relativePath)) {
		throw new Error(`writeCuePromptFile: relativePath must be relative, got "${relativePath}"`);
	}
	const promptsDir = path.resolve(path.join(projectRoot, CUE_PROMPTS_DIR));
	const absPath = path.resolve(path.join(projectRoot, relativePath));
	// Must be strictly inside .maestro/prompts/ — equality with promptsDir would
	// mean the caller asked to write to the directory path itself.
	if (!absPath.startsWith(promptsDir + path.sep)) {
		throw new Error(
			`writeCuePromptFile: path "${relativePath}" resolves outside the prompts directory`
		);
	}
	// Must be a .md file — pruneOrphanedPromptFiles only removes .md files,
	// so any other extension would create a permanently orphaned file. Enforce
	// the same trust boundary here as in the IPC layer (defense in depth).
	if (path.extname(absPath).toLowerCase() !== '.md') {
		throw new Error(`writeCuePromptFile: path "${relativePath}" must end with .md`);
	}
	const dir = path.dirname(absPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(absPath, content, 'utf-8');
	return absPath;
}

/**
 * Remove `.md` files under `.maestro/prompts/` that are not referenced by the
 * current YAML. Called after a successful `cue:writeYaml` so that renames and
 * deletions do not leave orphan prompt files behind.
 *
 * `referencedRelativePaths` is the set of project-root-relative paths the YAML
 * references (via `prompt_file` / `output_prompt_file`). Any `.md` file inside
 * `.maestro/prompts/` whose relative path is not in this set is deleted.
 *
 * Silently skips when the prompts directory does not exist. Errors on
 * individual files are swallowed to keep the save path non-fatal.
 */
export function pruneOrphanedPromptFiles(
	projectRoot: string,
	referencedRelativePaths: Iterable<string>
): string[] {
	const promptsDir = path.resolve(path.join(projectRoot, CUE_PROMPTS_DIR));
	if (!fs.existsSync(promptsDir)) return [];

	const keep = new Set<string>();
	for (const rel of referencedRelativePaths) {
		if (path.isAbsolute(rel)) continue;
		keep.add(path.resolve(path.join(projectRoot, rel)));
	}

	const removed: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			// Don't re-throw: pruning runs AFTER a successful YAML write, and
			// re-throwing here would surface a failed-save toast to the user
			// even though the YAML did persist. Report to Sentry so we can see
			// readdir failures in production, then continue (skip this dir).
			captureException(err, { operation: 'pruneOrphanedPromptFiles.readdir', dir });
			return;
		}
		for (const entry of entries) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
				continue;
			}
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
			// Defense-in-depth: only touch files strictly inside the prompts dir.
			if (!abs.startsWith(promptsDir + path.sep)) continue;
			if (keep.has(abs)) continue;
			try {
				fs.unlinkSync(abs);
				removed.push(abs);
			} catch (err) {
				// Same rationale as readdir: never let a per-file delete
				// failure poison a successful save. Report and move on.
				captureException(err, { operation: 'pruneOrphanedPromptFiles.unlink', file: abs });
			}
		}
	};
	walk(promptsDir);
	return removed;
}

/**
 * Watches both canonical and legacy Cue config paths, plus every `.md` file
 * under `.maestro/prompts/`. Debounces onChange by 1 second.
 *
 * Prompt files are watched so that a "YAML written first, prompt files
 * written later" sequence — common when an agent uses a generic file-write
 * tool instead of `cue:writeYaml` — still triggers a reload once the
 * referenced prompt files appear on disk. Without this, the YAML watcher
 * fires a reload while the prompt files are missing, the normalizer caches
 * empty prompts, and the editor renders blank textareas indefinitely
 * because no subsequent YAML change ever re-triggers the reload.
 *
 * Uses a `torn` flag and instance check so any event that slips past
 * `watcher.close()` (chokidar emits an `unlink` for in-flight events on some
 * platforms) is rejected — preventing a stale watcher from triggering a
 * refresh on a session that has been torn down or re-registered.
 *
 * `opts.onReady` fires once chokidar finishes its initial scan — use it in
 * tests so they don't have to sleep on a timer while chokidar registers
 * watched paths (that sleep was a flakiness source on slow CI runners).
 * Production callers can ignore the opt; file changes before `ready` are
 * uncommon for config reloads triggered by the user.
 */
export function watchCueConfigFile(
	projectRoot: string,
	onChange: () => void,
	opts?: { onReady?: () => void }
): () => void {
	const canonicalPath = path.join(projectRoot, CUE_CONFIG_PATH);
	const legacyPath = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	// Glob pattern (chokidar v3 supports globs in absolute paths). Matches
	// every `.md` file directly inside `.maestro/prompts/` — recursive
	// subdirectories aren't part of the prompt layout, so a single-level
	// glob keeps the watch set focused. The directory itself can be missing;
	// chokidar starts watching once it appears.
	const promptsGlob = path.join(projectRoot, CUE_PROMPTS_DIR, '*.md');
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let torn = false;

	const watcher = chokidar.watch([canonicalPath, legacyPath, promptsGlob], {
		persistent: true,
		ignoreInitial: true,
	});

	// Swallow chokidar errors (EISDIR on WSL network paths, ENOENT races, permission
	// changes). Without a listener, these bubble as unhandled promise rejections and
	// crash the main process. The watcher recovers on its own for transient issues.
	watcher.on('error', (error) => {
		logger.warn(
			`[Cue] Config file watcher error for ${projectRoot}: ${String(error)}`,
			'CueConfig'
		);
	});

	const debouncedOnChange = () => {
		if (torn) return;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			if (torn) return;
			onChange();
		}, 1000);
	};

	watcher.on('add', debouncedOnChange);
	watcher.on('change', debouncedOnChange);
	watcher.on('unlink', debouncedOnChange);
	if (opts?.onReady) {
		watcher.once('ready', opts.onReady);
	}

	return () => {
		torn = true;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		watcher.close();
	};
}
