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
 * Environment layers, lowest first: agent-level `customEnvVars` (Settings ->
 * Agents, fetched once per provider on mount) merged under the session's own
 * overrides. Global env vars are deliberately not consulted, matching
 * `useQuotaAccounts` - a machine-wide `CLAUDE_CONFIG_DIR` would move every
 * agent at once, which is not a per-agent attribution anyone is asking about.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '../../types';
import {
	getProviderProfileConfig,
	providerProfileKey,
	providerProfileLabel,
	providerProfileShortLabel,
	resolveAgentAccountKey,
} from '../../../shared/providerProfiles';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';

export interface ProviderProfile {
	/** Stable identity, used as the filter dropdown's value. */
	key: string;
	toolType: string;
	/** Config dir this profile represents, or null for account-less providers. */
	accountKey: string | null;
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
}

const EMPTY_INDEX: ProviderProfileIndex = {
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
function useAgentLevelEnvVars(toolTypes: string[]): Record<string, Record<string, string>> {
	const [envByToolType, setEnvByToolType] = useState<Record<string, Record<string, string>>>({});
	const fetchedRef = useRef(new Set<string>());
	const key = toolTypes.join(',');

	useEffect(() => {
		let cancelled = false;
		for (const toolType of key ? key.split(',') : []) {
			if (fetchedRef.current.has(toolType)) continue;
			fetchedRef.current.add(toolType);
			const fetcher = window.maestro?.agents?.getCustomEnvVars;
			if (typeof fetcher !== 'function') continue;
			Promise.resolve(fetcher(toolType))
				.then((env) => {
					if (cancelled || !env) return;
					setEnvByToolType((prev) => ({ ...prev, [toolType]: env }));
				})
				.catch(() => {
					// Best-effort: without agent-level vars the session-level
					// overrides (and the implicit default account) still produce a
					// usable, if coarser, attribution.
				});
		}
		return () => {
			cancelled = true;
		};
	}, [key]);

	return envByToolType;
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

	const agentLevelEnvVars = useAgentLevelEnvVars(accountProviders);

	const [homeDir, setHomeDir] = useState<string | undefined>(getHomeDir);
	useEffect(() => {
		if (!homeDir) {
			getHomeDirAsync()?.then(setHomeDir);
		}
	}, [homeDir]);

	return useMemo((): ProviderProfileIndex => {
		const profileKeyBySessionId: Record<string, string> = {};
		const counts = new Map<string, ProviderProfile>();

		for (const session of sessions) {
			if (session.toolType === 'terminal') continue;
			const hasAccounts = Boolean(getProviderProfileConfig(session.toolType));
			let accountKey: string | null = null;
			if (hasAccounts) {
				const merged = {
					...(agentLevelEnvVars[session.toolType] ?? {}),
					...((session.customEnvVars ?? {}) as Record<string, string>),
				};
				accountKey = resolveAgentAccountKey(session.toolType, merged, homeDir);
				// $HOME has not resolved yet and the agent named no dir: there is
				// no account to file it under, and guessing would put it in a
				// bucket it may not belong to. It reappears on the next render.
				if (!accountKey) continue;
			}

			const key = providerProfileKey(session.toolType, accountKey);
			profileKeyBySessionId[session.id] = key;
			const existing = counts.get(key);
			if (existing) {
				existing.count += 1;
			} else {
				counts.set(key, {
					key,
					toolType: session.toolType,
					accountKey,
					label: providerProfileLabel(session.toolType, accountKey),
					shortLabel: providerProfileShortLabel(session.toolType, accountKey),
					count: 1,
				});
			}
		}

		if (counts.size === 0) return EMPTY_INDEX;

		const profiles = Array.from(counts.values()).sort((a, b) => a.label.localeCompare(b.label));
		const labelByKey: Record<string, string> = {};
		for (const profile of profiles) labelByKey[profile.key] = profile.label;
		return { profiles, profileKeyBySessionId, labelByKey };
	}, [sessions, agentLevelEnvVars, homeDir]);
}
