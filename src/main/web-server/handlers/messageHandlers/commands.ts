/**
 * Commands domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: send_command, switch_mode,
 * select_session.
 */

import { logger } from '../../../utils/logger';
import { getDispatchCallbackRegistry } from '../../../dispatch-callbacks';
import { armDispatchCallback } from './dispatchCallbacks';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle send_command message - execute command in session
 */
export function handleSendCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const command = message.command as string;
	// inputMode from web client - use this instead of server state to avoid sync issues
	const clientInputMode = message.inputMode as 'ai' | 'terminal' | undefined;
	// Optional explicit tab target. When omitted, the renderer falls back to
	// the active tab (legacy `send --live` behavior). Used by
	// `maestro-cli dispatch --session <tabId>` to address a specific tab.
	const requestedTabId = typeof message.tabId === 'string' ? message.tabId : undefined;
	// force=true bypasses the busy-state guard below, allowing callers to
	// dispatch concurrent writes to an already-running agent. Used by
	// `maestro-cli dispatch --force`.
	const force = message.force === true;
	// background=true suppresses the desktop's focus side effect (switching
	// to the target agent/tab). `maestro-cli dispatch` sets this by default;
	// passing `--focus` clears it to bring the target to the foreground.
	const background = message.background === true;
	// Optional base64 data URLs pasted from the web client. Threaded through
	// to the renderer so AI tabs can include them in the agent prompt.
	const images = Array.isArray(message.images)
		? (message.images as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;

	logger.info(
		`[Web Command] Received: sessionId=${sessionId}, inputMode=${clientInputMode}, command=${command?.substring(0, 50)}, images=${images?.length ?? 0}`,
		LOG_CONTEXT
	);

	// Image-only sends are valid in AI mode (the composer lets users paste
	// images and submit without typing), so the guard accepts either a
	// non-empty command OR at least one image. Normalize a missing command
	// to '' so the renderer's downstream LogEntry.text stays a string.
	const hasImages = !!images && images.length > 0;
	if (!sessionId || (!command && !hasImages)) {
		logger.warn(
			`[Web Command] Missing sessionId or command/images: sessionId=${sessionId}, commandLen=${command?.length}, images=${images?.length ?? 0}`,
			LOG_CONTEXT
		);
		ctx.sendError(client, 'Missing sessionId or command');
		return;
	}
	const effectiveCommand = command ?? '';

	// Get session details to check state and determine how to handle
	const sessionDetail = ctx.callbacks.getSessionDetail?.(sessionId);
	if (!sessionDetail) {
		ctx.sendError(client, 'Session not found');
		return;
	}

	// Check if session is busy - prevent race conditions between desktop and web.
	// `force: true` opts out of this guard (see `maestro-cli send --live --force`).
	if (sessionDetail.state === 'busy' && !force) {
		ctx.sendError(client, 'Session is busy - please wait for the current operation to complete', {
			sessionId,
		});
		logger.debug(`Command rejected - session ${sessionId} is busy`, LOG_CONTEXT);
		return;
	}
	if (sessionDetail.state === 'busy' && force) {
		logger.info(`[Web Command] Force-dispatching to busy session ${sessionId}`, LOG_CONTEXT);
	}

	// Use client's inputMode if provided, otherwise fall back to server state
	const effectiveMode = clientInputMode || sessionDetail.inputMode;
	const isAiMode = effectiveMode === 'ai';
	const mode = isAiMode ? 'AI' : 'CLI';
	const claudeId = sessionDetail.agentSessionId || 'none';

	// Log all web interface commands prominently
	logger.info(
		`[Web Command] Mode: ${mode} | Session: ${sessionId}${isAiMode ? ` | Claude: ${claudeId}` : ''} | Message: ${effectiveCommand} | Images: ${images?.length ?? 0}`,
		LOG_CONTEXT
	);

	// Only echo a tabId in command_result when the caller passed one
	// explicitly. Returning the server's snapshot of `activeTabId` for the
	// no-tabId path would lie when the user switches active tabs between
	// the IPC send and IPC receive - callers chaining `dispatch --session
	// <returnedTabId>` would think they are continuing a conversation that
	// actually went to a different tab. For deterministic addressing,
	// callers should use `dispatch --new-tab` (returns the new tabId from
	// the renderer ack) and then `dispatch --session <tabId>` (echoes back
	// the caller-supplied authoritative tabId).
	const resolvedTabId = requestedTabId;

	// Arm a `--notify-on-complete` callback BEFORE handing the prompt to the
	// renderer: the renderer can spawn the agent process before this handler's
	// promise resolves, and an entry registered after that spawn would sit
	// unarmed until it timed out. Cancelled below if the dispatch is rejected.
	let sendCallbackId: string | undefined;
	if (typeof message.notifyOnComplete === 'string' && message.notifyOnComplete) {
		if (!requestedTabId) {
			ctx.sendError(client, '--notify-on-complete requires an explicit target tab', {
				sessionId,
			});
			return;
		}
		const armed = armDispatchCallback(ctx, message, {
			agentId: sessionId,
			tabId: requestedTabId,
			prompt: effectiveCommand,
			isNewTab: false,
		});
		if (armed.error) {
			ctx.sendError(client, armed.error, { sessionId });
			return;
		}
		sendCallbackId = armed.callbackId;
	}
	const cancelArmedCallback = () => {
		if (sendCallbackId) getDispatchCallbackRegistry()?.cancel(sendCallbackId);
	};

	// Route ALL commands through the renderer for consistent handling
	// The renderer handles both AI and terminal modes, updating UI and state
	// Pass clientInputMode so renderer uses the web's intended mode
	if (ctx.callbacks.executeCommand) {
		ctx.callbacks
			.executeCommand(
				sessionId,
				effectiveCommand,
				clientInputMode,
				requestedTabId,
				force,
				images,
				background
			)
			.then((success) => {
				if (!success) cancelArmedCallback();
				ctx.send(client, {
					type: 'command_result',
					success,
					sessionId,
					...(resolvedTabId ? { tabId: resolvedTabId } : {}),
					...(success && sendCallbackId ? { callbackId: sendCallbackId } : {}),
					requestId: message.requestId,
				});
				if (!success) {
					logger.warn(
						`[Web Command] ${mode} command rejected for session ${sessionId}`,
						LOG_CONTEXT
					);
				}
			})
			.catch((error) => {
				cancelArmedCallback();
				ctx.reportHandlerError(
					client,
					error,
					'send_command',
					{ sessionId, mode, requestId: message.requestId },
					'Failed to execute command'
				);
			});
	} else {
		cancelArmedCallback();
		ctx.sendError(client, 'Command execution not configured');
	}
}

