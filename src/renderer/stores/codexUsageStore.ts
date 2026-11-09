/**
 * codexUsageStore - renderer-side mirror of Codex quota snapshots.
 *
 * Main owns the auth-sensitive sampling path. Renderer components only fetch
 * already-sanitized quota windows through IPC.
 */

import { createQuotaSnapshotStore } from './quotaSnapshotStore';

import type { CodexCreditBalance } from '../../shared/codexCredits';
import type { CodexResetCreditCounts } from '../../shared/codexResetCredits';

export interface CodexUsageWindow {
	percent: number;
	resetsAt: string;
	/**
	 * Length of the window the percentage is measured over, in seconds, when the
	 * quota endpoint declares it. This is what files a window as a session or a
	 * weekly bucket - the slot it arrived in does not, because plans order the
	 * two differently. Undefined on responses that omit `limit_window_seconds`.
	 */
	windowSeconds?: number;
}

export interface CodexAdditionalLimit {
	name: string;
	percent: number;
	resetsAt?: string;
	/** Length of this sublimit's window, in seconds, when the endpoint declares it. */
	windowSeconds?: number;
}

export type CodexUsageAuthState = 'authenticated' | 'missing_auth' | 'unauthenticated' | 'error';

export interface CodexUsageSnapshot {
	sampledAt: string;
	codexHomeKey: string;
	authState: CodexUsageAuthState;
	label?: string;
	email?: string;
	planType?: string;
	session?: CodexUsageWindow;
	weekly?: CodexUsageWindow;
	additionalLimits?: CodexAdditionalLimit[];
	/** Additional usage credits; absent when the endpoint does not report a usable balance. */
	credits?: CodexCreditBalance;
	/** Reset-credit inventory, carried free on the usage payload. */
	resetCredits?: CodexResetCreditCounts;
	error?: string;
}

export const useCodexUsageStore = createQuotaSnapshotStore<CodexUsageSnapshot>({
	fetchSnapshots: () => window.maestro.agents.getCodexUsageSnapshots(),
	sampleOnMain: () => window.maestro.agents.refreshCodexUsageSnapshots(),
});

export function getAllCodexUsageSnapshots(): Record<string, CodexUsageSnapshot> {
	return useCodexUsageStore.getState().snapshots;
}
