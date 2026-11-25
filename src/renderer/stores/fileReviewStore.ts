/**
 * fileReviewStore - line comments left in the File Preview and not yet sent.
 *
 * One review per agent and file (`fileReviewKey`): the comments go to the
 * agent whose file tab they were written in, and a file on an SSH remote is a
 * different file from the same path on this machine. Closing the tab, or
 * switching between the preview and the editor, keeps them; they leave only
 * when the review is sent or discarded.
 *
 * Same shape and rules as the Git Diff review (`reviewCommentStore.ts`).
 */

import type { FileComment, FileCommentAnchor } from '../utils/fileReviewComments';
import {
	createReviewCommentStore,
	type ReviewCommentDraft,
	type ReviewCommentStore,
} from './reviewCommentStore';

/** A File Preview comment box parked while its tab is closed. */
export type FileCommentDraft = ReviewCommentDraft<FileCommentAnchor>;

export type FileReviewStore = ReviewCommentStore<FileComment, FileCommentAnchor>;

/** The key one agent's review of one file is stored under. */
export function fileReviewKey(
	sessionId: string,
	filePath: string,
	sshRemoteId?: string | null
): string {
	return sshRemoteId ? `${sessionId}|ssh:${sshRemoteId}|${filePath}` : `${sessionId}|${filePath}`;
}

export const useFileReviewStore = createReviewCommentStore<FileComment, FileCommentAnchor>();
