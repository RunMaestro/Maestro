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
 * @param agentId - The agent's tool type, or undefined when no agent is active.
 */
export function useAgentModelEffortOptions(agentId?: string): AgentModelEffortOptions {
	const [models, setModels] = useState<string[]>([]);
	const [efforts, setEfforts] = useState<string[]>([]);
	const [defaultModel, setDefaultModel] = useState('');
	const [defaultEffort, setDefaultEffort] = useState('');
	const [loaded, setLoaded] = useState(false);
	const [refreshingModels, setRefreshingModels] = useState(false);

	// Read after the refresh's await: the surface may have moved to another
	// agent, and that agent's list must not be overwritten with this one.
	const agentIdRef = useRef(agentId);
	agentIdRef.current = agentId;
	const modelsRef = useRef(models);
	modelsRef.current = models;

	useEffect(() => {
		if (!agentId) return;
		let stale = false;
		setLoaded(false);

		const modelsDone = window.maestro.agents
			.getModels(agentId)
			.then((fetched) => {
				if (!stale) setModels(fetched);
			})
			.catch(() => {
				if (!stale) setModels([]);
			});

		const effortsDone = Promise.all([
			window.maestro.agents.getConfigOptions(agentId, 'effort').catch(() => [] as string[]),
			window.maestro.agents
				.getConfigOptions(agentId, 'reasoningEffort')
				.catch(() => [] as string[]),
		])
			.then(([effortOpts, reasoningOpts]) => {
				if (stale) return;
				setEfforts(effortOpts.length > 0 ? effortOpts : reasoningOpts);
			})
			.catch(() => {
				if (!stale) setEfforts([]);
			});

		const defaultsDone = window.maestro.agents
			.getConfig(agentId)
			.then((config) => {
				if (stale) return;
				setDefaultModel(config?.model || '');
				setDefaultEffort(readEffortFromConfig(config) ?? '');
			})
			.catch(() => {
				if (stale) return;
				setDefaultModel('');
				setDefaultEffort('');
			});

		Promise.all([modelsDone, effortsDone, defaultsDone]).then(() => {
			if (!stale) setLoaded(true);
		});

		return () => {
			stale = true;
		};
	}, [agentId]);

	// A forced discovery anywhere (Settings, another picker, the CLI) carries
	// the fresh list. Without this a picker that stays mounted - the composer
	// does not remount per tab - kept the list it fetched on first render.
	useEffect(() => {
		if (!agentId) return;
		return window.maestro.agents.onModelsRefreshed((payload) => {
			// This hook discovers on this machine, so a remote host's list is not ours.
			if (payload.agentId !== agentId || payload.sshRemoteId !== null) return;
			setModels(payload.models);
		});
	}, [agentId]);

	const refreshModels = useCallback(async () => {
		const target = agentId;
		if (!target) return;
		const previous = modelsRef.current;
		setRefreshingModels(true);
		try {
			const next = await window.maestro.agents.getModels(target, true);
			if (agentIdRef.current !== target) return;
			setModels(next);
			notifyCenterFlash({
				message: 'Models refreshed',
				detail: describeModelsRefresh(summarizeModelsRefresh(previous, next)),
				color: 'green',
			});
		} catch (error) {
			if (agentIdRef.current !== target) return;
			notifyCenterFlash({
				message: 'Could not refresh models',
				detail: error instanceof Error ? error.message : String(error),
				color: 'red',
			});
		} finally {
			setRefreshingModels(false);
		}
	}, [agentId]);

	return {
		models,
		efforts,
		defaultModel,
		defaultEffort,
		loaded,
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
