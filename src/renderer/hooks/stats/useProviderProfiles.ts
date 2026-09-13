/**
 * useProviderProfiles
 *
 * Assigns every agent to the provider profile it actually runs as - the
 * provider plus, where the provider keeps credentials in a config dir, the
 * account that dir belongs to (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
 *
 * The attribution rule lives in `shared/providerProfiles` and is the same one
 * the quota panels' per-account agent-count badges use, so the count on a badge
 * and the number of cards the Agents grid shows for that profile are the same
 * number by construction rather than by coincidence.
 *
 * Environment: the session's own `customEnvVars`, or the agent-level set
 * (Settings -> Agents, fetched once per provider on mount) when the session has
 * none. The spawner replaces rather than layers, so this does too. An API key,
 * gateway, or cloud provider in that env is its own profile, because it outranks
 * the config dir's login. Global env vars are deliberately not consulted, matching
 * `useQuotaAccounts` - a machine-wide `CLAUDE_CONFIG_DIR` would move every
 * agent at once, which is not a per-agent attribution anyone is asking about.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../types';
import {
	effectiveAgentCustomEnvVars,
	getProviderProfileConfig,
	resolveAgentProfile,
	type AgentBillingCredential,
} from '../../../shared/providerProfiles';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';
import { ipcCache } from '../../services/ipcWrapper';

export interface ProviderProfile {
	/** Stable identity, used as the filter dropdown's value. */
	key: string;
	toolType: string;
	/** Config dir this profile represents; null for account-less providers and credential profiles. */
	accountKey: string | null;
	/** The API key, gateway, or cloud provider billed instead of a login, or null. */
	credential: AgentBillingCredential | null;
	/** SSH remote whose disk the account dir lives on, or null for a local account. */
	sshRemoteId: string | null;
	/** `Claude Code - smash`. */
	label: string;
	/** `smash` - the account alone, for a card badge where the provider is implied. */
	shortLabel: string;
	/** How many agents resolve to this profile. */
	count: number;
}

export interface ProviderProfileIndex {
	/** One entry per profile that holds at least one agent, sorted by label. */
	profiles: ProviderProfile[];
	/** Session id -> profile key. Agents whose account cannot be resolved yet are absent. */
	profileKeyBySessionId: Record<string, string>;
	/** Profile key -> label, for labelling a filter that came from another surface. */
	labelByKey: Record<string, string>;
	/**
	 * False while an attribution input is still loading: an agent-level env var
	 * fetch in flight, or $HOME unresolved for an agent that needs it. Until then
	 * a key missing from `profiles` may be late rather than gone.
	 */
	ready: boolean;
}

const EMPTY_INDEX: Omit<ProviderProfileIndex, 'ready'> = {
	profiles: [],
	profileKeyBySessionId: {},
	labelByKey: {},
};

/**
 * Agent-level `customEnvVars` for every provider present in `sessions`.
 *
 * Fetched once per provider. Settings -> Agents edits are rare and the quota
 * panels take the same one-shot approach; a stale value costs a mislabelled
 * badge until the dashboard is reopened, not a wrong number in the database.
 */
function useAgentLevelEnvVars(toolTypes: string[]): {
	envByToolType: Record<string, Record<string, string>>;
	/** Every provider in `toolTypes` has had its fetch resolve or fail. */
	settled: boolean;
} {
	const [envByToolType, setEnvByToolType] = useState<Record<string, Record<string, string>>>({});
	const [settledToolTypes, setSettledToolTypes] = useState<ReadonlySet<string>>(() => new Set());
	const fetchedRef = useRef(new Set<string>());
	// Guards on unmount only. A per-effect cancel flag dropped a fetch still in
	// flight when `key` changed (or StrictMode re-ran the effect), and
	// `fetchedRef` then stopped it from ever being asked for again.
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const key = toolTypes.join(',');

	useEffect(() => {
		const markSettled = (toolType: string) => {
			if (!mountedRef.current) return;
			setSettledToolTypes((prev) => (prev.has(toolType) ? prev : new Set(prev).add(toolType)));
		};
		for (const toolType of key ? key.split(',') : []) {
			if (fetchedRef.current.has(toolType)) continue;
			fetchedRef.current.add(toolType);
			const fetcher = window.maestro?.agents?.getCustomEnvVars;
			if (typeof fetcher !== 'function') {
				markSettled(toolType);
				continue;
			}
			Promise.resolve(fetcher(toolType))
				.then((env) => {
					if (!mountedRef.current || !env) return;
					setEnvByToolType((prev) => ({ ...prev, [toolType]: env }));
				})
				.catch(() => {
					// Best-effort: without agent-level vars the session-level
					// overrides (and the implicit default account) still produce a
					// usable, if coarser, attribution.
				})
				.finally(() => markSettled(toolType));
		}
	}, [key]);

	const settled = toolTypes.every((toolType) => settledToolTypes.has(toolType));
	return { envByToolType, settled };
}

