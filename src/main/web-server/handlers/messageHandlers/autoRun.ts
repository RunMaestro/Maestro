/**
 * Auto Run domain WebSocket message handlers.
 *
 * Extracted from messageHandlers.ts. Handles: refresh_auto_run_docs,
 * configure_auto_run, set_auto_run_folder, get_auto_run_docs,
 * get_auto_run_state, get_auto_run_document, save_auto_run_document,
 * stop_auto_run, reset_auto_run_doc_tasks, resume_auto_run_error,
 * skip_auto_run_document, abort_auto_run_error.
 */

import path from 'path';
import { logger } from '../../../utils/logger';
import { captureException } from '../../../utils/sentry';
import type { AutoRunState } from '../../types';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import { readBackgroundField } from '../../../../shared/focusPlacement';

/**
 * Validate that a filename is safe for Auto Run read/save operations.
 *
 * Allows relative forward-slash subpaths (e.g. `loop/step-1`) so documents
 * in subfolders can be opened and saved, but rejects:
 *   - `..` traversal segments
 *   - backslash separators (we only persist POSIX)
 *   - absolute POSIX paths (leading `/`)
 *   - absolute Windows paths (drive-letter prefix)
 */
function isValidFilename(filename: string): boolean {
	return (
		typeof filename === 'string' &&
		filename.length > 0 &&
		!filename.includes('..') &&
		!filename.includes('\\') &&
		!filename.startsWith('/') &&
		!/^[A-Za-z]:[\\/]/.test(filename)
	);
}

/**
 * Handle refresh_auto_run_docs message - refresh auto-run documents for a session
 */
