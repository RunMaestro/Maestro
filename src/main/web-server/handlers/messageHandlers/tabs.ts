/**
 * Tabs domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: select_tab, new_tab,
 * close_tab, rename_tab, star_tab, reorder_tab, toggle_bookmark,
 * open_file_tab, open_browser_tab, open_terminal_tab, new_ai_tab_with_prompt.
 */

import path from 'path';
import fs from 'fs/promises';
import { logger } from '../../../utils/logger';
import { validateCallbackRequest, armDispatchCallback } from './dispatchCallbacks';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle select_tab message - select a tab within a session
 */
export function handleSelectTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const tabId = message.tabId as string;
	logger.info(`[Web] Received select_tab message: session=${sessionId}, tab=${tabId}`, LOG_CONTEXT);

	if (!sessionId || !tabId) {
		ctx.sendError(client, 'Missing sessionId or tabId');
		return;
	}

	if (!ctx.callbacks.selectTab) {
		ctx.sendError(client, 'Tab selection not configured');
		return;
	}

	ctx.callbacks
		.selectTab(sessionId, tabId)
		.then((success) => {
			ctx.send(client, {
				type: 'select_tab_result',
				success,
				sessionId,
				tabId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to select tab: ${error.message}`);
		});
}

/**
 * Handle new_tab message - create a new tab within a session
 */
export function handleNewTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received new_tab message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.newTab) {
		ctx.sendError(client, 'Tab creation not configured');
		return;
	}

	ctx.callbacks
		.newTab(sessionId)
		.then((result) => {
			ctx.send(client, {
				type: 'new_tab_result',
				success: !!result,
				sessionId,
				tabId: result?.tabId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to create tab: ${error.message}`);
		});
}

/**
 * Handle close_tab message - close a tab within a session
 */
export function handleCloseTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const tabId = message.tabId as string;
	logger.info(`[Web] Received close_tab message: session=${sessionId}, tab=${tabId}`, LOG_CONTEXT);

	if (!sessionId || !tabId) {
		ctx.sendError(client, 'Missing sessionId or tabId');
		return;
	}

	if (!ctx.callbacks.closeTab) {
		ctx.sendError(client, 'Tab closing not configured');
		return;
	}

	ctx.callbacks
		.closeTab(sessionId, tabId)
		.then((success) => {
			ctx.send(client, {
				type: 'close_tab_result',
				success,
				sessionId,
				tabId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to close tab: ${error.message}`);
		});
}

/**
 * Handle rename_tab message - rename a tab within a session
 */
export function handleRenameTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const tabId = message.tabId as string;
	const newName = message.newName as string;
	logger.info(
		`[Web] Received rename_tab message: session=${sessionId}, tab=${tabId}, newName=${newName}`,
		LOG_CONTEXT
	);

	if (!sessionId || !tabId) {
		ctx.sendError(client, 'Missing sessionId or tabId');
		return;
	}

	if (!ctx.callbacks.renameTab) {
		ctx.sendError(client, 'Tab renaming not configured');
		return;
	}

	// newName can be empty string to clear the name
	ctx.callbacks
		.renameTab(sessionId, tabId, newName || '')
		.then((success) => {
			ctx.send(client, {
				type: 'rename_tab_result',
				success,
				sessionId,
				tabId,
				newName: newName || '',
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to rename tab: ${error.message}`);
		});
}

/**
 * Handle star_tab message - star/unstar a tab within a session
 */
