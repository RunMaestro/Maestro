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

import { useEffect, useState } from 'react';
import { readEffortFromConfig } from '../../utils/agentEffort';

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
		AgentModelEffortOptions & {
			agentId?: string;
			sshRemoteId?: string;
		}
	>({ models: [], efforts: [], defaultModel: '', defaultEffort: '', loaded: false });

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
				models,
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

	// Hide the previous scope synchronously, including the render before the
	// effect runs. A slow response must never offer another provider's knobs.
	return agentId && result.agentId === agentId && result.sshRemoteId === sshRemoteId
		? result
		: { models: [], efforts: [], defaultModel: '', defaultEffort: '', loaded: false };
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
