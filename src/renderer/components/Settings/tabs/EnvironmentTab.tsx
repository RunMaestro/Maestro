/**
 * EnvironmentTab - Global environment variables settings tab
 *
 * Provides a dedicated panel for managing global environment variables
 * that cascade to all agents and terminal sessions. Per-agent env vars
 * (configured in agent settings) override these globals.
 */

import { Globe } from 'lucide-react';
import { useSettings } from '../../../hooks';
import { useKnownAuthDirs } from '../../../hooks/agent/useKnownAuthDirs';
import type { Theme } from '../../../types';
import { EnvVarsEditor } from '../EnvVarsEditor';

export interface EnvironmentTabProps {
	theme: Theme;
}

export function EnvironmentTab({ theme }: EnvironmentTabProps) {
	const { shellEnvVars, setShellEnvVars, shellEnvVarsDisabled, setShellEnvVarsDisabled } =
		useSettings();
	const knownAuthDirs = useKnownAuthDirs();

	return (
		<div className="space-y-5">
			{/* Global Environment Variables */}
			<div data-setting-id="environment-global-vars">
				<div className="flex items-center gap-2 mb-1">
					<Globe className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span className="text-xs font-bold opacity-70 uppercase">
						Global Environment Variables
					</span>
				</div>
				<p className="text-xs opacity-70 mb-2">
					Variables set here apply to all terminal sessions and AI agents. Per-agent environment
					variables (configured in each agent's settings) take precedence when both define the same
					key. Common use cases: API keys, proxy settings, custom tool paths. Use the eye button to
					switch a variable off: it stays in this list with its value intact, but is no longer
					passed to anything Maestro runs.
				</p>
				<EnvVarsEditor
					envVars={shellEnvVars}
					setEnvVars={setShellEnvVars}
					disabledEnvVars={shellEnvVarsDisabled}
					setDisabledEnvVars={setShellEnvVarsDisabled}
					theme={theme}
					label={null}
					description={null}
					knownAuthDirs={knownAuthDirs}
				/>
			</div>
		</div>
	);
}