/**
 * Handle switch_mode message - switch between AI and terminal mode
 *
 * When switching to terminal mode, spawns a dedicated PTY process for the web client
 * (session ID: {sessionId}-terminal). When switching back to AI, kills it.
 */
export function handleSwitchMode(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const mode = message.mode as 'ai' | 'terminal';
	logger.info(
		`[Web] Received switch_mode message: session=${sessionId}, mode=${mode}`,
		LOG_CONTEXT
	);

	if (!sessionId || !mode) {
		ctx.sendError(client, 'Missing sessionId or mode');
		return;
	}

	if (!ctx.callbacks.switchMode) {
		logger.warn(`[Web] switchModeCallback is not set!`, LOG_CONTEXT);
		ctx.sendError(client, 'Mode switching not configured');
		return;
	}

	// Forward to desktop's mode switching logic
	// This ensures single source of truth - desktop handles state updates and broadcasts
	logger.info(`[Web] Calling switchModeCallback for session ${sessionId}: ${mode}`, LOG_CONTEXT);
	ctx.callbacks
		.switchMode(sessionId, mode)
		.then(async (success) => {
			// Spawn or kill the web terminal PTY based on mode
			if (success && mode === 'terminal') {
				// Look up session CWD for the terminal working directory
				const sessionDetail = ctx.callbacks.getSessionDetail?.(sessionId);
				const cwd = sessionDetail?.cwd || process.cwd();
				try {
					const spawnResult = await ctx.callbacks.spawnTerminalForWeb?.(sessionId, { cwd });
					logger.info(
						`[Web] Terminal PTY spawn for ${sessionId}: success=${spawnResult?.success}`,
						LOG_CONTEXT
					);
					if (spawnResult?.success) {
						// Notify the web client that the PTY is ready so it can re-send
						// its current dimensions (the initial resize fired before the PTY existed)
						ctx.send(client, {
							type: 'terminal_ready',
							sessionId,
						});
					} else {
						// PTY failed to spawn - report failure so the client can roll back
						ctx.send(client, {
							type: 'mode_switch_result',
							success: false,
							sessionId,
							mode,
							error: 'Failed to spawn terminal PTY',
							requestId: message.requestId,
						});
						return;
					}
				} catch (err) {
					logger.error(`[Web] Failed to spawn terminal PTY for ${sessionId}: ${err}`, LOG_CONTEXT);
					ctx.send(client, {
						type: 'mode_switch_result',
						success: false,
						sessionId,
						mode,
						error: `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`,
						requestId: message.requestId,
					});
					return;
				}
			}
			// When switching back to AI, keep the terminal PTY alive so the user
			// can return to a running process (e.g. npm run dev). The PTY is only
			// killed when the session itself is removed.

			ctx.send(client, {
				type: 'mode_switch_result',
				success,
				sessionId,
				mode,
				requestId: message.requestId,
			});
			logger.debug(
				`Mode switch for session ${sessionId} to ${mode}: ${success ? 'success' : 'failed'}`,
				LOG_CONTEXT
			);
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to switch mode: ${error.message}`);
		});
}

/**
 * Handle select_session message - select/switch to a session in desktop
 */
export function handleSelectSession(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const tabId = message.tabId as string | undefined;
	const focus = message.focus as boolean | undefined;
	logger.info(
		`[Web] Received select_session message: session=${sessionId}, tab=${tabId || 'none'}, focus=${focus || false}`,
		LOG_CONTEXT
	);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.selectSession) {
		logger.warn(`[Web] selectSessionCallback is not set!`, LOG_CONTEXT);
		ctx.sendError(client, 'Session selection not configured');
		return;
	}

	// Forward to desktop's session selection logic (include tabId if provided)
	logger.info(
		`[Web] Calling selectSessionCallback for session ${sessionId}${tabId ? `, tab ${tabId}` : ''}`,
		LOG_CONTEXT
	);
	ctx.callbacks
		.selectSession(sessionId, tabId, focus)
		.then((success) => {
			if (success) {
				// Subscribe client to this session's output so they receive session_output messages
				client.subscribedSessionId = sessionId;
				logger.debug(`Session ${sessionId} selected in desktop, client subscribed`, LOG_CONTEXT);
			} else {
				logger.warn(`Failed to select session ${sessionId} in desktop`, LOG_CONTEXT);
			}
			ctx.send(client, {
				type: 'select_session_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to select session: ${error.message}`);
		});
}
