/**
 * useComposerModelChoices - what the composer's model pill and its phone sheet
 * offer for the active tab's provider.
 *
 * The toolbar knows nothing about agents, so the AI composer resolves the
 * agent-dependent parts of the model choice here and hands the toolbar plain
 * values:
 * - `modelOptions`: the provider's models, with Auto after the leading default
 *   entry when Auto can act on this agent (`useAutoModelChoice`).
 * - `autoModelTitle`: Auto's tooltip (which axes it acts on, who decides).
 * - `runOn`: where the model runs when a model source replaces the named
 *   model, or undefined while Auto is picked (Auto chooses the target).
 *
 * `agent` is the tab's projection of the agent (`projectTabProvider`), so a tab
 * pinned to another provider, or carrying its own model source, is what is shown.
 */

import { useMemo } from 'react';
import type { Session } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useAutoModelChoice } from '../../../hooks/agent/useAutoModelChoice';
import { withAutoModelOption } from '../../../../shared/autoTurn';
import { isAutoModel } from '../../../../shared/autoModel';
import { turnRunOnLabel } from '../../../utils/providerTabSessions';

export interface ComposerModelChoices {
	modelOptions: string[];
	autoModelTitle?: string;
	runOn?: string;
}

export function useComposerModelChoices(
	agent: Session,
	availableModels: string[],
	currentModel: string | undefined
): ComposerModelChoices {
	const autoModel = useAutoModelChoice(agent);
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	const modelOptions = useMemo(
		() => withAutoModelOption(availableModels, autoModel),
		[availableModels, autoModel]
	);
	const runOn = useMemo(
		() => (isAutoModel(currentModel) ? undefined : turnRunOnLabel(agent, endpoints)),
		[currentModel, agent, endpoints]
	);
	return { modelOptions, autoModelTitle: autoModel?.title, runOn };
}
