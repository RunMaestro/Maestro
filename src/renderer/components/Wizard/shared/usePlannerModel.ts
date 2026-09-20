import { useCallback, useEffect, useState } from 'react';
import type { ToolType } from '../../../types';
import { resolveTierModel } from '../../../../shared/modelTiers';
import { logger } from '../../../utils/logger';

interface UsePlannerModelParams {
	selectedAgent: ToolType | null;
	plannerModel: string | undefined;
	setPlannerModel: (model: string | undefined) => void;
}

interface PlannerModelState {
	/** The model this run will actually use, or null when it is unknowable. */
	effectiveModel: string | null;
	/** Top tier for this provider, or null where Maestro has no opinion. */
	topTierModel: string | null;
	isOverridden: boolean;
	useTopTier: () => void;
	useAgentDefault: () => void;
}

/**
 * Whether `model` is the same model as `tier` wearing a longer name - the
 * variant suffixes providers append (`opus[1m]`) or a dated pin
 * (`claude-opus-4-5-20251101` for `opus`).
 */
function isSameModelFamily(model: string | null, tier: string): boolean {
	if (!model) return false;
	const normalized = model.trim().toLowerCase();
	const alias = tier.trim().toLowerCase();
	return normalized === alias || normalized.includes(alias);
}

/**
 * What the wizard is about to plan with.
 *
 * Resolution matches the main process (`applyAgentConfigOverrides`): a session
 * model wins, then the agent's configured model, then the provider's own
 * default. Where neither of the first two is set we say nothing rather than
 * guess, because a wrong model name in the UI is worse than an honest "its
 * configured model".
 */
export function usePlannerModel({
	selectedAgent,
	plannerModel,
	setPlannerModel,
}: UsePlannerModelParams): PlannerModelState {
	const [configuredModel, setConfiguredModel] = useState<string | null>(null);

	useEffect(() => {
		if (!selectedAgent) {
			setConfiguredModel(null);
			return;
		}

		// Display-only, so a host without this API (or a failing read) costs the
		// model name and nothing else.
		const getConfig = window.maestro?.agents?.getConfig;
		if (!getConfig) {
			setConfiguredModel(null);
			return;
		}

		let cancelled = false;
		void getConfig(selectedAgent)
			.then((config) => {
				if (cancelled) return;
				const model = config?.model;
				setConfiguredModel(typeof model === 'string' && model.trim() ? model : null);
			})
			.catch((error) => {
				logger.warn('Failed to read the agent model for the wizard:', undefined, error);
				if (!cancelled) setConfiguredModel(null);
			});

		return () => {
			cancelled = true;
		};
	}, [selectedAgent]);

	const effectiveModel = plannerModel ?? configuredModel;
	const topTier = selectedAgent ? (resolveTierModel(selectedAgent, 'high') ?? null) : null;

	// Suppress the offer when the agent is already on that tier under a longer
	// name. Claude's context variants read as `opus[1m]`, and offering to "use
	// opus" there proposes a DOWNGRADE (the 1M context window is the point),
	// which is worse than saying nothing.
	const topTierModel = topTier && isSameModelFamily(effectiveModel, topTier) ? null : topTier;

	const useTopTier = useCallback(() => {
		if (topTierModel) setPlannerModel(topTierModel);
	}, [setPlannerModel, topTierModel]);

	const useAgentDefault = useCallback(() => {
		setPlannerModel(undefined);
	}, [setPlannerModel]);

	return {
		effectiveModel,
		topTierModel,
		isOverridden: !!plannerModel,
		useTopTier,
		useAgentDefault,
	};
}
