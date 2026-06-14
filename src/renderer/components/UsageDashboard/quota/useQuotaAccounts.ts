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

	const configuredAccountKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const key of accountKeys) keys.add(normalizeKey(key));
		for (const key of discoveredAccountKeys) keys.add(normalizeKey(key));
		for (const s of sessions) {
			if (s.toolType !== toolType) continue;
			const sessionEnv = (s.customEnvVars ?? {}) as Record<string, string>;
			const merged = { ...agentLevelEnvVars, ...sessionEnv };
			const dir = merged[envVarName];
			if (typeof dir === 'string' && dir.length > 0) {
				keys.add(normalizeKey(dir));
			} else if (defaultAccountKey) {
				keys.add(defaultAccountKey);
			}
		}
		// Also include any snapshot key not surfaced in session config - e.g. an
		// account sampled in a previous run whose session was since deleted.
		// Keeping the tab lets the user still see the cached data.
		for (const key of Object.keys(snapshots)) keys.add(normalizeKey(key));
		return Array.from(keys).sort((a, b) => deriveShortName(a).localeCompare(deriveShortName(b)));
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

	return { configuredAccountKeys, selectedKey, setSelectedKey, effectiveSelectedKey };
}
