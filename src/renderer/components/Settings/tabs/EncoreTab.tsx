/**
 * EncoreTab - Encore Features settings tab for SettingsModal
 *
 * Contains: Feature flags for optional/experimental Maestro capabilities,
 * Director's Notes configuration (provider selection, agent config, lookback period).
 */

import { useState, useEffect, useRef } from 'react';
import { Clapperboard, ChevronDown, Settings, Check } from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme, AgentConfig, ToolType } from '../../../types';
import { AgentConfigPanel } from '../../shared/AgentConfigPanel';
import { AGENT_TILES } from '../../Wizard/screens/AgentSelectionScreen';

export interface EncoreTabProps {
	theme: Theme;
	isOpen: boolean;
}

export function EncoreTab({ theme, isOpen }: EncoreTabProps) {
	const { encoreFeatures, setEncoreFeatures, directorNotesSettings, setDirectorNotesSettings } =
		useSettings();

	// Director's Notes agent configuration state
	const [dnDetectedAgents, setDnDetectedAgents] = useState<AgentConfig[]>([]);
	const [dnIsDetecting, setDnIsDetecting] = useState(false);
	const [dnIsConfigExpanded, setDnIsConfigExpanded] = useState(false);
	const [dnCustomPath, setDnCustomPath] = useState(directorNotesSettings.customPath || '');
	const [dnCustomArgs, setDnCustomArgs] = useState(directorNotesSettings.customArgs || '');
	const [dnCustomEnvVars, setDnCustomEnvVars] = useState<Record<string, string>>(
		directorNotesSettings.customEnvVars || {}
	);
	const [dnAgentConfig, setDnAgentConfig] = useState<Record<string, any>>({});
	const [dnAvailableModels, setDnAvailableModels] = useState<string[]>([]);
	const [dnLoadingModels, setDnLoadingModels] = useState(false);
	const [dnRefreshingAgent, setDnRefreshingAgent] = useState(false);
	const dnAgentConfigRef = useRef<Record<string, any>>({});

	// Detect agents when Encore Features tab is active (needed for Director's Notes config)
	useEffect(() => {
		if (!isOpen || !encoreFeatures.directorNotes) return;
		let cancelled = false;
		setDnIsDetecting(true);
		window.maestro.agents
			.detect()
			.then((agents) => {
				if (cancelled) return;
				const available = agents.filter((a: AgentConfig) => a.available && !a.hidden);
				setDnDetectedAgents(available);
				setDnIsDetecting(false);
			})
			.catch(() => {
				if (!cancelled) setDnIsDetecting(false);
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, encoreFeatures.directorNotes]);

	// Sync local Director's Notes custom config state from settings when tab opens
	useEffect(() => {
		setDnCustomPath(directorNotesSettings.customPath || '');
		setDnCustomArgs(directorNotesSettings.customArgs || '');
		setDnCustomEnvVars(directorNotesSettings.customEnvVars || {});
		setDnIsConfigExpanded(false);
	}, []);

	// Load agent config when expanding Director's Notes configuration panel
	useEffect(() => {
		if (dnIsConfigExpanded && directorNotesSettings.provider) {
			const agentId = directorNotesSettings.provider;
			window.maestro.agents.getConfig(agentId).then((config) => {
				setDnAgentConfig(config || {});
				dnAgentConfigRef.current = config || {};
			});
			// Load models if agent supports it
			const agent = dnDetectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setDnLoadingModels(true);
				window.maestro.agents
					.getModels(agentId)
					.then((models) => {
						setDnAvailableModels(models);
					})
					.catch(() => {})
					.finally(() => setDnLoadingModels(false));
			}
		}
	}, [dnIsConfigExpanded, directorNotesSettings.provider, dnDetectedAgents]);

	const dnAvailableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return dnDetectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});
	const dnSelectedAgentConfig = dnDetectedAgents.find(
		(a) => a.id === directorNotesSettings.provider
	);
	const dnSelectedTile = AGENT_TILES.find((t) => t.id === directorNotesSettings.provider);
	const dnHasCustomization =
		dnCustomPath || dnCustomArgs || Object.keys(dnCustomEnvVars).length > 0;

	const handleDnAgentChange = (agentId: ToolType) => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			provider: agentId,
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
		});
		setDnCustomPath('');
		setDnCustomArgs('');
		setDnCustomEnvVars({});
		setDnAgentConfig({});
		dnAgentConfigRef.current = {};
		if (dnIsConfigExpanded) {
			window.maestro.agents.getConfig(agentId).then((config) => {
				setDnAgentConfig(config || {});
				dnAgentConfigRef.current = config || {};
			});
			const agent = dnDetectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setDnLoadingModels(true);
				window.maestro.agents
					.getModels(agentId)
					.then((models) => {
						setDnAvailableModels(models);
					})
					.catch(() => {})
					.finally(() => setDnLoadingModels(false));
			}
		}
	};

	const handleDnRefreshAgent = async () => {
		setDnRefreshingAgent(true);
		try {
			const agents = await window.maestro.agents.detect();
			const available = agents.filter((a: AgentConfig) => a.available && !a.hidden);
			setDnDetectedAgents(available);
		} finally {
			setDnRefreshingAgent(false);
		}
	};

	const handleDnRefreshModels = async () => {
		if (!directorNotesSettings.provider) return;
		setDnLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(directorNotesSettings.provider, true);
			setDnAvailableModels(models);
		} catch (err) {
			console.error('Failed to refresh models:', err);
		} finally {
			setDnLoadingModels(false);
		}
	};

	const persistDnCustomConfig = () => {
		setDirectorNotesSettings({
			...directorNotesSettings,
			customPath: dnCustomPath || undefined,
			customArgs: dnCustomArgs || undefined,
			customEnvVars: Object.keys(dnCustomEnvVars).length > 0 ? dnCustomEnvVars : undefined,
		});
	};

	return (
		<div className="space-y-6">
			{/* Encore Features Header */}
			<div>
				<h3 className="text-sm font-bold mb-2" style={{ color: theme.colors.textMain }}>
					Encore Features
				</h3>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Optional features that extend Maestro's capabilities. Enable the ones you want. Disabled
					features are completely hidden from shortcuts, menus, and the command palette.
					Contributors building new features should consider gating them here to keep the core
					experience focused.
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
								Director's Notes
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.warning + '30',
										color: theme.colors.warning,
									}}
								>
									Beta
								</span>
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Unified history view and AI-generated synopsis across all sessions
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.directorNotes ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.directorNotes
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.directorNotes ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
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
								Synopsis Provider
							</div>

							{dnIsDetecting ? (
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
							) : dnAvailableTiles.length === 0 ? (
								<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
									No agents available. Please install Claude Code, OpenCode, Codex, or Factory
									Droid.
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
											aria-label="Select synopsis provider agent"
										>
											{dnAvailableTiles.map((tile) => {
												const isBeta =
													tile.id === 'codex' ||
													tile.id === 'opencode' ||
													tile.id === 'factory-droid';
												return (
													<option key={tile.id} value={tile.id}>
														{tile.name}
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
										onClick={() => setDnIsConfigExpanded((prev) => !prev)}
										className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-colors hover:bg-white/5"
										style={{
											borderColor: dnIsConfigExpanded ? theme.colors.accent : theme.colors.border,
											color: dnIsConfigExpanded ? theme.colors.accent : theme.colors.textDim,
											backgroundColor: dnIsConfigExpanded
												? `${theme.colors.accent}10`
												: 'transparent',
										}}
										title="Customize provider settings"
									>
										<Settings className="w-4 h-4" />
										<span className="text-sm">Customize</span>
										{dnHasCustomization && (
											<span
												className="w-2 h-2 rounded-full"
												style={{ backgroundColor: theme.colors.accent }}
											/>
										)}
									</button>
								</div>
							)}

							{dnIsConfigExpanded && dnSelectedAgentConfig && dnSelectedTile && (
								<div
									className="mt-3 p-4 rounded-lg border"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
									}}
								>
									<div className="flex items-center justify-between mb-3">
										<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
											{dnSelectedTile.name} Configuration
										</span>
										{dnHasCustomization && (
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
										agent={dnSelectedAgentConfig}
										customPath={dnCustomPath}
										onCustomPathChange={setDnCustomPath}
										onCustomPathBlur={persistDnCustomConfig}
										onCustomPathClear={() => {
											setDnCustomPath('');
											setDirectorNotesSettings({
												...directorNotesSettings,
												customPath: undefined,
											});
										}}
										customArgs={dnCustomArgs}
										onCustomArgsChange={setDnCustomArgs}
										onCustomArgsBlur={persistDnCustomConfig}
										onCustomArgsClear={() => {
											setDnCustomArgs('');
											setDirectorNotesSettings({
												...directorNotesSettings,
												customArgs: undefined,
											});
										}}
										customEnvVars={dnCustomEnvVars}
										onEnvVarKeyChange={(oldKey, newKey, value) => {
											const newVars = { ...dnCustomEnvVars };
											delete newVars[oldKey];
											newVars[newKey] = value;
											setDnCustomEnvVars(newVars);
										}}
										onEnvVarValueChange={(key, value) => {
											setDnCustomEnvVars({ ...dnCustomEnvVars, [key]: value });
										}}
										onEnvVarRemove={(key) => {
											const newVars = { ...dnCustomEnvVars };
											delete newVars[key];
											setDnCustomEnvVars(newVars);
										}}
										onEnvVarAdd={() => {
											let newKey = 'NEW_VAR';
											let counter = 1;
											while (dnCustomEnvVars[newKey]) {
												newKey = `NEW_VAR_${counter}`;
												counter++;
											}
											setDnCustomEnvVars({ ...dnCustomEnvVars, [newKey]: '' });
										}}
										onEnvVarsBlur={persistDnCustomConfig}
										agentConfig={dnAgentConfig}
										onConfigChange={(key, value) => {
											const newConfig = { ...dnAgentConfig, [key]: value };
											setDnAgentConfig(newConfig);
											dnAgentConfigRef.current = newConfig;
										}}
										onConfigBlur={async () => {
											if (directorNotesSettings.provider) {
												await window.maestro.agents.setConfig(
													directorNotesSettings.provider,
													dnAgentConfigRef.current
												);
											}
										}}
										availableModels={dnAvailableModels}
										loadingModels={dnLoadingModels}
										onRefreshModels={handleDnRefreshModels}
										onRefreshAgent={handleDnRefreshAgent}
										refreshingAgent={dnRefreshingAgent}
										compact
										showBuiltInEnvVars
									/>
								</div>
							)}

							<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
								The AI agent used to generate synopsis summaries
							</p>
						</div>

						{/* Default Lookback Period */}
						<div>
							<div
								className="block text-xs font-bold mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Default Lookback Period: {directorNotesSettings.defaultLookbackDays} days
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
					</div>
				)}
			</div>
		</div>
	);
}
