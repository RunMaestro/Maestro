/**
 * Feedback IPC Handlers
 *
 * This module provides IPC handlers for the Send Feedback feature.
 * It checks GitHub CLI authentication and submits user feedback
 * by sending a structured prompt to the selected agent.
 *
 * Usage:
 * - window.maestro.feedback.checkGhAuth()
 * - window.maestro.feedback.submit(sessionId, feedbackText)
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	isGhInstalled,
	getExpandedEnv,
	getCachedGhStatus,
	setCachedGhStatus,
} from '../../utils/cliDetection';
import { execFileNoThrow } from '../../utils/execFile';
import { feedbackPrompt } from '../../../prompts';
import type { ProcessManager } from '../../process-manager';

const LOG_CONTEXT = '[Feedback]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for feedback handler registration
 */
export interface FeedbackHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
}

/**
 * Register all Feedback-related IPC handlers.
 *
 * - feedback:check-gh-auth: checks if gh CLI is installed and authenticated
 * - feedback:submit: sends feedback prompt to the selected agent session
 */
export function registerFeedbackHandlers(deps: FeedbackHandlerDependencies): void {
	const { getProcessManager } = deps;

	// Check if GitHub CLI is installed and authenticated
	ipcMain.handle(
		'feedback:check-gh-auth',
		withIpcErrorLogging(handlerOpts('check-gh-auth'), async () => {
			// Check cache first (60-second TTL is managed by cliDetection)
			const cached = getCachedGhStatus();
			if (cached !== null) {
				logger.debug('Using cached gh auth status', LOG_CONTEXT, cached);
				if (!cached.installed) {
					return {
						authenticated: false,
						message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
					};
				}
				if (!cached.authenticated) {
					return {
						authenticated: false,
						message: 'GitHub CLI is not authenticated. Run "gh auth login" in your terminal.',
					};
				}
				return { authenticated: true };
			}

			const installed = await isGhInstalled();
			if (!installed) {
				setCachedGhStatus(false, false);
				return {
					authenticated: false,
					message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
				};
			}

			const result = await execFileNoThrow('gh', ['auth', 'status'], undefined, getExpandedEnv());
			const authenticated = result.exitCode === 0;
			setCachedGhStatus(true, authenticated);

			if (!authenticated) {
				logger.debug('gh auth check failed', LOG_CONTEXT, { stderr: result.stderr });
				return {
					authenticated: false,
					message: 'GitHub CLI is not authenticated. Run "gh auth login" in your terminal.',
				};
			}

			return { authenticated: true };
		})
	);

	// Submit feedback by writing the prompt to the selected agent session
	ipcMain.handle(
		'feedback:submit',
		withIpcErrorLogging(
			handlerOpts('submit'),
			async (params: { sessionId?: unknown; feedbackText?: unknown }) => {
				const sessionId = typeof params?.sessionId === 'string' ? params.sessionId.trim() : '';
				const feedbackText =
					typeof params?.feedbackText === 'string' ? params.feedbackText.trim() : '';

				if (!sessionId) {
					return { success: false, error: 'Invalid session id' };
				}
				if (!feedbackText || feedbackText.length > 5000) {
					return { success: false, error: 'Feedback must be between 1 and 5,000 characters' };
				}

				const processManager = getProcessManager();
				if (!processManager) {
					logger.error('Process manager not available for feedback submit', LOG_CONTEXT);
					return { success: false, error: 'Agent process not available' };
				}

				const constructedPrompt = feedbackPrompt.replace('{{FEEDBACK}}', feedbackText);
				const wrote = processManager.write(sessionId, constructedPrompt + '\n');

				if (!wrote) {
					logger.error('write() returned false for feedback session', LOG_CONTEXT, { sessionId });
					return { success: false, error: 'Agent process not available' };
				}

				logger.info('Feedback prompt sent to agent session', LOG_CONTEXT, { sessionId });
				return { success: true };
			}
		)
	);
}
