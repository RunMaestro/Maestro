/**
 * Read-only access to an agent's User Journey
 * (`<userData>/journey/<agentId>.jsonl`).
 *
 * The desktop's store (`src/main/user-journey-manager.ts`) owns these files: it
 * appends and prunes them. A second process doing either would race those
 * writes, so this reader only reads. `maestro-cli journey` and the system
 * prompt builders that run outside Electron (the CLI and the TUI) read through
 * it.
 *
 * Parsing, limits, and filters are the store's own (`src/shared/userJourney.ts`),
 * so the two cannot disagree about what a file holds. Nothing here throws: a
 * missing or unreadable file reads as no entries.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
	applyJourneyLimits,
	filterJourneyEntries,
	JOURNEY_DIR_NAME,
	journeyFileName,
	parseJourneyJsonl,
	type ReadJourneyOptions,
	type UserJourneyEntry,
} from '../../userJourney';

/** Path to an agent's journey file under Maestro's data directory (never the sync directory). */
export function journeyFilePath(userDataDir: string, agentId: string): string {
	return path.join(userDataDir, JOURNEY_DIR_NAME, journeyFileName(agentId));
}

/**
 * The entries of one journey file, oldest first, inside retention and the
 * entry cap, with `options` applied the way the desktop's `journey:read` does.
 */
export function readJourneyFile(
	file: string,
	options: ReadJourneyOptions = {},
	now: number = Date.now()
): UserJourneyEntry[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, 'utf-8');
	} catch {
		return [];
	}
	return filterJourneyEntries(applyJourneyLimits(parseJourneyJsonl(raw), now), options);
}
