import fs from 'fs/promises';
import path from 'path';
import type { Playbook } from '../../../shared/types';
import type { WorkGraphImportSummary } from '../../../shared/work-graph-types';
import {
	hashContent,
	importCandidates,
	pathId,
	toGitPath,
	type ImportCandidate,
	type WorkGraphImporterOptions,
} from './common';

export interface PlaybookImportOptions extends WorkGraphImporterOptions {
	playbooks: Array<Playbook & { sessionId?: string }>;
	autoRunFolderPath?: string;
}

export async function importPlaybookWorkItems(
	options: PlaybookImportOptions
): Promise<WorkGraphImportSummary> {
	const candidates: ImportCandidate[] = [];

	for (const playbook of options.playbooks) {
		for (const document of playbook.documents) {
			const docPath = options.autoRunFolderPath
				? path.join(options.autoRunFolderPath, `${document.filename}.md`)
				: undefined;
			const content = docPath ? await readOptionalFile(docPath) : undefined;
			const gitPath =
				docPath && docPath.startsWith(options.projectPath)
					? toGitPath(options.projectPath, docPath)
					: `playbooks/${playbook.id}/${document.filename}.md`;
			const title = `Playbook Task: ${playbook.name} / ${document.filename}`;

			candidates.push({
				externalType: 'document-task',
				externalId: pathId(
					'playbook',
					playbook.sessionId ?? 'unknown-session',
					playbook.id,
					document.filename
				),
				gitPath,
				type: 'task',
				title,
				description: content ? firstLines(content) : playbook.prompt,
				status: 'planned',
				tags: ['playbook', 'task'],
				metadata: {
					playbook: {
						playbookId: playbook.id,
						playbookName: playbook.name,
						sessionId: playbook.sessionId,
						document: document.filename,
						resetOnCompletion: document.resetOnCompletion,
						contentHash: content ? hashContent(content) : undefined,
					},
				},
			});
		}
	}

	return importCandidates('playbook', options, candidates);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

function firstLines(content: string): string {
	return content
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 3)
		.join('\n');
}
