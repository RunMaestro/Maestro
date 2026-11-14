/**
 * useAgentModelEffortOptions
 *
 * The one place that answers "what models and effort levels can this agent be
 * set to, and what does it fall back to when a tab overrides nothing?".
 *
 * Both the composer's model/effort pills and the keyboard-only Model & Effort
 * modal need the same three answers, and getting them wrong in one surface but
 * not the other would show two different truths for the same tab. The fetch
 * lives here so there is a single request shape, a single stale-guard, and a
 * single fallback story.
 *
 * Effort options use the selected discovery context when supplied: agents expose the list
 * under either `effort` (Claude Code) or `reasoningEffort` (Codex, Copilot-CLI,
 * Factory Droid, Grok), so both keys are probed and whichever the agent defines
 * wins. That keeps this correct as agents are added without touching callers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDiscoveryRequest, AgentDiscoveryResult } from '../../../shared/types';
import { readEffortFromConfig } from '../../utils/agentEffort';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { describeModelsRefresh, summarizeModelsRefresh } from '../../../shared/agentModelsRefresh';
import { useDebouncedValue } from '../utils/useThrottle';

export interface AgentModelEffortOptions {
	/** Model ids the agent offers. Empty when the agent has no model selection. */
	models: string[];
	/** Effort levels the agent offers. Empty when the agent has no effort knob. */
	efforts: string[];
	/** Agent-level default model, used when neither tab nor session overrides it. */
	defaultModel: string;
	/** Agent-level default effort, used when neither tab nor session overrides it. */
	defaultEffort: string;
	/**
	 * False until every lookup for this agent has settled. Empty lists mean
	 * "still loading" and "this agent has neither knob" alike, so any surface
	 * that renders an empty state has to wait for this before claiming there is
	 * nothing to show.
	 */
	loaded: boolean;
	/**
	 * Re-run model discovery past the cache (a model just pulled into Ollama,
	 * say) and report the result in a center flash. Every other open picker
	 * picks the new list up from the main-process broadcast.
	 */
	refreshModels: () => Promise<void>;
	/** True while a refresh started by THIS surface is in flight. */
	refreshingModels: boolean;
	modelStatus: AgentDiscoveryResult['status'];
	effortStatus: AgentDiscoveryResult['status'];
}

/**
 * Fetch available models, effort levels, and agent-level defaults for an agent.
 *
 * Uses a stale flag so switching agents can't let a slow response (e.g. the
 * `opencode models` subprocess) from the previous agent overwrite the current
 * agent's list.
 *
 * @param agentId - The effective tab provider, or undefined when no agent is active.
 * @param sshRemoteId - Model discovery host; config and effort remain provider-scoped.
 */
type DiscoveryContext = AgentDiscoveryRequest['context'];

/** Wrap a legacy string list as a discovery result. */
function asDiscoveryResult(options: string[]): AgentDiscoveryResult {
	return { status: options.length ? 'discovered' : 'unavailable', options };
}

const UNAVAILABLE: AgentDiscoveryResult = { status: 'unavailable', options: [] };

