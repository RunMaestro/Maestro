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
	};
}
