/**
 * useAutoModelChoice
 *
 * The Auto model choice (`shared/autoModel.ts`) as a model picker offers it for
 * one agent: whether it is offered at all, and the tooltip that says which
 * axes it acts on and which router decides.
 *
 * Every picker reads it here: the Provider tab of the agent settings, the
 * composer's model pill and its phone sheet, the Model & Effort console and
 * the queued-message editor. The rule itself is `autoModelChoice()` in
 * `shared/autoTurn.ts`; this hook only supplies what the renderer holds (the
 * harness tier defaults, the `model-routing` assignment, the saved sources),
 * so a change to any of them moves every picker at once.
 */

import { useMemo } from 'react';
import { autoModelChoice, type AutoModelChoice } from '../../../shared/autoTurn';
import type { TierTargetAgent } from '../../../shared/modelTiers';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * The Auto choice for an agent, or `null` when Auto must not be offered: no
 * agent, or an agent Auto would change nothing for.
 *
 * `agent` is read field by field, so a caller may pass a fresh object on every
 * render (a form's working copy) without recomputing.
 */
export function useAutoModelChoice(
	agent: Partial<TierTargetAgent> | null | undefined
): AutoModelChoice | null {
	const harnessDefaults = useSettingsStore((s) => s.harnessTierDefaults);
	const assignments = useSettingsStore((s) => s.localModelAssignments);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	const toolType = agent?.toolType;
	const tierTargets = agent?.tierTargets;
	const runOn = agent?.runOn;
	return useMemo(
		() =>
			toolType
				? autoModelChoice(
						{ toolType, tierTargets, runOn },
						{ harnessDefaults, assignments, endpoints }
					)
				: null,
		[toolType, tierTargets, runOn, harnessDefaults, assignments, endpoints]
	);
}