export function handleRefreshAutoRunDocs(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received refresh_auto_run_docs message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.refreshAutoRunDocs) {
		ctx.sendError(client, 'Auto-run docs refresh not configured');
		return;
	}

	ctx.callbacks
		.refreshAutoRunDocs(sessionId, readBackgroundField(message))
		.then((success) => {
			ctx.send(client, {
				type: 'refresh_auto_run_docs_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to refresh auto-run docs: ${error.message}`);
		});
}

/**
 * Handle configure_auto_run message - configure and optionally launch an auto-run
 */
export function handleConfigureAutoRun(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const documents = message.documents as
		| Array<{ filename: string; resetOnCompletion?: boolean }>
		| undefined;
	logger.info(
		`[Web] Received configure_auto_run message: session=${sessionId}, documents=${documents?.length || 0}`,
		LOG_CONTEXT
	);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!documents || !Array.isArray(documents) || documents.length === 0) {
		ctx.sendError(client, 'Missing or empty documents array');
		return;
	}

	// Validate each document entry
	for (const doc of documents) {
		if (typeof doc !== 'object' || doc === null) {
			ctx.sendError(client, 'Each document must be an object');
			return;
		}
		if (typeof doc.filename !== 'string' || doc.filename.trim() === '') {
			ctx.sendError(client, 'Each document must have a non-empty string filename');
			return;
		}
		if (doc.resetOnCompletion !== undefined && typeof doc.resetOnCompletion !== 'boolean') {
			ctx.sendError(client, 'resetOnCompletion must be a boolean if provided');
			return;
		}
	}

	if (!ctx.callbacks.configureAutoRun) {
		ctx.sendError(client, 'Auto-run configuration not configured');
		return;
	}

	// Validate and coerce optional config fields at the WebSocket boundary
	if (message.loopEnabled !== undefined && typeof message.loopEnabled !== 'boolean') {
		ctx.sendError(client, 'loopEnabled must be a boolean');
		return;
	}
	if (message.maxLoops !== undefined) {
		const maxLoops = Number(message.maxLoops);
		if (!Number.isFinite(maxLoops) || maxLoops < 0) {
			ctx.sendError(client, 'maxLoops must be a finite non-negative number');
			return;
		}
	}
	if (message.launch !== undefined && typeof message.launch !== 'boolean') {
		ctx.sendError(client, 'launch must be a boolean');
		return;
	}
	if (
		message.saveAsPlaybook !== undefined &&
		(typeof message.saveAsPlaybook !== 'string' || message.saveAsPlaybook.trim() === '')
	) {
		ctx.sendError(client, 'saveAsPlaybook must be a non-empty string');
		return;
	}
	// Per-run model/effort override. Optional, but when present it must be a
	// non-empty string: an empty value would pin the run to a nonexistent model
	// instead of falling back to the agent default.
	if (
		message.model !== undefined &&
		(typeof message.model !== 'string' || message.model.trim() === '')
	) {
		ctx.sendError(client, 'model must be a non-empty string');
		return;
	}
	if (
		message.effort !== undefined &&
		(typeof message.effort !== 'string' || message.effort.trim() === '')
	) {
		ctx.sendError(client, 'effort must be a non-empty string');
		return;
	}

	// Validate optional worktree config - desktop app uses this to create a
	// git worktree, checkout the branch, and optionally open a PR on completion.
	let worktree:
		| {
				enabled: boolean;
				path: string;
				branchName: string;
				baseBranch: string;
				createPROnCompletion: boolean;
				prTargetBranch: string;
		  }
		| undefined;
	if (message.worktree !== undefined) {
		const w = message.worktree as Record<string, unknown> | null;
		if (typeof w !== 'object' || w === null) {
			ctx.sendError(client, 'worktree must be an object');
			return;
		}
		if (typeof w.enabled !== 'boolean') {
			ctx.sendError(client, 'worktree.enabled must be a boolean');
			return;
		}
		if (typeof w.path !== 'string' || w.path.trim() === '') {
			ctx.sendError(client, 'worktree.path must be a non-empty string');
			return;
		}
		if (typeof w.branchName !== 'string' || w.branchName.trim() === '') {
			ctx.sendError(client, 'worktree.branchName must be a non-empty string');
			return;
		}
		if (w.baseBranch !== undefined && typeof w.baseBranch !== 'string') {
			ctx.sendError(client, 'worktree.baseBranch must be a string');
			return;
		}
		if (w.createPROnCompletion !== undefined && typeof w.createPROnCompletion !== 'boolean') {
			ctx.sendError(client, 'worktree.createPROnCompletion must be a boolean');
			return;
		}
		if (w.prTargetBranch !== undefined && typeof w.prTargetBranch !== 'string') {
			ctx.sendError(client, 'worktree.prTargetBranch must be a string');
			return;
		}
		worktree = {
			enabled: w.enabled,
			path: w.path,
			branchName: w.branchName,
			baseBranch: (w.baseBranch as string | undefined) ?? '',
			createPROnCompletion: Boolean(w.createPROnCompletion),
			prTargetBranch: (w.prTargetBranch as string | undefined) ?? '',
		};
	}

	const config = {
		documents,
		prompt: message.prompt as string | undefined,
		loopEnabled: message.loopEnabled as boolean | undefined,
		maxLoops: message.maxLoops !== undefined ? Number(message.maxLoops) : undefined,
		saveAsPlaybook: message.saveAsPlaybook as string | undefined,
		launch: message.launch as boolean | undefined,
		model: message.model as string | undefined,
		effort: message.effort as string | undefined,
		worktree,
	};

	ctx.callbacks
		.configureAutoRun(sessionId, config)
		.then((result) => {
			ctx.send(client, {
				type: 'configure_auto_run_result',
				success: result.success,
				playbookId: result.playbookId,
				error: result.error,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to configure auto-run: ${error.message}`);
		});
}

/**
 * Handle launch_goal_run message - start a desktop-owned Goal-Driven Auto Run
 * (`maestro-cli goal-run --visible`).
 *
 * Unlike `configure_auto_run` this carries no documents: goal mode is
 * document-less, and the renderer routes it to the same `startBatchRun({
 * goalConfig })` entry point the Auto Run modal's Go button uses. The reply
 * carries a machine-readable `code` on failure so the CLI can distinguish
 * "agent is busy" from "no such agent" without matching on prose.
 */
export function handleLaunchGoalRun(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received launch_goal_run message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	const goal = typeof message.goal === 'string' ? message.goal.trim() : '';
	if (!goal) {
		ctx.sendError(client, 'goal must be a non-empty string');
		return;
	}

	if (message.exitCriteria !== undefined && typeof message.exitCriteria !== 'string') {
		ctx.sendError(client, 'exitCriteria must be a string');
		return;
	}

	// `null` is meaningful here (run indefinitely) and must survive the boundary,
	// so it is checked before the numeric validation rather than folded into it.
	let maxIterations: number | null | undefined;
	if (message.maxIterations !== undefined && message.maxIterations !== null) {
		const parsed = Number(message.maxIterations);
		if (!Number.isInteger(parsed) || parsed < 1) {
			ctx.sendError(client, 'maxIterations must be a positive integer or null');
			return;
		}
		maxIterations = parsed;
	} else {
		maxIterations = message.maxIterations === null ? null : undefined;
	}

	// Same rule as configure_auto_run: an empty override would pin the run to a
	// nonexistent model instead of falling back to the agent default.
	if (
		message.model !== undefined &&
		(typeof message.model !== 'string' || message.model.trim() === '')
	) {
		ctx.sendError(client, 'model must be a non-empty string');
		return;
	}
	if (
		message.effort !== undefined &&
		(typeof message.effort !== 'string' || message.effort.trim() === '')
	) {
		ctx.sendError(client, 'effort must be a non-empty string');
		return;
	}

	if (!ctx.callbacks.launchGoalRun) {
		ctx.sendError(client, 'Goal run launch not configured');
		return;
	}

	ctx.callbacks
		.launchGoalRun(sessionId, {
			goal,
			exitCriteria: (message.exitCriteria as string | undefined)?.trim() || undefined,
			maxIterations,
			model: message.model as string | undefined,
			effort: message.effort as string | undefined,
		})
		.then((result) => {
			ctx.send(client, {
				type: 'launch_goal_run_result',
				success: result.success,
				tabId: result.tabId,
				code: result.code,
				error: result.error,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			captureException(error, { extra: { sessionId, message: 'launch_goal_run' } });
			ctx.sendError(client, `Failed to launch goal run: ${error.message}`);
		});
}

/**
 * Handle set_auto_run_folder message - update the Auto Run folder for an
 * existing session. Mirrors desktop's `dialog.selectFolder` flow: the renderer
 * lists docs from the new path, persists the choice to session storage, and
 * broadcasts the updated session.
 */
export function handleSetAutoRunFolder(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const folderPath = message.folderPath as string;
	// Avoid logging the raw folder path: it can contain user/home/project
	// identifiers that count as PII in production logs. The basename is
	// usually enough for debugging without leaking the full path.
	const folderPathHint = typeof folderPath === 'string' ? path.basename(folderPath) : '<invalid>';
	logger.info(
		`[Web] Received set_auto_run_folder message: session=${sessionId}, folderBasename=${folderPathHint}, folderPathLength=${folderPath?.length ?? 0}`,
		LOG_CONTEXT
	);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (typeof folderPath !== 'string' || folderPath.trim() === '') {
		ctx.sendError(client, 'Missing or invalid folderPath');
		return;
	}

	if (!ctx.callbacks.setSessionAutoRunFolder) {
		ctx.sendError(client, 'Auto Run folder updates not configured');
		return;
	}

	ctx.callbacks
		.setSessionAutoRunFolder(sessionId, folderPath)
		.then((result) => {
			ctx.send(client, {
				type: 'set_auto_run_folder_result',
				success: result.success,
				error: result.error,
				sessionId,
				folderPath,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			captureException(err, {
				extra: {
					area: 'web-server',
					handler: 'set_auto_run_folder',
					sessionId,
					requestId: message.requestId,
				},
			});
			ctx.sendError(client, `Failed to set Auto Run folder: ${err.message}`);
		});
}

/**
 * Handle get_auto_run_docs message - list Auto Run documents for a session
 */
export function handleGetAutoRunDocs(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received get_auto_run_docs message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.getAutoRunDocs) {
		ctx.sendError(client, 'Auto-run docs listing not configured');
		return;
	}

	ctx.callbacks
		.getAutoRunDocs(sessionId)
		.then((documents) => {
			ctx.send(client, {
				type: 'auto_run_docs',
				sessionId,
				documents,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get auto-run docs: ${error.message}`);
		});
}

/**
 * Handle get_auto_run_state message - get current Auto Run state for a session
 */
export function handleGetAutoRunState(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received get_auto_run_state message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.getSessionDetail) {
		ctx.sendError(client, 'Session detail not configured');
		return;
	}

	const detail = ctx.callbacks.getSessionDetail(sessionId);
	const state: AutoRunState | null = ((detail as any)?.autoRunState as AutoRunState | null) ?? null;

	ctx.send(client, {
		type: 'auto_run_state',
		sessionId,
		state,
		requestId: message.requestId,
	});
}

