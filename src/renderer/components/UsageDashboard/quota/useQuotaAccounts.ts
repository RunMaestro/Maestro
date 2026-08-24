/**
 * useQuotaAccounts
 *
 * Derives the account list a provider quota panel should show, mirroring the
 * main-side sampler's sourcing rule: explicit prop keys + locally-discovered
 * account dirs + every `<TOOL>_HOME`/`CONFIG_DIR` referenced by a session
 * (agent-level customEnvVars merged under session-level, session wins) + any
 * key already present in the snapshot store. Sessions without an explicit env
 * var fall back to the implicit default (`~/<defaultSubdir>`).
 *
 * The result includes selection state (which account tab is active) clamped to
 * the first account whenever the current selection disappears.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { getHomeDir, getHomeDirAsync } from '../../../utils/homeDir';

export interface UseQuotaAccountsOptions {
	/** Provider session `toolType` that owns this quota surface. */
	toolType: string;
	/** Env var that selects the account home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). */
	envVarName: string;
	/** Default account subdir under $HOME when no env var is set (`.claude` / `.codex`). */
	defaultSubdir: string;
	/** Explicit account keys from the parent (normalized internally). */
	accountKeys: string[];
	/** Live snapshot map from the provider store (keys are canonical account keys). */
	snapshots: Record<string, unknown>;
	/** Strip-trailing-slash normalizer shared with the panel. */
	normalizeKey: (value: string) => string;
	/** Short-name deriver, used as the tab sort comparator. */
	deriveShortName: (key: string | undefined) => string;
	/** Best-effort agent-level customEnvVars fetch (may resolve null/undefined). */
	fetchAgentEnvVars?: () => Promise<Record<string, string> | null | undefined> | undefined;
	/** Best-effort discovered-account-keys fetch (may be undefined). */
	fetchAccountKeys?: () => Promise<string[]> | undefined;
}

export interface UseQuotaAccountsResult {
	configuredAccountKeys: string[];
	/**
	 * How many agents of this provider resolve to each account key. Computed in
	 * the same pass that builds `configuredAccountKeys` so the badge can never
	 * disagree with the tab/row list about which account an agent belongs to.
	 * Accounts with no agent (a cached snapshot, a discovered dir) are absent.
	 */
	agentCountsByAccount: Record<string, number>;
	selectedKey: string | null;
	setSelectedKey: (key: string) => void;
	effectiveSelectedKey: string | null;
}

