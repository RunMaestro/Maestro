/**
 * Main-process integration for the permission relay: connects the transport
 * (PermissionRelayServer + registry) to Electron - surfacing requests to the
 * renderer, cleaning up per-spawn bindings on process exit, and preparing the
 * CLI args injected at spawn time.
 *
 * Kept separate from PermissionRelayServer (which has no Electron dependency)
 * so the server stays unit-testable.
 */

import { BrowserWindow } from 'electron';
import type { EventEmitter } from 'events';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { permissionRelayServer } from './PermissionRelayServer';
import { registerSpawn, resolvePending, subscribePendingPermissions } from './registry';
import { createSafeSend } from '../utils/safe-send';
import { buildRelayArgs, resolveBridgeScriptPath } from './spawn-args';
import type { PermissionDecision } from './types';
import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';

const LOG_CONTEXT = '[PermissionRelay]';

/** IPC channel: main -> renderer, "please decide on this request". */
export const PERMISSION_REQUEST_CHANNEL = 'process:permission-request';

/** Per-spawn token cleanups, keyed by the (compound) spawn session id. */
const sessionCleanups = new Map<string, { cleanup: () => void; running: boolean }>();

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
	const release = beginGlobalWorktreeActivity();
	try {
		if (initialized) {
			return;
		}
		initialized = true;

		const send = createSafeSend(() => BrowserWindow.getAllWindows());
		subscribePendingPermissions((snapshot) => {
			const releaseSnapshot = beginGlobalWorktreeActivity();
			try {
				// Status only: prompt bodies and per-spawn authentication tokens stay private.
				send('process:pending-permissions', snapshot);
			} finally {
				releaseSnapshot();
			}
		});

		permissionRelayServer.setOnRequest((request) => {
			const releaseRequest = beginGlobalWorktreeActivity();
			try {
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
				try {
					win.webContents.send(PERMISSION_REQUEST_CHANNEL, request);
				} catch (e) {
					// The destroyed-window guard above covers the realistic case; this
					// catches a rare teardown race between the check and the send. Deny so
					// the awaiting bridge call unblocks instead of waiting on the timeout.
					logger.warn('Failed to deliver permission request to renderer; denying', LOG_CONTEXT, {
						requestId: request.requestId,
						error: e instanceof Error ? e.message : String(e),
					});
					resolvePending(request.requestId, {
						behavior: 'deny',
						message: 'Failed to deliver permission request to the Maestro window.',
					});
				}
			} finally {
				releaseRequest();
			}
		});

		// Best-effort per-spawn cleanup on process exit. Not fatal if the emitter
		// isn't ready yet: the registry auto-denies pending requests on timeout and
		// each new spawn clears its session's prior binding.
		if (processManager && typeof processManager.on === 'function') {
			processManager.on('exit', (sessionId: string) => {
				cleanupSessionRelay(sessionId);
			});
		}
	} finally {
		release();
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
	const release = beginGlobalWorktreeActivity();
	try {
		const entry = sessionCleanups.get(sessionId);
		if (entry && !entry.running) {
			entry.running = true;
			try {
				entry.cleanup();
				// Keep retry ownership on failure; nested cleanup cannot retire it.
				if (sessionCleanups.get(sessionId) === entry) sessionCleanups.delete(sessionId);
			} finally {
				entry.running = false;
			}
		}
	} finally {
		release();
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
	const release = beginGlobalWorktreeActivity();
	try {
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
		// Argument construction may throw after registration. Keep the known
		// binding reachable by spawn-failure, exit and replacement cleanup.
		const entry = { cleanup, running: true };
		sessionCleanups.set(params.sessionId, entry);
		try {
			// Install recovery before construction: the exclusive file may exist even
			// when writing its content fails and buildRelayArgs never returns.
			let configPath: string | undefined;
			let releaseRecovery: (() => void) | undefined;
			entry.cleanup = () => {
				cleanup();
				if (configPath === undefined) return;
				try {
					fs.unlinkSync(configPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
						// Token cleanup may already have released its hold. Keep this
						// session's recovery busy and reachable until unlink succeeds.
						releaseRecovery ??= beginGlobalWorktreeActivity();
						throw error;
					}
				}
				releaseRecovery?.();
				releaseRecovery = undefined;
			};
			const config = buildRelayArgs(
				params.execPath,
				bridgeScriptPath,
				socketPath,
				token,
				params.userDataDir,
				(createdPath) => {
					configPath = createdPath;
				}
			);
			configPath = config.configPath;

			logger.debug('Prepared permission relay for spawn', LOG_CONTEXT, {
				sessionId: params.sessionId,
				socketPath,
			});

			return config.args;
		} finally {
			// Reentrant cleanup during construction cannot retire a partial owner.
			// Once setup unwinds, failure/exit/replacement callers can retry it.
			entry.running = false;
		}
	} finally {
		release();
	}
}
