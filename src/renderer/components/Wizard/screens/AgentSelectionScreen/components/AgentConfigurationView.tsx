import { ArrowLeft } from 'lucide-react';
import type { RefObject } from 'react';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../../../../../shared/types';
import type { AgentConfig, Theme } from '../../../../../types';
import { AgentConfigPanel } from '../../../../shared/AgentConfigPanel';
import type { AgentTile } from '../types';
import { AgentLocationSelect } from './AgentLocationSelect';

interface AgentConfigurationViewProps {
	theme: Theme;
	containerRef: RefObject<HTMLDivElement>;
	isTransitioning: boolean;
	isDetecting: boolean;
	configuringAgent: AgentConfig;
	configuringTile: AgentTile;
	detectedConfigAgent: AgentConfig | undefined;
	sshRemotes: SshRemoteConfig[];
	sshRemoteConfig: AgentSshRemoteConfig | undefined;
	onSshRemoteChange: (remoteId: string) => void;
	onCloseConfig: () => void;
	customPath: string;
	onCustomPathChange: (value: string) => void;
	onCustomPathBlur: () => Promise<void>;
	customArgs: string;
	onCustomArgsChange: (value: string) => void;
	onCustomArgsBlur: () => void;
	customEnvVars: Record<string, string>;
	onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
	onEnvVarValueChange: (key: string, value: string) => void;
	onEnvVarRemove: (key: string) => void;
	onEnvVarAdd: () => void;
	onEnvVarsBlur: () => void;
	agentConfig: Record<string, any>;
	onConfigChange: (key: string, value: any) => void;
	onConfigBlur: (key: string, value: any) => Promise<void>;
	availableModels: string[];
	loadingModels: boolean;
	onRefreshModels: () => Promise<void>;
	onRefreshAgent: () => Promise<void>;
	refreshingAgent: boolean;
	// Claude Token Source (claude-code only; AgentConfigPanel gates on agent.id)
	enableMaestroP?: boolean;
	onEnableMaestroPChange: (value: boolean | undefined) => void;
	maestroPMode?: 'interactive' | 'dynamic';
	onMaestroPModeChange: (mode: 'interactive' | 'dynamic') => void;
	maestroPPath: string;
	onMaestroPPathChange: (value: string) => void;
	detectedMaestroPPath?: string;
}

export function AgentConfigurationView({
	theme,
	containerRef,
	isTransitioning,
	isDetecting,
	configuringAgent,
	configuringTile,
	detectedConfigAgent,
	sshRemotes,
	sshRemoteConfig,
	onSshRemoteChange,
	onCloseConfig,
	customPath,
	onCustomPathChange,
	onCustomPathBlur,
	customArgs,
	onCustomArgsChange,
	onCustomArgsBlur,
	customEnvVars,
	onEnvVarKeyChange,
	onEnvVarValueChange,
	onEnvVarRemove,
	onEnvVarAdd,
	onEnvVarsBlur,
	agentConfig,
	onConfigChange,
	onConfigBlur,
	availableModels,
	loadingModels,
	onRefreshModels,
	onRefreshAgent,
	refreshingAgent,
	enableMaestroP,
	onEnableMaestroPChange,
	maestroPMode,
	onMaestroPModeChange,
	maestroPPath,
	onMaestroPPathChange,
	detectedMaestroPPath,
}: AgentConfigurationViewProps): JSX.Element {
	const isSshEnabled = !!(sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId);
	const sshRemoteId = sshRemoteConfig?.remoteId ?? undefined;
	return (
		<div
			ref={containerRef}
			className={`flex flex-col flex-1 min-h-0 px-8 py-6 overflow-y-auto transition-opacity duration-150 ${
				isTransitioning ? 'opacity-0' : 'opacity-100'
			}`}
			tabIndex={-1}
		>
			<div className="flex items-center justify-between mb-6">
				<button
					onClick={onCloseConfig}
					className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
					style={{
						color: theme.colors.textDim,
						['--tw-ring-color' as any]: theme.colors.accent,
						['--tw-ring-offset-color' as any]: theme.colors.bgMain,
					}}
				>
					<ArrowLeft className="w-4 h-4" />
					Back
				</button>
				<div className="flex flex-col items-center gap-2">
					<h3 className="text-xl font-semibold" style={{ color: theme.colors.textMain }}>
						Configure {configuringTile.name}
					</h3>
					<AgentLocationSelect
						theme={theme}
						sshRemotes={sshRemotes}
						sshRemoteConfig={sshRemoteConfig}
						onSshRemoteChange={onSshRemoteChange}
						compact
					/>
				</div>
				<div className="w-20" />
			</div>

			{isDetecting && !detectedConfigAgent && (
				<div
					className="flex items-center gap-2 p-3 mb-4 rounded-lg text-sm"
					style={{ backgroundColor: theme.colors.warning + '20', color: theme.colors.warning }}
				>
					<div
						className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
						style={{ borderColor: theme.colors.warning, borderTopColor: 'transparent' }}
					/>
					Detecting agent on remote host...
				</div>
			)}

			<div className="flex-1 flex justify-center overflow-y-auto">
				<div className="w-full max-w-xl">
					<AgentConfigPanel
						theme={theme}
						agent={configuringAgent}
						customPath={customPath}
						onCustomPathChange={onCustomPathChange}
						onCustomPathBlur={onCustomPathBlur}
						customArgs={customArgs}
						onCustomArgsChange={onCustomArgsChange}
						onCustomArgsBlur={onCustomArgsBlur}
						customEnvVars={customEnvVars}
						onEnvVarKeyChange={onEnvVarKeyChange}
						onEnvVarValueChange={onEnvVarValueChange}
						onEnvVarRemove={onEnvVarRemove}
						onEnvVarAdd={onEnvVarAdd}
						onEnvVarsBlur={onEnvVarsBlur}
						agentConfig={agentConfig}
						onConfigChange={onConfigChange}
						onConfigBlur={onConfigBlur}
						availableModels={availableModels}
						loadingModels={loadingModels}
						onRefreshModels={onRefreshModels}
						onRefreshAgent={onRefreshAgent}
						refreshingAgent={refreshingAgent}
						compact
						showBuiltInEnvVars
						isSshEnabled={isSshEnabled}
						sshRemoteId={sshRemoteId}
						enableMaestroP={enableMaestroP}
						onEnableMaestroPChange={onEnableMaestroPChange}
						maestroPMode={maestroPMode}
						onMaestroPModeChange={onMaestroPModeChange}
						maestroPPath={maestroPPath}
						onMaestroPPathChange={onMaestroPPathChange}
						onMaestroPPathBlur={() => {
							/* Persisted when the wizard creates the session */
						}}
						detectedMaestroPPath={detectedMaestroPPath}
					/>
				</div>
			</div>

			<div className="flex justify-center mt-6">
				<button
					onClick={onCloseConfig}
					className="px-8 py-2.5 rounded-lg font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						['--tw-ring-color' as any]: theme.colors.accent,
						['--tw-ring-offset-color' as any]: theme.colors.bgMain,
					}}
				>
					Done
				</button>
			</div>
		</div>
	);
}
