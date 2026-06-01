/**
 * Playbooks Folder Migration
 *
 * One-shot move of legacy Auto Run document folders from the old
 * `<root>/Auto Run Docs` location to the canonical `<root>/.maestro/playbooks`
 * (see `PLAYBOOKS_DIR` / `LEGACY_PLAYBOOKS_DIR` in `src/shared/maestro-paths.ts`).
 *
 * Two things happen, both keyed off the legacy folder name so intentional
 * custom Auto Run folders are never touched:
 *   1. On disk: every distinct `<root>/Auto Run Docs` directory referenced by a
 *      session is moved (or merged) into `<root>/.maestro/playbooks`.
 *   2. In the sessions store: any session whose `autoRunFolderPath` still points
 *      at a legacy `Auto Run Docs` folder is repointed to `.maestro/playbooks`.
 *
 * Idempotent via a marker in the settings store. Sessions with an unset
 * `autoRunFolderPath` need no repoint - they already resolve to the canonical
 * folder at runtime - and sessions pointed at a custom (non-legacy) folder are
 * left exactly as the user configured them.
 */

import * as fs from 'fs';
import * as path from 'path';

import type Store from 'electron-store';

import { PLAYBOOKS_DIR, LEGACY_PLAYBOOKS_DIR } from '../../../shared/maestro-paths';
import { logger } from '../../utils/logger';
import { getSessionsStore } from '../getters';
import type { MaestroSettings, StoredSession } from '../types';

/** Settings key marking the one-time playbooks-folder migration as done. */
export const PLAYBOOKS_FOLDER_MIGRATION_MARKER = 'migration_playbooksFolderV1';

const LOG_CONTEXT = 'Migration';

/** True when `folderPath`'s final segment is the legacy "Auto Run Docs" name. */
function isLegacyFolder(folderPath: string): boolean {
	return path.basename(folderPath) === LEGACY_PLAYBOOKS_DIR;
}

/** Canonical `.maestro/playbooks` path for the project root that owns `legacyDir`. */
function canonicalFor(legacyDir: string): string {
	return path.join(path.dirname(legacyDir), PLAYBOOKS_DIR);
}

/**
 * Move a single legacy `Auto Run Docs` directory to its canonical
 * `.maestro/playbooks` location. Returns true if a move/merge happened.
 *
 * - No canonical folder yet: rename the legacy folder into place.
 * - Canonical folder exists: copy legacy contents in WITHOUT overwriting
 *   existing canonical files (canonical wins on name collisions), then remove
 *   the now-redundant legacy folder.
 */
function moveLegacyFolder(legacyDir: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(legacyDir);
	} catch {
		return false; // Legacy folder doesn't exist - nothing to move.
	}
	if (!stat.isDirectory()) {
		return false;
	}

	const canonicalDir = canonicalFor(legacyDir);

	if (!fs.existsSync(canonicalDir)) {
		// Ensure the `.maestro` parent exists, then move the whole folder.
		fs.mkdirSync(path.dirname(canonicalDir), { recursive: true });
		fs.renameSync(legacyDir, canonicalDir);
	} else {
		// Merge without clobbering anything already in the canonical folder.
		fs.cpSync(legacyDir, canonicalDir, {
			recursive: true,
			force: false,
			errorOnExist: false,
		});
		fs.rmSync(legacyDir, { recursive: true, force: true });
	}
	return true;
}

/**
 * Migrate legacy Auto Run folders to `.maestro/playbooks` once. Reads/writes the
 * sessions store directly; guarded by a marker in the passed settings store.
 */
export function migratePlaybooksFolder(store: Store<MaestroSettings>): void {
	if (store.get(PLAYBOOKS_FOLDER_MIGRATION_MARKER)) {
		return;
	}

	const sessionsStore = getSessionsStore();
	const sessions = sessionsStore.get('sessions', []) as StoredSession[];

	// 1. Collect every distinct legacy folder referenced by a session - both the
	//    conventional `<projectRoot>/Auto Run Docs` and any explicit
	//    `autoRunFolderPath` still pointing at a legacy folder.
	const legacyDirs = new Set<string>();
	for (const session of sessions) {
		if (session.projectRoot) {
			legacyDirs.add(path.join(session.projectRoot, LEGACY_PLAYBOOKS_DIR));
		}
		const arp = session.autoRunFolderPath;
		if (typeof arp === 'string' && isLegacyFolder(arp)) {
			legacyDirs.add(arp);
		}
	}

	let foldersMoved = 0;
	for (const legacyDir of legacyDirs) {
		try {
			if (moveLegacyFolder(legacyDir)) {
				foldersMoved++;
				logger.info(
					`Moved legacy Auto Run folder: ${legacyDir} -> ${canonicalFor(legacyDir)}`,
					LOG_CONTEXT
				);
			}
		} catch (error) {
			// A single project's move failing must not block the rest or the
			// marker - log and carry on. Sentry captures via the logger.
			logger.error(`Failed to move legacy Auto Run folder: ${legacyDir}`, LOG_CONTEXT, error);
		}
	}

	// 2. Repoint sessions whose stored path still names the legacy folder.
	let repointed = 0;
	const nextSessions = sessions.map((session) => {
		const arp = session.autoRunFolderPath;
		if (typeof arp === 'string' && isLegacyFolder(arp)) {
			repointed++;
			return { ...session, autoRunFolderPath: canonicalFor(arp) };
		}
		return session;
	});
	if (repointed > 0) {
		sessionsStore.set('sessions', nextSessions);
	}

	store.set(PLAYBOOKS_FOLDER_MIGRATION_MARKER, true);
	logger.info(
		`Playbooks folder migration complete - moved ${foldersMoved} legacy folder(s), repointed ${repointed} agent(s) to ${PLAYBOOKS_DIR}`,
		LOG_CONTEXT
	);
}
