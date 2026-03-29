/**
 * Preload API for feedback submission
 *
 * Provides the window.maestro.feedback namespace for:
 * - Checking GitHub CLI auth status for feedback submission
 * - Submitting structured feedback to an active agent session
 */

import { ipcRenderer } from 'electron';

/**
 * Feedback auth check response
 */
export interface FeedbackAuthResponse {
	authenticated: boolean;
	message?: string;
}

/**
 * Feedback submission response
 */
export interface FeedbackSubmitResponse {
	success: boolean;
	error?: string;
	issueUrl?: string;
}

export interface FeedbackAttachmentPayload {
	name: string;
	dataUrl: string;
}

export type FeedbackCategory =
	| 'bug_report'
	| 'feature_request'
	| 'improvement'
	| 'general_feedback';

export interface FeedbackSubmissionPayload {
	sessionId: string;
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	details: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentPayload[];
}

/**
 * Feedback API
 */
export interface FeedbackConversationSubmitPayload {
	category: FeedbackCategory;
	summary: string;
	expectedBehavior: string;
	actualBehavior: string;
	reproductionSteps?: string;
	additionalContext?: string;
	agentProvider?: string;
	sshRemoteEnabled?: boolean;
	attachments?: FeedbackAttachmentPayload[];
	includeDebugPackage?: boolean;
}

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
	getConversationPrompt: () => Promise<{ prompt: string; environment: string }>;
	/**
	 * Submit feedback from the conversational interface
	 */
	submitConversation: (
		payload: FeedbackConversationSubmitPayload
	) => Promise<FeedbackSubmitResponse>;
	/**
	 * Search existing GitHub issues for potential duplicates
	 */
	searchIssues: (query: string) => Promise<{
		issues: Array<{
			number: number;
			title: string;
			url: string;
			state: string;
			labels: string[];
			createdAt: string;
			author: string;
			commentCount: number;
		}>;
	}>;
	/**
	 * Subscribe to an existing issue (+1 reaction) and optionally comment
	 */
	subscribeIssue: (issueNumber: number, comment?: string) => Promise<FeedbackSubmitResponse>;
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

		getConversationPrompt: (): Promise<{ prompt: string; environment: string }> =>
			ipcRenderer.invoke('feedback:get-conversation-prompt'),

		submitConversation: (
			payload: FeedbackConversationSubmitPayload
		): Promise<FeedbackSubmitResponse> =>
			ipcRenderer.invoke('feedback:submit-conversation', payload),

		searchIssues: (query: string) => ipcRenderer.invoke('feedback:search-issues', { query }),

		subscribeIssue: (issueNumber: number, comment?: string): Promise<FeedbackSubmitResponse> =>
			ipcRenderer.invoke('feedback:subscribe-issue', { issueNumber, comment }),
	};
}
