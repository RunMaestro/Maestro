import path from 'path';
import type { WorkGraphImportSummary } from '../../../shared/work-graph-types';
import {
	findMarkdownFiles,
	importCandidates,
	pathId,
	readMarkdownCandidate,
	type ImportCandidate,
	type WorkGraphImporterOptions,
} from './common';

export async function importOpenSpecWorkItems(
	options: WorkGraphImporterOptions
): Promise<WorkGraphImportSummary> {
	const candidates: ImportCandidate[] = [];
	const files = await findMarkdownFiles(options.projectPath, 'openspec/changes');

	for (const filePath of files) {
		const fileName = path.basename(filePath);
		if (fileName !== 'proposal.md' && fileName !== 'design.md') {
			continue;
		}

		const changeId = path.relative(
			path.join(options.projectPath, 'openspec/changes'),
			path.dirname(filePath)
		);
		const doc = await readMarkdownCandidate(options.projectPath, filePath, changeId);
		const isDesign = fileName === 'design.md';
		candidates.push({
			externalType: isDesign ? 'design' : 'proposal',
			externalId: pathId('openspec', doc.gitPath),
			gitPath: doc.gitPath,
			type: isDesign ? 'milestone' : 'feature',
			title: `${isDesign ? 'OpenSpec Epic' : 'OpenSpec PRD'}: ${doc.title}`,
			description: doc.description,
			status: 'planned',
			tags: ['openspec', isDesign ? 'epic' : 'prd'],
			metadata: {
				openSpec: {
					kind: isDesign ? 'epic' : 'prd',
					changeId,
					contentHash: doc.hash,
				},
			},
		});
	}

	return importCandidates('openspec', options, candidates);
}
