/**
 * Feedback IPC Handlers
 *
 * Provides IPC handlers for the in-app Send Feedback feature:
 * - feedback:check-gh-auth — verify GitHub CLI is installed and authenticated
 * - feedback:submit — wrap user feedback in a system prompt and send it to a
 *   running agent, which converts it into a GitHub issue on RunMaestro/Maestro.
 *
 * The feedback flow:
 *   Renderer collects free-form feedback → main process resolves the feedback
 *   prompt template → writes `prompt + '\n'` to the selected agent's stdin via
 *   ProcessManager.write(). The agent then runs gh to file the issue.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { execFileNoThrow } from '../../utils/execFile';
import { isGhInstalled, getExpandedEnv, resolveGhPath } from '../../utils/cliDetection';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { feedbackPrompt } from '../../../prompts';
import type { ProcessManager } from '../../process-manager';

const LOG_CONTEXT = '[Feedback]';

/**
 * Helper to create handler options with consistent context.
 */
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for feedback handler registration.
 */
export interface FeedbackHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
}

/**
 * Result of a gh authentication check.
 */
export interface GhAuthStatus {
	authenticated: boolean;
	message?: string;
}

/**
 * Result of submitting feedback to an agent.
 */
export interface FeedbackSubmitResult {
	success: boolean;
	error?: string;
}

// 60-second TTL cache for the gh auth check so the UI can poll without
// re-shelling out on every keystroke.
const GH_AUTH_CACHE_TTL_MS = 60000;
let cachedAuthStatus: GhAuthStatus | null = null;
let cachedAuthAt: number | null = null;

/**
 * Internal: run the actual auth check and populate the cache.
 */
async function computeGhAuthStatus(): Promise<GhAuthStatus> {
	const installed = await isGhInstalled();
	if (!installed) {
		return {
			authenticated: false,
			message: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com',
		};
	}

	const ghPath = await resolveGhPath();
	const result = await execFileNoThrow(ghPath, ['auth', 'status'], undefined, getExpandedEnv());

	if (result.exitCode === 0) {
		return { authenticated: true };
	}

	return {
		authenticated: false,
		message: 'GitHub CLI is not authenticated. Run "gh auth login" in your terminal.',
	};
}

/**
 * Get the gh auth status, using the TTL cache when fresh.
 */
async function getGhAuthStatus(): Promise<GhAuthStatus> {
	if (cachedAuthStatus && cachedAuthAt !== null) {
		const age = Date.now() - cachedAuthAt;
		if (age < GH_AUTH_CACHE_TTL_MS) {
			return cachedAuthStatus;
		}
	}

	const status = await computeGhAuthStatus();
	cachedAuthStatus = status;
	cachedAuthAt = Date.now();
	return status;
}

/**
 * Clear the gh auth status cache. Exported for testing and for situations
 * where the renderer wants to force a fresh check after the user has just
 * run `gh auth login` in another terminal.
 */
export function clearFeedbackGhAuthCache(): void {
	cachedAuthStatus = null;
	cachedAuthAt = null;
}

/**
 * Register all Feedback-related IPC handlers.
 */
export function registerFeedbackHandlers(deps: FeedbackHandlerDependencies): void {
	const { getProcessManager } = deps;

	// Check whether gh is installed and authenticated. Cached for 60s.
	ipcMain.handle(
		'feedback:check-gh-auth',
		withIpcErrorLogging(handlerOpts('check-gh-auth'), async (): Promise<GhAuthStatus> => {
			const status = await getGhAuthStatus();
			logger.debug(`gh auth status: authenticated=${status.authenticated}`, LOG_CONTEXT);
			return status;
		})
	);

	// Submit feedback by writing the wrapped prompt to the selected agent.
	ipcMain.handle(
		'feedback:submit',
		withIpcErrorLogging(
			handlerOpts('submit'),
			async (args: { sessionId: string; feedbackText: string }): Promise<FeedbackSubmitResult> => {
				const { sessionId, feedbackText } = args;

				if (!sessionId || typeof sessionId !== 'string') {
					return { success: false, error: 'Invalid sessionId' };
				}
				if (typeof feedbackText !== 'string' || feedbackText.trim().length === 0) {
					return { success: false, error: 'Feedback text is empty' };
				}

				const processManager = requireDependency(getProcessManager, 'Process manager');

				const constructedPrompt = feedbackPrompt.replace('{{FEEDBACK}}', feedbackText);

				try {
					const wrote = processManager.write(sessionId, constructedPrompt + '\n');
					if (!wrote) {
						return { success: false, error: 'Agent process not available' };
					}
					logger.info(`Feedback dispatched to session ${sessionId}`, LOG_CONTEXT, {
						promptLength: constructedPrompt.length,
					});
					return { success: true };
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					logger.error('Failed to write feedback to agent', LOG_CONTEXT, { error: errorMsg });
					return { success: false, error: 'Agent process not available' };
				}
			}
		)
	);
}
