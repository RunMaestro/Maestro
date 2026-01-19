// List playbooks command
// Lists all playbooks, optionally filtered by agent

import { readPlaybooks, listAllPlaybooks } from '../services/playbooks';
import { getSessionById, resolveAgentId, readSessions } from '../services/storage';
import {
	formatPlaybooks,
	formatPlaybooksByAgent,
	formatError,
	PlaybookDisplay,
	PlaybooksByAgent,
} from '../output/formatter';

interface ListPlaybooksOptions {
	agent?: string;
	json?: boolean;
}

// Ensure filename has .md extension
function normalizeFilename(filename: string): string {
	return filename.endsWith('.md') ? filename : `${filename}.md`;
}

export function listPlaybooks(options: ListPlaybooksOptions): void {
	try {
		if (options.agent) {
			// List playbooks for a specific agent
			const agentId = resolveAgentId(options.agent);
			const playbooks = readPlaybooks(agentId);
			const agent = getSessionById(agentId);
			const agentName = agent?.name;
			const folderPath = agent?.autoRunFolderPath;

			if (options.json) {
				// JSON array output
				const output = playbooks.map((p) => ({
					id: p.id,
					name: p.name,
					agentId: agentId,
					agentName: agentName,
					folderPath: folderPath,
					loopEnabled: p.loopEnabled,
					maxLoops: p.maxLoops,
					documents: p.documents.map((d) => ({
						filename: normalizeFilename(d.filename),
						resetOnCompletion: d.resetOnCompletion,
					})),
				}));
				console.log(JSON.stringify(output, null, 2));
			} else {
				const displayPlaybooks: PlaybookDisplay[] = playbooks.map((p) => ({
					id: p.id,
					name: p.name,
					sessionId: agentId,
					documents: p.documents.map((d) => ({
						filename: normalizeFilename(d.filename),
						resetOnCompletion: d.resetOnCompletion,
					})),
					loopEnabled: p.loopEnabled,
					maxLoops: p.maxLoops,
				}));
				console.log(formatPlaybooks(displayPlaybooks, agentName, folderPath));
			}
		} else {
			// List all playbooks grouped by agent
			const allPlaybooks = listAllPlaybooks();
			const sessions = readSessions();

			if (options.json) {
				// JSON array output
				const output = allPlaybooks.map((p) => {
					const session = sessions.find((s) => s.id === p.sessionId);
					return {
						id: p.id,
						name: p.name,
						agentId: p.sessionId,
						agentName: session?.name,
						folderPath: session?.autoRunFolderPath,
						loopEnabled: p.loopEnabled,
						maxLoops: p.maxLoops,
						documents: p.documents.map((d) => ({
							filename: normalizeFilename(d.filename),
							resetOnCompletion: d.resetOnCompletion,
						})),
					};
				});
				console.log(JSON.stringify(output, null, 2));
			} else {
				// Group playbooks by agent
				const agentMap = new Map<string, PlaybooksByAgent>();

				for (const playbook of allPlaybooks) {
					if (!agentMap.has(playbook.sessionId)) {
						const session = sessions.find((s) => s.id === playbook.sessionId);
						agentMap.set(playbook.sessionId, {
							agentId: playbook.sessionId,
							agentName: session?.name || 'Unknown Agent',
							playbooks: [],
						});
					}

					const group = agentMap.get(playbook.sessionId)!;
					group.playbooks.push({
						id: playbook.id,
						name: playbook.name,
						sessionId: playbook.sessionId,
						documents: playbook.documents.map((d) => ({
							filename: normalizeFilename(d.filename),
							resetOnCompletion: d.resetOnCompletion,
						})),
						loopEnabled: playbook.loopEnabled,
						maxLoops: playbook.maxLoops,
					});
				}

				const groups = Array.from(agentMap.values());
				console.log(formatPlaybooksByAgent(groups));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to list playbooks: ${message}`));
		}
		process.exit(1);
	}
}
