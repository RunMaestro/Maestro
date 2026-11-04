/**
 * In-memory registry for the permission relay.
 *
 * Tracks two things:
 *  1. Spawn bindings: token -> which session/tab a Claude spawn belongs to.
 *     A token is a per-spawn nonce. The bridge presents it on every message;
 *     an unknown token is rejected (the token is the socket's auth).
 *  2. Pending requests: requestId -> the promise resolver awaiting the user's
 *     decision, with an auto-deny timeout.
 *
 * Purely in-memory; nothing is persisted. Cleared per-spawn on process exit
 * via the cleanup returned by `registerSpawn`.
 */

import { randomBytes } from 'crypto';
import { beginGlobalWorktreeActivity } from '../git/worktreeActivity';
import type { PermissionDecision, RelaySpawnBinding } from './types';
import { RELAY_DECISION_TIMEOUT_MS } from './types';
import type { PendingPermissionSnapshot } from '../../shared/pendingPermissions';

interface PendingRequest {
	resolve: (decision: PermissionDecision) => void;
	cancelTimer: () => void;
	token: string;
}

const bindings = new Map<string, RelaySpawnBinding>();
const pending = new Map<string, PendingRequest>();
let pendingVersion = 0;
const pendingListeners = new Set<(snapshot: PendingPermissionSnapshot) => void>();

/** The registry is the authority for real blocked requests, across all tabs. */
export function getPendingPermissionSnapshot(): PendingPermissionSnapshot {
	return {
		version: pendingVersion,
		processIds: [
			...new Set(
				[...pending.values()].flatMap((request) => {
					const binding = bindings.get(request.token);
					return binding ? [binding.sessionId] : [];
				})
			),
		],
	};
}

export function subscribePendingPermissions(
	listener: (snapshot: PendingPermissionSnapshot) => void
): () => void {
	const release = beginGlobalWorktreeActivity();
	try {
		pendingListeners.add(listener);
		return () => {
			const releaseUnsubscribe = beginGlobalWorktreeActivity();
			try {
				pendingListeners.delete(listener);
			} finally {
				releaseUnsubscribe();
			}
		};
	} finally {
		release();
	}
}

function notifyPendingPermissions(): void {
	pendingVersion++;
	const snapshot = getPendingPermissionSnapshot();
	for (const listener of pendingListeners) listener(snapshot);
}

/** Generate a cryptographically-strong per-spawn token. */
export function generateRelayToken(): string {
	return randomBytes(32).toString('hex');
}

/**
 * Register a spawn's token -> session/tab binding. Returns the token to embed
 * in the bridge env and a cleanup that removes the binding and denies any of
 * its still-pending requests (called when the Claude process exits).
 */
export function registerSpawn(binding: RelaySpawnBinding): {
	token: string;
	cleanup: () => void;
} {
	// A valid token can admit future permission work after setup or native close.
	// Own it independently through successful cleanup, including reentrant calls.
	const release = beginGlobalWorktreeActivity();
	let insertionStarted = false;
	let setupSettled = false;
	let cleanupDepth = 0;
	let cleanupSettled = false;
	let released = false;
	const releaseIfSettled = () => {
		if (setupSettled && cleanupSettled && cleanupDepth === 0 && !released) {
			released = true;
			release();
		}
	};
	try {
		const token = generateRelayToken();
		// Once insertion starts, an exception cannot prove the token is absent.
		insertionStarted = true;
		bindings.set(token, binding);

		const cleanup = () => {
			const releaseCleanup = beginGlobalWorktreeActivity();
			cleanupDepth++;
			let completed = false;
			try {
				bindings.delete(token);
				let changed = false;
				// Deny any requests still waiting on this dead spawn so the bridge's
				// socket handler (if somehow still open) doesn't hang forever.
				for (const [requestId, req] of pending) {
					if (req.token === token) {
						req.cancelTimer();
						pending.delete(requestId);
						changed = true;
						req.resolve({ behavior: 'deny', message: 'Agent process exited.' });
					}
				}
				if (changed) notifyPendingPermissions();
				completed = true;
			} finally {
				cleanupSettled = completed;
				cleanupDepth--;
				releaseIfSettled();
				releaseCleanup();
			}
		};

		return { token, cleanup };
	} finally {
		setupSettled = true;
		if (!insertionStarted) cleanupSettled = true;
		releaseIfSettled();
	}
}

/** Look up which session/tab a token belongs to, or undefined if unknown. */
export function lookupBinding(token: string): RelaySpawnBinding | undefined {
	return bindings.get(token);
}

/**
 * Create a pending request that resolves when `resolvePending` is called with
 * its `requestId`, or auto-denies after `timeoutMs`. Returns the decision
 * promise.
 */
export function createPending(
	requestId: string,
	token: string,
	timeoutMs: number = RELAY_DECISION_TIMEOUT_MS
): Promise<PermissionDecision> {
	const release = beginGlobalWorktreeActivity();
	let setupSettled = false;
	let timerSettled = false;
	let decisionSettled = false;
	let expiring = false;
	let released = false;
	// A rejected setup can leave a live timer; a failed notification can leave
	// an unresolved decision. Neither is completion of this request's work.
	const releaseIfSettled = () => {
		if (setupSettled && timerSettled && decisionSettled && !expiring && !released) {
			released = true;
			release();
		}
	};
	try {
		return new Promise<PermissionDecision>((resolve) => {
			const resolveDecision = (decision: PermissionDecision) => {
				resolve(decision);
				decisionSettled = true;
				releaseIfSettled();
			};
			try {
				const timer = setTimeout(() => {
					expiring = true;
					try {
						pending.delete(requestId);
						notifyPendingPermissions();
						resolveDecision({
							behavior: 'deny',
							message: 'Permission request timed out with no response.',
						});
					} finally {
						timerSettled = true;
						expiring = false;
						releaseIfSettled();
					}
				}, timeoutMs);
				// Don't keep the event loop alive purely for a pending prompt.
				if (typeof timer.unref === 'function') {
					timer.unref();
				}
				pending.set(requestId, {
					resolve: resolveDecision,
					cancelTimer: () => {
						clearTimeout(timer);
						timerSettled = true;
						releaseIfSettled();
					},
					token,
				});
				notifyPendingPermissions();
			} catch (error) {
				// The Promise executor rejects with this same error. A timer whose
				// completion was not observed must continue to exclude cleanup.
				decisionSettled = true;
				throw error;
			}
		});
	} finally {
		setupSettled = true;
		releaseIfSettled();
	}
}

/**
 * Resolve a pending request with a decision. No-op if the request is unknown
 * (already resolved, timed out, or cleaned up). Returns whether it matched.
 */
export function resolvePending(requestId: string, decision: PermissionDecision): boolean {
	const release = beginGlobalWorktreeActivity();
	try {
		const req = pending.get(requestId);
		if (!req) {
			return false;
		}
		req.cancelTimer();
		pending.delete(requestId);
		notifyPendingPermissions();
		req.resolve(decision);
		return true;
	} finally {
		release();
	}
}

/** Test/inspection helper: current counts. */
export function relayRegistryStats(): { bindings: number; pending: number } {
	return { bindings: bindings.size, pending: pending.size };
}