/**
 * Handle get_auto_run_document message - read content of a specific Auto Run document
 */
export function handleGetAutoRunDocument(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const filename = message.filename as string;
	logger.info(
		`[Web] Received get_auto_run_document message: session=${sessionId}, filename=${filename}`,
		LOG_CONTEXT
	);

	if (!sessionId || !filename) {
		ctx.sendError(client, 'Missing sessionId or filename');
		return;
	}

	if (!isValidFilename(filename)) {
		ctx.sendError(
			client,
			'Invalid filename: must not contain `..` traversal segments, backslashes, or absolute paths (POSIX `/` or Windows drive-letter). Forward-slash subpaths are allowed.'
		);
		return;
	}

	if (!ctx.callbacks.getAutoRunDocContent) {
		ctx.sendError(client, 'Auto-run document reading not configured');
		return;
	}

	ctx.callbacks
		.getAutoRunDocContent(sessionId, filename)
		.then((content) => {
			ctx.send(client, {
				type: 'auto_run_document_content',
				sessionId,
				filename,
				content,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to read auto-run document: ${error.message}`);
		});
}

/**
 * Handle save_auto_run_document message - write content to a specific Auto Run document
 */
export function handleSaveAutoRunDocument(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const filename = message.filename as string;
	const content = message.content as string;
	logger.info(
		`[Web] Received save_auto_run_document message: session=${sessionId}, filename=${filename}`,
		LOG_CONTEXT
	);

	if (!sessionId || !filename) {
		ctx.sendError(client, 'Missing sessionId or filename');
		return;
	}

	if (typeof content !== 'string') {
		ctx.sendError(client, 'Missing or invalid content');
		return;
	}

	if (!isValidFilename(filename)) {
		ctx.sendError(
			client,
			'Invalid filename: must not contain `..` traversal segments, backslashes, or absolute paths (POSIX `/` or Windows drive-letter). Forward-slash subpaths are allowed.'
		);
		return;
	}

	if (!ctx.callbacks.saveAutoRunDoc) {
		ctx.sendError(client, 'Auto-run document saving not configured');
		return;
	}

	ctx.callbacks
		.saveAutoRunDoc(sessionId, filename, content)
		.then((success) => {
			ctx.send(client, {
				type: 'save_auto_run_document_result',
				success,
				sessionId,
				filename,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to save auto-run document: ${error.message}`);
		});
}

/**
 * Handle stop_auto_run message - stop an active Auto Run for a session
 */
export function handleStopAutoRun(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received stop_auto_run message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.stopAutoRun) {
		ctx.sendError(client, 'Auto-run stopping not configured');
		return;
	}

	ctx.callbacks
		.stopAutoRun(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'stop_auto_run_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to stop auto-run: ${error.message}`);
		});
}

