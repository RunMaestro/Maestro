import { Check, ChevronDown, Clapperboard, Settings } from 'lucide-react';
import { getAgentDisplayName, isBetaAgent } from '../../../../../../shared/agentMetadata';
import type { DirectorNotesSettings, Theme, ToolType } from '../../../../../types';
import { AgentConfigPanel } from '../../../../shared/AgentConfigPanel';
import type { DirectorNotesAgentState } from '../types';
import { EncoreFeatureCard } from './EncoreFeatureCard';

interface DirectorNotesSectionProps {
	theme: Theme;
	enabled: boolean;
	open: boolean;
	onToggleOpen: () => void;
	onManage: () => void;
	directorNotesSettings: DirectorNotesSettings;
	setDirectorNotesSettings: (settings: DirectorNotesSettings) => void;
	directorNotesAgentState: DirectorNotesAgentState;
}

export function DirectorNotesSection({
	theme,
	enabled,
	open,
	onToggleOpen,
	onManage,
	directorNotesSettings,
	setDirectorNotesSettings,
	directorNotesAgentState,
}: DirectorNotesSectionProps) {
	const ac = directorNotesAgentState.agentConfiguration;

	return (
		<div data-setting-id="encore-director-notes">
			<EncoreFeatureCard
				theme={theme}
				enabled={enabled}
				open={open}
				onToggleOpen={onToggleOpen}
				onManage={onManage}
				icon={Clapperboard}
				title={
					<span className="flex items-center gap-2">
						Director&apos;s Notes
						<span
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{
								backgroundColor: theme.colors.warning + '30',
								color: theme.colors.warning,
							}}
						>
							Beta
						</span>
					</span>
				}
				description="Unified history view and AI-generated synopsis across all sessions"
				contentClassName="space-y-6"
			>
				<div className="pt-4">
					<div
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Synopsis Provider
					</div>

					{ac.isDetecting ? (
						<div className="flex items-center gap-2 py-2">
							<div
								className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
								style={{
									borderColor: theme.colors.accent,
									borderTopColor: 'transparent',
								}}
							/>
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								Detecting agents...
							</span>
						</div>
					) : directorNotesAgentState.availableTiles.length === 0 ? (
						<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
							No agents available. Please install Claude Code, OpenCode, Codex, or Factory Droid.
						</div>
					) : (
						<div className="flex items-center gap-2">
							<div className="relative flex-1">
								<select
									value={directorNotesSettings.provider}
									onChange={(event) =>
										directorNotesAgentState.handleAgentChange(event.target.value as ToolType)
									}
									className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									aria-label="Select synopsis provider agent"
								>
									{directorNotesAgentState.availableTiles.map((tile) => {
										const isBeta = isBetaAgent(tile.id);
										return (
											<option key={tile.id} value={tile.id}>
												{getAgentDisplayName(tile.id)}
												{isBeta ? ' (Beta)' : ''}
											</option>
										);
									})}
								</select>
								<ChevronDown
									className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								/>
							</div>

							<button
								onClick={ac.toggleConfigExpanded}
								className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-colors hover:bg-white/5"
								style={{
									borderColor: ac.isConfigExpanded ? theme.colors.accent : theme.colors.border,
									color: ac.isConfigExpanded ? theme.colors.accent : theme.colors.textDim,
									backgroundColor: ac.isConfigExpanded ? `${theme.colors.accent}10` : 'transparent',
								}}
								title="Customize provider settings"
							>
								<Settings className="w-4 h-4" />
								<span className="text-sm">Customize</span>
								{ac.hasCustomization && (
									<span
										className="w-2 h-2 rounded-full"
										style={{ backgroundColor: theme.colors.accent }}
									/>
								)}
							</button>
						</div>
					)}

					{ac.isConfigExpanded &&
						directorNotesAgentState.selectedAgentConfig &&
						directorNotesAgentState.selectedTile && (
							<div
								className="mt-3 p-4 rounded-lg border"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
								}}
							>
								<div className="flex items-center justify-between mb-3">
									<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
										{getAgentDisplayName(directorNotesAgentState.selectedTile.id)} Configuration
									</span>
									{ac.hasCustomization && (
										<div className="flex items-center gap-1">
											<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
											<span className="text-xs" style={{ color: theme.colors.success }}>
												Customized
											</span>
										</div>
									)}
								</div>
								<AgentConfigPanel
									theme={theme}
									agent={directorNotesAgentState.selectedAgentConfig}
									customPath={ac.customPath}
									onCustomPathChange={ac.setCustomPath}
									onCustomPathBlur={directorNotesAgentState.persistCustomConfig}
									customArgs={ac.customArgs}
									onCustomArgsChange={ac.setCustomArgs}
									onCustomArgsBlur={directorNotesAgentState.persistCustomConfig}
									customEnvVars={ac.customEnvVars}
									onEnvVarKeyChange={directorNotesAgentState.handleEnvVarKeyChange}
									onEnvVarValueChange={directorNotesAgentState.handleEnvVarValueChange}
									onEnvVarRemove={directorNotesAgentState.handleEnvVarRemove}
									onEnvVarAdd={directorNotesAgentState.handleEnvVarAdd}
									onEnvVarsBlur={directorNotesAgentState.persistCustomConfig}
									agentConfig={ac.agentConfig}
									onConfigChange={directorNotesAgentState.handleConfigChange}
									onConfigBlur={directorNotesAgentState.handleConfigBlur}
									availableModels={ac.availableModels}
									loadingModels={ac.loadingModels}
									onRefreshModels={ac.refreshModels}
									dynamicOptions={ac.dynamicOptions}
									loadingDynamicOptions={ac.loadingDynamicOptions}
									onRefreshAgent={ac.refreshAgent}
									refreshingAgent={ac.refreshingAgent}
									compact
									showBuiltInEnvVars
								/>
							</div>
						)}

					<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
						The AI agent used to generate synopsis summaries
					</p>
				</div>

				<div>
					<label
						htmlFor="director-notes-default-lookback-days"
						className="block text-xs font-bold mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Default Lookback Period: {directorNotesSettings.defaultLookbackDays} days
					</label>
					<input
						id="director-notes-default-lookback-days"
						type="range"
						min={1}
						max={90}
						value={directorNotesSettings.defaultLookbackDays}
						onChange={(event) =>
							setDirectorNotesSettings({
								...directorNotesSettings,
								defaultLookbackDays: parseInt(event.target.value, 10),
							})
						}
						className="w-full"
					/>
					<div
						className="flex justify-between text-[10px] mt-1"
						style={{ color: theme.colors.textDim }}
					>
						<span>1 day</span>
						<span>7</span>
						<span>14</span>
						<span>30</span>
						<span>60</span>
						<span>90 days</span>
					</div>
					<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
						How far back to look when generating notes (can be adjusted per-report)
					</p>
				</div>

				{/* Default Reading Mode (Rich widget dashboard vs Plain markdown) */}
				<div data-setting-id="encore-director-notes-default-mode">
					<div className="block text-xs font-bold mb-2" style={{ color: theme.colors.textMain }}>
						Default Reading Mode
					</div>
					<div
						className="flex items-center rounded overflow-hidden w-fit"
						style={{ border: `1px solid ${theme.colors.border}` }}
						role="group"
						aria-label="Default reading mode"
					>
						{(['rich', 'plain'] as const).map((mode) => {
							const active = (directorNotesSettings.defaultMode ?? 'rich') === mode;
							return (
								<button
									key={mode}
									onClick={() =>
										setDirectorNotesSettings({
											...directorNotesSettings,
											defaultMode: mode,
										})
									}
									aria-pressed={active}
									className="px-3 py-1.5 text-xs font-medium capitalize transition-colors"
									style={{
										backgroundColor: active ? theme.colors.accent : 'transparent',
										color: active ? theme.colors.accentForeground : theme.colors.textDim,
									}}
								>
									{mode}
								</button>
							);
						})}
					</div>
					<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
						Which view the AI Overview opens in: Rich shows the widget dashboard, Plain shows the
						markdown notes (can be toggled per-report)
					</p>
				</div>
			</EncoreFeatureCard>
		</div>
	);
}
