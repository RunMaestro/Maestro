/**
 * claudeUsageStore - renderer-side mirror of the main-process Claude plan
 * usage snapshot map.
 *
 * Snapshots live on disk (electron-store namespace `claude-usage-snapshots`,
 * keyed by canonical `CLAUDE_CONFIG_DIR`). The renderer reads them via the
 * `agents:getClaudeUsageSnapshots` IPC handler and caches them here.
 *
 * Refresh contract:
 *   - First read lazily fetches the map (so a mounted badge component triggers
 *     the first IPC round-trip without each render site having to wire it).
 *   - The `process:claude-mode-resolved` listener fires `refresh()` because the
 *     spawner sampled usage as part of its mode decision; the on-disk map may
 *     have changed.
 *   - The settings UI / Usage Dashboard "Refresh now" button can also call
 *     `refresh()` after asking main to re-sample.
 *
 * This is renderer-local state, NOT persisted across app restarts - the
 * authoritative store is on the main side. We hold the same map shape here for
 * cheap synchronous reads from React components.
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { getHomeDir, getHomeDirAsync } from '../utils/homeDir';
import type { Session } from '../types';

/**
 * Snapshot shape mirrors `UsageSnapshot` in `src/main/agents/claude-mode-selector.ts`.
 * Duplicated here to keep the renderer bundle free of main-process imports.
 *
 * `authState` is optional for back-compat with snapshots persisted before the
 * field existed - readers treat absence as `'authenticated'` and only switch
 * the dashboard row into the "run /login" CTA when it's explicitly
 * `'unauthenticated'`.
 */
export interface ClaudeUsageSnapshot {
	sampledAt: string;
	configDirKey: string;
	authState?: 'authenticated' | 'unauthenticated';
	session: { percent: number; resetsAt: string };
	weekAllModels: { percent: number; resetsAt: string };
	weekSonnetOnly: { percent: number; resetsAt: string };
}

interface ClaudeUsageState {
	snapshots: Record<string, ClaudeUsageSnapshot>;
	/** True once the first fetch has resolved (success or empty). Drives lazy first-read. */
	loaded: boolean;
	/** True while a refresh is in flight. Settings/Dashboard UIs use this to disable buttons. */
	refreshing: boolean;
	/** Replace the full snapshot map. */
	setSnapshots: (next: Record<string, ClaudeUsageSnapshot>) => void;
	/** Pull the latest map from main via IPC and store it. Safe to call repeatedly. */
	refresh: () => Promise<void>;
	/** Test-only: reset to initial state. */
	__resetForTests: () => void;
}

const initial = {
	snapshots: {} as Record<string, ClaudeUsageSnapshot>,
	loaded: false,
	refreshing: false,
};

export const useClaudeUsageStore = create<ClaudeUsageState>((set, get) => ({
	...initial,
	setSnapshots: (next) => set({ snapshots: next, loaded: true }),
	refresh: async () => {
		if (get().refreshing) return;
		set({ refreshing: true });
		try {
			const next = await window.maestro.agents.getClaudeUsageSnapshots();
			set({ snapshots: next ?? {}, loaded: true });
		} catch {
			// Swallow - main-side errors surface in main logs; the renderer just
			// keeps the last good snapshot rather than blowing up the UI.
			set({ loaded: true });
		} finally {
			set({ refreshing: false });
		}
	},
	__resetForTests: () => set({ ...initial }),
}));

/**
 * Imperative accessor for non-React call sites (the
 * `process:claude-mode-resolved` listener mostly). Returns the current
 * snapshot map without subscribing.
 */
export function getAllSnapshots(): Record<string, ClaudeUsageSnapshot> {
	return useClaudeUsageStore.getState().snapshots;
}

/**
 * Read the snapshot for a specific canonical `CLAUDE_CONFIG_DIR` key. Returns
 * `null` when the key is missing or undefined. Triggers a lazy first-load
 * fetch the first time any consumer mounts so the badge tooltip has data
 * without each render site having to wire the IPC manually.
 *
 * Lookup is forgiving in two specific ways so the popover doesn't silently
 * hide the gauge when the renderer's derived key drifts from main's canonical
 * path:
 *   1. Try the exact key against snapshots (strict match, fastest path).
 *   2. Try matching by basename (e.g. ".claude-smash"). Two spellings of the
 *      same dir collapse to the same trailing segment.
 *   3. If exactly one snapshot exists in the store, use it. Single-account
 *      installs (the common case) always show their numbers regardless of
 *      env-var resolution issues.
 */
export function useClaudeUsageSnapshot(
	configDirKey: string | undefined
): ClaudeUsageSnapshot | null {
	const loaded = useClaudeUsageStore((s) => s.loaded);
	const snapshots = useClaudeUsageStore((s) => s.snapshots);

	useEffect(() => {
		if (!loaded) {
			void useClaudeUsageStore.getState().refresh();
		}
	}, [loaded]);

	if (configDirKey) {
		const exact = snapshots[configDirKey];
		if (exact) return exact;
		const targetBasename = configDirKey.slice(configDirKey.lastIndexOf('/') + 1);
		if (targetBasename) {
			for (const [k, v] of Object.entries(snapshots)) {
				const basename = k.slice(k.lastIndexOf('/') + 1);
				if (basename === targetBasename) return v;
			}
		}
	}

	const entries = Object.values(snapshots);
	if (entries.length === 1) return entries[0];
	return null;
}

