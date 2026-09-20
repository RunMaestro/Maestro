/**
 * Ordering rules for the Auto Run "Select Documents" picker.
 *
 * The run list is an ordered program: document 1 runs, then document 2, and so
 * on. The picker is where that order is authored, so selection order IS the run
 * order. Clicking folder `deploy` and then folder `verify` means the deploy
 * documents run first, even when the tree draws `verify` above `deploy`
 * alphabetically.
 *
 * Two helpers keep that promise:
 *
 * - `selectFolderFiles` places a folder's documents as one contiguous block at
 *   the end of the selection, so a folder's documents never end up split across
 *   the run list by an earlier stray click on one of its files.
 * - `applySelectionOrder` turns the selection into run-list entries. Entries
 *   that are already in the list keep their id, their reset flag, and any
 *   duplicates the user made of them, but they move to the position their
 *   selection implies rather than being pinned to the front.
 *
 * Because the picker seeds its selection from the current run list, a run list
 * the user hand-ordered by dragging survives untouched when they reopen the
 * picker just to add one more document.
 */

import type { BatchDocumentEntry } from '../types';

/**
 * Select every file in a folder, as a contiguous block at the end of `prev`.
 *
 * Files already selected are moved rather than left in place: the user's most
 * recent folder click decides where that folder's documents sit.
 */
export function selectFolderFiles(prev: Set<string>, files: string[]): Set<string> {
	const next = new Set(prev);
	for (const file of files) next.delete(file);
	for (const file of files) next.add(file);
	return next;
}

/** Deselect every file in a folder. */
export function deselectFolderFiles(prev: Set<string>, files: string[]): Set<string> {
	const next = new Set(prev);
	for (const file of files) next.delete(file);
	return next;
}

/**
 * Add every document not yet selected, keeping the order of what is already
 * selected. Used by "Select All" so it extends the user's selection instead of
 * flattening it back to the loader's alphabetical order.
 */
export function selectAllDocuments(prev: Set<string>, allDocuments: string[]): Set<string> {
	const next = new Set(prev);
	for (const doc of allDocuments) next.add(doc);
	return next;
}

/**
 * Rebuild the run list from `selectedFilenames`, in selection order.
 *
 * Existing entries are reused so ids, reset flags, and duplicate rows survive;
 * every duplicate of a filename stays grouped with its original. Filenames with
 * no existing entry become fresh entries via `createEntry`.
 */
export function applySelectionOrder(
	documents: BatchDocumentEntry[],
	selectedFilenames: Iterable<string>,
	createEntry: (filename: string) => BatchDocumentEntry
): BatchDocumentEntry[] {
	const existingByFilename = new Map<string, BatchDocumentEntry[]>();
	for (const doc of documents) {
		const bucket = existingByFilename.get(doc.filename);
		if (bucket) bucket.push(doc);
		else existingByFilename.set(doc.filename, [doc]);
	}

	const result: BatchDocumentEntry[] = [];
	for (const filename of selectedFilenames) {
		const existing = existingByFilename.get(filename);
		if (existing) result.push(...existing);
		else result.push(createEntry(filename));
	}
	return result;
}