export function handleStarTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const tabId = message.tabId as string;
	const starred = message.starred as boolean;
	logger.info(
		`[Web] Received star_tab message: session=${sessionId}, tab=${tabId}, starred=${starred}`,
		LOG_CONTEXT
	);

	if (!sessionId || !tabId) {
		ctx.sendError(client, 'Missing sessionId or tabId');
		return;
	}

	if (!ctx.callbacks.starTab) {
		ctx.sendError(client, 'Tab starring not configured');
		return;
	}

	ctx.callbacks
		.starTab(sessionId, tabId, !!starred)
		.then((success) => {
			ctx.send(client, {
				type: 'star_tab_result',
				success,
				sessionId,
				tabId,
				starred,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to star tab: ${error.message}`);
		});
}

/**
 * Handle reorder_tab message - move a tab to a new position within a session
 */
export function handleReorderTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const fromIndex = message.fromIndex as number;
	const toIndex = message.toIndex as number;
	logger.info(
		`[Web] Received reorder_tab message: session=${sessionId}, from=${fromIndex}, to=${toIndex}`,
		LOG_CONTEXT
	);

	if (!sessionId || fromIndex == null || toIndex == null) {
		ctx.sendError(client, 'Missing sessionId, fromIndex, or toIndex');
		return;
	}

	if (!ctx.callbacks.reorderTab) {
		ctx.sendError(client, 'Tab reordering not configured');
		return;
	}

	ctx.callbacks
		.reorderTab(sessionId, fromIndex, toIndex)
		.then((success) => {
			ctx.send(client, {
				type: 'reorder_tab_result',
				success,
				sessionId,
				fromIndex,
				toIndex,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to reorder tab: ${error.message}`);
		});
}

/**
 * Handle toggle_bookmark message - toggle bookmark state on a session
 */