/**
 * Handle reset_auto_run_doc_tasks message - revert all completed `[x]`
 * checkboxes back to `[ ]` for a single document. Mirrors the desktop's
 * "Reset Tasks" action so a playbook can be re-run from scratch.
 */
export function handleResetAutoRunDocTasks(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const filename = message.filename as string;
	logger.info(
		`[Web] Received reset_auto_run_doc_tasks message: session=${sessionId}, filename=${filename}`,
		LOG_CONTEXT
	);

	if (!sessionId || !filename) {
		ctx.sendError(client, 'Missing sessionId or filename');
		return;
	}

	// Allow relative subdirectory paths (forward slashes) but reject traversal and
	// absolute paths (POSIX `/foo.md` and Windows `C:/foo.md` / `C:\foo.md`) so the
	// target always resolves under the Auto Run root.
	if (
		typeof filename !== 'string' ||
		filename.length === 0 ||
		filename.includes('..') ||
		filename.includes('\\') ||
		filename.startsWith('/') ||
		/^[A-Za-z]:[\\/]/.test(filename)
	) {
		ctx.sendError(client, 'Invalid filename');
		return;
	}

	if (!ctx.callbacks.resetAutoRunDocTasks) {
		ctx.sendError(client, 'Auto-run task reset not configured');
		return;
	}

	ctx.callbacks
		.resetAutoRunDocTasks(sessionId, filename)
		.then((success) => {
			ctx.send(client, {
				type: 'reset_auto_run_doc_tasks_result',
				success,
				sessionId,
				filename,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'reset_auto_run_doc_tasks',
				{ sessionId, filename, requestId: message.requestId },
				'Failed to reset auto-run doc tasks'
			);
		});
}

/**
 * Handle resume_auto_run_error message - clear the error pause and continue.
 */
export function handleResumeAutoRunError(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!ctx.callbacks.resumeAutoRunError) {
		ctx.sendError(client, 'Auto-run resume not configured');
		return;
	}
	ctx.callbacks
		.resumeAutoRunError(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'resume_auto_run_error_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'resume_auto_run_error',
				{ sessionId, requestId: message.requestId },
				'Failed to resume auto-run'
			);
		});
}

/**
 * Handle skip_auto_run_document message - skip the failing document and
 * continue with the next one in the queue.
 */
export function handleSkipAutoRunDocument(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!ctx.callbacks.skipAutoRunDocument) {
		ctx.sendError(client, 'Auto-run skip not configured');
		return;
	}
	ctx.callbacks
		.skipAutoRunDocument(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'skip_auto_run_document_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'skip_auto_run_document',
				{ sessionId, requestId: message.requestId },
				'Failed to skip auto-run document'
			);
		});
}

/**
 * Handle abort_auto_run_error message - fully stop the run after an error.
 */
export function handleAbortAutoRunError(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!ctx.callbacks.abortAutoRunError) {
		ctx.sendError(client, 'Auto-run abort not configured');
		return;
	}
	ctx.callbacks
		.abortAutoRunError(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'abort_auto_run_error_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'abort_auto_run_error',
				{ sessionId, requestId: message.requestId },
				'Failed to abort auto-run'
			);
		});
}
