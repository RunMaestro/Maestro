/**
 * EnvironmentTab - Provider accounts and global environment variables
 *
 * Both halves of this tab describe the same thing from two directions: the
 * credential an agent presents, and the environment that decides which one it
 * is. Provider Accounts comes first because it is the one a user goes looking
 * for when something is broken, and because the env vars below it are exactly
 * what a non-OAuth account's row tells them to change.
 */

import { Globe } from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme } from '../../../types';
import { EnvVarsEditor } from '../EnvVarsEditor';
import { ProviderAccountsSection } from '../ProviderAccountsSection';

export interface EnvironmentTabProps {
	theme: Theme;
}

export function EnvironmentTab({ theme }: EnvironmentTabProps) {
	const {
		shellEnvVars,
		setShellEnvVars,
		providerAuthProbeOnStartup,
		setProviderAuthProbeOnStartup,
	} = useSettings();

	return (
		<div className="space-y-5">
			<ProviderAccountsSection
				theme={theme}
				probeOnStartup={providerAuthProbeOnStartup}
				onProbeOnStartupChange={setProviderAuthProbeOnStartup}
			/>

			{/* Global Environment Variables */}
			<div data-setting-id="environment-global-vars">
				<div className="flex items-center gap-2 mb-1">
					<Globe className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span className="text-xs font-bold opacity-70 uppercase">
						Global Environment Variables
					</span>
				</div>
				<p className="text-xs opacity-50 mb-2">
					Variables set here apply to all terminal sessions and AI agents. Per-agent environment
					variables (configured in each agent's settings) take precedence when both define the same
					key. Common use cases: API keys, proxy settings, custom tool paths.
				</p>
				<EnvVarsEditor
					envVars={shellEnvVars}
					setEnvVars={setShellEnvVars}
					theme={theme}
					label={null}
					description={null}
				/>
			</div>
		</div>
	);
}
