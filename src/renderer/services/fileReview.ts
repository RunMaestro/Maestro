/**
 * fileReview - hand the line comments left in the File Preview to the agent
 * whose file tab they were written in, and the CLI half of the same thing
 * (`maestro-cli file-review`).
 *
 * `deliverFileReview` is the one place a file review leaves the store, the
 * twin of `deliverDiffReview`: it drops the comments the file has outdated,
 * formats the rest, hands them to one of the two ways out in
 * `reviewDelivery.ts` (queue it, or put it in the composer), and forgets only
 * what was delivered. The File Preview's tray and the CLI's `send` both go
 * through it.
 */

import type { Session } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import { fileReviewKey, useFileReviewStore } from '../stores/fileReviewStore';
import {
	canReceiveReview,
	deliverPendingReview,
	type ReviewDeliveryMode,
	type ReviewDeliveryResult,
} from './reviewDelivery';
import { resolveGitSshRemoteId } from '../hooks/git/useGitAgentActions';
import { generateId } from '../utils/ids';
import { toRelativePath } from '../utils/fileLinks/matcher';
import { getBasename, isAbsolutePath, joinPath } from '../../shared/formatters';
import { getLanguageFromFilename } from '../components/FilePreview/filePreviewUtils';
import {
	anchorForFileLines,
	findOutdatedFileComments,
	formatFileCommentLocation,
	formatFileReviewPrompt,
	type FileComment,
} from '../utils/fileReviewComments';
import type {
	DiffReviewCommandRequest,
	DiffReviewCommandResult,
	DiffReviewCommentSummary,
} from '../../shared/diffReviewCommands';

/**
 * The path an agent is told for `filePath`: relative to its working directory
 * when the file sits under it, else absolute.
 */
export function fileReviewPath(filePath: string, agentCwd: string | undefined): string {
	return toRelativePath(filePath, agentCwd) ?? filePath;
}

/**
 * Deliver one file's pending review against `content`, the file as the
 * reviewer sees it now.
 */
export function deliverFileReview({
	sessionId,
	key,
	content,
	mode,
	background,
}: {
	sessionId: string;
	key: string;
	content: string;
	mode: ReviewDeliveryMode;
	background?: boolean;
}): ReviewDeliveryResult<FileComment> {
	const comments = useFileReviewStore.getState().commentsByKey[key] ?? [];
	return deliverPendingReview({
		sessionId,
		comments,
		outdatedIds: findOutdatedFileComments(comments, content),
		formatPrompt: formatFileReviewPrompt,
		forget: (ids) => useFileReviewStore.getState().removeComments(key, ids),
		mode,
		background,
	});
}

// ============================================================================
// CLI: `maestro-cli file-review`
// ============================================================================

/** The file a CLI request names, and the review it is kept under. */
function resolveReviewFile(
	session: Session,
	file: string
): { filePath: string; key: string; sshRemoteId?: string } {
	const sshRemoteId = resolveGitSshRemoteId(session);
	const filePath = isAbsolutePath(file) ? file : joinPath(session.cwd, file);
	return { filePath, sshRemoteId, key: fileReviewKey(session.id, filePath, sshRemoteId) };
}

function summarize(comment: FileComment, outdated: boolean): DiffReviewCommentSummary {
	return {
		id: comment.id,
		path: comment.path,
		side: 'new',
		startLine: comment.startLine,
		endLine: comment.endLine,
		location: formatFileCommentLocation(comment),
		body: comment.body,
		outdated,
	};
}

/**
 * Answer one `file-review` verb. Every verb reads and writes the same store the
 * File Preview draws, so a comment added here appears on an open file tab, and
 * `send` is the tray's own `deliverFileReview`. Lines are checked against the
 * file as it is on disk.
 */
export async function runRemoteFileReviewCommand(
	request: DiffReviewCommandRequest & { file: string }
): Promise<DiffReviewCommandResult> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === request.sessionId);
	if (!session) return { success: false, error: `Agent not found: ${request.sessionId}` };
	if (!canReceiveReview(session)) {
		return {
			success: false,
			error: `${session.name} is a terminal agent and cannot take a review`,
		};
	}
	const { filePath, key, sshRemoteId } = resolveReviewFile(session, request.file);
	const store = useFileReviewStore.getState();
	const pendingComments = () => useFileReviewStore.getState().commentsByKey[key] ?? [];
	const loadContent = async (): Promise<string | null> =>
		window.maestro.fs.readFile(filePath, sshRemoteId);
	const unreadable = { success: false, error: `Could not read ${filePath}` };
	const listAgainst = (content: string) => {
		const comments = pendingComments();
		const outdated = findOutdatedFileComments(comments, content);
		return comments.map((c) => summarize(c, outdated.has(c.id)));
	};

	switch (request.action) {
		case 'list': {
			const content = await loadContent();
			if (content === null) return unreadable;
			return { success: true, file: filePath, comments: listAgainst(content) };
		}

		case 'add': {
			const content = await loadContent();
			if (content === null) return unreadable;
			const anchor = anchorForFileLines({
				content,
				path: fileReviewPath(filePath, session.cwd),
				startLine: request.startLine!,
				endLine: request.endLine ?? request.startLine!,
				language: getLanguageFromFilename(getBasename(filePath)),
			});
			if (!anchor) {
				const lineCount = content.split(/\r?\n/).length;
				return {
					success: false,
					error: `${filePath} has ${lineCount} line${lineCount === 1 ? '' : 's'}; line ${request.endLine ?? request.startLine} is past its end`,
				};
			}
			const comment: FileComment = { ...anchor, id: generateId(), body: request.body! };
			store.addComment(key, comment);
			return { success: true, file: filePath, comment: summarize(comment, false) };
		}

		case 'edit': {
			const pending = () => pendingComments().find((c) => c.id === request.commentId);
			const missing = { success: false, error: `No pending comment ${request.commentId}` };
			if (!pending()) return missing;
			const content = await loadContent();
			if (content === null) return unreadable;
			// Read it again: the tray may have sent or removed it while the file loaded.
			const existing = pending();
			if (!existing) return missing;
			if (findOutdatedFileComments([existing], content).size > 0) {
				return {
					success: false,
					error: `${formatFileCommentLocation(existing)} is outdated (its lines changed); remove it and add a new comment`,
				};
			}
			store.updateComment(key, existing.id, request.body!);
			return {
				success: true,
				file: filePath,
				comment: summarize({ ...existing, body: request.body! }, false),
			};
		}

		case 'remove': {
			const existing = pendingComments().find((c) => c.id === request.commentId);
			if (!existing) return { success: false, error: `No pending comment ${request.commentId}` };
			store.removeComment(key, existing.id);
			return { success: true, file: filePath, comment: summarize(existing, false) };
		}

		case 'clear': {
			const count = pendingComments().length;
			store.clearComments(key);
			return { success: true, file: filePath, cleared: count };
		}

		case 'send': {
			const content = await loadContent();
			if (content === null) return unreadable;
			const result = deliverFileReview({
				sessionId: session.id,
				key,
				content,
				mode: request.compose ? 'compose' : 'send',
				background: request.background,
			});
			const outdated = result.outdated.map((c) => summarize(c, true));
			if (!result.ok) return { success: false, error: result.error, outdated };
			return {
				success: true,
				file: filePath,
				delivered: result.delivered.map((c) => summarize(c, false)),
				outdated,
				prompt: result.prompt,
			};
		}
	}
}
