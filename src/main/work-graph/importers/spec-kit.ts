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

const SPEC_KIT_DIRS = ['.specify/specs', 'specs'];

export async function importSpecKitWorkItems(
	options: WorkGraphImporterOptions
): Promise<WorkGraphImportSummary> {
	const candidates: ImportCandidate[] = [];

	for (const dir of SPEC_KIT_DIRS) {
		for (const filePath of await findMarkdownFiles(options.projectPath, dir)) {
			const fileName = path.basename(filePath);
			if (fileName !== 'spec.md' && fileName !== 'plan.md') {
				continue;
			}

			const specSlug = path.basename(path.dirname(filePath));
			const doc = await readMarkdownCandidate(options.projectPath, filePath, specSlug);
			const isPlan = fileName === 'plan.md';
			candidates.push({
				externalType: isPlan ? 'plan' : 'spec',
				externalId: pathId('spec-kit', doc.gitPath),
				gitPath: doc.gitPath,
				type: isPlan ? 'milestone' : 'feature',
				title: `${isPlan ? 'Spec-Kit Epic' : 'Spec-Kit PRD'}: ${doc.title}`,
				description: doc.description,
				status: 'planned',
				tags: ['spec-kit', isPlan ? 'epic' : 'prd'],
				metadata: {
					specKit: {
						kind: isPlan ? 'epic' : 'prd',
						specSlug,
						contentHash: doc.hash,
					},
				},
			});
		}
	}

	return importCandidates('spec-kit', options, candidates);
}
