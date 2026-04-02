/**
 * EnvironmentTab - Global environment variables settings tab
 *
 * Provides a dedicated panel for managing global environment variables
 * that cascade to all agents and terminal sessions. Per-agent env vars
 * (configured in agent settings) override these globals.
 */

import { Globe } from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme } from '../../../types';
import { EnvVarsEditor } from '../EnvVarsEditor';

export interface EnvironmentTabProps {
	theme: Theme;
}

export function EnvironmentTab({ theme }: EnvironmentTabProps) {
	const { shellEnvVars, setShellEnvVars } = useSettings();

	return (
		<div className="space-y-5">
			{/* Global Environment Variables */}
			<div>
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
