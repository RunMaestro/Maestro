/**
 * EncoreTab - Encore Features settings tab for SettingsModal
 *
 * Contains: Feature flags for optional/experimental Maestro capabilities,
 * Director's Notes configuration (provider selection, agent config, lookback period).
 */

import { useTranslation } from 'react-i18next';
import { Clapperboard, ChevronDown, Settings, Check } from 'lucide-react';
import { useSettings } from '../../../hooks';
import { useAgentConfiguration } from '../../../hooks/agent/useAgentConfiguration';
import type { Theme, AgentConfig, ToolType } from '../../../types';
import { AgentConfigPanel } from '../../shared/AgentConfigPanel';
import { AGENT_TILES } from '../../Wizard/screens/AgentSelectionScreen';
import { isBetaAgent } from '../../../../shared/agentMetadata';
import { ToggleSwitch } from '../../ui/ToggleSwitch';

export interface EncoreTabProps {
	theme: Theme;
	isOpen: boolean;
}

export function EncoreTab({ theme, isOpen }: EncoreTabProps) {
	const { t } = useTranslation('settings');
	const { encoreFeatures, setEncoreFeatures, directorNotesSettings, setDirectorNotesSettings } =
		useSettings();

	// Centralized agent configuration via shared hook
	const ac = useAgentConfiguration({
		enabled: isOpen && encoreFeatures.directorNotes,
		autoSelect: false,
		initialValues: {
			selectedAgent: directorNotesSettings.provider,
			customPath: directorNotesSettings.customPath || '',
			customArgs: directorNotesSettings.customArgs || '',
			customEnvVars: directorNotesSettings.customEnvVars || {},
		},
	});

	const dnAvailableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return ac.detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});
	const dnSelectedAgentConfig = ac.detectedAgents.find(
		(a) => a.id === directorNotesSettings.provider
	);
	const dnSelectedTile = AGENT_TILES.find((t) => t.id === directorNotesSettings.provider);

	const handleDnAgentChange = (agentId: ToolType) => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			provider: agentId,
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
		});
		ac.handleAgentChange(agentId);
	};

	const persistDnCustomConfig = () => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			customPath: ac.customPath || undefined,
			customArgs: ac.customArgs || undefined,
			customEnvVars: Object.keys(ac.customEnvVars).length > 0 ? ac.customEnvVars : undefined,
		});
	};

	return (
		<div className="space-y-6">
			{/* Encore Features Header */}
			<div>
				<h3 className="text-sm font-bold mb-2" style={{ color: theme.colors.textMain }}>
					{t('encore.title')}
				</h3>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{t('encore.description')}
				</p>
			</div>

			{/* Director's Notes Feature Section */}
			<div
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.directorNotes ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.directorNotes
						? `${theme.colors.accent}08`
						: 'transparent',
				}}
			>
				{/* Feature Toggle Header */}
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							directorNotes: !encoreFeatures.directorNotes,
						})
					}
				>
					<div className="flex items-center gap-3">
						<Clapperboard
							className="w-5 h-5"
							style={{
								color: encoreFeatures.directorNotes ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div
								className="text-sm font-bold flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								{t('encore.director_notes.title')}
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.warning + '30',
										color: theme.colors.warning,
									}}
								>
									{t('encore.director_notes.badge_beta')}
								</span>
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								{t('encore.director_notes.description')}
							</div>
						</div>
					</div>
					<ToggleSwitch
						checked={encoreFeatures.directorNotes}
						theme={theme}
						size="md"
						className={encoreFeatures.directorNotes ? '' : 'opacity-50'}
					/>
				</button>

				{/* Director's Notes Settings (shown when enabled) */}
				{encoreFeatures.directorNotes && (
					<div
						className="px-4 pb-4 space-y-6 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						{/* Provider Selection */}
						<div className="pt-4">
							<div
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								{t('encore.director_notes.provider_label')}
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
										{t('encore.director_notes.detecting_agents')}
									</span>
								</div>
							) : dnAvailableTiles.length === 0 ? (
								<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
									{t('encore.director_notes.no_agents')}
								</div>
							) : (
								<div className="flex items-center gap-2">
									<div className="relative flex-1">
										<select
											value={directorNotesSettings.provider}
											onChange={(e) => handleDnAgentChange(e.target.value as ToolType)}
											className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
											style={{
												backgroundColor: theme.colors.bgMain,
												borderColor: theme.colors.border,
												color: theme.colors.textMain,
											}}
											aria-label={t('encore.director_notes.provider_aria_label')}
										>
											{dnAvailableTiles.map((tile) => {
												const isBeta = isBetaAgent(tile.id);
												return (
													<option key={tile.id} value={tile.id}>
														{tile.name}
														{isBeta ? ` ${t('encore.director_notes.beta_suffix')}` : ''}
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
											backgroundColor: ac.isConfigExpanded
												? `${theme.colors.accent}10`
												: 'transparent',
										}}
										title={t('encore.director_notes.customize_title')}
									>
										<Settings className="w-4 h-4" />
										<span className="text-sm">{t('encore.director_notes.customize_button')}</span>
										{ac.hasCustomization && (
											<span
												className="w-2 h-2 rounded-full"
												style={{ backgroundColor: theme.colors.accent }}
											/>
										)}
									</button>
								</div>
							)}

							{ac.isConfigExpanded && dnSelectedAgentConfig && dnSelectedTile && (
								<div
									className="mt-3 p-4 rounded-lg border"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
									}}
								>
									<div className="flex items-center justify-between mb-3">
										<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
											{t('encore.director_notes.configuration_header', {
												name: dnSelectedTile.name,
											})}
										</span>
										{ac.hasCustomization && (
											<div className="flex items-center gap-1">
												<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
												<span className="text-xs" style={{ color: theme.colors.success }}>
													{t('encore.director_notes.customized')}
												</span>
											</div>
										)}
									</div>
									<AgentConfigPanel
										theme={theme}
										agent={dnSelectedAgentConfig}
										customPath={ac.customPath}
										onCustomPathChange={ac.setCustomPath}
										onCustomPathBlur={persistDnCustomConfig}
										onCustomPathClear={() => {
											ac.setCustomPath('');
											setDirectorNotesSettings({
												...directorNotesSettings,
												customPath: undefined,
											});
										}}
										customArgs={ac.customArgs}
										onCustomArgsChange={ac.setCustomArgs}
										onCustomArgsBlur={persistDnCustomConfig}
										onCustomArgsClear={() => {
											ac.setCustomArgs('');
											setDirectorNotesSettings({
												...directorNotesSettings,
												customArgs: undefined,
											});
										}}
										customEnvVars={ac.customEnvVars}
										onEnvVarKeyChange={(oldKey, newKey, value) => {
											const newVars = { ...ac.customEnvVars };
											delete newVars[oldKey];
											newVars[newKey] = value;
											ac.setCustomEnvVars(newVars);
										}}
										onEnvVarValueChange={(key, value) => {
											ac.setCustomEnvVars({ ...ac.customEnvVars, [key]: value });
										}}
										onEnvVarRemove={(key) => {
											const newVars = { ...ac.customEnvVars };
											delete newVars[key];
											ac.setCustomEnvVars(newVars);
										}}
										onEnvVarAdd={() => {
											let newKey = 'NEW_VAR';
											let counter = 1;
											while (ac.customEnvVars[newKey]) {
												newKey = `NEW_VAR_${counter}`;
												counter++;
											}
											ac.setCustomEnvVars({ ...ac.customEnvVars, [newKey]: '' });
										}}
										onEnvVarsBlur={persistDnCustomConfig}
										agentConfig={ac.agentConfig}
										onConfigChange={(key, value) => {
											const newConfig = { ...ac.agentConfig, [key]: value };
											ac.setAgentConfig(newConfig);
											ac.agentConfigRef.current = newConfig;
										}}
										onConfigBlur={async () => {
											if (directorNotesSettings.provider) {
												await ac.saveAgentConfig(directorNotesSettings.provider);
											}
										}}
										availableModels={ac.availableModels}
										loadingModels={ac.loadingModels}
										onRefreshModels={ac.refreshModels}
										onRefreshAgent={ac.refreshAgent}
										refreshingAgent={ac.refreshingAgent}
										compact
										showBuiltInEnvVars
									/>
								</div>
							)}

							<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
								{t('encore.director_notes.provider_help')}
							</p>
						</div>

						{/* Default Lookback Period */}
						<div>
							<div
								className="block text-xs font-bold mb-2"
								style={{ color: theme.colors.textMain }}
							>
								{t('encore.director_notes.lookback_label', {
									days: directorNotesSettings.defaultLookbackDays,
								})}
							</div>
							<input
								type="range"
								min={1}
								max={90}
								value={directorNotesSettings.defaultLookbackDays}
								onChange={(e) =>
									setDirectorNotesSettings({
										...directorNotesSettings,
										defaultLookbackDays: parseInt(e.target.value, 10),
									})
								}
								className="w-full"
							/>
							<div
								className="flex justify-between text-[10px] mt-1"
								style={{ color: theme.colors.textDim }}
							>
								<span>{t('encore.director_notes.lookback_1_day')}</span>
								<span>{t('encore.director_notes.lookback_7')}</span>
								<span>{t('encore.director_notes.lookback_14')}</span>
								<span>{t('encore.director_notes.lookback_30')}</span>
								<span>{t('encore.director_notes.lookback_60')}</span>
								<span>{t('encore.director_notes.lookback_90_days')}</span>
							</div>
							<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
								{t('encore.director_notes.lookback_help')}
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
