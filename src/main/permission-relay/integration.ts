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
import { logger } from '../utils/logger';
import { permissionRelayServer } from './PermissionRelayServer';
import { registerSpawn, resolvePending } from './registry';
import { buildRelayArgs, resolveBridgeScriptPath } from './spawn-args';
import type { PermissionDecision } from './types';

const LOG_CONTEXT = '[PermissionRelay]';

/** IPC channel: main -> renderer, "please decide on this request". */
export const PERMISSION_REQUEST_CHANNEL = 'process:permission-request';

/** Per-spawn token cleanups, keyed by the (compound) spawn session id. */
const sessionCleanups = new Map<string, () => void>();

let initialized = false;

/**
 * Wire the relay into Electron. Idempotent. `getMainWindow` supplies the
 * window to forward requests to; `processManager` is the EventEmitter whose
 * `exit` event (sessionId, code) triggers per-spawn cleanup.
 */
export function initPermissionRelay(
	getMainWindow: () => BrowserWindow | null,
	processManager: EventEmitter | null
): void {
	if (initialized) {
		return;
	}
	initialized = true;

	permissionRelayServer.setOnRequest((request) => {
		const win = getMainWindow();
		if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
			// No window to prompt: deny so the agent gets a clear answer instead
			// of hanging until the timeout.
			resolvePending(request.requestId, {
				behavior: 'deny',
				message: 'Maestro window unavailable to prompt for permission.',
			});
			return;
		}
		win.webContents.send(PERMISSION_REQUEST_CHANNEL, request);
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
	return resolvePending(requestId, decision);
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
	sessionCleanups.set(params.sessionId, cleanup);

	logger.debug('Prepared permission relay for spawn', LOG_CONTEXT, {
		sessionId: params.sessionId,
		socketPath,
	});

	return buildRelayArgs(params.execPath, bridgeScriptPath, socketPath, token).args;
}
