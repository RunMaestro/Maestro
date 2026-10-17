/**
 * EnvironmentTab - the agent's own environment variables, parked rows
 * included, and the list of variables Maestro sets itself.
 */

import { AgentEnvVarsSection, type AgentEnvVarsSectionProps } from '../shared/AgentEnvVarsSection';
import { AgentSettingsPanel, type AgentSettingsPanelBaseProps } from './AgentSettingsPanel';

export interface EnvironmentTabProps
	extends
		AgentSettingsPanelBaseProps,
		Omit<AgentEnvVarsSectionProps, 'theme' | 'showBuiltInEnvVars' | 'compact'> {
	/**
	 * New Agent keeps one environment per provider; naming the provider says
	 * which one the rows below belong to.
	 */
	providerName?: string;
}

export function EnvironmentTab({ theme, idPrefix, providerName, ...envVars }: EnvironmentTabProps) {
	return (
		<AgentSettingsPanel
			theme={theme}
			idPrefix={idPrefix}
			tab="environment"
			intro={
				<>
					{providerName && <>Editing the {providerName} environment. </>}
					These variables are added to this agent's process on top of the global environment from
					Settings. A parked row is kept but not passed.
				</>
			}
		>
			<AgentEnvVarsSection theme={theme} showBuiltInEnvVars {...envVars} />
		</AgentSettingsPanel>
	);
}
