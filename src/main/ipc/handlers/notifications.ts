/**
 * Notification IPC Handlers
 *
 * Handles all notification-related IPC operations:
 * - Showing OS notifications
 * - Custom notification commands with queueing
 * - Stopping active notification processes
 *
 * Note: Custom notification commands are user-configured and can be any command
 * that accepts text via stdin. The user has full control over what command is executed.
 */

import { ipcMain, Notification, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { parseDeepLink, dispatchDeepLink } from '../../deep-links';
import { buildSessionDeepLink } from '../../../shared/deep-link-urls';
import { captureException } from '../../utils/sentry';

// ==========================================================================
// Constants
// ==========================================================================

/**
 * Minimum delay between notification command calls to prevent audio overlap.
 *
 * 15 seconds was chosen to:
 * 1. Allow sufficient time for most messages to complete naturally
 * 2. Prevent rapid-fire notifications from overwhelming the user
 * 3. Give users time to process each notification before the next one
 *
 * This value balances responsiveness with preventing notification chaos when
 * multiple notifications trigger in quick succession.
 */
const NOTIFICATION_MIN_DELAY_MS = 15000;

/**
 * Maximum number of items allowed in the notification queue.
 * Prevents memory issues if requests accumulate faster than they can be processed.
 */
const NOTIFICATION_MAX_QUEUE_SIZE = 10;

/**
 * Default notification command (macOS TTS)
 */
const DEFAULT_NOTIFICATION_COMMAND = 'say';

// ==========================================================================
// Types
// ==========================================================================

/**
 * Response from showing a notification
 */
export interface NotificationShowResponse {
	success: boolean;
	error?: string;
}

export interface NotificationMetadata {
	windowId?: string;
	sessionId?: string;
	tabId?: string;
}

/**
 * Response from custom notification command operations
 */
export interface NotificationCommandResponse {
	success: boolean;
	notificationId?: number;
	error?: string;
}

/**
 * Optional Maestro context forwarded to the custom notification command as
 * environment variables (MAESTRO_NOTIFY_*). Passing metadata via env instead of
 * string interpolation keeps it safe from shell injection; unset fields are
 * simply absent from the child's environment.
 */
export interface NotificationCommandVars {
	/** Agent name (Left Bar entity / session name) -> MAESTRO_NOTIFY_AGENT */
	agent?: string;
	/** AI tab name within the agent -> MAESTRO_NOTIFY_TAB */
	tab?: string;
	/** Group the agent belongs to -> MAESTRO_NOTIFY_GROUP */
	group?: string;
	/** Originating task/prompt title -> MAESTRO_NOTIFY_TASK */
	task?: string;
}

/**
 * Item in the notification command queue
 */
interface NotificationQueueItem {
	text: string;
	command?: string;
	vars?: NotificationCommandVars;
	resolve: (result: NotificationCommandResponse) => void;
}

/**
 * Active notification command process tracking
 */
interface ActiveNotificationProcess {
	process: ChildProcess;
	command: string;
}

// ==========================================================================
// Module State
// ==========================================================================

/** Track active notification command processes by ID for stopping */
const activeNotificationProcesses = new Map<number, ActiveNotificationProcess>();

/**
 * Keep OS Notification objects alive until clicked or closed.
 * Without this, GC can collect the notification before the user
 * interacts with it, silently dropping the click handler.
 */
const activeNotifications = new Set<Notification>();

/** Counter for generating unique notification process IDs */
let notificationProcessIdCounter = 0;

/** Timestamp when the last notification command completed */
let lastNotificationEndTime = 0;

/** Queue of pending notification command requests */
const notificationQueue: NotificationQueueItem[] = [];

/** Flag indicating if notification command is currently being processed */
let isNotificationProcessing = false;

// ==========================================================================
// Helper Functions
// ==========================================================================

/**
 * Parse the notification command configuration.
 *
 * The user can configure any command they want - this is intentional.
 * The command is executed with shell: true to support pipes and command chains.
 *
 * @param command - The user-configured notification command
 * @returns The command to execute (or default if empty)
 */
export function parseNotificationCommand(command?: string): string {
	// Use default if no command provided
	if (!command || command.trim() === '') {
		return DEFAULT_NOTIFICATION_COMMAND;
	}

	return command.trim();
}

function focusNotificationWindow(win: BrowserWindow | null | undefined): boolean {
	if (!win || win.isDestroyed()) {
		return false;
	}

	if (win.isMinimized()) {
		win.restore();
	}
	win.show();
	win.focus();
	return true;
}

/**
 * Build the child-process environment for a notification command.
 *
 * Always inherits the parent environment (so PATH etc. stay intact) and layers
 * on MAESTRO_NOTIFY_* variables for any context the caller provided. Empty or
 * missing fields are omitted so commands can test for their presence.
 */
export function buildNotificationEnv(vars?: NotificationCommandVars): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (vars?.agent) env.MAESTRO_NOTIFY_AGENT = vars.agent;
	if (vars?.tab) env.MAESTRO_NOTIFY_TAB = vars.tab;
	if (vars?.group) env.MAESTRO_NOTIFY_GROUP = vars.group;
	if (vars?.task) env.MAESTRO_NOTIFY_TASK = vars.task;
	return env;
}

