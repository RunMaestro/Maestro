// Group settings command - print what a new agent created in a group starts
// with: the group's defaults and its pill label, read from the group store.
//
// The read half of `update-group-settings`, the way `show-agent` is the read
// half of `update-agent`. It needs no running app.

import { resolveGroupId, readGroups } from '../services/storage';
import { describeGroupSettings } from '../services/group-settings';
import { failCommand, failFromError } from '../services/session-command';
import { formatGroupSettings } from '../output/formatter';

interface GroupSettingsOptions {
	json?: boolean;
}

export function groupSettings(groupId: string, options: GroupSettingsOptions): void {
	let resolvedGroupId: string;
	try {
		resolvedGroupId = resolveGroupId(groupId);
	} catch (error) {
		return failFromError(error, options.json);
	}
	const group = readGroups().find((candidate) => candidate.id === resolvedGroupId);
	if (!group) return failCommand(`Group not found: ${groupId}`, options.json);

	const report = describeGroupSettings(group);
	if (options.json) {
		console.log(JSON.stringify({ success: true, group: report }));
		return;
	}
	console.log(formatGroupSettings(report));
}