export function handleToggleBookmark(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	logger.info(`[Web] Received toggle_bookmark message: session=${sessionId}`, LOG_CONTEXT);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.toggleBookmark) {
		ctx.sendError(client, 'Bookmark toggling not configured');
		return;
	}

	ctx.callbacks
		.toggleBookmark(sessionId)
		.then((success) => {
			ctx.send(client, {
				type: 'toggle_bookmark_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to toggle bookmark: ${error.message}`);
		});
}

/**
 * Handle open_file_tab message - open a file in a preview tab
 */
export function handleOpenFileTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const filePath = message.filePath as string;
	// `switchToAgent` defaults to true so older clients keep the existing UX.
	const switchToAgent = message.switchToAgent !== false;
	logger.info(
		`[Web] Received open_file_tab message: session=${sessionId}, filePath=${filePath}, switchToAgent=${switchToAgent}`,
		LOG_CONTEXT
	);

	// Helper to send typed error responses with requestId (prevents client timeouts)
	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'open_file_tab_result',
			success: false,
			error,
			sessionId,
			requestId: message.requestId,
		});
	};

	if (!sessionId || !filePath) {
		sendErrorResult('Missing sessionId or filePath');
		return;
	}

	const sessions = ctx.callbacks.getSessions?.();
	const session = sessions?.find((s) => s.id === sessionId);
	if (!session?.cwd) {
		sendErrorResult('Session not found or has no working directory');
		return;
	}
	// Relative paths resolve against the agent's working directory; absolute
	// paths are honored as-is. Opening files outside the worktree is
	// intentionally allowed - a paired client already has shell-level access
	// (execute_command), so confining preview tabs to the worktree gated
	// nothing the connection token doesn't already gate.
	const sessionRoot = path.resolve(session.cwd);
	const resolved = path.resolve(sessionRoot, filePath);

	if (!ctx.callbacks.openFileTab) {
		sendErrorResult('File tab opening not configured');
		return;
	}

	ctx.callbacks
		.openFileTab(sessionId, resolved, switchToAgent)
		.then((success) => {
			ctx.send(client, {
				type: 'open_file_tab_result',
				success,
				sessionId,
				filePath,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			sendErrorResult(`Failed to open file tab: ${error.message}`);
		});
}

/**
 * Handle open_browser_tab message - open a URL in a browser tab
 */
export function handleOpenBrowserTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const url = typeof message.url === 'string' ? message.url : '';
	// URLs can embed bearer tokens or session IDs - log length only.
	logger.info(
		`[Web] Received open_browser_tab message: session=${sessionId}, urlLength=${url.length}`,
		LOG_CONTEXT
	);

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'open_browser_tab_result',
			success: false,
			error,
			sessionId,
			requestId: message.requestId,
		});
	};

	if (!sessionId || !url) {
		sendErrorResult('Missing sessionId or url');
		return;
	}

	const session = ctx.callbacks.getSessions?.().find((s) => s.id === sessionId);
	if (!session) {
		sendErrorResult('Session not found');
		return;
	}

	// Only http(s) URLs are allowed in browser tabs; everything else is rejected
	// (mailto:, file:, javascript:, etc. would be unsafe or nonsensical here).
	// Normalize bare host:port inputs (e.g. `localhost:3000`) to http:// so
	// WHATWG URL parsing doesn't mistake the host for a protocol.
	const trimmedUrl = url.trim();
	const hasExplicitScheme = trimmedUrl.includes('://');
	const candidate = hasExplicitScheme ? trimmedUrl : `http://${trimmedUrl}`;
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		sendErrorResult('Invalid URL');
		return;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		sendErrorResult(`Unsupported URL protocol: ${parsed.protocol}`);
		return;
	}
	// A bare input that parses with userinfo is almost certainly malformed
	// (e.g. `foo:bar@baz` accidentally looking like `user:pass@host`).
	if (!hasExplicitScheme && (parsed.username || parsed.password)) {
		sendErrorResult('Invalid URL');
		return;
	}

	if (!ctx.callbacks.openBrowserTab) {
		sendErrorResult('Browser tab opening not configured');
		return;
	}

	// Background tabs are created without moving the user: the active agent
	// is left alone and the new tab does not become the visible one.
	const background = message.background === true;

	ctx.callbacks
		.openBrowserTab(sessionId, parsed.toString(), { background })
		.then((result) => {
			ctx.send(client, {
				type: 'open_browser_tab_result',
				success: result.success,
				tabId: result.tabId,
				background,
				sessionId,
				url: parsed.toString(),
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			sendErrorResult(`Failed to open browser tab: ${error.message}`);
		});
}

/**
 * Handle close_browser_tab message - close a browser tab by id. The owning
 * agent is resolved in the renderer, so callers only need the tab id handed
 * back by open_browser_tab.
 */
export function handleCloseBrowserTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const tabId = typeof message.tabId === 'string' ? message.tabId : '';
	logger.info(`[Web] Received close_browser_tab message: tab=${tabId}`, LOG_CONTEXT);

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'close_browser_tab_result',
			success: false,
			error,
			tabId,
			requestId: message.requestId,
		});
	};

	if (!tabId) {
		sendErrorResult('Missing tabId');
		return;
	}

	if (!ctx.callbacks.closeBrowserTab) {
		sendErrorResult('Browser tab closing not configured');
		return;
	}

	ctx.callbacks
		.closeBrowserTab(tabId)
		.then((success) => {
			ctx.send(client, {
				type: 'close_browser_tab_result',
				success,
				error: success ? undefined : `Browser tab not found: ${tabId}`,
				tabId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			sendErrorResult(`Failed to close browser tab: ${error.message}`);
		});
}

/**
 * Handle open_terminal_tab message - open a new terminal tab
 */
export async function handleOpenTerminalTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const rawCwd = message.cwd;
	const rawShell = message.shell;
	const rawName = message.name;
	// cwd/shell/name can leak local usernames or project names - log
	// presence flags only.
	logger.info(
		`[Web] Received open_terminal_tab message: session=${sessionId}, cwdProvided=${
			typeof rawCwd === 'string' && rawCwd.length > 0
		}, shellProvided=${
			typeof rawShell === 'string' && rawShell.length > 0
		}, nameProvided=${rawName !== undefined}`,
		LOG_CONTEXT
	);

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'open_terminal_tab_result',
			success: false,
			error,
			sessionId,
			requestId: message.requestId,
		});
	};

	if (!sessionId) {
		sendErrorResult('Missing sessionId');
		return;
	}

	// Reject malformed optional fields rather than silently defaulting them,
	// which could spawn a terminal in the wrong cwd or with the wrong shell.
	if (rawCwd !== undefined && typeof rawCwd !== 'string') {
		sendErrorResult('Invalid cwd: must be a string');
		return;
	}
	if (rawShell !== undefined && typeof rawShell !== 'string') {
		sendErrorResult('Invalid shell: must be a string');
		return;
	}
	if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
		sendErrorResult('Invalid name: must be a string or null');
		return;
	}
	const cwd = typeof rawCwd === 'string' ? rawCwd : undefined;
	const shell = typeof rawShell === 'string' ? rawShell : undefined;
	const name = typeof rawName === 'string' ? rawName : rawName === null ? null : undefined;

	const session = ctx.callbacks.getSessions?.().find((s) => s.id === sessionId);
	if (!session) {
		sendErrorResult('Session not found');
		return;
	}

	// If a cwd is provided, confine it to the agent working directory
	// (same rule as open_file_tab - prevents spawning a shell outside scope).
	// Resolve symlinks via fs.realpath so a `link-to-outside` inside the
	// session root can't slip past the lexical prefix check.
	let resolvedCwd: string | undefined;
	if (cwd) {
		if (!session.cwd) {
			sendErrorResult('Session has no working directory');
			return;
		}
		let sessionRoot: string;
		let resolved: string;
		try {
			sessionRoot = await fs.realpath(path.resolve(session.cwd));
			resolved = await fs.realpath(path.resolve(sessionRoot, cwd));
		} catch {
			sendErrorResult('Invalid cwd');
			return;
		}
		if (!resolved.startsWith(sessionRoot + path.sep) && resolved !== sessionRoot) {
			sendErrorResult('Invalid cwd: path is outside the agent working directory');
			return;
		}
		resolvedCwd = resolved;
	}

	if (!ctx.callbacks.openTerminalTab) {
		sendErrorResult('Terminal tab opening not configured');
		return;
	}

	ctx.callbacks
		.openTerminalTab(sessionId, { cwd: resolvedCwd, shell, name })
		.then((success) => {
			ctx.send(client, {
				type: 'open_terminal_tab_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			sendErrorResult(`Failed to open terminal tab: ${error.message}`);
		});
}

/**
 * Handle new_ai_tab_with_prompt message - atomically create a new AI tab
 * and dispatch an initial prompt into it. Used by `send --live --new-tab`
 * to guarantee a fresh conversation rather than writing into whichever tab
 * happens to be active.
 */
export function handleNewAITabWithPrompt(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const prompt = typeof message.prompt === 'string' ? message.prompt : '';
	// background=true creates the tab without switching to/focusing it.
	// `maestro-cli dispatch --new-tab` sets this by default; `--focus` clears it.
	const background = message.background === true;
	// Prompts can contain user-authored content with secrets or PII -
	// log length only rather than a raw preview.
	logger.info(
		`[Web] Received new_ai_tab_with_prompt message: session=${sessionId}, promptLength=${prompt.length}`,
		LOG_CONTEXT
	);

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'new_ai_tab_with_prompt_result',
			success: false,
			error,
			sessionId,
			requestId: message.requestId,
		});
	};

	if (!sessionId || !prompt) {
		sendErrorResult('Missing sessionId or prompt');
		return;
	}

	const session = ctx.callbacks.getSessions?.().find((s) => s.id === sessionId);
	if (!session) {
		sendErrorResult('Session not found');
		return;
	}

	if (!ctx.callbacks.newAITabWithPrompt) {
		sendErrorResult('New AI tab with prompt not configured');
		return;
	}

	// Reject impossible callback requests BEFORE the tab exists. Arming needs
	// the fresh tab id, but every tab-independent rejection (no registry,
	// unknown caller, self-target) would otherwise surface only after the tab
	// was created and its prompt was already running - leaving the caller a
	// `success: false` plus a live turn in an orphaned tab.
	const callbackPrecheck = validateCallbackRequest(ctx, message, { agentId: sessionId });
	if (callbackPrecheck.error) {
		sendErrorResult(callbackPrecheck.error);
		return;
	}

	ctx.callbacks
		.newAITabWithPrompt(sessionId, prompt, background)
		.then((result) => {
			// Arm the callback only once the fresh tab id is known - that id is
			// the correlation key. `isNewTab` lets the registry adopt a spawn the
			// renderer may already have emitted while this ack was in flight.
			let callbackId: string | undefined;
			if (result.success && result.tabId) {
				const armed = armDispatchCallback(ctx, message, {
					agentId: sessionId,
					tabId: result.tabId,
					prompt,
					isNewTab: true,
				});
				if (armed.error) {
					sendErrorResult(armed.error);
					return;
				}
				callbackId = armed.callbackId;
			}
			ctx.send(client, {
				type: 'new_ai_tab_with_prompt_result',
				success: result.success,
				sessionId,
				...(result.tabId ? { tabId: result.tabId } : {}),
				...(callbackId ? { callbackId } : {}),
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			sendErrorResult(`Failed to create AI tab with prompt: ${error.message}`);
		});
}
