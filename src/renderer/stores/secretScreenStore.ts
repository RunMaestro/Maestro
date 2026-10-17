/**
 * Pending "this content holds a possible secret, publish anyway?" questions.
 *
 * Every path that publishes content (gist, feedback, support package) is
 * screened in the main process and refuses on a finding. The renderer then asks
 * the user once, here, and repeats the request with `allowSecrets` on a yes.
 * `confirmSecretFindings()` (services/secretScreen.ts) enqueues a request and
 * awaits it; `SecretScreenConfirmHost` draws the front of the queue.
 *
 * Same shape as `coworkingApprovalStore`: `settle(id, false)` is wired to both
 * Cancel and dialog-close, so dismissing never leaves a publish hanging.
 */

import { create } from 'zustand';
import type { SecretFinding } from '../../shared/secretScan';

export interface SecretScreenRequest {
	id: string;
	/** What would be sent, as it reads in a sentence: "this gist". */
	subject: string;
	/** Masked findings from the main-process screen. */
	findings: SecretFinding[];
	/** Why the optional model pass did not run. */
	note?: string;
	/** The yes button. "Publish anyway" unless the caller is not publishing. */
	confirmLabel: string;
	resolve: (proceed: boolean) => void;
}

interface SecretScreenState {
	queue: SecretScreenRequest[];
	/** Resolve and remove a pending request. Safe to call for an unknown id. */
	settle: (id: string, proceed: boolean) => void;
}

export const useSecretScreenStore = create<SecretScreenState>((set, get) => ({
	queue: [],
	settle: (id, proceed) => {
		const request = get().queue.find((r) => r.id === id);
		if (!request) return;
		set((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
		request.resolve(proceed);
	},
}));
