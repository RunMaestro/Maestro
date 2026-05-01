import type { HistoryEntry } from '../../../shared/types';
import type { WorkGraphImportSummary } from '../../../shared/work-graph-types';
import {
	hashContent,
	importCandidates,
	pathId,
	type ImportCandidate,
	type WorkGraphImporterOptions,
} from './common';

export interface DirectorNotesImportOptions extends WorkGraphImporterOptions {
	entries: HistoryEntry[];
}

export async function importDirectorNotesWorkItems(
	options: DirectorNotesImportOptions
): Promise<WorkGraphImportSummary> {
	const candidates: ImportCandidate[] = [];

	for (const entry of options.entries) {
		const body = entry.fullResponse ?? entry.summary;
		if (!body?.trim()) {
			continue;
		}

		candidates.push({
			externalType: 'history-summary',
			externalId: pathId('director-notes', entry.sessionId ?? 'unknown-session', entry.id),
			gitPath: `history/${entry.sessionId ?? 'unknown-session'}.json`,
			type: 'document',
			title: `Director's Notes: ${entry.summary || entry.id}`,
			description: body,
			status: 'discovered',
			tags: ['director-notes', 'history-summary'],
			readonly: true,
			metadata: {
				directorNotes: {
					historyEntryId: entry.id,
					sessionId: entry.sessionId,
					sessionName: entry.sessionName,
					agentSessionId: entry.agentSessionId,
					projectPath: entry.projectPath,
					timestamp: entry.timestamp,
					type: entry.type,
					contentHash: hashContent(body),
				},
			},
		});
	}

	return importCandidates('director-notes', options, candidates);
}