/**
 * SSH remote display names by id, for labelling `account @ host` profiles.
 *
 * Fetched only when some agent runs over SSH, through the same 30s
 * `ssh-configs` cache the remote pickers use. Names never gate `ready`: a
 * remote profile's key is the remote id, so it is complete without the name,
 * and a label that fills in a moment later costs nothing.
 */
function useSshRemoteNames(needed: boolean): Record<string, string> {
	const [names, setNames] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!needed || typeof window.maestro?.sshRemote?.getConfigs !== 'function') return;
		let cancelled = false;
		ipcCache
			.getOrFetch('ssh-configs', () => window.maestro.sshRemote.getConfigs(), 30000)
			.then((result) => {
				if (cancelled || !result?.success || !result.configs) return;
				const byId: Record<string, string> = {};
				for (const config of result.configs) byId[config.id] = config.name;
				setNames(byId);
			})
			.catch(() => {
				// Best-effort: without names a remote profile reads "@ unknown host",
				// and it still keeps its own bucket.
			});
		return () => {
			cancelled = true;
		};
	}, [needed]);
	return names;
}

export function useProviderProfiles(sessions: Session[]): ProviderProfileIndex {
	// Only providers that keep accounts in a config dir need their env vars
	// read; for the rest the profile is the provider itself.
	const accountProviders = useMemo(() => {
		const present = new Set<string>();
		for (const s of sessions) {
			if (s.toolType === 'terminal') continue;
			if (getProviderProfileConfig(s.toolType)) present.add(s.toolType);
		}
		return Array.from(present).sort();
	}, [sessions]);

	const { envByToolType: agentLevelEnvVars, settled: envSettled } =
		useAgentLevelEnvVars(accountProviders);

	const hasRemoteAgents = useMemo(
		() => sessions.some((s) => s?.sessionSshRemoteConfig?.enabled),
		[sessions]
	);
	const remoteNames = useSshRemoteNames(hasRemoteAgents);

	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	return useMemo((): ProviderProfileIndex => {
		const profileKeyBySessionId: Record<string, string> = {};
		const counts = new Map<string, ProviderProfile>();
		let everyAgentAttributed = true;

		for (const session of sessions) {
			if (session.toolType === 'terminal') continue;
			const env = effectiveAgentCustomEnvVars(
				session.customEnvVars as Record<string, string> | undefined,
				agentLevelEnvVars[session.toolType]
			);
			const sshConfig = session.sessionSshRemoteConfig;
			const remoteId = sshConfig?.enabled ? (sshConfig.remoteId ?? 'default') : null;
			const profile = resolveAgentProfile(
				session.toolType,
				env,
				homeDir,
				remoteId ? { id: remoteId, name: remoteNames[remoteId] } : null
			);
			// $HOME has not resolved yet and the agent named no dir: there is no
			// account to file it under, and guessing would put it in a bucket it
			// may not belong to. It reappears on the next render.
			if (!profile) {
				everyAgentAttributed = false;
				continue;
			}

			profileKeyBySessionId[session.id] = profile.key;
			const existing = counts.get(profile.key);
			if (existing) {
				existing.count += 1;
			} else {
				counts.set(profile.key, { ...profile, toolType: session.toolType, count: 1 });
			}
		}

		const ready = envSettled && everyAgentAttributed;
		if (counts.size === 0) return { ...EMPTY_INDEX, ready };

		const profiles = Array.from(counts.values()).sort((a, b) => a.label.localeCompare(b.label));
		const labelByKey: Record<string, string> = {};
		for (const profile of profiles) labelByKey[profile.key] = profile.label;
		return { profiles, profileKeyBySessionId, labelByKey, ready };
	}, [sessions, agentLevelEnvVars, envSettled, remoteNames, homeDir]);
}
