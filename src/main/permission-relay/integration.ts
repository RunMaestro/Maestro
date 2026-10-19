/**
 * Main-process integration for the permission relay: connects the transport
 * (PermissionRelayServer + registry) to Electron - surfacing requests to the
 * renderer, cleaning up per-spawn bindings on process exit, and preparing the
 * CLI args injected at spawn time.
 *
 * Kept separate from PermissionRelayServer (which has no Electron dependency)
 * so the server stays unit-testable.
 */

import type { BrowserWindow } from 'electron';
import type { EventEmitter } from 'events';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { permissionRelayServer } from './PermissionRelayServer';
import { isPendingRequest, registerSpawn, resolvePending } from './registry';
import { createPermissionRequestRouter, type PermissionRequestRouter } from './request-router';
import { buildRelayArgs, resolveBridgeScriptPath } from './spawn-args';
import type { PermissionDecision, PermissionRequest } from './types';

const LOG_CONTEXT = '[PermissionRelay]';

/** IPC channel: main -> renderer, "please decide on this request". */
export const PERMISSION_REQUEST_CHANNEL = 'process:permission-request';

/** Per-spawn token cleanups, keyed by the (compound) spawn session id. */
const sessionCleanups = new Map<string, () => void>();

let initialized = false;

/** Which window prompts for each request; set by {@link initPermissionRelay}. */
let router: PermissionRequestRouter | null = null;

/** Optional routing for {@link initPermissionRelay}. */
export interface PermissionRelayRouting {
	/**
	 * The tab window holding the request's tab when that tab is popped out
	 * (Tab Windows), else null. Such a request is prompted there, not in the
	 * main window.
	 */
	resolveTabWindow?: (request: PermissionRequest) => BrowserWindow | null;
}

/**
 * Wire the relay into Electron. Idempotent. `getMainWindow` supplies the
 * window to forward requests to, unless `routing` names the tab window that
 * shows the request's tab; `processManager` is the EventEmitter whose `exit`
 * event (sessionId, code) triggers per-spawn cleanup.
 */
export function initPermissionRelay(
	getMainWindow: () => BrowserWindow | null,
	processManager: EventEmitter | null,
	routing: PermissionRelayRouting = {}
): void {
	if (initialized) {
		return;
	}
	initialized = true;

	router = createPermissionRequestRouter({
		getMainWindow,
		resolveTabWindow: routing.resolveTabWindow,
		isPending: isPendingRequest,
		send: (win, request) => win.webContents.send(PERMISSION_REQUEST_CHANNEL, request),
	});

	permissionRelayServer.setOnRequest((request) => {
		const delivery = router!.deliver(request);
		if (delivery.delivered) return;
		// No window to prompt, or a teardown race between the window check and
		// the send: deny so the agent gets a clear answer instead of hanging
		// until the timeout.
		logger.warn('Failed to deliver permission request to renderer; denying', LOG_CONTEXT, {
			requestId: request.requestId,
			reason: delivery.reason,
		});
		resolvePending(request.requestId, {
			behavior: 'deny',
			message: 'Maestro window unavailable to prompt for permission.',
		});
	});

	// Best-effort per-spawn cleanup on process exit. Not fatal if the emitter
	// isn't ready yet: the registry auto-denies pending requests on timeout and
	// each new spawn clears its session's prior binding.
	if (processManager && typeof processManager.on === 'function') {
		processManager.on('exit', (sessionId: string) => {
			cleanupSessionRelay(sessionId);
		});
	}
}

/** Resolve a pending request with the user's decision (called from IPC). */
export function resolvePermissionResponse(
	requestId: string,
	decision: PermissionDecision
): boolean {
	router?.settle(requestId);
	return resolvePending(requestId, decision);
}

/**
 * Re-deliver the requests waiting in a tab window that no longer shows their
 * tab (it docked, or the window closed) to the window that shows it now.
 * Call it on every `tab-window-changed`. One that no window can take is
 * denied, so the agent is not left waiting out the timeout.
 */
export function reroutePermissionRequests(): void {
	if (!router) return;
	const { moved, failed } = router.reroute();
	for (const requestId of failed) {
		resolvePending(requestId, {
			behavior: 'deny',
			message: 'Maestro window unavailable to prompt for permission.',
		});
	}
	if (moved.length > 0 || failed.length > 0) {
		logger.debug('Re-routed permission requests after a tab window change', LOG_CONTEXT, {
			moved: moved.length,
			denied: failed.length,
		});
	}
}

/** Clean up a spawn's relay binding (on process exit or re-spawn). */
export function cleanupSessionRelay(sessionId: string): void {
	const cleanup = sessionCleanups.get(sessionId);
	if (cleanup) {
		sessionCleanups.delete(sessionId);
		cleanup();
	}
}

/**
 * Prepare the relay CLI args for a claude-code standard-mode API spawn.
 * Ensures the socket is listening and registers a fresh per-spawn token
 * (cleaning up any prior token for the same session). Throws if the bridge
 * script can't be located - callers MUST fail loud rather than spawn without
 * the relay (which would abort on the first tool call).
 */
export async function preparePermissionRelayArgs(params: {
	sessionId: string;
	tabId?: string;
	userDataDir: string;
	execPath: string;
}): Promise<string[]> {
	const bridgeScriptPath = resolveBridgeScriptPath();
	if (!bridgeScriptPath) {
		throw new Error('permission relay bridge script not found');
	}

	const socketPath = await permissionRelayServer.ensureStarted(params.userDataDir);

	// Replace any stale binding for this session before registering a new one.
	cleanupSessionRelay(params.sessionId);
	const { token, cleanup } = registerSpawn({
		sessionId: params.sessionId,
		tabId: params.tabId,
	});

	const { args, configPath } = buildRelayArgs(
		params.execPath,
		bridgeScriptPath,
		socketPath,
		token,
		params.userDataDir
	);

	// Wrap the registry cleanup so process exit also deletes the temp MCP config.
	sessionCleanups.set(params.sessionId, () => {
		cleanup();
		try {
			fs.unlinkSync(configPath);
		} catch {
			// Already gone - fine.
		}
	});

	logger.debug('Prepared permission relay for spawn', LOG_CONTEXT, {
		sessionId: params.sessionId,
		socketPath,
	});

	return args;
}
