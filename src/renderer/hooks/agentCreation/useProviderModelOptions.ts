/**
 * useProviderModelOptions
 *
 * Shared hook for per-host agent provider + model + effort discovery.
 *
 * Extracted from SlotCard (#441) so that both the SlotCard dropdowns and the
 * AgentCreationDialog use the same detection path.  Reuses the same IPC
 * surface that the New Agent creation dialog calls (window.maestro.agents.*).
 *
 * Features:
 * - Detects installed agent providers on a given host (local or SSH-remote)
 * - Fetches models for a selected provider + host combination
 * - Fetches effort options for a selected provider
 * - Caches discovery results per (host, provider) for ~60 s to avoid
 *   hammering the IPC bridge on rapid dropdown interactions
 * - Loading + error states for slow / unreachable hosts
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentConfig } from '../../types';
import type { AgentId } from '../../../shared/agentIds';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Cache — keyed by "hostKey:provider"
// ---------------------------------------------------------------------------

const MODEL_CACHE_TTL_MS = 60_000; // 60 s

interface CacheEntry<T> {
	value: T;
	fetchedAt: number;
}

const modelsCache = new Map<string, CacheEntry<string[]>>();
const effortCache = new Map<string, CacheEntry<string[]>>();
const providersCache = new Map<string, CacheEntry<AgentConfig[]>>();

function cacheKey(hostKey: string, provider?: string): string {
	return provider ? `${hostKey}:${provider}` : hostKey;
}

function getCached<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
	const entry = map.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.fetchedAt > MODEL_CACHE_TTL_MS) {
		map.delete(key);
		return undefined;
	}
	return entry.value;
}

function setCached<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
	map.set(key, { value, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The host selection passed to this hook. */
export type ProviderHostInput = { kind: 'local' } | { kind: 'ssh-remote'; remoteId: string };

export interface UseProviderModelOptionsParams {
	/** Whether the hook should actively fetch (e.g., panel is visible). */
	enabled: boolean;
	/** Where the ephemeral agent should run. Defaults to local. */
	host?: ProviderHostInput;
	/** Currently selected agent provider. */
	selectedProvider?: AgentId | null;
	/** Optional filter for which providers to show. */
	providerFilter?: (agent: AgentConfig) => boolean;
}

export interface UseProviderModelOptionsReturn {
	// Provider discovery
	availableProviders: AgentConfig[];
	loadingProviders: boolean;
	providerError: string | null;
	refreshProviders: () => void;

	// Model discovery (for selected provider + host)
	availableModels: string[];
	loadingModels: boolean;
	modelError: string | null;

	// Effort discovery (for selected provider)
	availableEfforts: string[];
	loadingEfforts: boolean;
}