/**
 * Result from executeNotificationCommand.
 * `response` is returned to the renderer immediately (contains the notificationId).
 * `completed` resolves when the process exits (used by the queue for spacing).
 */
interface ExecuteResult {
	response: NotificationCommandResponse;
	completed: Promise<void>;
}

/**
 * Execute notification command - the actual implementation.
 * Returns immediately after spawning with the notificationId so the renderer
 * can show a Stop button. The `completed` promise resolves when the process
 * exits, allowing the queue to enforce spacing between notifications.
 */
function executeNotificationCommand(
	text: string,
	command?: string,
	vars?: NotificationCommandVars
): ExecuteResult {
	const fullCommand = parseNotificationCommand(command);
	const textLength = text?.length || 0;
	const textPreview = text
		? text.length > 200
			? text.substring(0, 200) + '...'
			: text
		: '(no text)';

	// Log the incoming request with full details for debugging
	logger.info('Notification command request received', 'Notification', {
		command: fullCommand,
		textLength,
		textPreview,
	});

	try {
		// Log the full command being executed
		logger.debug('Notification executing command', 'Notification', {
			command: fullCommand,
			textLength,
		});

		// Spawn the process with shell mode to support pipes and command chains
		// The text is passed via stdin, not as command arguments. Maestro context
		// (agent/tab/group/task) rides along as MAESTRO_NOTIFY_* env vars so the
		// command can reference it without any shell-injection risk.
		const child = spawn(fullCommand, [], {
			stdio: ['pipe', 'ignore', 'pipe'], // stdin: pipe, stdout: ignore, stderr: pipe for errors
			shell: true, // Enable shell mode to support pipes (e.g., "cmd1 | cmd2")
			env: buildNotificationEnv(vars),
		});

		// Generate a unique ID for this notification process
		const notificationId = ++notificationProcessIdCounter;
		activeNotificationProcesses.set(notificationId, { process: child, command: fullCommand });

		// Write the text to stdin and close it
		if (child.stdin) {
			// Handle stdin errors (EPIPE if process terminates before write completes)
			child.stdin.on('error', (err: unknown) => {
				const errorCode =
					err && typeof err === 'object' && 'code' in err
						? (err as NodeJS.ErrnoException).code
						: undefined;

				if (errorCode === 'EPIPE') {
					logger.debug(
						'Notification stdin EPIPE - process closed before write completed',
						'Notification'
					);
				} else {
					logger.error('Notification stdin error', 'Notification', {
						error: String(err),
						code: errorCode,
					});
				}
			});

			logger.debug('Notification writing to stdin', 'Notification', { textLength });
			child.stdin.write(text, 'utf8', (err) => {
				if (err) {
					logger.error('Notification stdin write error', 'Notification', { error: String(err) });
				} else {
					logger.debug('Notification stdin write completed', 'Notification');
				}
				child.stdin!.end();
			});
		} else {
			logger.error('Notification no stdin available on child process', 'Notification');
		}

		// Track process completion for queue spacing
		const completed = new Promise<void>((resolveCompleted) => {
			let stderrOutput = '';

			child.on('error', (err) => {
				logger.error('Notification spawn error', 'Notification', {
					error: String(err),
					command: fullCommand,
					textPreview: text
						? text.length > 100
							? text.substring(0, 100) + '...'
							: text
						: '(no text)',
				});
				activeNotificationProcesses.delete(notificationId);
				// Notify renderer of completion even on error
				BrowserWindow.getAllWindows().forEach((win) => {
					if (isWebContentsAvailable(win)) {
						win.webContents.send('notification:commandCompleted', notificationId);
					}
				});
				resolveCompleted();
			});

			// Capture stderr for debugging
			if (child.stderr) {
				child.stderr.on('data', (data) => {
					stderrOutput += data.toString();
				});
			}

			child.on('close', (code, signal) => {
				// Always log close event for debugging production issues
				logger.info('Notification process closed', 'Notification', {
					notificationId,
					exitCode: code,
					signal,
					stderr: stderrOutput || '(none)',
					command: fullCommand,
				});

				if (code !== 0 && stderrOutput) {
					logger.error('Notification process error output', 'Notification', {
						exitCode: code,
						stderr: stderrOutput,
						command: fullCommand,
					});
				}

				activeNotificationProcesses.delete(notificationId);

				// Notify renderer that notification command has completed
				BrowserWindow.getAllWindows().forEach((win) => {
					if (isWebContentsAvailable(win)) {
						win.webContents.send('notification:commandCompleted', notificationId);
					}
				});

				resolveCompleted();
			});
		});

		logger.info('Notification process spawned successfully', 'Notification', {
			notificationId,
			command: fullCommand,
			textLength,
		});

		// Return immediately with notificationId; completed resolves when process exits
		return {
			response: { success: true, notificationId },
			completed,
		};
	} catch (error) {
		void captureException(error);
		logger.error('Notification error starting command', 'Notification', {
			error: String(error),
			command: fullCommand,
			textPreview,
		});
		return {
			response: { success: false, error: String(error) },
			completed: Promise.resolve(),
		};
	}
}

