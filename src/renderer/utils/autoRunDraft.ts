/**
 * The Auto Run editor keeps an unsaved draft beside the text last seen on disk.
 * These helpers decide what happens to that draft when the disk moves under it.
 *
 * The file watcher re-reads the selected document on every `.md` change in the
 * folder, and that includes the echo of the user's own Cmd+S. Resetting the
 * draft to disk on every such tick threw away whatever was typed after the save
 * landed, or after any agent touched the file - a sentence gone with no trace.
 */

import type { BatchRunState } from '../types';

/**
 * Whether the selected document belongs to a run that is up: running WITHOUT a
 * worktree (directly on the main repo) and listed in the run's locked set.
 * Documents outside the run are never claimed by it.
 */
export function isAutoRunRunDocument(
	batchRunState: BatchRunState | null | undefined,
	selectedFile: string | null
): boolean {
	return (
		!!batchRunState?.isRunning &&
		!batchRunState.worktreeActive &&
		selectedFile !== null &&
		!!batchRunState.lockedDocuments?.includes(selectedFile)
	);
}

/**
 * Whether a run is driving the selected document right now, so the editor
 * refuses input. A paused run (agent error or HITL gate) hands it back.
 */
export function isAutoRunDocumentLocked(
	batchRunState: BatchRunState | null | undefined,
	selectedFile: string | null,
	errorPaused: boolean
): boolean {
	return isAutoRunRunDocument(batchRunState, selectedFile) && !errorPaused;
}

export interface DiskContentReconciliation {
	/** Text the editor shows. */
	draft: string;
	/** Baseline the dirty check and Revert compare against. */
	saved: string;
	/** The disk changed under an unsaved draft, and the draft was kept. */
	conflict: boolean;
}

/**
 * Fold a fresh read of the document into the editor's draft/saved pair.
 *
 * - Disk matches the baseline: nothing changed (typically our own save echoing
 *   back). Keep the draft exactly as it is.
 * - No unsaved edits, or `diskWins` (a run owns the document): adopt the disk.
 * - Unsaved edits AND a genuinely different disk: keep the draft, move the
 *   baseline to the disk so Revert loads the new version and the draft still
 *   reads as dirty. Saving then overwrites the external change deliberately.
 */
export function reconcileDiskContent({
	draft,
	saved,
	incoming,
	diskWins = false,
}: {
	draft: string;
	saved: string;
	incoming: string;
	diskWins?: boolean;
}): DiskContentReconciliation {
	if (incoming === saved) return { draft, saved, conflict: false };
	if (diskWins || draft === saved || draft === incoming) {
		return { draft: incoming, saved: incoming, conflict: false };
	}
	return { draft, saved: incoming, conflict: true };
}
