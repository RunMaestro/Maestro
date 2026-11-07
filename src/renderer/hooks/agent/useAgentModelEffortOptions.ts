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
 * Effort options are agent-scoped, not model-scoped: agents expose the list
 * under either `effort` (Claude Code) or `reasoningEffort` (Codex, Copilot-CLI,
 * Factory Droid, Grok), so both keys are probed and whichever the agent defines
 * wins. That keeps this correct as agents are added without touching callers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { readEffortFromConfig } from '../../utils/agentEffort';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { describeModelsRefresh, summarizeModelsRefresh } from '../../../shared/agentModelsRefresh';

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
export function useAgentModelEffortOptions(
	agentId?: string,
	sshRemoteId?: string
): AgentModelEffortOptions {
	const [result, setResult] = useState<
		Omit<AgentModelEffortOptions, 'refreshModels' | 'refreshingModels'> & {
			agentId?: string;
			sshRemoteId?: string;
		}
	>({ models: [], efforts: [], defaultModel: '', defaultEffort: '', loaded: false });
	const [refreshingModels, setRefreshingModels] = useState(false);
	const scopeRef = useRef({ agentId, sshRemoteId });
	scopeRef.current = { agentId, sshRemoteId };
	const resultRef = useRef(result);
	resultRef.current = result;
	const refreshSequence = useRef(0);
	const refreshed = useRef<{ agentId: string; sshRemoteId?: string; models: string[] } | null>(
		null
	);

	useEffect(() => {
		if (!agentId) return;
		let stale = false;
		// Only model discovery is host-specific. Config and effort are provider
		// definitions, and their existing APIs deliberately take no host.
		Promise.all([
			window.maestro.agents.getModels(agentId, false, sshRemoteId).catch(() => [] as string[]),
			window.maestro.agents.getConfigOptions(agentId, 'effort').catch(() => [] as string[]),
			window.maestro.agents
				.getConfigOptions(agentId, 'reasoningEffort')
				.catch(() => [] as string[]),
			window.maestro.agents.getConfig(agentId).catch(() => undefined),
		]).then(([models, effortOpts, reasoningOpts, config]) => {
			if (stale) return;
			setResult({
				agentId,
				sshRemoteId,
				models:
					refreshed.current?.agentId === agentId && refreshed.current.sshRemoteId === sshRemoteId
						? refreshed.current.models
						: models,
				efforts: effortOpts.length > 0 ? effortOpts : reasoningOpts,
				defaultModel: config?.model || '',
				defaultEffort: readEffortFromConfig(config) ?? '',
				loaded: true,
			});
		});
		return () => {
			stale = true;
		};
	}, [agentId, sshRemoteId]);

	useEffect(() => {
		if (!agentId) return;
		return window.maestro.agents.onModelsRefreshed((payload) => {
			if (payload.agentId !== agentId || payload.sshRemoteId !== (sshRemoteId ?? null)) return;
			refreshed.current = { agentId, sshRemoteId, models: payload.models };
			setResult((previous) =>
				previous.agentId === agentId && previous.sshRemoteId === sshRemoteId
					? { ...previous, models: payload.models }
					: previous
			);
		});
	}, [agentId, sshRemoteId]);

	const refreshModels = useCallback(async () => {
		if (!agentId) return;
		const sequence = ++refreshSequence.current;
		const isCurrent = () =>
			sequence === refreshSequence.current &&
			scopeRef.current.agentId === agentId &&
			scopeRef.current.sshRemoteId === sshRemoteId;
		const previous =
			resultRef.current.agentId === agentId && resultRef.current.sshRemoteId === sshRemoteId
				? resultRef.current.models
				: [];
		setRefreshingModels(true);
		try {
			const models = await window.maestro.agents.getModels(agentId, true, sshRemoteId);
			if (!isCurrent()) return;
			refreshed.current = { agentId, sshRemoteId, models };
			setResult((current) =>
				current.agentId === agentId && current.sshRemoteId === sshRemoteId
					? { ...current, models }
					: current
			);
			notifyCenterFlash({
				message: 'Models refreshed',
				detail: describeModelsRefresh(summarizeModelsRefresh(previous, models)),
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
	}, [agentId, sshRemoteId]);

	// Hide the previous scope synchronously, including the render before the
	// effect runs. A slow response must never offer another provider's knobs.
	return agentId && result.agentId === agentId && result.sshRemoteId === sshRemoteId
		? { ...result, refreshModels, refreshingModels }
		: {
				models: [],
				efforts: [],
				defaultModel: '',
				defaultEffort: '',
				loaded: false,
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
