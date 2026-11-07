import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { tierPillLabel, type ModelTier } from '../../../shared/modelTiers';

/**
 * Where a tier launches for one agent, as a pill names it
 * (`low · qwen3.5-4b · Maestro`, `high · opus`), or `undefined` for a tier
 * that names no target on this agent.
 *
 * Reads what a launch reads (the agent's tier targets and Run on target, then
 * the harness defaults) through `tierPillLabel`, so the Auto Run panel's model
 * pills and the task's launch cannot disagree. Subscribes to those four agent
 * fields only: the panel must not re-render on every transcript update.
 */
export function useTierPillLabel(sessionId: string): (tier: ModelTier) => string | undefined {
	const agent = useSessionStore(
		useShallow((state) => {
			const session = state.sessions.find((s) => s.id === sessionId);
			return {
				toolType: session?.toolType,
				customModel: session?.customModel,
				tierTargets: session?.tierTargets,
				runOn: session?.runOn,
			};
		})
	);
	const harnessDefaults = useSettingsStore((s) => s.harnessTierDefaults);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	const { toolType, customModel, tierTargets, runOn } = agent;

	return useCallback(
		(tier: ModelTier) =>
			toolType
				? tierPillLabel(
						toolType,
						tier,
						customModel,
						{ tierTargets, runOn, harnessDefaults },
						endpoints
					)
				: undefined,
		[toolType, customModel, tierTargets, runOn, harnessDefaults, endpoints]
	);
}
