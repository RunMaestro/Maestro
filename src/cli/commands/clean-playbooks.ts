// Clean playbooks command
// Removes orphaned playbooks (playbooks for sessions that no longer exist)

import * as fs from 'fs';
import * as path from 'path';
import { readSessions, getConfigDirectory } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

interface CleanPlaybooksOptions {
	json?: boolean;
	dryRun?: boolean;
}

/**
 * Get the playbooks directory path
 */
function getPlaybooksDir(): string {
	return path.join(getConfigDirectory(), 'playbooks');
}

/**
 * Find orphaned playbook files (files for sessions that no longer exist)
 */
function findOrphanedPlaybooks(): Array<{ sessionId: string; filePath: string }> {
	const playbooksDir = getPlaybooksDir();
	const orphaned: Array<{ sessionId: string; filePath: string }> = [];

	try {
		if (!fs.existsSync(playbooksDir)) {
			return orphaned;
		}

		const sessions = readSessions();
		const sessionIds = new Set(sessions.map((s) => s.id));

		const files = fs.readdirSync(playbooksDir);

		for (const file of files) {
			if (!file.endsWith('.json')) continue;

			const sessionId = file.replace('.json', '');
			if (!sessionIds.has(sessionId)) {
				orphaned.push({
					sessionId,
					filePath: path.join(playbooksDir, file),
				});
			}
		}

		return orphaned;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return orphaned;
		}
		throw error;
	}
}

export function cleanPlaybooks(options: CleanPlaybooksOptions): void {
	try {
		const orphaned = findOrphanedPlaybooks();

		if (orphaned.length === 0) {
			if (options.json) {
				console.log(JSON.stringify({ removed: [], count: 0 }));
			} else {
				console.log(formatSuccess('No orphaned playbooks found'));
			}
			return;
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
			console.error(formatError(`Failed to clean playbooks: ${message}`));
		}
		process.exit(1);
	}
}
