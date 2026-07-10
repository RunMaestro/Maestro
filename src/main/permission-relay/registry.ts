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
import type { PermissionDecision, RelaySpawnBinding } from './types';
import { RELAY_DECISION_TIMEOUT_MS } from './types';

interface PendingRequest {
	resolve: (decision: PermissionDecision) => void;
	timer: NodeJS.Timeout;
	token: string;
}

const bindings = new Map<string, RelaySpawnBinding>();
const pending = new Map<string, PendingRequest>();

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
	const token = generateRelayToken();
	bindings.set(token, binding);

	const cleanup = () => {
		bindings.delete(token);
		// Deny any requests still waiting on this dead spawn so the bridge's
		// socket handler (if somehow still open) doesn't hang forever.
		for (const [requestId, req] of pending) {
			if (req.token === token) {
				clearTimeout(req.timer);
				pending.delete(requestId);
				req.resolve({ behavior: 'deny', message: 'Agent process exited.' });
			}
		}
	};

	return { token, cleanup };
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
	return new Promise<PermissionDecision>((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			resolve({
				behavior: 'deny',
				message: 'Permission request timed out with no response.',
			});
		}, timeoutMs);
		// Don't keep the event loop alive purely for a pending prompt.
		if (typeof timer.unref === 'function') {
			timer.unref();
		}
		pending.set(requestId, { resolve, timer, token });
	});
}

/**
 * Resolve a pending request with a decision. No-op if the request is unknown
 * (already resolved, timed out, or cleaned up). Returns whether it matched.
 */
export function resolvePending(requestId: string, decision: PermissionDecision): boolean {
	const req = pending.get(requestId);
	if (!req) {
		return false;
	}
	clearTimeout(req.timer);
	pending.delete(requestId);
	req.resolve(decision);
	return true;
}

/** Test/inspection helper: current counts. */
export function relayRegistryStats(): { bindings: number; pending: number } {
	return { bindings: bindings.size, pending: pending.size };
}
