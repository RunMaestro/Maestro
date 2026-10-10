/**
 * codexUsageStore - renderer-side mirror of Codex quota snapshots.
 *
 * Main owns the auth-sensitive sampling path. Renderer components only fetch
 * already-sanitized quota windows through IPC.
 */

import { create } from 'zustand';

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
	/** Reset-credit inventory, carried free on the usage payload. */
	resetCredits?: CodexResetCreditCounts;
	error?: string;
}

interface CodexUsageState {
	snapshots: Record<string, CodexUsageSnapshot>;
	loaded: boolean;
	refreshing: boolean;
	setSnapshots: (next: Record<string, CodexUsageSnapshot>) => void;
	refresh: () => Promise<void>;
	__resetForTests: () => void;
}

const initial = {
	snapshots: {} as Record<string, CodexUsageSnapshot>,
	loaded: false,
	refreshing: false,
};

export const useCodexUsageStore = create<CodexUsageState>((set, get) => ({
	...initial,
	setSnapshots: (next) => set({ snapshots: next, loaded: true }),
	refresh: async () => {
		if (get().refreshing) return;
		set({ refreshing: true });
		try {
			const next = await window.maestro.agents.getCodexUsageSnapshots();
			set({ snapshots: next ?? {}, loaded: true });
		} catch {
			set({ loaded: true });
		} finally {
			set({ refreshing: false });
		}
	},
	__resetForTests: () => set({ ...initial }),
}));

export function getAllCodexUsageSnapshots(): Record<string, CodexUsageSnapshot> {
	return useCodexUsageStore.getState().snapshots;
}
