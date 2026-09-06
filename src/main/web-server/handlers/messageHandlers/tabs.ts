/**
 * Tabs domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: select_tab, new_tab,
 * close_tab, rename_tab, star_tab, reorder_tab, toggle_bookmark,
 * open_file_tab, open_browser_tab, open_terminal_tab, new_ai_tab_with_prompt,
 * open_document_graph.
 */

import path from 'path';
import { readBackgroundField, readSwitchToAgentField } from '../../../../shared/focusPlacement';
import fs from 'fs/promises';
import { logger } from '../../../utils/logger';
import { validateCallbackRequest, armDispatchCallback } from './dispatchCallbacks';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import {
	UI_SURFACES,
	resolveUiSurface,
	resolveUiSurfaceTab,
	surfaceTabIds,
} from '../../../../shared/uiSurfaces';

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
	const background = readBackgroundField(message);
	logger.info(
		`[Web] Received new_tab message: session=${sessionId}, background=${background}`,
		LOG_CONTEXT
	);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.newTab) {
		ctx.sendError(client, 'Tab creation not configured');
		return;
	}

	ctx.callbacks
		.newTab(sessionId, background)
		.then((result) => {
			ctx.send(client, {
				type: 'new_tab_result',
				success: !!result,
				sessionId,
				tabId: result?.tabId,
				background,
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
	// Two DIFFERENT asks, and folding one into the other would silently change
	// behaviour for callers already passing `--no-switch`:
	//   switchToAgent:false -> stay on the current agent, but still activate
	//                          the new tab inside the target agent.
	//   background:true     -> change nothing that is currently rendered,
	//                          anywhere. Strictly stronger, so it wins.
	const background = readBackgroundField(message);
	const switchToAgent = readSwitchToAgentField(message);
	logger.info(
		`[Web] Received open_file_tab message: session=${sessionId}, filePath=${filePath}, background=${background}, switchToAgent=${switchToAgent}`,
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
		.openFileTab(sessionId, resolved, { background, switchToAgent })
		.then((success) => {
			ctx.send(client, {
				type: 'open_file_tab_result',
				success,
				sessionId,
				filePath,
				background,
				switchToAgent,
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
	const rawCommand = message.command;
	const background = readBackgroundField(message);
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
	if (rawCommand !== undefined && typeof rawCommand !== 'string') {
		sendErrorResult('Invalid command: must be a string');
		return;
	}
	const cwd = typeof rawCwd === 'string' ? rawCwd : undefined;
	const shell = typeof rawShell === 'string' ? rawShell : undefined;
	const name = typeof rawName === 'string' ? rawName : rawName === null ? null : undefined;
	// An all-whitespace command would spawn a terminal that runs a bare
	// newline - treat it as "no command" rather than storing it.
	const command =
		typeof rawCommand === 'string' && rawCommand.trim() !== '' ? rawCommand.trim() : undefined;

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
		.openTerminalTab(sessionId, { cwd: resolvedCwd, shell, name, command }, { background })
		.then((result) => {
			ctx.send(client, {
				type: 'open_terminal_tab_result',
				success: result.success,
				tabId: result.tabId,
				sessionId,
				background,
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

/**
 * Handle write_terminal_tab message - write raw data into an already-open
 * desktop terminal tab. Unlike the web client's own PTY `write`, this targets
 * one of the desktop's per-tab terminals. The tab is resolved in the renderer,
 * since terminal tabs live only in renderer state.
 */
export async function handleWriteTerminalTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const rawTabRef = message.tabRef;
	const rawData = message.data;
	// Command text can carry secrets (tokens in flags, env assignments) -
	// log length only, never the payload.
	logger.info(
		`[Web] Received write_terminal_tab message: session=${sessionId}, tabRefProvided=${
			typeof rawTabRef === 'string' && rawTabRef.length > 0
		}, dataLength=${typeof rawData === 'string' ? rawData.length : 0}`,
		LOG_CONTEXT
	);

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'write_terminal_tab_result',
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
	if (typeof rawData !== 'string' || rawData === '') {
		sendErrorResult('Invalid data: must be a non-empty string');
		return;
	}
	if (rawTabRef !== undefined && typeof rawTabRef !== 'string') {
		sendErrorResult('Invalid tabRef: must be a string');
		return;
	}

	const session = ctx.callbacks.getSessions?.().find((s) => s.id === sessionId);
	if (!session) {
		sendErrorResult('Session not found');
		return;
	}

	if (!ctx.callbacks.writeTerminalTab) {
		sendErrorResult('Terminal writes not configured');
		return;
	}

	try {
		const result = await ctx.callbacks.writeTerminalTab(sessionId, {
			tabRef: typeof rawTabRef === 'string' ? rawTabRef : undefined,
			data: rawData,
		});
		ctx.send(client, {
			type: 'write_terminal_tab_result',
			success: result.success,
			error: result.error,
			tabId: result.tabId,
			tabName: result.tabName,
			sessionId,
			requestId: message.requestId,
		});
	} catch (error) {
		sendErrorResult(
			`Failed to write to terminal tab: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Handle read_terminal_tab message - read a terminal tab's scrollback. The
 * counterpart to write_terminal_tab: that one types into a shell, this reads
 * back what it printed, so an agent can observe a command it started.
 *
 * Like the write path, the tab is resolved in the renderer, since terminal
 * tabs (and their xterm buffers) live only in renderer state.
 */
export async function handleReadTerminalTab(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const rawTabRef = message.tabRef;
	const rawTail = message.tail;

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'read_terminal_tab_result',
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
	if (rawTabRef !== undefined && typeof rawTabRef !== 'string') {
		sendErrorResult('Invalid tabRef: must be a string');
		return;
	}
	if (
		rawTail !== undefined &&
		(typeof rawTail !== 'number' || !Number.isFinite(rawTail) || rawTail < 1)
	) {
		sendErrorResult('Invalid tail: must be a positive number');
		return;
	}

	const session = ctx.callbacks.getSessions?.().find((s) => s.id === sessionId);
	if (!session) {
		sendErrorResult('Session not found');
		return;
	}

	if (!ctx.callbacks.readTerminalTab) {
		sendErrorResult('Terminal reads not configured');
		return;
	}

	try {
		const result = await ctx.callbacks.readTerminalTab(sessionId, {
			tabRef: typeof rawTabRef === 'string' ? rawTabRef : undefined,
			tail: typeof rawTail === 'number' ? Math.floor(rawTail) : undefined,
		});
		ctx.send(client, {
			type: 'read_terminal_tab_result',
			success: result.success,
			error: result.error,
			tabId: result.tabId,
			tabName: result.tabName,
			cwd: result.cwd,
			state: result.state,
			content: result.content,
			totalLines: result.totalLines,
			sessionId,
			requestId: message.requestId,
		});
	} catch (error) {
		sendErrorResult(
			`Failed to read terminal tab: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Handle list_terminal_tabs message - enumerate open desktop terminal tabs,
 * optionally scoped to one agent.
 */
export async function handleListTerminalTabs(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const rawSessionId = message.sessionId;
	if (rawSessionId !== undefined && typeof rawSessionId !== 'string') {
		ctx.send(client, {
			type: 'list_terminal_tabs_result',
			success: false,
			error: 'Invalid sessionId: must be a string',
			requestId: message.requestId,
		});
		return;
	}
	const sessionId = typeof rawSessionId === 'string' && rawSessionId ? rawSessionId : undefined;

	if (!ctx.callbacks.listTerminalTabs) {
		ctx.send(client, {
			type: 'list_terminal_tabs_result',
			success: false,
			error: 'Terminal tab listing not configured',
			requestId: message.requestId,
		});
		return;
	}

	try {
		const tabs = await ctx.callbacks.listTerminalTabs(sessionId);
		ctx.send(client, {
			type: 'list_terminal_tabs_result',
			success: true,
			tabs,
			requestId: message.requestId,
		});
	} catch (error) {
		ctx.send(client, {
			type: 'list_terminal_tabs_result',
			success: false,
			error: `Failed to list terminal tabs: ${
				error instanceof Error ? error.message : String(error)
			}`,
			requestId: message.requestId,
		});
	}
}

/**
 * Handle open_document_graph - render the Document Graph over a named set of
 * documents rather than the usual one-focus-file graph.
 *
 * Paths are resolved against the agent's cwd only so a relative path from a
 * script still works. They are deliberately NOT confined to the worktree,
 * matching `open_file_tab`: a paired client already has shell-level access, so
 * confining a read-only visualization gates nothing the connection token does
 * not already gate.
 */
export function handleOpenDocumentGraph(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const rawFiles = Array.isArray(message.files) ? (message.files as string[]) : [];
	const rawDirectory = typeof message.directory === 'string' ? message.directory : undefined;
	const rawFocus = typeof message.focusPath === 'string' ? message.focusPath : undefined;

	const sendErrorResult = (error: string) => {
		ctx.send(client, {
			type: 'open_document_graph_result',
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
	if (rawFiles.length === 0 && rawDirectory === undefined) {
		sendErrorResult('Give either files or a directory to graph');
		return;
	}

	const sessions = ctx.callbacks.getSessions?.();
	const session = sessions?.find((s) => s.id === sessionId);
	if (!session?.cwd) {
		sendErrorResult('Session not found or has no working directory');
		return;
	}

	const sessionRoot = path.resolve(session.cwd);
	const files = rawFiles
		.filter((f) => typeof f === 'string' && f.length > 0)
		.map((f) => path.resolve(sessionRoot, f));
	const directory =
		rawDirectory !== undefined ? path.resolve(sessionRoot, rawDirectory) : undefined;
	const focusPath = rawFocus ? path.resolve(sessionRoot, rawFocus) : undefined;

	logger.info(
		`[Web] Received open_document_graph: session=${sessionId}, files=${files.length}, directory=${directory ?? 'none'}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.openDocumentGraph) {
		sendErrorResult('Document graph opening not configured');
		return;
	}

	ctx.callbacks
		.openDocumentGraph({ sessionId, files, directory, focusPath })
		.then((success) => {
			ctx.send(client, {
				type: 'open_document_graph_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			sendErrorResult(`Failed to open document graph: ${error.message}`);
		});
}

/**
 * Handle open_modal message - open one of the app's modals / dashboards by
 * `UiSurface.id`, optionally on a specific tab. Both the surface and the tab
 * are validated here so the renderer only ever receives ids it can act on.
 */
export function handleOpenModal(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const surfaceName = typeof message.surface === 'string' ? message.surface : '';
	const tabName =
		typeof message.tab === 'string' && message.tab.length > 0 ? message.tab : undefined;

	const sendResult = (success: boolean, error?: string) => {
		ctx.send(client, {
			type: 'open_modal_result',
			success,
			error,
			requestId: message.requestId,
		});
	};

	const surface = resolveUiSurface(surfaceName);
	if (!surface) {
		sendResult(
			false,
			`Unknown surface "${surfaceName}". Valid surfaces: ${UI_SURFACES.map((s) => s.id).join(', ')}`
		);
		return;
	}

	let tabId: string | undefined;
	if (tabName !== undefined) {
		const tab = resolveUiSurfaceTab(surface, tabName);
		if (!tab) {
			const valid = surfaceTabIds(surface);
			sendResult(
				false,
				valid.length > 0
					? `Unknown tab "${tabName}" for ${surface.label}. Valid tabs: ${valid.join(', ')}`
					: `${surface.label} has no tabs.`
			);
			return;
		}
		tabId = tab.id;
	}

	logger.info(
		`[Web] Received open_modal message: surface=${surface.id}, tab=${tabId ?? '-'}`,
		LOG_CONTEXT
	);

	if (!ctx.callbacks.openModal) {
		sendResult(false, 'Opening modals is not configured');
		return;
	}

	ctx.callbacks
		.openModal({ surface: surface.id, tab: tabId })
		.then((success) => sendResult(success, success ? undefined : 'Maestro window is not available'))
		.catch((error) => sendResult(false, `Failed to open ${surface.label}: ${error.message}`));
}