/**
 * Non-hook variant of `useClaudeUsageSnapshot` for imperative call sites (the
 * auto-resume coordinator probes a paused session's account outside React).
 * Resolves the session's canonical `CLAUDE_CONFIG_DIR` key from the spawner's
 * stamped `lastUsageSnapshotKey` (or the session/agent env var as a fallback),
 * then applies the same forgiving lookup as the hook: exact key, then basename,
 * then the single-account fallback. Returns `null` for non-Claude sessions or
 * when no snapshot matches.
 */
export function getClaudeUsageSnapshotForSession(
	session: Pick<Session, 'toolType' | 'claudeInteractive' | 'customEnvVars'> | null | undefined
): ClaudeUsageSnapshot | null {
	if (!session || session.toolType !== 'claude-code') return null;
	const snapshots = useClaudeUsageStore.getState().snapshots;

	const stamped = session.claudeInteractive?.lastUsageSnapshotKey;
	const envKey = (session.customEnvVars as Record<string, string> | undefined)?.CLAUDE_CONFIG_DIR;
	const rawKey =
		typeof stamped === 'string' && stamped.length > 0
			? stamped
			: typeof envKey === 'string' && envKey.length > 0
				? envKey
				: undefined;
	const key = rawKey ? rawKey.replace(/\/+$/, '') : undefined;

	if (key) {
		const exact = snapshots[key];
		if (exact) return exact;
		const targetBasename = key.slice(key.lastIndexOf('/') + 1);
		if (targetBasename) {
			for (const [k, v] of Object.entries(snapshots)) {
				const basename = k.slice(k.lastIndexOf('/') + 1);
				if (basename === targetBasename) return v;
			}
		}
	}

	const entries = Object.values(snapshots);
	if (entries.length === 1) return entries[0];
	return null;
}

/**
 * Module-level cache for the claude-code agent's `customEnvVars`. One IPC
 * fetch per renderer process; subsequent consumers read the same Promise. The
 * agent-level vars rarely change at runtime (Settings → Agents) so we don't
 * subscribe to a live channel - call sites just need a stable reference for
 * deriving `CLAUDE_CONFIG_DIR` per session.
 */
let cachedClaudeAgentEnv: Record<string, string> | undefined;
let claudeAgentEnvPromise: Promise<Record<string, string>> | undefined;

function fetchClaudeAgentEnv(): Promise<Record<string, string>> {
	if (claudeAgentEnvPromise) return claudeAgentEnvPromise;
	const bridge = (window as any)?.maestro?.agents?.getCustomEnvVars;
	if (typeof bridge !== 'function') {
		claudeAgentEnvPromise = Promise.resolve({});
		return claudeAgentEnvPromise;
	}
	claudeAgentEnvPromise = Promise.resolve(bridge('claude-code'))
		.then((env: Record<string, string> | null | undefined) => {
			const safe = env ?? {};
			cachedClaudeAgentEnv = safe;
			return safe;
		})
		.catch(() => {
			cachedClaudeAgentEnv = {};
			return {};
		});
	return claudeAgentEnvPromise;
}

/**
 * Resolve the canonical `CLAUDE_CONFIG_DIR` key for a Claude Code session
 * the same way the main-side spawner does: session env wins over agent env,
 * with the implicit default `~/.claude` as the final fallback. Returns
 * `undefined` only when the session isn't a Claude Code session, when no
 * useful resolution is possible yet (no home dir, no env vars, no
 * pre-stamped key), or when the inputs explicitly disable resolution.
 */
function resolveSessionConfigDirKey(
	session: Session | null | undefined,
	agentEnv: Record<string, string>,
	homeDir: string | undefined
): string | undefined {
	if (!session || session.toolType !== 'claude-code') return undefined;
	// The spawner stamps the canonical key onto claudeInteractive when it
	// resolves the mode. Prefer that - it's already canonicalized via
	// `path.resolve()` on the main side.
	const stamped = session.claudeInteractive?.lastUsageSnapshotKey;
	if (typeof stamped === 'string' && stamped.length > 0) {
		return stamped.replace(/\/+$/, '');
	}
	const sessionEnv = (session.customEnvVars ?? {}) as Record<string, string>;
	const explicit = sessionEnv.CLAUDE_CONFIG_DIR ?? agentEnv.CLAUDE_CONFIG_DIR;
	if (typeof explicit === 'string' && explicit.length > 0) {
		return explicit.replace(/\/+$/, '');
	}
	if (homeDir) return `${homeDir.replace(/\/+$/, '')}/.claude`;
	return undefined;
}

/**
 * Hook variant of `resolveSessionConfigDirKey` - pairs the lazy agent-env
 * fetch with React state so consumers re-render once the IPC resolves and
 * the implicit default key becomes derivable.
 */
export function useResolvedClaudeConfigDirKey(
	session: Session | null | undefined
): string | undefined {
	const [agentEnv, setAgentEnv] = useState<Record<string, string>>(
		() => cachedClaudeAgentEnv ?? {}
	);
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);

	useEffect(() => {
		if (!cachedClaudeAgentEnv) {
			void fetchClaudeAgentEnv().then((env) => setAgentEnv(env));
		}
	}, []);

	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	return resolveSessionConfigDirKey(session ?? null, agentEnv, homeDir);
}
