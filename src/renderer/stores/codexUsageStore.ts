/**
 * codexUsageStore - renderer-side mirror of Codex quota snapshots.
 *
 * Main owns the auth-sensitive sampling path. Renderer components only fetch
 * already-sanitized quota windows through IPC.
 */

import { create } from 'zustand';

export interface CodexUsageWindow {
	percent: number;
	resetsAt: string;
}

export interface CodexAdditionalLimit {
	name: string;
	percent: number;
	resetsAt?: string;
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
