// List agents command
// Lists all agents/sessions from Maestro storage

import { readSessions, readGroups, getSessionsByGroup, resolveGroupId } from '../services/storage';
import { formatAgents, formatError, AgentDisplay } from '../output/formatter';

interface ListAgentsOptions {
	group?: string;
	json?: boolean;
}

export function listAgents(options: ListAgentsOptions): void {
	try {
		let sessions;
		let groupName: string | undefined;

		if (options.group) {
			// Resolve partial group ID
			const groupId = resolveGroupId(options.group);
			sessions = getSessionsByGroup(groupId);
			// Get the group name for display
			const groups = readGroups();
			const group = groups.find((g) => g.id === groupId);
			groupName = group?.name;
		} else {
			sessions = readSessions();
		}

		if (options.json) {
			// JSON array output
			const output = sessions.map((s) => ({
				id: s.id,
				name: s.name,
				toolType: s.toolType,
				cwd: s.cwd,
				groupId: s.groupId,
				autoRunFolderPath: s.autoRunFolderPath,
			}));
			console.log(JSON.stringify(output, null, 2));
		} else {
			// Human-readable output
			const displayAgents: AgentDisplay[] = sessions.map((s) => ({
				id: s.id,
				name: s.name,
				toolType: s.toolType,
				cwd: s.cwd,
				groupId: s.groupId,
				autoRunFolderPath: s.autoRunFolderPath,
			}));
			console.log(formatAgents(displayAgents, groupName));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to list agents: ${message}`));
		}
		process.exit(1);
	}
}