export function useQuotaAccounts(opts: UseQuotaAccountsOptions): UseQuotaAccountsResult {
	const {
		toolType,
		envVarName,
		defaultSubdir,
		accountKeys,
		snapshots,
		normalizeKey,
		deriveShortName,
	} = opts;
	const sessions = useSessionStore((s) => s.sessions);

	// Keep the latest fetchers in refs so the mount-only effects below can call
	// them without re-firing when the parent passes fresh closures each render.
	const fetchEnvRef = useRef(opts.fetchAgentEnvVars);
	const fetchKeysRef = useRef(opts.fetchAccountKeys);
	useEffect(() => {
		fetchEnvRef.current = opts.fetchAgentEnvVars;
		fetchKeysRef.current = opts.fetchAccountKeys;
	});

	// Agent-level customEnvVars. Fetched once on mount; updates are rare
	// (Settings -> Agents) so we don't subscribe - Refresh re-pulls on demand.
	const [agentLevelEnvVars, setAgentLevelEnvVars] = useState<Record<string, string>>({});
	useEffect(() => {
		let cancelled = false;
		const p = fetchEnvRef.current?.();
		if (!p) return;
		Promise.resolve(p)
			.then((env) => {
				if (!cancelled && env) setAgentLevelEnvVars(env);
			})
			.catch(() => {
				// Best-effort; agent-level vars are optional context. The
				// session-level fallback still produces a usable tab list.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Locally-discovered account keys (main-side scan of ~/<prefix>* dirs).
	// Stored raw; the memo below normalizes alongside every other source.
	const [discoveredAccountKeys, setDiscoveredAccountKeys] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		const p = fetchKeysRef.current?.();
		if (!p) return;
		Promise.resolve(p)
			.then((keys) => {
				if (!cancelled && Array.isArray(keys)) setDiscoveredAccountKeys(keys);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	// Home dir for the implicit default `~/<defaultSubdir>` account. The
	// renderer has no direct fs access; cached IPC fetch returns synchronously
	// on subsequent renders.
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);
	const defaultAccountKey = homeDir ? normalizeKey(`${homeDir}/${defaultSubdir}`) : null;

	const { configuredAccountKeys, agentCountsByAccount } = useMemo(() => {
		const keys = new Set<string>();
		const counts: Record<string, number> = {};
		for (const key of accountKeys) keys.add(normalizeKey(key));
		for (const key of discoveredAccountKeys) keys.add(normalizeKey(key));
		for (const s of sessions) {
			if (s.toolType !== toolType) continue;
			const sessionEnv = (s.customEnvVars ?? {}) as Record<string, string>;
			const merged = { ...agentLevelEnvVars, ...sessionEnv };
			const dir = merged[envVarName];
			// An agent with no env var runs against the implicit `~/<subdir>`
			// account, so it belongs to that bucket - unless $HOME hasn't
			// resolved yet, in which case there is no key to attribute it to.
			const resolved =
				typeof dir === 'string' && dir.length > 0 ? normalizeKey(dir) : defaultAccountKey;
			if (!resolved) continue;
			keys.add(resolved);
			counts[resolved] = (counts[resolved] ?? 0) + 1;
		}
		// Also include any snapshot key not surfaced in session config - e.g. an
		// account sampled in a previous run whose session was since deleted.
		// Keeping the tab lets the user still see the cached data.
		for (const key of Object.keys(snapshots)) keys.add(normalizeKey(key));

		// Collapse case-variant spellings of the same path - e.g. the canonical
		// `/Users/me/.claude-x` from the fs scan vs a `/users/me/.claude-x` typed
		// into a session's CLAUDE_CONFIG_DIR. On a case-insensitive filesystem
		// (macOS, Windows) those are one directory, so showing two rows is a bug.
		// Two real account dirs never differ only by case, so folding on lowercase
		// is safe. Prefer the spelling that has a snapshot so the data-bearing
		// (main-derived, correctly-cased) key wins; otherwise keep the first seen,
		// which is the fs-discovered key before any session-typed variant.
		const byFold = new Map<string, string>();
		for (const key of keys) {
			const fold = key.toLowerCase();
			const existing = byFold.get(fold);
			if (existing === undefined || (!snapshots[existing] && snapshots[key])) {
				byFold.set(fold, key);
			}
		}
		const foldedKeys = Array.from(byFold.values());

		// The counts were tallied per raw spelling, so fold them the same way. A
		// count left under a spelling that just lost the fold would be stranded:
		// its key is no longer in the list, and the surviving row would under-report
		// its agents - exactly the tab/badge disagreement this map exists to prevent.
		const foldedCounts: Record<string, number> = {};
		for (const [rawKey, count] of Object.entries(counts)) {
			const survivor = byFold.get(rawKey.toLowerCase()) ?? rawKey;
			foldedCounts[survivor] = (foldedCounts[survivor] ?? 0) + count;
		}

		return {
			configuredAccountKeys: foldedKeys.sort((a, b) =>
				deriveShortName(a).localeCompare(deriveShortName(b))
			),
			agentCountsByAccount: foldedCounts,
		};
	}, [
		accountKeys,
		discoveredAccountKeys,
		sessions,
		agentLevelEnvVars,
		snapshots,
		defaultAccountKey,
		toolType,
		envVarName,
		normalizeKey,
		deriveShortName,
	]);

	// Sub-tab selection. Defaults to the first account; clamps back to the
	// first whenever the selected key disappears.
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	useEffect(() => {
		if (configuredAccountKeys.length === 0) {
			if (selectedKey !== null) setSelectedKey(null);
			return;
		}
		if (selectedKey === null || !configuredAccountKeys.includes(selectedKey)) {
			setSelectedKey(configuredAccountKeys[0]);
		}
	}, [configuredAccountKeys, selectedKey]);

	const effectiveSelectedKey = selectedKey ?? configuredAccountKeys[0] ?? null;

	return {
		configuredAccountKeys,
		agentCountsByAccount,
		selectedKey,
		setSelectedKey,
		effectiveSelectedKey,
	};
}
