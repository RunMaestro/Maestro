/**
 * A saved playbook record as the Auto Run engine's input.
 *
 * `playbookBatchDocuments()` is the run list the Auto Run panel shows when a
 * playbook is loaded. `buildPlaybookBatchRunConfig()` is the `BatchRunConfig`
 * the panel's Go button would send for that record untouched, so the Playbook
 * Exchange's Run button starts exactly the run a user would get by loading
 * the playbook in the panel and pressing Go.
 */

import type { PlaybookParamValues } from '../../../shared/playbookParams';
import { toBatchRunPlaybook } from '../../../shared/playbookRun';
import type { AutoRunLaunchSource } from '../../../shared/stats-types';
import type { BatchDocumentEntry, BatchRunConfig, Playbook } from '../../types';
import { generateId } from '../../utils/ids';
import { DEFAULT_BATCH_PROMPT } from './batchUtils';

/**
 * The run-list entries for a playbook's documents, each with a fresh id. A
 * filename seen earlier in the list is a duplicate. When `availableDocuments`
 * is given, a document not in it is marked missing.
 */
export function playbookBatchDocuments(
	playbook: Pick<Playbook, 'documents'>,
	availableDocuments?: Iterable<string>
): BatchDocumentEntry[] {
	const available = availableDocuments ? new Set(availableDocuments) : null;
	const seen = new Set<string>();
	return playbook.documents.map((doc) => {
		const entry: BatchDocumentEntry = {
			id: generateId(),
			filename: doc.filename,
			resetOnCompletion: doc.resetOnCompletion,
			isDuplicate: seen.has(doc.filename),
			...(available && { isMissing: !available.has(doc.filename) }),
		};
		seen.add(doc.filename);
		return entry;
	});
}

/** A playbook's agent prompt, or the default Auto Run prompt when it has none. */
export function playbookEffectivePrompt(playbook: Pick<Playbook, 'prompt'>): string {
	return playbook.prompt?.trim() ? playbook.prompt : DEFAULT_BATCH_PROMPT;
}

export interface PlaybookBatchRunOptions {
	/** The agent whose playbook store holds the record. */
	ownerSessionId: string;
	launchSource: AutoRunLaunchSource;
	/** Answers fresher than the record's (stored answers plus Detected proposals). */
	parameterValues?: PlaybookParamValues;
}

/** The `BatchRunConfig` that runs a saved playbook as it is stored. */
export function buildPlaybookBatchRunConfig(
	playbook: Playbook,
	{ ownerSessionId, launchSource, parameterValues }: PlaybookBatchRunOptions
): BatchRunConfig {
	return {
		documents: playbookBatchDocuments(playbook),
		prompt: playbookEffectivePrompt(playbook),
		loopEnabled: playbook.loopEnabled,
		maxLoops: playbook.loopEnabled ? (playbook.maxLoops ?? null) : null,
		taskSelectionMode: playbook.taskSelectionMode ?? 'task',
		launchSource,
		playbook: toBatchRunPlaybook(playbook, ownerSessionId, parameterValues),
	};
}
