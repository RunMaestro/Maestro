/**
 * Feedback IPC Handlers
 *
 * Thin IPC wrappers over the feedback service in `src/main/feedback`, which
 * owns the logic so `maestro-cli feedback` (over the WS bridge) files the
 * identical issue the desktop modal does.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import type { DebugPackageDependencies } from '../../debug-package';
import type { MaestroCliManager } from '../../maestro-cli-manager';
import {
	buildFeedbackConversationPrompt,
	checkFeedbackGhAuth,
	composeFeedbackPromptFromText,
	deleteFeedbackDraft,
	deleteSubmittedIssue,
	getFeedbackGhLoginCommand,
	listFeedbackDrafts,
	listSubmittedIssues,
	refreshSubmittedIssueStates,
	saveFeedbackDraft,
	searchFeedbackIssues,
	submitFeedback,
	submitFeedbackConversation,
	subscribeFeedbackIssue,
} from '../../feedback';
import { listFeedbackAccounts, rememberFeedbackAccount } from '../../feedback/accounts';

const LOG_CONTEXT = '[Feedback]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
	...extra,
});

/**
 * Dependencies required for feedback handler registration
 */
export interface FeedbackHandlerDependencies {
	getProcessManager: () => unknown;
	debugPackageDeps?: DebugPackageDependencies;
	/**
	 * Resolves the maestro-cli install status so the conversation prompt can tell
	 * the feedback agent whether live diagnostics are actually available. Optional:
	 * without it the prompt simply omits the CLI from the environment block and the
	 * agent falls back to reading logs directly.
	 */
	getMaestroCliManager?: () => MaestroCliManager;
}

/**
 * Register feedback IPC handlers.
 */
export function registerFeedbackHandlers(deps: FeedbackHandlerDependencies): void {
	logger.info('Registering feedback IPC handlers', LOG_CONTEXT);

	ipcMain.handle(
		'feedback:check-gh-auth',
		withIpcErrorLogging(handlerOpts('check-gh-auth'), (payload?: { fresh?: boolean }) =>
			checkFeedbackGhAuth({ fresh: payload?.fresh === true })
		)
	);

	ipcMain.handle(
		'feedback:gh-login-command',
		withIpcErrorLogging(handlerOpts('gh-login-command'), () => getFeedbackGhLoginCommand())
	);

	ipcMain.handle(
		'feedback:search-issues',
		withIpcErrorLogging(handlerOpts('search-issues'), (payload: { query: string }) =>
			searchFeedbackIssues(payload)
		)
	);

	ipcMain.handle(
		'feedback:subscribe-issue',
		withIpcErrorLogging(
			handlerOpts('subscribe-issue'),
			(payload: { issueNumber: number; comment?: string }) => subscribeFeedbackIssue(payload)
		)
	);

	ipcMain.handle('feedback:submit', withIpcErrorLogging(handlerOpts('submit'), submitFeedback));

	ipcMain.handle(
		'feedback:get-conversation-prompt',
		withIpcErrorLogging(handlerOpts('get-conversation-prompt'), () =>
			buildFeedbackConversationPrompt(deps.getMaestroCliManager?.())
		)
	);

	ipcMain.handle(
		'feedback:submit-conversation',
		withIpcErrorLogging(
			handlerOpts('submit-conversation'),
			(payload: Parameters<typeof submitFeedbackConversation>[0]) =>
				submitFeedbackConversation(payload, deps.debugPackageDeps)
		)
	);

	ipcMain.handle(
		'feedback:list-accounts',
		withIpcErrorLogging(handlerOpts('list-accounts'), () =>
			listFeedbackAccounts(() => deps.debugPackageDeps?.getAgentDetector() ?? null)
		)
	);

	ipcMain.handle(
		'feedback:remember-account',
		withIpcErrorLogging(handlerOpts('remember-account'), async (payload: { key: string | null }) =>
			rememberFeedbackAccount(payload?.key ?? null)
		)
	);

	ipcMain.handle(
		'feedback:compose-prompt',
		withIpcErrorLogging(handlerOpts('compose-prompt'), composeFeedbackPromptFromText)
	);

	// Persisted, resumable feedback drafts. Listed most-recently-updated first
	// so the renderer can treat drafts[0] as the "most recent" draft.
	ipcMain.handle(
		'feedback:drafts:list',
		withIpcErrorLogging(handlerOpts('drafts-list'), () => listFeedbackDrafts())
	);

	ipcMain.handle(
		'feedback:drafts:save',
		withIpcErrorLogging(handlerOpts('drafts-save'), (draft: unknown) => saveFeedbackDraft(draft))
	);

	ipcMain.handle(
		'feedback:drafts:delete',
		withIpcErrorLogging(
			handlerOpts('drafts-delete'),
			async (payload: { id?: string }): Promise<Record<string, never>> => {
				await deleteFeedbackDraft(typeof payload?.id === 'string' ? payload.id : '');
				return {};
			}
		)
	);

	// Submitted-issue history, most-recent-first.
	ipcMain.handle(
		'feedback:issues:list',
		withIpcErrorLogging(handlerOpts('issues-list'), () => listSubmittedIssues())
	);

	// Delete one history record locally (does not touch GitHub).
	ipcMain.handle(
		'feedback:issues:delete',
		withIpcErrorLogging(
			handlerOpts('issues-delete'),
			async (payload: { number?: number }): Promise<Record<string, never>> => {
				await deleteSubmittedIssue(typeof payload?.number === 'number' ? payload.number : NaN);
				return {};
			}
		)
	);

	ipcMain.handle(
		'feedback:issues:refresh-states',
		withIpcErrorLogging(handlerOpts('issues-refresh-states'), () => refreshSubmittedIssueStates())
	);
}
