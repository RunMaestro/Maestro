/**
 * permissionRequestStore - Zustand store for Claude Code standard-mode
 * permission prompts.
 *
 * When Claude Code runs in `standard` permission mode (API/print path), the
 * main-process relay forwards each tool-permission request here via
 * `window.maestro.process.onPermissionRequest`. The PermissionPrompt modal
 * renders the head of the queue; the user's decision is sent back through
 * `window.maestro.process.respondPermission`.
 *
 * Requests are queued (one prompt shown at a time) and answered FIFO.
 */

import { create } from 'zustand';

export interface PermissionRequestUI {
	requestId: string;
	sessionId: string;
	tabId?: string;
	toolName: string;
	input: Record<string, unknown>;
	createdAt: number;
}

export type PermissionDecision =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string };

interface PermissionRequestState {
	queue: PermissionRequestUI[];
	/** Add a request to the queue (from the IPC listener). */
	enqueue: (request: PermissionRequestUI) => void;
	/** Answer a request: send the decision to main, then dequeue it. */
	respond: (requestId: string, decision: PermissionDecision) => void;
	/** Drop all requests for a session (e.g. when its process exits). */
	clearSession: (sessionId: string) => void;
}

export const usePermissionRequestStore = create<PermissionRequestState>((set) => ({
	queue: [],
	enqueue: (request) =>
		set((state) => {
			// Ignore duplicates (defensive against double-delivery).
			if (state.queue.some((r) => r.requestId === request.requestId)) {
				return state;
			}
			return { queue: [...state.queue, request] };
		}),
	respond: (requestId, decision) => {
		// Fire-and-forget to main; the relay resolves the awaiting bridge call.
		void window.maestro?.process?.respondPermission?.(requestId, decision);
		set((state) => ({ queue: state.queue.filter((r) => r.requestId !== requestId) }));
	},
	clearSession: (sessionId) =>
		set((state) => {
			// Explicitly deny any queued requests for the exiting session so the
			// awaiting bridge call unblocks immediately, rather than waiting on the
			// main-side exit cleanup or the ~300s registry timeout. Denying an
			// already-resolved request is a harmless no-op in the registry.
			for (const r of state.queue) {
				if (r.sessionId === sessionId) {
					void window.maestro?.process?.respondPermission?.(r.requestId, {
						behavior: 'deny',
						message: 'Agent exited.',
					});
				}
			}
			return { queue: state.queue.filter((r) => r.sessionId !== sessionId) };
		}),
}));

/** Selector: the request currently shown (head of the queue), or undefined. */
export function selectActivePermissionRequest(
	state: PermissionRequestState
): PermissionRequestUI | undefined {
	return state.queue[0];
}
