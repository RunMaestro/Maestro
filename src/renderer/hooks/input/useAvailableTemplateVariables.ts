/**
 * The template variables a picker or help panel may LIST right now.
 *
 * A variable that belongs to an Encore Feature (`{{COMPUTER_HISTORY_DIR}}`,
 * `{{MAESTRO_RUN_PATH}}`, every `{{CUE_*}}`) is left out while that feature is
 * switched off, so a disabled feature does not show up in a variable list.
 * Substitution is unaffected.
 */

import { useMemo } from 'react';
import { TEMPLATE_VARIABLES } from '../../utils/templateVariables';
import { availableTemplateVariables } from '../../../shared/templateVariables';
import { useSettingsStore } from '../../stores/settingsStore';

type TemplateVariableDoc = (typeof TEMPLATE_VARIABLES)[number];

export function useAvailableTemplateVariables(
	variables: readonly TemplateVariableDoc[] = TEMPLATE_VARIABLES
): TemplateVariableDoc[] {
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	return useMemo(
		() => availableTemplateVariables(variables, encoreFeatures),
		[variables, encoreFeatures]
	);
}

/** Non-hook form, for code that reads the list at the moment a popup opens. */
export function getAvailableTemplateVariables(): TemplateVariableDoc[] {
	return availableTemplateVariables(TEMPLATE_VARIABLES, useSettingsStore.getState().encoreFeatures);
}
