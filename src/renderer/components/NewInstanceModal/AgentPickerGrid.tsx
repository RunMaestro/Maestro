import React from 'react';
import { RefreshCw, ChevronRight, AlertTriangle } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { AgentConfigPanel } from '../shared/AgentConfigPanel';
import { isBetaAgent } from '../../../shared/agentMetadata';
import { buildMaestroUrl } from '../../utils/buildMaestroUrl';
import { SUPPORTED_AGENTS } from './types';
import type { AgentPickerGridProps } from './types';
import { openUrl } from '../../utils/openUrl';

export const AgentPickerGrid = React.memo(function AgentPickerGrid({
	theme,
	loading,
	sshConnectionError,
	sortedAgents,
	selectedAgent,
	expandedAgent,
	refreshingAgent,
	debugInfo,
	customAgentPaths,
	customAgentArgs,
	customAgentEnvVars,
	agentConfigs,
	availableModels,
	loadingModels,
	onAgentSelect,
	onAgentExpand,
	onRefreshAgent,
	onDismissDebug,
	onCustomPathChange,
	onCustomArgsChange,
	onEnvVarKeyChange,
	onEnvVarValueChange,
	onEnvVarRemove,
	onEnvVarAdd,
	onConfigChange,
	onConfigBlur,
	onRefreshModels,
	onTransferPendingSshConfig,
	onLoadModelsForAgent,
	dynamicOptions = {},
	loadingDynamicOptions = {},
	onLoadDynamicOptionsForAgent,
}: AgentPickerGridProps) {
	return (
		<div>
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Agent Provider
			</div>
			{loading ? (
				<div className="text-sm opacity-50">Loading agents...</div>
			) : sshConnectionError ? (
				/* SSH Connection Error State */
				<div
					className="flex flex-col items-center justify-center p-6 rounded-lg border-2 text-center"
					style={{
						backgroundColor: `${theme.colors.error}10`,
						borderColor: theme.colors.error,
					}}
				>
					<AlertTriangle className="w-10 h-10 mb-3" style={{ color: theme.colors.error }} />
					<h4 className="text-base font-semibold mb-2" style={{ color: theme.colors.textMain }}>
						Unable to Connect
					</h4>
					<p className="text-sm mb-3" style={{ color: theme.colors.textDim }}>
						{sshConnectionError}
					</p>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Select a different remote host or switch to Local Execution.
					</p>
				</div>
			) : (
				<div className="space-y-1" role="listbox" aria-label="Agent provider selection">
					{sortedAgents.map((agent) => {
						const isSupported = SUPPORTED_AGENTS.includes(agent.id);
						const isExpanded = expandedAgent === agent.id;
						const isSelected = selectedAgent === agent.id;

						const handleAgentHeaderActivate = () => {
							if (isSupported) {
								const nowExpanded = !isExpanded;
								onAgentExpand(nowExpanded ? agent.id : null);
								onAgentSelect(agent.id);
								onTransferPendingSshConfig(agent.id);
								if (nowExpanded) {
									if (agent.capabilities?.supportsModelSelection) {
										onLoadModelsForAgent(agent.id);
									}
									onLoadDynamicOptionsForAgent?.(agent.id);
								}
							}
						};

						return (
							<div
								key={agent.id}
								className={`rounded border transition-all overflow-hidden ${
									isSelected ? 'ring-2' : ''
								}`}
								style={
									{
										borderColor: theme.colors.border,
										backgroundColor: isSelected ? theme.colors.accentDim : 'transparent',
										'--tw-ring-color': theme.colors.accent,
									} as React.CSSProperties
								}
							>
								{/* Collapsed header row */}
								<div
									onClick={handleAgentHeaderActivate}
									onKeyDown={(e) => {
										if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
											e.preventDefault();
											handleAgentHeaderActivate();
										}
									}}
									className={`w-full text-left px-3 py-2 flex items-center justify-between ${
										!isSupported
											? 'opacity-40 cursor-not-allowed'
											: 'hover:bg-white/5 cursor-pointer'
									}`}
									style={{ color: theme.colors.textMain }}
									role="option"
									aria-selected={isSelected}
									aria-expanded={isExpanded}
									tabIndex={isSupported ? 0 : -1}
								>
									<div className="flex items-center gap-2">
										{isSupported && (
											<ChevronRight
												className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
												style={{ color: theme.colors.textDim }}
											/>
										)}
										<span className="font-medium">{agent.name}</span>
										{isBetaAgent(agent.id) && (
											<span
												className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase"
												style={{
													backgroundColor: theme.colors.warning + '30',
													color: theme.colors.warning,
												}}
											>
												Beta
											</span>
										)}
									</div>
									<div className="flex items-center gap-2">
										{isSupported ? (
											<>
												{agent.available ? (
													<span
														className="text-xs px-2 py-0.5 rounded"
														style={{
															backgroundColor: theme.colors.success + '20',
															color: theme.colors.success,
														}}
													>
														Available
													</span>
												) : (
													<span
														className="text-xs px-2 py-0.5 rounded"
														style={{
															backgroundColor: theme.colors.error + '20',
															color: theme.colors.error,
														}}
													>
														Not Found
													</span>
												)}
												<GhostIconButton
													onClick={(e) => {
														e.stopPropagation();
														onRefreshAgent(agent.id);
													}}
													title="Refresh detection"
													color={theme.colors.textDim}
												>
													<RefreshCw
														className={`w-3 h-3 ${refreshingAgent === agent.id ? 'animate-spin' : ''}`}
													/>
												</GhostIconButton>
											</>
										) : (
											<span
												className="text-xs px-2 py-0.5 rounded"
												style={{
													backgroundColor: theme.colors.warning + '20',
													color: theme.colors.warning,
												}}
											>
												Coming Soon
											</span>
										)}
									</div>
								</div>

								{/* Expanded details for supported agents */}
								{isSupported && isExpanded && (
									<div className="px-3 pb-3 pt-2">
										<AgentConfigPanel
											theme={theme}
											agent={agent}
											customPath={customAgentPaths[agent.id] || ''}
											onCustomPathChange={(value) => {
												onCustomPathChange(agent.id, value);
											}}
											onCustomPathBlur={() => {
												/* Saved on agent create */
											}}
											customArgs={customAgentArgs[agent.id] || ''}
											onCustomArgsChange={(value) => {
												onCustomArgsChange(agent.id, value);
											}}
											onCustomArgsBlur={() => {
												/* Saved on agent create */
											}}
											customEnvVars={customAgentEnvVars[agent.id] || {}}
											onEnvVarKeyChange={(oldKey, newKey, value) => {
												onEnvVarKeyChange(agent.id, oldKey, newKey, value);
											}}
											onEnvVarValueChange={(key, value) => {
												onEnvVarValueChange(agent.id, key, value);
											}}
											onEnvVarRemove={(key) => {
												onEnvVarRemove(agent.id, key);
											}}
											onEnvVarAdd={() => {
												onEnvVarAdd(agent.id);
											}}
											onEnvVarsBlur={() => {
												/* Saved on agent create */
											}}
											agentConfig={agentConfigs[agent.id] || {}}
											onConfigChange={(key, value) => {
												onConfigChange(agent.id, key, value);
											}}
											onConfigBlur={(key, value) => {
												onConfigBlur(agent.id, key, value);
											}}
											availableModels={availableModels[agent.id] || []}
											loadingModels={loadingModels[agent.id] || false}
											onRefreshModels={() => onRefreshModels(agent.id)}
											dynamicOptions={dynamicOptions[agent.id] || {}}
											loadingDynamicOptions={loadingDynamicOptions[agent.id] || false}
											onRefreshAgent={() => onRefreshAgent(agent.id)}
											refreshingAgent={refreshingAgent === agent.id}
											showBuiltInEnvVars
										/>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* Hook behavior note */}
			<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
				Agent hooks run per-message. Use{' '}
				<button
					type="button"
					className="underline hover:opacity-80"
					style={{ color: theme.colors.accent }}
					onClick={() =>
						openUrl(
							buildMaestroUrl('https://docs.runmaestro.ai/autorun-playbooks#environment-variables')
						)
					}
				>
					MAESTRO_SESSION_RESUMED
				</button>{' '}
				to skip on resumed sessions.
			</p>

			{/* Debug Info Display */}
			{debugInfo && (
				<div
					className="mt-3 p-3 rounded border text-xs font-mono overflow-auto max-h-40"
					style={{
						backgroundColor: theme.colors.error + '10',
						borderColor: theme.colors.error + '40',
						color: theme.colors.textMain,
					}}
				>
					<div className="font-bold mb-2" style={{ color: theme.colors.error }}>
						Debug Info: {debugInfo.binaryName} not found
					</div>
					{debugInfo.error && <div className="mb-2 text-red-400">{debugInfo.error}</div>}
					<div className="space-y-1 opacity-70">
						<div>
							<span className="opacity-50">Platform:</span> {debugInfo.platform}
						</div>
						<div>
							<span className="opacity-50">Home:</span> {debugInfo.homeDir}
						</div>
						<div>
							<span className="opacity-50">PATH:</span>
						</div>
						<div className="pl-2 break-all text-[10px]">
							{debugInfo.envPath.split(debugInfo.platform === 'win32' ? ';' : ':').map((p, i) => (
								<div key={`${debugInfo.platform}-${i}-${p}`}>{p}</div>
							))}
						</div>
					</div>
					<button
						type="button"
						onClick={onDismissDebug}
						className="mt-2 text-xs underline"
						style={{ color: theme.colors.textDim }}
					>
						Dismiss
					</button>
				</div>
			)}
		</div>
	);
});
