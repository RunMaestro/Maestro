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
import type { NotificationMetadata } from '../../shared/types/notification';
import type { WindowRegistry } from '../../window-registry';

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

/**
 * Response from custom notification command operations
 */
export interface NotificationCommandResponse {
	success: boolean;
	notificationId?: number;
	error?: string;
}

/**
 * Item in the notification command queue
 */
interface NotificationQueueItem {
	text: string;
	command?: string;
	resolve: (result: NotificationCommandResponse) => void;
}

/**
 * Active notification command process tracking
 */
interface ActiveNotificationProcess {
	process: ChildProcess;
	command: string;
}

interface NotificationHandlerDependencies {
	getWindowRegistry?: () => WindowRegistry | null;
}

// ==========================================================================
// Module State
// ==========================================================================

/** Track active notification command processes by ID for stopping */
const activeNotificationProcesses = new Map<number, ActiveNotificationProcess>();

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

/**
 * Execute notification command - the actual implementation
 * Returns a Promise that resolves when the process completes (not just when it starts)
 */
async function executeNotificationCommand(
	text: string,
	command?: string
): Promise<NotificationCommandResponse> {
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
		// The text is passed via stdin, not as command arguments
		const child = spawn(fullCommand, [], {
			stdio: ['pipe', 'ignore', 'pipe'], // stdin: pipe, stdout: ignore, stderr: pipe for errors
			shell: true, // Enable shell mode to support pipes (e.g., "cmd1 | cmd2")
		});

		// Generate a unique ID for this notification process
		const notificationId = ++notificationProcessIdCounter;
		activeNotificationProcesses.set(notificationId, { process: child, command: fullCommand });

		// Return a Promise that resolves when the process completes
		return new Promise((resolve) => {
			let resolved = false;
			let stderrOutput = '';

			// Write the text to stdin and close it
			if (child.stdin) {
				// Handle stdin errors (EPIPE if process terminates before write completes)
				child.stdin.on('error', (err: unknown) => {
					// Type-safe error code extraction
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
				if (!resolved) {
					resolved = true;
					resolve({ success: false, notificationId, error: String(err) });
				}
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

				// Resolve the promise now that process has completed
				if (!resolved) {
					resolved = true;
					resolve({ success: code === 0, notificationId });
				}
			});

			logger.info('Notification process spawned successfully', 'Notification', {
				notificationId,
				command: fullCommand,
				textLength,
			});
		});
	} catch (error) {
		logger.error('Notification error starting command', 'Notification', {
			error: String(error),
			command: fullCommand,
			textPreview,
		});
		return { success: false, error: String(error) };
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

	// Execute the notification command
	const result = await executeNotificationCommand(item.text, item.command);
	item.resolve(result);

	// Record when this notification ended
	lastNotificationEndTime = Date.now();
	isNotificationProcessing = false;

	// Process next item in queue
	processNextNotification();
}

function focusBrowserWindow(target: BrowserWindow | null | undefined): boolean {
	if (!target || target.isDestroyed?.()) {
		return false;
	}

	try {
		if (target.isMinimized?.()) {
			target.restore?.();
		}
		target.show?.();
		target.focus?.();
		target.moveTop?.();
		return true;
	} catch (error) {
		logger.warn('Notification failed to focus window', 'Notification', {
			error: String(error),
		});
		return false;
	}
}

function focusWindowForMetadata(
	metadata: NotificationMetadata | undefined,
	deps: NotificationHandlerDependencies
): boolean {
	if (!metadata) {
		return false;
	}

	const registry = deps.getWindowRegistry?.();
	if (!registry) {
		return false;
	}

	const resolvedWindowId = metadata.windowId ?? (metadata.sessionId ? registry.getWindowForSession(metadata.sessionId) : undefined);
	if (!resolvedWindowId) {
		return false;
	}

	const entry = registry.get(resolvedWindowId);
	if (!entry) {
		logger.debug('Notification target window not found', 'Notification', { windowId: resolvedWindowId });
		return false;
	}

	return focusBrowserWindow(entry.browserWindow);
}

function focusSourceWindow(sender: Electron.WebContents | null | undefined): boolean {
	if (!sender) {
		return false;
	}

	const ownerWindow = BrowserWindow.fromWebContents?.(sender);
	if (focusBrowserWindow(ownerWindow)) {
		return true;
	}

	const [fallback] = BrowserWindow.getAllWindows();
	return focusBrowserWindow(fallback);
}

// ==========================================================================
// Handler Registration
// ==========================================================================

/**
 * Register all notification-related IPC handlers
 */
export function registerNotificationsHandlers(
	deps: NotificationHandlerDependencies = {}
): void {
	// Show OS notification
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

					notification.once('click', () => {
						const focused = focusWindowForMetadata(metadata, deps);
						if (!focused) {
							focusSourceWindow(event.sender);
						}
					});

					notification.show();
					logger.debug('Showed OS notification', 'Notification', {
						title,
						body,
						windowId: metadata?.windowId,
						sessionId: metadata?.sessionId,
					});
					return { success: true };
				} else {
					logger.warn('OS notifications not supported on this platform', 'Notification');
					return { success: false, error: 'Notifications not supported' };
				}
			} catch (error) {
				logger.error('Error showing notification', 'Notification', error);
				return { success: false, error: String(error) };
			}
		}
	);

	// Custom notification command - queued to prevent overlap
	ipcMain.handle(
		'notification:speak',
		async (_event, text: string, command?: string): Promise<NotificationCommandResponse> => {
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
				notificationQueue.push({ text, command, resolve });
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
