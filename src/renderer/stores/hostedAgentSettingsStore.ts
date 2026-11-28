/**
 * hostedAgentSettingsStore - this window's part of the Federation settings sync.
 *
 * A hosted agent's settings belong to its host (`lift-settings-sync.ts`). What a conductor keeps
 * here is what the host does not hold yet, or must never hold:
 *
 * - `pending`: edits made on a mirrored agent that have not reached its host (the peer was down,
 *   or the send is in flight), by `mirrorKey()`. `values` is what this conductor set; `base` is the
 *   host's value when the edit was made, so a host change since then reads as a conflict.
 * - `conflicts` and `resolutions`: fields both sides changed, waiting for the person, by
 *   `mirrorKey()` of the host agent, and the picks made for them until the host takes them.
 *
 * `pending` survives a restart (guarded local storage of the window that keeps it); conflicts are
 * worked out again from the records on every pass. A hosted agent's own settings are edited in its
 * normal Edit Agent, on its Left Bar record, and the sync sends them.
 */

import { create } from 'zustand';
import type {
	LiftSyncConflict,
	LiftSyncResolution,
	StoredSyncValue,
} from '../../shared/maestro-lib/agents/lift-settings-sync';
import { readStoredSyncValues } from '../../shared/maestro-lib/agents/lift-settings-sync';
import { safeStorageGet, safeStorageSet } from '../utils/safeLocalStorage';

const PENDING_KEY = 'maestro:federation:pending-settings:v1';

/** Edits on one mirrored agent that its host has not taken yet. */
export interface PendingHostedEdit {
	values: Record<string, StoredSyncValue>;
	base: Record<string, StoredSyncValue>;
	/** The env var names the edit follows, so a removed one still reaches the host. */
	envKeys: string[];
}

/** The conflicts of one hosted agent. */
export interface HostedConflictSet {
	peerId: string;
	agentId: string;
	agentName: string;
	conflicts: LiftSyncConflict[];
}

interface HostedAgentSettingsState {
	pending: Record<string, PendingHostedEdit>;
	conflicts: Record<string, HostedConflictSet>;
	resolutions: Record<string, Record<string, LiftSyncResolution>>;
	conflictsOpen: boolean;
}

interface HostedAgentSettingsActions {
	setPending(key: string, edit: PendingHostedEdit | null): void;
	setConflicts(key: string, set: HostedConflictSet | null): void;
	resolve(key: string, id: string, resolution: LiftSyncResolution): void;
	/** Drop the picks the host has taken. */
	clearResolutions(key: string, ids: readonly string[]): void;
	setConflictsOpen(open: boolean): void;
}

function readJson(key: string): Record<string, unknown> {
	const raw = safeStorageGet(key);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// A damaged entry only costs what was stored there.
		return {};
	}
}

function loadPending(): Record<string, PendingHostedEdit> {
	const out: Record<string, PendingHostedEdit> = {};
	for (const [key, value] of Object.entries(readJson(PENDING_KEY))) {
		if (!value || typeof value !== 'object') continue;
		const entry = value as Record<string, unknown>;
		const values = readStoredSyncValues(entry.values);
		const base = readStoredSyncValues(entry.base);
		if (!values || !base || Object.keys(values).length === 0) continue;
		const envKeys = Array.isArray(entry.envKeys)
			? entry.envKeys.filter((name): name is string => typeof name === 'string')
			: [];
		out[key] = { values, base, envKeys };
	}
	return out;
}

export const useHostedAgentSettingsStore = create<
	HostedAgentSettingsState & HostedAgentSettingsActions
>()((set, get) => ({
	pending: loadPending(),
	conflicts: {},
	resolutions: {},
	conflictsOpen: false,

	setPending: (key, edit) => {
		const pending = { ...get().pending };
		if (edit && Object.keys(edit.values).length > 0) pending[key] = edit;
		else delete pending[key];
		set({ pending });
		safeStorageSet(PENDING_KEY, JSON.stringify(pending));
	},

	setConflicts: (key, conflictSet) => {
		const current = get().conflicts;
		if (!conflictSet || conflictSet.conflicts.length === 0) {
			if (!(key in current)) return;
			const conflicts = { ...current };
			delete conflicts[key];
			set({ conflicts, conflictsOpen: get().conflictsOpen && Object.keys(conflicts).length > 0 });
			return;
		}
		set({ conflicts: { ...current, [key]: conflictSet } });
	},

	resolve: (key, id, resolution) => {
		const resolutions = get().resolutions;
		set({
			resolutions: { ...resolutions, [key]: { ...(resolutions[key] ?? {}), [id]: resolution } },
		});
	},

	clearResolutions: (key, ids) => {
		const existing = get().resolutions[key];
		if (!existing || ids.length === 0) return;
		const next = { ...existing };
		for (const id of ids) delete next[id];
		const resolutions = { ...get().resolutions };
		if (Object.keys(next).length > 0) resolutions[key] = next;
		else delete resolutions[key];
		set({ resolutions });
	},

	setConflictsOpen: (open) => set({ conflictsOpen: open }),
}));

/** How many fields wait for the person, across every hosted agent. */
export function selectHostedConflictCount(state: HostedAgentSettingsState): number {
	let count = 0;
	for (const entry of Object.values(state.conflicts)) count += entry.conflicts.length;
	return count;
}