/**
 * Process the next item in the notification queue.
 *
 * Uses a flag-first approach to prevent race conditions:
 * 1. Check and set the processing flag atomically
 * 2. Then check the queue
 * This ensures only one processNextNotification call can proceed at a time.
 */
async function processNextNotification(): Promise<void> {
	// Check queue first - if empty, nothing to do
	if (notificationQueue.length === 0) return;

	// Set flag BEFORE processing to prevent race condition
	// where multiple calls could pass the isNotificationProcessing check simultaneously
	if (isNotificationProcessing) return;
	isNotificationProcessing = true;

	// Double-check queue after setting flag (another call might have emptied it)
	if (notificationQueue.length === 0) {
		isNotificationProcessing = false;
		return;
	}

	const item = notificationQueue.shift()!;

	// Calculate delay needed to maintain minimum gap
	const now = Date.now();
	const timeSinceLastNotification = now - lastNotificationEndTime;
	const delayNeeded = Math.max(0, NOTIFICATION_MIN_DELAY_MS - timeSinceLastNotification);

	if (delayNeeded > 0) {
		logger.debug(`Notification queue waiting ${delayNeeded}ms before next command`, 'Notification');
		await new Promise((resolve) => setTimeout(resolve, delayNeeded));
	}

	// Execute the notification command — resolve the IPC call immediately
	// with the notificationId, then await completion for queue spacing
	const { response, completed } = executeNotificationCommand(item.text, item.command, item.vars);
	item.resolve(response);
	await completed;

	// Record when this notification ended
	lastNotificationEndTime = Date.now();
	isNotificationProcessing = false;

	// Process next item in queue
	processNextNotification();
}

// ==========================================================================
// Handler Registration
// ==========================================================================

/**
 * Dependencies for notification handlers
 */
export interface NotificationsHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	getWindowById?: (windowId: string) => BrowserWindow | null | undefined;
}

/**
 * Register all notification-related IPC handlers
 */
