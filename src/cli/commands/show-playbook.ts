// Show playbook command
// Displays detailed information about a specific playbook

import { findPlaybookById } from '../services/playbooks';
import { getSessionById } from '../services/storage';
import { readDocAndGetTasks } from '../services/agent-spawner';
import { formatPlaybookDetail, formatError } from '../output/formatter';

interface ShowPlaybookOptions {
	json?: boolean;
}

export function showPlaybook(playbookId: string, options: ShowPlaybookOptions): void {
	try {
		// Find playbook across all agents
		const { playbook, agentId } = findPlaybookById(playbookId);
		const agent = getSessionById(agentId);

		if (!agent) {
			throw new Error(`Agent not found: ${agentId}`);
		}

		const folderPath = agent.autoRunFolderPath;

		// Get task counts for each document
		const documentDetails = playbook.documents.map((doc) => {
			let tasks: string[] = [];
			if (folderPath) {
				const result = readDocAndGetTasks(folderPath, doc.filename);
				tasks = result.tasks;
			}
			return {
				filename: doc.filename.endsWith('.md') ? doc.filename : `${doc.filename}.md`,
				resetOnCompletion: doc.resetOnCompletion,
				taskCount: tasks.length,
				tasks,
			};
		});

		if (options.json) {
			const output = {
				id: playbook.id,
				name: playbook.name,
				agentId,
				agentName: agent.name,
				folderPath,
				loopEnabled: playbook.loopEnabled,
				maxLoops: playbook.maxLoops,
				prompt: playbook.prompt,
				documents: documentDetails,
				totalTasks: documentDetails.reduce((sum, d) => sum + d.taskCount, 0),
			};
			console.log(JSON.stringify(output, null, 2));
		} else {
			console.log(
				formatPlaybookDetail({
					id: playbook.id,
					name: playbook.name,
					agentId,
					agentName: agent.name,
					folderPath,
					loopEnabled: playbook.loopEnabled,
					maxLoops: playbook.maxLoops,
					prompt: playbook.prompt,
					documents: documentDetails,
				})
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}
