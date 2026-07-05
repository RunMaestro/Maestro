/**
 * Pending per-call approval queue for coworking browser interaction.
 *
 * State-changing browser tools (navigate/click/type/eval/...) can require an
 * explicit human approval on top of the per-agent interaction permission. The
 * renderer responder calls `requestCoworkingApproval(...)` and awaits the
 * returned promise; the front of the queue is rendered as a confirm dialog by
 * `CoworkingApprovalHost`, which calls `settle(id, approved)`.
 *
 * The promise is created with `Promise.withResolvers`, and `settle(id, false)`
 * is wired to BOTH decline and dialog-close, so cancelling never hangs the
 * awaiting op.
 */

import { create } from 'zustand';
import { generateId } from '../utils/ids';

export interface CoworkingApprovalRequest {
	id: string;
	agentId: string;
	sessionId: string;
	title: string;
	message: string;
	/** Settles the awaiting op: true = allow, false = decline/cancel. */
	resolve: (approved: boolean) => void;
}

interface CoworkingApprovalState {
	queue: CoworkingApprovalRequest[];
	/** Resolve and remove a pending request. Safe to call for an unknown id. */
	settle: (id: string, approved: boolean) => void;
}

export const useCoworkingApprovalStore = create<CoworkingApprovalState>((set, get) => ({
	queue: [],
	settle: (id, approved) => {
		const request = get().queue.find((r) => r.id === id);
		if (!request) return;
		set((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
		request.resolve(approved);
	},
}));

/** Enqueue a per-call browser-interaction approval. Resolves true when the user
 *  allows, false when they decline or close the dialog (cancel-safe). When
 *  `timeoutMs` is set, the request auto-declines and dismisses its dialog after
 *  that long, so a belatedly-approved action can't execute after the caller's
 *  round-trip has already timed out. */
export function requestCoworkingApproval(
	input: {
		agentId: string;
		sessionId: string;
		title: string;
		message: string;
	},
	timeoutMs?: number
): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const id = generateId();
	let timer: number | null = null;
	// Wrap resolve so a user decision (or the auto-decline below) cancels the
	// pending timer exactly once.
	const resolveOnce = (approved: boolean) => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
		resolve(approved);
	};
	const request: CoworkingApprovalRequest = { ...input, id, resolve: resolveOnce };
	useCoworkingApprovalStore.setState((s) => ({ queue: [...s.queue, request] }));
	if (typeof timeoutMs === 'number' && timeoutMs > 0) {
		timer = window.setTimeout(() => {
			// settle() removes the request from the queue (dismissing the dialog)
			// and calls resolveOnce(false).
			useCoworkingApprovalStore.getState().settle(id, false);
		}, timeoutMs);
	}
	return promise;
}
