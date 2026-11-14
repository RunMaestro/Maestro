// List groups command
// Lists all session groups from Maestro storage

import { readGroups } from '../services/storage';
import { formatGroups, GroupDisplay } from '../output/formatter';
import { failCommand } from '../services/session-command';

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
				icon: g.icon,
				color: g.color,
				collapsed: g.collapsed,
				parentGroupId: g.parentGroupId,
				hidden: !!g.hidden,
			}));
			console.log(JSON.stringify(output, null, 2));
		} else {
			// Human-readable output
			const displayGroups: GroupDisplay[] = groups.map((g) => ({
				id: g.id,
				name: g.name,
				emoji: g.emoji,
				collapsed: g.collapsed,
				hidden: !!g.hidden,
			}));
			console.log(formatGroups(displayGroups));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		failCommand(`Failed to list groups: ${message}`, options.json);
	}
}
