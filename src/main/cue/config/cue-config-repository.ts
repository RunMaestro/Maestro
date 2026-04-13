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
	if (!absPath.startsWith(promptsDir + path.sep) && absPath !== promptsDir) {
		throw new Error(
			`writeCuePromptFile: path "${relativePath}" resolves outside the prompts directory`
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
		} catch {
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
			} catch {
				// Ignore — a file we can't delete is not worth failing the save.
			}
		}
	};
	walk(promptsDir);
	return removed;
}

/**
 * Watches both canonical and legacy Cue config paths.
 * Debounces onChange by 1 second.
 */
export function watchCueConfigFile(projectRoot: string, onChange: () => void): () => void {
	const canonicalPath = path.join(projectRoot, CUE_CONFIG_PATH);
	const legacyPath = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = chokidar.watch([canonicalPath, legacyPath], {
		persistent: true,
		ignoreInitial: true,
	});

	const debouncedOnChange = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			onChange();
		}, 1000);
	};

	watcher.on('add', debouncedOnChange);
	watcher.on('change', debouncedOnChange);
	watcher.on('unlink', debouncedOnChange);

	return () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		watcher.close();
	};
}
