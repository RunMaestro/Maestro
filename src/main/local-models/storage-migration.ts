/**
 * One-time move of model and runtime installs out of the legacy A Cappella roots.
 *
 *   userData/models/acappella/<id>/    ->  userData/models/<id>/
 *   userData/runtimes/acappella/<id>/  ->  userData/runtimes/<id>/
 *
 * Voice was the first consumer of local models, so their stores were named for
 * it. Local Models is now a core service with its own roots, and an install that
 * already cost the user a gigabyte of bandwidth must not cost it again because a
 * directory was renamed. So every entry is MOVED (`fs.rename`, same volume, no
 * copy), never re-downloaded and never deleted.
 *
 * Rules the migration holds, each because of a way it could otherwise lose data:
 *
 *   - Idempotent. It runs on every startup; once there is nothing to move it is a
 *     single failed `readdir`.
 *   - Crash-tolerant. A rename is atomic, so a crash halfway leaves some entries
 *     moved and some not. The next run simply moves what is left.
 *   - Never clobbers. When the target already exists (an install made in the new
 *     root while the old one sat there), the legacy copy is left exactly where it
 *     is and logged. Choosing between two installs is not this function's call.
 *   - Never deletes bytes. The legacy root is removed with `rmdir`, which refuses
 *     a non-empty directory, so only an empty shell can go.
 *
 * Runs at app startup before any store is read, regardless of whether A Cappella
 * is enabled: the stores belong to the core service, not to voice.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { logger } from '../utils/logger';
import { LOCAL_MODELS_DIRNAME, LOCAL_RUNTIMES_DIRNAME, localModelsDataDir } from './paths';

const LOG_CONTEXT = 'LocalModels';

/** Directory name the legacy roots used under each store root. */
export const LEGACY_ACAPPELLA_DIRNAME = 'acappella';

/** What one legacy root's migration did. */
export interface LegacyRootMigration {
	/** Absolute path of the legacy root that was examined. */
	legacyRoot: string;
	/** Absolute path of the root entries were moved into. */
	targetRoot: string;
	/** Entry names moved into the new root. */
	moved: string[];
	/** Entry names left behind because the target already exists. */
	skipped: string[];
	/** True when the (now empty) legacy root was removed. */
	removedLegacyRoot: boolean;
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === code;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error) {
		if (isErrno(error, 'ENOENT')) return false;
		throw error;
	}
}

/**
 * Move every entry of `targetRoot/acappella/` up into `targetRoot/`.
 *
 * Exported for tests; production calls {@link migrateLegacyLocalModelStorage}.
 */
export async function migrateLegacyRoot(targetRoot: string): Promise<LegacyRootMigration> {
	const legacyRoot = path.join(targetRoot, LEGACY_ACAPPELLA_DIRNAME);
	const result: LegacyRootMigration = {
		legacyRoot,
		targetRoot,
		moved: [],
		skipped: [],
		removedLegacyRoot: false,
	};

	let names: string[];
	try {
		names = await fs.readdir(legacyRoot);
	} catch (error) {
		// No legacy root is the steady state after the first successful run.
		if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return result;
		throw error;
	}

	for (const name of names) {
		const from = path.join(legacyRoot, name);
		const to = path.join(targetRoot, name);
		if (await pathExists(to)) {
			result.skipped.push(name);
			logger.warn(
				`Local model storage migration left ${from} in place: ${to} already exists`,
				LOG_CONTEXT
			);
			continue;
		}
		await fs.rename(from, to);
		result.moved.push(name);
		logger.info(`Local model storage migration moved ${from} -> ${to}`, LOG_CONTEXT);
	}

	try {
		await fs.rmdir(legacyRoot);
		result.removedLegacyRoot = true;
	} catch (error) {
		// Not empty means something was skipped (or appeared meanwhile). It stays,
		// and the store reports it as a stray directory the user can reclaim.
		if (!isErrno(error, 'ENOTEMPTY') && !isErrno(error, 'EEXIST') && !isErrno(error, 'ENOENT')) {
			throw error;
		}
	}

	return result;
}

/**
 * Migrate both the model and the runtime store. Call once at startup, before
 * anything reads either store.
 */
export async function migrateLegacyLocalModelStorage(
	dataDir: string = localModelsDataDir()
): Promise<LegacyRootMigration[]> {
	const results: LegacyRootMigration[] = [];
	for (const dirname of [LOCAL_MODELS_DIRNAME, LOCAL_RUNTIMES_DIRNAME]) {
		results.push(await migrateLegacyRoot(path.join(dataDir, dirname)));
	}
	return results;
}
