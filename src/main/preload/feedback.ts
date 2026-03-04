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

/**
 * Feedback API
 */
export interface FeedbackApi {
	/**
	 * Check whether gh CLI is available and authenticated
	 */
	checkGhAuth: () => Promise<FeedbackAuthResponse>;
	/**
	 * Submit user feedback to an active agent session
	 */
	submit: (sessionId: string, feedbackText: string) => Promise<FeedbackSubmitResponse>;
}

/**
 * Creates the feedback API object for preload exposure
 */
export function createFeedbackApi() {
	return {
		checkGhAuth: (): Promise<FeedbackAuthResponse> => ipcRenderer.invoke('feedback:check-gh-auth'),

		submit: (sessionId: string, feedbackText: string): Promise<FeedbackSubmitResponse> =>
			ipcRenderer.invoke('feedback:submit', { sessionId, feedbackText }),
	};
}
