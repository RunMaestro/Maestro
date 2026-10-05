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
	/** Per document, in playbook order: what the pass read. */
	scanned: Array<{ document: string; unchecked: number }>;
	/** The first document that still carries a halt marker, if any. */
	preExistingHalt: { document: string; halt: HaltMarker } | null;
}

export async function preflightPlaybook(
	playbook: Pick<Playbook, 'documents'>,
	folderPath: string,
	documents: AutoRunDeps['documents']
): Promise<PlaybookPreflight> {
	const scanned: PlaybookPreflight['scanned'] = [];
	let initialTotalTasks = 0;
	let preExistingHalt: PlaybookPreflight['preExistingHalt'] = null;
	for (const doc of playbook.documents) {
		const { unchecked, content } = await documents.read(folderPath, doc.filename);
		scanned.push({ document: doc.filename, unchecked });
		initialTotalTasks += unchecked;
		if (!preExistingHalt) {
			const halt = findHaltMarker(content);
			if (halt) preExistingHalt = { document: doc.filename, halt };
		}
	}
	return { initialTotalTasks, scanned, preExistingHalt };
}
