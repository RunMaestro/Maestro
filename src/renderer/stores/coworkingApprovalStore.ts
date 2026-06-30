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
 *  allows, false when they decline or close the dialog (cancel-safe). */
export function requestCoworkingApproval(input: {
	agentId: string;
	sessionId: string;
	title: string;
	message: string;
}): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const request: CoworkingApprovalRequest = { ...input, id: generateId(), resolve };
	useCoworkingApprovalStore.setState((s) => ({ queue: [...s.queue, request] }));
	return promise;
}