export function registerNotificationsHandlers(deps?: NotificationsHandlerDependencies): void {
	// Show OS notification (with optional click-to-navigate support)
	ipcMain.handle(
		'notification:show',
		async (
			event,
			title: string,
			body: string,
			metadata?: NotificationMetadata
		): Promise<NotificationShowResponse> => {
			try {
				if (Notification.isSupported()) {
					const notification = new Notification({
						title,
						body,
						silent: true, // Don't play system sound - we have our own audio feedback option
					});

					// Prevent GC from collecting the notification before user interaction
					activeNotifications.add(notification);
					const releaseNotification = () => {
						activeNotifications.delete(notification);
					};
					notification.on('close', releaseNotification);

					// Wire click handler for navigation if session context is provided
					if (metadata?.sessionId || metadata?.windowId) {
						const deepLinkUrl = metadata.sessionId
							? buildSessionDeepLink(metadata.sessionId, metadata.tabId)
							: null;
						notification.on('click', () => {
							const targetWindow =
								metadata.windowId && deps?.getWindowById
									? (deps.getWindowById(metadata.windowId) ??
										BrowserWindow.fromWebContents(event.sender))
									: BrowserWindow.fromWebContents(event.sender);
							const focused = focusNotificationWindow(targetWindow);

							const parsed = deepLinkUrl ? parseDeepLink(deepLinkUrl) : null;
							if (parsed && deps?.getMainWindow) {
								dispatchDeepLink(parsed, deps.getMainWindow);
							}
							logger.debug('Notification click handled', 'Notification', {
								focused,
								windowId: metadata.windowId,
								sessionId: metadata.sessionId,
								tabId: metadata.tabId,
							});
							releaseNotification();
						});
					}

					notification.show();
					logger.debug('Showed OS notification', 'Notification', { title, body, metadata });
					return { success: true };
				} else {
					logger.warn('OS notifications not supported on this platform', 'Notification');
					return { success: false, error: 'Notifications not supported' };
				}
			} catch (error) {
				void captureException(error);
				logger.error('Error showing notification', 'Notification', error);
				return { success: false, error: String(error) };
			}
		}
	);

	// Custom notification command - queued to prevent overlap
	ipcMain.handle(
		'notification:speak',
		async (
			_event,
			text: string,
			command?: string,
			vars?: NotificationCommandVars
		): Promise<NotificationCommandResponse> => {
			// Skip if there's no content to send
			if (!text || text.trim().length === 0) {
				logger.info('Notification skipped - empty or whitespace-only content', 'Notification', {
					textLength: text?.length ?? 0,
					hasText: !!text,
				});
				return { success: true }; // Return success since there's nothing to do
			}

			// Check queue size limit to prevent memory issues
			if (notificationQueue.length >= NOTIFICATION_MAX_QUEUE_SIZE) {
				logger.warn('Notification queue is full, rejecting request', 'Notification', {
					queueLength: notificationQueue.length,
					maxSize: NOTIFICATION_MAX_QUEUE_SIZE,
				});
				return {
					success: false,
					error: `Notification queue is full (max ${NOTIFICATION_MAX_QUEUE_SIZE} items). Please wait for current items to complete.`,
				};
			}

			// Add to queue and return a promise that resolves when this notification completes
			return new Promise<NotificationCommandResponse>((resolve) => {
				notificationQueue.push({ text, command, vars, resolve });
				logger.debug(
					`Notification queued, queue length: ${notificationQueue.length}`,
					'Notification'
				);
				processNextNotification();
			});
		}
	);

	// Stop a running notification command process
	ipcMain.handle(
		'notification:stopSpeak',
		async (_event, notificationId: number): Promise<NotificationCommandResponse> => {
			logger.debug('Notification stop requested', 'Notification', { notificationId });

			const notificationProcess = activeNotificationProcesses.get(notificationId);
			if (!notificationProcess) {
				logger.debug('Notification no active process found', 'Notification', { notificationId });
				return { success: false, error: 'No active notification process with that ID' };
			}

			try {
				// Kill the process and all its children
				notificationProcess.process.kill('SIGTERM');
				activeNotificationProcesses.delete(notificationId);

				logger.info('Notification process stopped', 'Notification', {
					notificationId,
					command: notificationProcess.command,
				});

				return { success: true };
			} catch (error) {
				void captureException(error);
				logger.error('Notification error stopping process', 'Notification', {
					notificationId,
					error: String(error),
				});
				return { success: false, error: String(error) };
			}
		}
	);
}

// ==========================================================================
// Exports for Testing
// ==========================================================================

/**
 * Get the current notification queue length (for testing)
 */
export function getNotificationQueueLength(): number {
	return notificationQueue.length;
}

/**
 * Get the count of active notification processes (for testing)
 */
export function getActiveNotificationCount(): number {
	return activeNotificationProcesses.size;
}

/**
 * Clear the notification queue (for testing)
 */
export function clearNotificationQueue(): void {
	notificationQueue.length = 0;
}

/**
 * Reset notification state (for testing)
 */
export function resetNotificationState(): void {
	notificationQueue.length = 0;
	activeNotificationProcesses.clear();
	activeNotifications.clear();
	notificationProcessIdCounter = 0;
	lastNotificationEndTime = 0;
	isNotificationProcessing = false;
}

/**
 * Get the maximum notification queue size (for testing)
 */
export function getNotificationMaxQueueSize(): number {
	return NOTIFICATION_MAX_QUEUE_SIZE;
}
