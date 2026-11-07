/**
 * ProviderEnvironmentSection - the provider's environment variables, parked
 * rows included, and the list of variables Maestro sets itself.
 */

import { AgentEnvVarsSection, type AgentEnvVarsSectionProps } from '../shared/AgentEnvVarsSection';

export interface ProviderEnvironmentSectionProps extends Omit<
	AgentEnvVarsSectionProps,
	'showBuiltInEnvVars' | 'compact'
> {
	/**
	 * New Agent keeps one environment per provider; naming the provider says
	 * which one the rows below belong to.
	 */
	providerName?: string;
}

export function ProviderEnvironmentSection({
	theme,
	providerName,
	...envVars
}: ProviderEnvironmentSectionProps) {
	return (
		<div className="rounded border p-3" style={{ borderColor: theme.colors.border }}>
			<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
				Environment variables
			</h3>
			<div className="mt-3 space-y-3">
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{providerName && <>Editing the {providerName} environment. </>}
					Choose an account or profile with the provider's configuration directory or API key. These
					variables override the global environment from Settings. A parked row is kept but not
					passed to the process.
				</p>
				<AgentEnvVarsSection theme={theme} showBuiltInEnvVars {...envVars} />
			</div>
		</div>
	);
}
