/**
 * The checks before a spec-driven run starts: how many tasks there are, and whether an earlier
 * run left a halt marker behind.
 *
 * Both come from one pass over the documents. Folding them together keeps the read count per
 * document stable for callers and mocks. A stale marker means the previous run halted on
 * purpose, and the person must resolve it before running again.
 */

import { findHaltMarker, type HaltMarker } from '../../autorunMarkers';
import type { Playbook } from '../../types';
import type { AutoRunDeps } from './engine-types';

export interface PlaybookPreflight {
	/** Unchecked tasks across every document. */
	initialTotalTasks: number;
	/**
	 * Checked tasks across every document before the run starts: the baseline a run's pace (and
	 * its ETA) is measured from, as the desktop runner counts it. Zero when the reader does not
	 * report checked counts.
	 */
	initialCheckedTasks: number;
	/** Per document, in playbook order: what the pass read. */
	scanned: Array<{ document: string; unchecked: number }>;
	/** The first document that still carries a halt marker, if any. */
	preExistingHalt: { document: string; halt: HaltMarker } | null;
	/** The path of every document that does not exist, in playbook order. */
	missingDocuments: string[];
}

export async function preflightPlaybook(
	playbook: Pick<Playbook, 'documents'>,
	folderPath: string,
	documents: AutoRunDeps['documents']
): Promise<PlaybookPreflight> {
	const scanned: PlaybookPreflight['scanned'] = [];
	let initialTotalTasks = 0;
	let initialCheckedTasks = 0;
	let preExistingHalt: PlaybookPreflight['preExistingHalt'] = null;
	const missingDocuments: string[] = [];
	for (const doc of playbook.documents) {
		const { unchecked, checked, content, missingPath } = await documents.read(
			folderPath,
			doc.filename
		);
		if (missingPath) missingDocuments.push(missingPath);
		scanned.push({ document: doc.filename, unchecked });
		initialTotalTasks += unchecked;
		initialCheckedTasks += checked ?? 0;
		if (!preExistingHalt) {
			const halt = findHaltMarker(content);
			if (halt) preExistingHalt = { document: doc.filename, halt };
		}
	}
	return { initialTotalTasks, initialCheckedTasks, scanned, preExistingHalt, missingDocuments };
}
