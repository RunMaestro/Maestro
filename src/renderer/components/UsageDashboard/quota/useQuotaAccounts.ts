/**
 * useQuotaAccounts
 *
 * Derives the account list a provider quota panel should show, mirroring the
 * main-side sampler's sourcing rule: explicit prop keys + locally-discovered
 * account dirs + every `<TOOL>_HOME`/`CONFIG_DIR` referenced by a session
 * (the agent's own customEnvVars, or the provider-level set when it has none -
 * the spawner replaces, it does not layer) + any key already present in the
 * snapshot store. Sessions without an explicit env var fall back to that
 * provider's implicit default account dir. Agents billing an API key, gateway,
 * or cloud provider are on no account's plan and are not counted.
 *
 * The result includes selection state (which account tab is active) clamped to
 * the first account whenever the current selection disappears.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import {
	effectiveAgentCustomEnvVars,
	resolveAgentAccountKey,
	resolveAgentBillingCredential,
} from '../../../../shared/providerProfiles';
import { getHomeDir, getHomeDirAsync } from '../../../utils/homeDir';

export interface UseQuotaAccountsOptions {
	/**
	 * Provider session `toolType` that owns this quota surface. The env var and
	 * default account subdir come from `PROVIDER_PROFILE_CONFIGS` keyed by this,
	 * so a panel cannot attribute an agent to a different account than the
	 * Agents grid's provider filter does.
	 */
	toolType: string;
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
	 *
	 * SSH-remote agents ARE counted, and also tallied in
	 * `remoteAgentCountsByAccount` - see the note on the counting loop below.
	 */
	agentCountsByAccount: Record<string, number>;
	/**
	 * How many of each account's agents run over SSH. Absent keys mean zero. The
	 * directory a remote agent names lives on the remote host, so its quota is
	 * whatever login that host keeps there - not necessarily this row's.
	 */
	remoteAgentCountsByAccount: Record<string, number>;
	selectedKey: string | null;
	setSelectedKey: (key: string) => void;
	effectiveSelectedKey: string | null;
}

export function useQuotaAccounts(opts: UseQuotaAccountsOptions): UseQuotaAccountsResult {
	const { toolType, accountKeys, snapshots, normalizeKey, deriveShortName } = opts;
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

	// Home dir for the provider's implicit default account dir. The
	// renderer has no direct fs access; cached IPC fetch returns synchronously
	// on subsequent renders.
	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	const { configuredAccountKeys, agentCountsByAccount, remoteAgentCountsByAccount } =
		useMemo(() => {
			const keys = new Set<string>();
			const counts: Record<string, number> = {};
			const remoteCounts: Record<string, number> = {};
			for (const key of accountKeys) keys.add(normalizeKey(key));
			for (const key of discoveredAccountKeys) keys.add(normalizeKey(key));
			// SSH-remote agents are counted, AND tallied on their own. The
			// main-process sampler (`buildTarget` in claude-usage-startup.ts) skips
			// them because the path names a directory on the remote host's disk - and
			// that directory holds the remote host's own login. It can be a different
			// account from this machine's same-named dir (one real setup had a dir
			// logged into one account locally and another on the remote), so a bare
			// "1 agent" beside this machine's bars claimed a quota that agent never
			// touched. Dropping remote agents would hide who is configured against
			// the profile; the separate tally lets the chip say "remote" instead.
			for (const s of sessions) {
				if (s.toolType !== toolType) continue;
				const env = effectiveAgentCustomEnvVars(
					s.customEnvVars as Record<string, string> | undefined,
					agentLevelEnvVars
				);
				// An API key, gateway, or cloud provider outranks the config dir's
				// login, so that agent draws nothing from this plan's quota.
				if (resolveAgentBillingCredential(toolType, env)) continue;
				// An agent with no env var runs against the implicit `~/<subdir>`
				// account, so it belongs to that bucket - unless $HOME hasn't
				// resolved yet, in which case there is no key to attribute it to.
				const resolved = resolveAgentAccountKey(toolType, env, homeDir);
				if (!resolved) continue;
				keys.add(resolved);
				counts[resolved] = (counts[resolved] ?? 0) + 1;
				if (s.sessionSshRemoteConfig?.enabled) {
					remoteCounts[resolved] = (remoteCounts[resolved] ?? 0) + 1;
				}
			}
			// Also include any snapshot key not surfaced in session config - e.g. an
			// account sampled in a previous run whose session was since deleted.
			// Keeping the tab lets the user still see the cached data.
			for (const key of Object.keys(snapshots)) keys.add(normalizeKey(key));
			return {
				configuredAccountKeys: Array.from(keys).sort((a, b) =>
					deriveShortName(a).localeCompare(deriveShortName(b))
				),
				agentCountsByAccount: counts,
				remoteAgentCountsByAccount: remoteCounts,
			};
		}, [
			accountKeys,
			discoveredAccountKeys,
			sessions,
			agentLevelEnvVars,
			snapshots,
			homeDir,
			toolType,
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
		remoteAgentCountsByAccount,
		selectedKey,
		setSelectedKey,
		effectiveSelectedKey,
	};
}
