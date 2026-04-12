/**
 * Preload API for the Send Feedback feature
 *
 * Provides the window.maestro.feedback namespace for:
 * - Checking GitHub CLI authentication status
 * - Submitting user feedback via the selected agent session
 */

import { ipcRenderer } from 'electron';

/**
 * Creates the feedback API object for preload exposure
 */
export function createFeedbackApi() {
	return {
		/**
		 * Check if GitHub CLI is installed and authenticated.
		 * Result is cached for 60 seconds.
		 */
		checkGhAuth: (): Promise<{ authenticated: boolean; message?: string }> =>
			ipcRenderer.invoke('feedback:check-gh-auth'),

		/**
		 * Submit feedback by sending a structured prompt to the selected agent session.
		 */
		submit: (
			sessionId: string,
			feedbackText: string
		): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('feedback:submit', { sessionId, feedbackText }),
	};
}

/**
 * TypeScript type for the feedback API
 */
export type FeedbackApi = ReturnType<typeof createFeedbackApi>;
