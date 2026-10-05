/**
 * Preload API for feedback submission
 *
 * Provides the window.maestro.feedback namespace for:
 * - Checking GitHub CLI auth status for feedback submission
 * - Submitting structured feedback to an active agent session
 */

import { ipcRenderer } from 'electron';

import type {
	FeedbackAttachmentPayload,
	FeedbackAuthResponse,
	FeedbackConversationSubmitPayload,
	FeedbackGhLoginCommand,
	FeedbackIssueSearchResponse,
	FeedbackSubmissionPayload,
	FeedbackSubmitResponse,
} from '../../shared/feedback';
import type { FeedbackAccountsResponse } from '../../shared/feedbackAccounts';

export type {
	FeedbackAttachmentPayload,
	FeedbackAuthResponse,
	FeedbackCategory,
	FeedbackConversationSubmitPayload,
	FeedbackSubmissionPayload,
	FeedbackSubmitResponse,
} from '../../shared/feedback';

/**
 * Feedback API
 */
export interface FeedbackApi {
	/**
	 * Check whether gh CLI is available and authenticated. `fresh` skips the
	 * cached verdict (after a login, or "Check again").
	 */
	checkGhAuth: (options?: { fresh?: boolean }) => Promise<FeedbackAuthResponse>;
	/**
	 * The gh login command, with the gh binary feedback uses
	 */
	getGhLoginCommand: () => Promise<FeedbackGhLoginCommand>;
	/**
	 * Submit structured user feedback and create a GitHub issue
	 */
	submit: (payload: FeedbackSubmissionPayload) => Promise<FeedbackSubmitResponse>;
	composePrompt: (
		feedbackText: string,
		attachments?: FeedbackAttachmentPayload[]
	) => Promise<{ prompt: string }>;
	/**
	 * Get the conversation system prompt for the feedback chat interface
	 */
	getConversationPrompt: () => Promise<{ prompt: string; environment: string; cwd: string }>;
	/**
	 * Submit feedback from the conversational interface
	 */
	submitConversation: (
		payload: FeedbackConversationSubmitPayload
	) => Promise<FeedbackSubmitResponse>;
	/**
	 * Search existing GitHub issues for potential duplicates
	 */
	searchIssues: (query: string) => Promise<FeedbackIssueSearchResponse>;
	/**
	 * Subscribe to an existing issue (+1 reaction) and optionally comment
	 */
	subscribeIssue: (issueNumber: number, comment?: string) => Promise<FeedbackSubmitResponse>;
	/**
	 * Accounts the feedback chat can run as, checked and in pick order
	 */
	listAccounts: () => Promise<FeedbackAccountsResponse>;
	/**
	 * Remember the account the next conversation tries first
	 */
	rememberAccount: (key: string | null) => Promise<void>;
}

/**
 * Creates the feedback API object for preload exposure
 */
export function createFeedbackApi(): FeedbackApi {
	return {
		checkGhAuth: (options?: { fresh?: boolean }): Promise<FeedbackAuthResponse> =>
			ipcRenderer.invoke('feedback:check-gh-auth', { fresh: options?.fresh === true }),

		getGhLoginCommand: (): Promise<FeedbackGhLoginCommand> =>
			ipcRenderer.invoke('feedback:gh-login-command'),

		submit: (payload: FeedbackSubmissionPayload): Promise<FeedbackSubmitResponse> =>
			ipcRenderer.invoke('feedback:submit', {
				...payload,
				attachments: payload.attachments ?? [],
			}),

		composePrompt: (
			feedbackText: string,
			attachments: FeedbackAttachmentPayload[] = []
		): Promise<{ prompt: string }> =>
			ipcRenderer.invoke('feedback:compose-prompt', { feedbackText, attachments }),

		getConversationPrompt: (): Promise<{ prompt: string; environment: string; cwd: string }> =>
			ipcRenderer.invoke('feedback:get-conversation-prompt'),

		submitConversation: (
			payload: FeedbackConversationSubmitPayload
		): Promise<FeedbackSubmitResponse> =>
			ipcRenderer.invoke('feedback:submit-conversation', payload),

		searchIssues: (query: string) => ipcRenderer.invoke('feedback:search-issues', { query }),

		subscribeIssue: (issueNumber: number, comment?: string): Promise<FeedbackSubmitResponse> =>
			ipcRenderer.invoke('feedback:subscribe-issue', { issueNumber, comment }),

		listAccounts: (): Promise<FeedbackAccountsResponse> =>
			ipcRenderer.invoke('feedback:list-accounts'),

		rememberAccount: (key: string | null): Promise<void> =>
			ipcRenderer.invoke('feedback:remember-account', { key }),
	};
}
