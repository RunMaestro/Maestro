// Clean playbooks command
// Removes orphaned playbooks (playbooks for sessions that no longer exist)

import * as fs from 'fs';
import * as path from 'path';
import {
	readSessions,
	getConfigDirectory,
	getSyncDir,
	getSyncDirFallbackReason,
} from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

interface CleanPlaybooksOptions {
	json?: boolean;
	dryRun?: boolean;
	force?: boolean;
}

interface OrphanScan {
	orphaned: Array<{ sessionId: string; filePath: string }>;
	/** How many agents the CLI read. Zero is not believed without `--force`. */
	agentCount: number;
}

/** A guard stopped the run before it listed or removed anything. The message says why. */
class CleanRefusedError extends Error {}

/**
 * Get the playbooks directory path
 */
function getPlaybooksDir(): string {
	return path.join(getConfigDirectory(), 'playbooks');
}

/**
 * Find orphaned playbook files (files for sessions that no longer exist)
 */
function findOrphanedPlaybooks(): OrphanScan {
	const playbooksDir = getPlaybooksDir();
	const scan: OrphanScan = { orphaned: [], agentCount: 0 };

	try {
		if (!fs.existsSync(playbooksDir)) {
			return scan;
		}

		const sessions = readSessions();
		scan.agentCount = sessions.length;
		const sessionIds = new Set(sessions.map((s) => s.id));

		const files = fs.readdirSync(playbooksDir);

		for (const file of files) {
			if (!file.endsWith('.json')) continue;

			const sessionId = file.replace('.json', '');
			if (!sessionIds.has(sessionId)) {
				scan.orphaned.push({
					sessionId,
					filePath: path.join(playbooksDir, file),
				});
			}
		}

		return scan;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return scan;
		}
		throw error;
	}
}

/**
 * Why the orphan list cannot be believed, or undefined when it can.
 *
 * A playbook is an orphan when its agent is not in the list `readSessions()`
 * returned, and a removed file does not come back. So a wrong list turns live
 * playbooks into deletions. Two ways the list is wrong:
 *
 * - The Storage Location the settings name is missing (an unmounted drive) or
 *   refused. The CLI then reads the config directory's copy of the agents, which
 *   is empty or old, while the app uses another. `--force` does not override
 *   this: no flag makes that list the app's list.
 * - The list is empty, so every playbook is an orphan. A real cleanup after the
 *   user deleted every agent looks the same as a wrong data folder, so this one
 *   needs `--force`.
 */
function untrustedListReason(
	orphanedCount: number,
	agentCount: number,
	force: boolean
): string | undefined {
	const fallbackReason = getSyncDirFallbackReason();
	if (fallbackReason) {
		return (
			`Nothing was removed. The Storage Location in Settings > General is not in use (${fallbackReason}), ` +
			`so maestro-cli read the agents from ${getSyncDir()}. That list can be empty or out of date, ` +
			'and playbooks of live agents would look orphaned. ' +
			'Restore the folder, or choose Use Default in Settings > General > Storage Location, ' +
			'then run this command again. --force does not override this check.'
		);
	}
	if (agentCount === 0 && !force) {
		return (
			`Nothing was removed. maestro-cli found no agents in ${getSyncDir()}, ` +
			`so all ${orphanedCount} playbook file(s) would look orphaned. ` +
			'If maestro-cli reads the wrong data folder, set MAESTRO_USER_DATA to the right one. ' +
			'If you deleted every agent on purpose, run this command again with --force.'
		);
	}
	return undefined;
}

export function cleanPlaybooks(options: CleanPlaybooksOptions): void {
	try {
		const { orphaned, agentCount } = findOrphanedPlaybooks();

		if (orphaned.length === 0) {
			if (options.json) {
				console.log(JSON.stringify({ removed: [], count: 0 }));
			} else {
				console.log(formatSuccess('No orphaned playbooks found'));
			}
			return;
		}

		// With nothing to remove nothing is at risk, so the check waits for a real candidate.
		// It also covers --dry-run: a preview built on a wrong list would only mislead.
		const refusal = untrustedListReason(orphaned.length, agentCount, options.force === true);
		if (refusal) {
			throw new CleanRefusedError(refusal);
		}

		if (options.dryRun) {
			if (options.json) {
				console.log(
					JSON.stringify({
						dryRun: true,
						wouldRemove: orphaned.map((o) => ({
							sessionId: o.sessionId,
							filePath: o.filePath,
						})),
						count: orphaned.length,
					})
				);
			} else {
				console.log(`\nWould remove ${orphaned.length} orphaned playbook file(s):\n`);
				for (const o of orphaned) {
					console.log(`  ${o.sessionId.slice(0, 8)}  ${o.filePath}`);
				}
				console.log('\nRun without --dry-run to actually remove these files.');
			}
			return;
		}

		// Actually remove the files
		const removed: string[] = [];
		for (const o of orphaned) {
			try {
				fs.unlinkSync(o.filePath);
				removed.push(o.sessionId);
			} catch (error) {
				console.error(`Failed to remove ${o.filePath}: ${error}`);
			}
		}

		if (options.json) {
			console.log(
				JSON.stringify({
					removed: removed.map((id) => id.slice(0, 8)),
					count: removed.length,
				})
			);
		} else {
			console.log(formatSuccess(`Removed ${removed.length} orphaned playbook file(s)`));
			for (const id of removed) {
				console.log(`  ${id.slice(0, 8)}`);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			// A refusal is the answer, not a failure, so it keeps its own words.
			console.error(
				formatError(
					error instanceof CleanRefusedError ? message : `Failed to clean playbooks: ${message}`
				)
			);
		}
		process.exit(1);
	}
}