export function useAgentModelEffortOptions(
	agentId?: string,
	sshRemoteId?: string,
	context?: DiscoveryContext
): AgentModelEffortOptions;
export function useAgentModelEffortOptions(
	agentId?: string,
	context?: DiscoveryContext
): AgentModelEffortOptions;
export function useAgentModelEffortOptions(
	agentId?: string,
	hostOrContext?: string | DiscoveryContext,
	contextArg?: DiscoveryContext
): AgentModelEffortOptions {
	// The model discovery host, and (Grok only) the selected discovery context.
	// A Grok context names its own host, so the host argument only steers the
	// legacy provider-ID lookups.
	const sshRemoteId = typeof hostOrContext === 'string' ? hostOrContext : undefined;
	const context = typeof hostOrContext === 'object' ? hostOrContext : contextArg;
	/** Memoized selected context. Grok never discovers from a provider ID alone. */
	const scopedContext = agentId === 'grok' ? context : undefined;
	const debouncedContext = useDebouncedValue(scopedContext, 300);
	// Legacy requests have no context, even while a prior Grok context is debouncing.
	const discoveryContext = agentId === 'grok' ? debouncedContext : undefined;
	const [result, setResult] = useState<
		Omit<AgentModelEffortOptions, 'refreshModels' | 'refreshingModels'> & {
			agentId?: string;
			sshRemoteId?: string;
			context?: DiscoveryContext;
		}
	>({
		models: [],
		efforts: [],
		defaultModel: '',
		defaultEffort: '',
		loaded: false,
		modelStatus: 'unavailable',
		effortStatus: 'unavailable',
	});
	const [refreshingModels, setRefreshingModels] = useState(false);
	// Read after an await: the surface may have moved to another agent, host or
	// Grok account, and that scope's list must not be overwritten with this one.
	const scopeRef = useRef({ agentId, sshRemoteId, context: scopedContext });
	scopeRef.current = { agentId, sshRemoteId, context: scopedContext };
	const resultRef = useRef(result);
	resultRef.current = result;
	const refreshSequence = useRef(0);
	const refreshed = useRef<{ agentId: string; sshRemoteId?: string; models: string[] } | null>(
		null
	);

	useEffect(() => {
		if (!agentId || (agentId === 'grok' && discoveryContext !== scopedContext)) return;
		let stale = false;
		// Only model discovery is host-specific. Config and effort are provider
		// definitions, and their existing APIs deliberately take no host. A Grok
		// list belongs to its selected context and is never asked for by ID alone.
		const isGrok = agentId === 'grok';
		const modelsDone: Promise<AgentDiscoveryResult> = (
			isGrok
				? discoveryContext
					? window.maestro.agents.getModels({ providerId: agentId, context: discoveryContext })
					: Promise.resolve(UNAVAILABLE)
				: window.maestro.agents.getModels(agentId, false, sshRemoteId).then(asDiscoveryResult)
		).catch(() => UNAVAILABLE);
		const effortDone = (key: string): Promise<AgentDiscoveryResult> =>
			(isGrok
				? discoveryContext
					? window.maestro.agents.getConfigOptions(
							{ providerId: agentId, context: discoveryContext },
							key
						)
					: Promise.resolve(UNAVAILABLE)
				: window.maestro.agents.getConfigOptions(agentId, key).then(asDiscoveryResult)
			).catch(() => UNAVAILABLE);
		Promise.all([
			modelsDone,
			effortDone('effort'),
			effortDone('reasoningEffort'),
			window.maestro.agents.getConfig(agentId).catch(() => undefined),
		]).then(([models, effortOpts, reasoningOpts, config]) => {
			if (stale) return;
			const efforts =
				effortOpts.status === 'discovered' && effortOpts.options.length > 0
					? effortOpts
					: reasoningOpts.status === 'discovered' || effortOpts.options.length === 0
						? reasoningOpts
						: effortOpts;
			const refreshedModels =
				!isGrok &&
				refreshed.current?.agentId === agentId &&
				refreshed.current.sshRemoteId === sshRemoteId
					? refreshed.current.models
					: undefined;
			setResult({
				agentId,
				sshRemoteId,
				context: discoveryContext,
				models: refreshedModels ?? models.options,
				modelStatus: refreshedModels ? asDiscoveryResult(refreshedModels).status : models.status,
				efforts: efforts.options,
				effortStatus: efforts.status,
				defaultModel: config?.model || '',
				defaultEffort: readEffortFromConfig(config) ?? '',
				loaded: true,
			});
		});
		return () => {
			stale = true;
		};
	}, [agentId, sshRemoteId, discoveryContext, scopedContext]);

	// A forced discovery anywhere (Settings, another picker, the CLI) carries
	// the fresh list. Without this a picker that stays mounted - the composer
	// does not remount per tab - kept the list it fetched on first render.
	// Grok lists belong to a selected context, so an unscoped broadcast is never
	// a Grok list.
	useEffect(() => {
		if (!agentId || agentId === 'grok') return;
		return window.maestro.agents.onModelsRefreshed((payload) => {
			if (payload.agentId !== agentId || payload.sshRemoteId !== (sshRemoteId ?? null)) return;
			refreshed.current = { agentId, sshRemoteId, models: payload.models };
			setResult((previous) =>
				previous.agentId === agentId && previous.sshRemoteId === sshRemoteId
					? {
							...previous,
							models: payload.models,
							modelStatus: asDiscoveryResult(payload.models).status,
						}
					: previous
			);
		});
	}, [agentId, sshRemoteId]);

	const refreshModels = useCallback(async () => {
		if (!agentId) return;
		const targetContext = scopedContext;
		// Grok never discovers from a provider ID alone.
		if (agentId === 'grok' && !targetContext) return;
		const sequence = ++refreshSequence.current;
		const isCurrent = () =>
			sequence === refreshSequence.current &&
			scopeRef.current.agentId === agentId &&
			scopeRef.current.sshRemoteId === sshRemoteId &&
			scopeRef.current.context === targetContext;
		const previous =
			resultRef.current.agentId === agentId && resultRef.current.sshRemoteId === sshRemoteId
				? resultRef.current.models
				: [];
		setRefreshingModels(true);
		try {
			const next: AgentDiscoveryResult =
				agentId === 'grok' && targetContext
					? await window.maestro.agents.getModels({
							providerId: agentId,
							forceRefresh: true,
							context: targetContext,
						})
					: asDiscoveryResult(await window.maestro.agents.getModels(agentId, true, sshRemoteId));
			if (!isCurrent()) return;
			if (agentId !== 'grok') refreshed.current = { agentId, sshRemoteId, models: next.options };
			setResult((current) =>
				current.agentId === agentId && current.sshRemoteId === sshRemoteId
					? { ...current, models: next.options, modelStatus: next.status }
					: current
			);
			notifyCenterFlash({
				message: 'Models refreshed',
				detail: describeModelsRefresh(summarizeModelsRefresh(previous, next.options)),
				color: 'green',
			});
		} catch (error) {
			if (isCurrent())
				notifyCenterFlash({
					message: 'Could not refresh models',
					detail: error instanceof Error ? error.message : String(error),
					color: 'red',
				});
		} finally {
			if (sequence === refreshSequence.current) setRefreshingModels(false);
		}
	}, [agentId, sshRemoteId, scopedContext]);

	// Hide the previous scope synchronously, including the render before the
	// effect runs. A slow response must never offer another provider's knobs,
	// or another host's or Grok account's list.
	const {
		agentId: resultAgent,
		sshRemoteId: resultHost,
		context: resultContext,
		...options
	} = result;
	return agentId &&
		resultAgent === agentId &&
		resultHost === sshRemoteId &&
		resultContext === scopedContext
		? { ...options, refreshModels, refreshingModels }
		: {
				models: [],
				efforts: [],
				defaultModel: '',
				defaultEffort: '',
				loaded: false,
				modelStatus: 'unavailable',
				effortStatus: 'unavailable',
				refreshModels,
				refreshingModels,
			};
}

/**
 * Resolve the model and effort a tab is actually running with.
 *
 * Precedence is tab override > session override > agent default > empty. Every
 * surface that displays or edits these values has to apply the same ladder, so
 * it lives next to the fetch that supplies the last rung.
 */
export function resolveModelEffort(
	tab: { customModel?: string; customEffort?: string } | null | undefined,
	session: { customModel?: string; customEffort?: string } | null | undefined,
	defaults: { defaultModel: string; defaultEffort: string }
): { model: string; effort: string } {
	return {
		model: tab?.customModel || session?.customModel || defaults.defaultModel,
		effort: tab?.customEffort || session?.customEffort || defaults.defaultEffort,
	};
}
