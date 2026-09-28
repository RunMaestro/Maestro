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
	FeedbackDraft,
	FeedbackIssueSearchResponse,
	FeedbackSubmissionPayload,
	FeedbackSubmitResponse,
	SubmittedIssue,
} from '../../shared/feedback';

export type {
	FeedbackAttachmentPayload,
	FeedbackAuthResponse,
	FeedbackCategory,
	FeedbackConversationSubmitPayload,
	FeedbackDraft,
	FeedbackDraftAttachment,
	FeedbackDraftMessage,
	FeedbackDraftResponse,
	FeedbackDraftStructured,
	FeedbackSubmissionPayload,
	FeedbackSubmitResponse,
	SubmittedIssue,
} from '../../shared/feedback';

/**
 * Feedback API
 */
export interface FeedbackApi {
	/**
	 * Check whether gh CLI is available and authenticated
	 */
	checkGhAuth: () => Promise<FeedbackAuthResponse>;
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
	 * Persisted, resumable feedback drafts (list / upsert / delete)
	 */
	drafts: {
		list: () => Promise<{ drafts: FeedbackDraft[] }>;
		save: (draft: FeedbackDraft) => Promise<{ draft: FeedbackDraft }>;
		delete: (id: string) => Promise<Record<string, never>>;
	};
	/** Persisted history of issues the user has submitted (list / delete / refresh state) */
	issues: {
		list: () => Promise<{ issues: SubmittedIssue[] }>;
		delete: (issueNumber: number) => Promise<Record<string, never>>;
		refreshStates: () => Promise<{ issues: SubmittedIssue[] }>;
	};
}

/**
 * Creates the feedback API object for preload exposure
 */
export function createFeedbackApi(): FeedbackApi {
	return {
		checkGhAuth: (): Promise<FeedbackAuthResponse> => ipcRenderer.invoke('feedback:check-gh-auth'),

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

		drafts: {
			list: (): Promise<{ drafts: FeedbackDraft[] }> => ipcRenderer.invoke('feedback:drafts:list'),
			save: (draft: FeedbackDraft): Promise<{ draft: FeedbackDraft }> =>
				ipcRenderer.invoke('feedback:drafts:save', draft),
			delete: (id: string): Promise<Record<string, never>> =>
				ipcRenderer.invoke('feedback:drafts:delete', { id }),
		},
		issues: {
			list: (): Promise<{ issues: SubmittedIssue[] }> => ipcRenderer.invoke('feedback:issues:list'),
			delete: (issueNumber: number): Promise<Record<string, never>> =>
				ipcRenderer.invoke('feedback:issues:delete', { number: issueNumber }),
			refreshStates: (): Promise<{ issues: SubmittedIssue[] }> =>
				ipcRenderer.invoke('feedback:issues:refresh-states'),
		},
	};
}
