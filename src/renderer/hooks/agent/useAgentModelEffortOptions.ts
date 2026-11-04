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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readEffortFromConfig } from '../../utils/agentEffort';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import {
	describeModelsRefresh,
	summarizeModelsRefresh,
	type ModelsRefreshedPayload,
} from '../../../shared/agentModelsRefresh';

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
	const scope = useMemo(
		() => ({ agentId, sshRemoteId: sshRemoteId || undefined }),
		[agentId, sshRemoteId]
	);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const modelVersion = useRef(0);
	const refreshRequest = useRef(0);
	const [refresh, setRefresh] = useState<{ scope: typeof scope; request: number }>();
	const [result, setResult] = useState<{
		scope?: typeof scope;
		models: string[];
		efforts: string[];
		defaultModel: string;
		defaultEffort: string;
		loaded: boolean;
	}>({ models: [], efforts: [], defaultModel: '', defaultEffort: '', loaded: false });
	const resultRef = useRef(result);
	resultRef.current = result;

	useEffect(() => {
		if (!scope.agentId) return;
		let stale = false;
		const version = ++modelVersion.current;
		// Older public hosts have no refresh broadcast. On RC use its existing
		// event contract without adding a second discovery or a host fallback.
		const agents: typeof window.maestro.agents & {
			onModelsRefreshed?: (callback: (payload: ModelsRefreshedPayload) => void) => () => void;
		} = window.maestro.agents;
		const unsubscribe = agents.onModelsRefreshed?.((payload) => {
			if (
				stale ||
				scopeRef.current !== scope ||
				payload.agentId !== scope.agentId ||
				(payload.sshRemoteId || undefined) !== scope.sshRemoteId
			)
				return;
			++modelVersion.current;
			setResult((previous) => ({
				...(previous.scope === scope
					? previous
					: { efforts: [], defaultModel: '', defaultEffort: '', loaded: false }),
				scope,
				models: payload.models,
			}));
		});
		Promise.all([
			agents.getModels(scope.agentId, false, scope.sshRemoteId).catch(() => [] as string[]),
			agents.getConfigOptions(scope.agentId, 'effort').catch(() => [] as string[]),
			agents.getConfigOptions(scope.agentId, 'reasoningEffort').catch(() => [] as string[]),
			agents.getConfig(scope.agentId).catch(() => undefined),
		]).then(([models, effortOpts, reasoningOpts, config]) => {
			if (stale || scopeRef.current !== scope) return;
			setResult((previous) => ({
				scope,
				models:
					modelVersion.current === version
						? models
						: previous.scope === scope
							? previous.models
							: [],
				efforts: effortOpts.length > 0 ? effortOpts : reasoningOpts,
				defaultModel: config?.model || '',
				defaultEffort: readEffortFromConfig(config) ?? '',
				loaded: true,
			}));
		});
		return () => {
			stale = true;
			++modelVersion.current;
			++refreshRequest.current;
			unsubscribe?.();
		};
	}, [scope]);

	const refreshModels = useCallback(async () => {
		if (!scope.agentId || scopeRef.current !== scope) return;
		const version = modelVersion.current;
		const request = ++refreshRequest.current;
		const previous = resultRef.current.scope === scope ? resultRef.current.models : [];
		setRefresh({ scope, request });
		try {
			const next = await window.maestro.agents.getModels(scope.agentId, true, scope.sshRemoteId);
			if (scopeRef.current !== scope || refreshRequest.current !== request) return;
			if (modelVersion.current === version) {
				// Only accepted data supersedes initial discovery; a pending or failed
				// refresh must leave its successful initial fallback available.
				++modelVersion.current;
				setResult((current) => ({
					...(current.scope === scope
						? current
						: { efforts: [], defaultModel: '', defaultEffort: '', loaded: false }),
					scope,
					models: next,
				}));
			}
			notifyCenterFlash({
				message: 'Models refreshed',
				detail: describeModelsRefresh(summarizeModelsRefresh(previous, next)),
				color: 'green',
			});
		} catch (error) {
			if (scopeRef.current !== scope || refreshRequest.current !== request) return;
			notifyCenterFlash({
				message: 'Could not refresh models',
				detail: error instanceof Error ? error.message : String(error),
				color: 'red',
			});
		} finally {
			if (scopeRef.current === scope && refreshRequest.current === request)
				setRefresh((current) =>
					current?.scope === scope && current.request === request ? undefined : current
				);
		}
	}, [scope]);
	const current =
		scope.agentId && result.scope === scope
			? result
			: { models: [], efforts: [], defaultModel: '', defaultEffort: '', loaded: false };
	return {
		models: current.models,
		efforts: current.efforts,
		defaultModel: current.defaultModel,
		defaultEffort: current.defaultEffort,
		loaded: current.loaded,
		refreshModels,
		refreshingModels: refresh?.scope === scope,
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