export function useProviderModelOptions({
	enabled,
	host,
	selectedProvider,
	providerFilter,
}: UseProviderModelOptionsParams): UseProviderModelOptionsReturn {
	// Providers
	const [availableProviders, setAvailableProviders] = useState<AgentConfig[]>([]);
	const [loadingProviders, setLoadingProviders] = useState(false);
	const [providerError, setProviderError] = useState<string | null>(null);

	// Models
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [modelError, setModelError] = useState<string | null>(null);

	// Efforts
	const [availableEfforts, setAvailableEfforts] = useState<string[]>([]);
	const [loadingEfforts, setLoadingEfforts] = useState(false);

	// Stale-result guards
	const providerRequestRef = useRef(0);
	const modelRequestRef = useRef(0);
	const effortRequestRef = useRef(0);

	// Derive a stable string key for the host so effects can use it as a dep
	const hostKey = !host || host.kind === 'local' ? 'local' : `ssh:${host.remoteId}`;
	const sshRemoteId = host?.kind === 'ssh-remote' ? host.remoteId : undefined;

	// ------------------------------------------------------------------
	// Provider detection — re-runs when host changes
	// ------------------------------------------------------------------
	const fetchProviders = useCallback(async () => {
		const reqId = ++providerRequestRef.current;
		const key = hostKey;

		const cached = getCached(providersCache, key);
		if (cached) {
			setAvailableProviders(cached);
			return;
		}

		setLoadingProviders(true);
		setProviderError(null);
		try {
			const agents = await window.maestro.agents.detect(sshRemoteId);
			if (providerRequestRef.current !== reqId) return; // stale

			// Default filter: available, not hidden, not terminal
			const filtered = providerFilter
				? agents.filter(providerFilter)
				: agents.filter((a: AgentConfig) => a.available && !a.hidden && a.id !== 'terminal');

			setCached(providersCache, key, filtered);
			setAvailableProviders(filtered);
		} catch (err) {
			if (providerRequestRef.current !== reqId) return;
			const msg = err instanceof Error ? err.message : String(err);
			logger.error('useProviderModelOptions: provider detect failed', undefined, err);
			setProviderError(msg);
			setAvailableProviders([]);
		} finally {
			if (providerRequestRef.current === reqId) {
				setLoadingProviders(false);
			}
		}
	}, [hostKey, sshRemoteId, providerFilter]);

	useEffect(() => {
		if (!enabled) {
			setAvailableProviders([]);
			setProviderError(null);
			setAvailableModels([]);
			setAvailableEfforts([]);
			return;
		}
		void fetchProviders();
	}, [enabled, fetchProviders]);

	// ------------------------------------------------------------------
	// Model discovery — re-runs when host or selectedProvider changes
	// ------------------------------------------------------------------
	useEffect(() => {
		if (!enabled || !selectedProvider) {
			setAvailableModels([]);
			setModelError(null);
			return;
		}

		const reqId = ++modelRequestRef.current;
		const key = cacheKey(hostKey, selectedProvider);

		const cached = getCached(modelsCache, key);
		if (cached) {
			setAvailableModels(cached);
			return;
		}

		let cancelled = false;
		setLoadingModels(true);
		setModelError(null);

		window.maestro.agents
			.getModels(selectedProvider)
			.then((models: string[]) => {
				if (cancelled || modelRequestRef.current !== reqId) return;
				const list = models ?? [];
				setCached(modelsCache, key, list);
				setAvailableModels(list);
			})
			.catch((err: unknown) => {
				if (cancelled || modelRequestRef.current !== reqId) return;
				const msg = err instanceof Error ? err.message : String(err);
				logger.error('useProviderModelOptions: model fetch failed', undefined, err);
				setModelError(msg);
				setAvailableModels([]);
			})
			.finally(() => {
				if (!cancelled && modelRequestRef.current === reqId) {
					setLoadingModels(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [enabled, hostKey, selectedProvider]);

	// ------------------------------------------------------------------
	// Effort discovery — re-runs when selectedProvider changes
	// ------------------------------------------------------------------
	useEffect(() => {
		if (!enabled || !selectedProvider) {
			setAvailableEfforts([]);
			return;
		}

		const reqId = ++effortRequestRef.current;
		const key = cacheKey('effort', selectedProvider);

		const cached = getCached(effortCache, key);
		if (cached) {
			setAvailableEfforts(cached);
			return;
		}

		let cancelled = false;
		setLoadingEfforts(true);

		Promise.all([
			window.maestro.agents.getConfigOptions(selectedProvider, 'effort').catch((): string[] => []),
			window.maestro.agents
				.getConfigOptions(selectedProvider, 'reasoningEffort')
				.catch((): string[] => []),
		])
			.then(([effortOpts, reasoningOpts]: [string[], string[]]) => {
				if (cancelled || effortRequestRef.current !== reqId) return;
				const merged = effortOpts.length > 0 ? effortOpts : reasoningOpts;
				setCached(effortCache, key, merged);
				setAvailableEfforts(merged);
			})
			.catch(() => {
				if (cancelled || effortRequestRef.current !== reqId) return;
				setAvailableEfforts([]);
			})
			.finally(() => {
				if (!cancelled && effortRequestRef.current === reqId) {
					setLoadingEfforts(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [enabled, selectedProvider]);

	// ------------------------------------------------------------------
	// Public refresh (busts provider cache for current host)
	// ------------------------------------------------------------------
	const refreshProviders = useCallback(() => {
		providersCache.delete(hostKey);
		void fetchProviders();
	}, [hostKey, fetchProviders]);

	return {
		availableProviders,
		loadingProviders,
		providerError,
		refreshProviders,

		availableModels,
		loadingModels,
		modelError,

		availableEfforts,
		loadingEfforts,
	};
}
