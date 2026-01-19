// List groups command
// Lists all session groups from Maestro storage

import { readGroups } from '../services/storage';
import { formatGroups, formatError, GroupDisplay } from '../output/formatter';

interface ListGroupsOptions {
	json?: boolean;
}

export function listGroups(options: ListGroupsOptions): void {
	try {
		const groups = readGroups();

		if (options.json) {
			// JSON array output
			const output = groups.map((g) => ({
				id: g.id,
				name: g.name,
				emoji: g.emoji,
				collapsed: g.collapsed,
			}));
			console.log(JSON.stringify(output, null, 2));
		} else {
			// Human-readable output
			const displayGroups: GroupDisplay[] = groups.map((g) => ({
				id: g.id,
				name: g.name,
				emoji: g.emoji,
				collapsed: g.collapsed,
			}));
			console.log(formatGroups(displayGroups));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to list groups: ${message}`));
		}
		process.exit(1);
	}
}
