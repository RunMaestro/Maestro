/**
 * ProviderTab - which provider runs the agent and how: the picker and Agent
 * Resilience.
 *
 * The picker is a slot because each modal keeps its own state model: Edit
 * Agent passes its provider `<select>`, the provider-change notice and
 * `<AgentConfigPanel hideEnvVars>`; New Agent passes `<AgentPickerGrid>`,
 * whose settings are keyed by provider id. The moderator has no resilience.
 */

import type { ReactNode } from 'react';
import {
	AgentResilienceSection,
	type AgentResilienceSectionProps,
} from '../NewInstanceModal/AgentResilienceSection';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export interface ProviderTabProps extends AgentSettingsPanelBaseProps {
	picker: ReactNode;
	resilience?: Omit<AgentResilienceSectionProps, 'theme'>;
}

export function ProviderTab({ theme, idPrefix, picker, resilience }: ProviderTabProps) {
	return (
		<AgentSettingsPanel theme={theme} idPrefix={idPrefix} tab="provider">
			{picker}
			{resilience && <AgentResilienceSection theme={theme} {...resilience} />}
		</AgentSettingsPanel>
	);
}
