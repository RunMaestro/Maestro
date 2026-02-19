/**
 * DirectorNotesSettings - Self-contained settings panel for the Director's Notes Encore Feature.
 *
 * Manages agent detection, provider selection, custom configuration, and lookback period.
 * Mounts only when the feature is enabled (via EncoreFeatureCard), so effects run on mount.
 */

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, Settings, Check } from 'lucide-react';
import type { Theme, AgentConfig, ToolType, DirectorNotesSettings as DirectorNotesSettingsType } from '../../types';
import { AgentConfigPanel } from '../shared/AgentConfigPanel';
import { AGENT_TILES } from '../Wizard/screens/AgentSelectionScreen';

interface DirectorNotesSettingsProps {
	theme: Theme;
	settings: DirectorNotesSettingsType;
	onSettingsChange: (settings: DirectorNotesSettingsType) => void;
}

export function DirectorNotesSettings({
	theme,
	settings,
	onSettingsChange,
}: DirectorNotesSettingsProps) {
	// Agent detection state
	const [detectedAgents, setDetectedAgents] = useState<AgentConfig[]>([]);
	const [isDetecting, setIsDetecting] = useState(false);

	// Custom configuration state
	const [isConfigExpanded, setIsConfigExpanded] = useState(false);
	const [customPath, setCustomPath] = useState(settings.customPath || '');
	const [customArgs, setCustomArgs] = useState(settings.customArgs || '');
	const [customEnvVars, setCustomEnvVars] = useState<Record<string, string>>(
		settings.customEnvVars || {}
	);
	const [agentConfig, setAgentConfig] = useState<Record<string, any>>({});
	const [availableModels, setAvailableModels] = useState<string[]>([]);
	const [loadingModels, setLoadingModels] = useState(false);
	const [refreshingAgent, setRefreshingAgent] = useState(false);
	const agentConfigRef = useRef<Record<string, any>>({});

	// Detect agents on mount
	useEffect(() => {
		let cancelled = false;
		setIsDetecting(true);
		window.maestro.agents
			.detect()
			.then((agents) => {
				if (cancelled) return;
				const available = agents.filter((a: AgentConfig) => a.available && !a.hidden);
				setDetectedAgents(available);
				setIsDetecting(false);
			})
			.catch(() => {
				if (!cancelled) setIsDetecting(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Load agent config when expanding configuration panel
	useEffect(() => {
		if (isConfigExpanded && settings.provider) {
			const agentId = settings.provider;
			window.maestro.agents.getConfig(agentId).then((config) => {
				setAgentConfig(config || {});
				agentConfigRef.current = config || {};
			});
			const agent = detectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setLoadingModels(true);
				window.maestro.agents
					.getModels(agentId)
					.then((models) => {
						setAvailableModels(models);
					})
					.catch(() => {})
					.finally(() => setLoadingModels(false));
			}
		}
	}, [isConfigExpanded, settings.provider, detectedAgents]);

	// Derived values
	const availableTiles = AGENT_TILES.filter((tile) => {
		if (!tile.supported) return false;
		return detectedAgents.some((a: AgentConfig) => a.id === tile.id);
	});
	const selectedAgentConfig = detectedAgents.find((a) => a.id === settings.provider);
	const selectedTile = AGENT_TILES.find((t) => t.id === settings.provider);
	const hasCustomization = customPath || customArgs || Object.keys(customEnvVars).length > 0;

	// Handlers
	const handleAgentChange = (agentId: ToolType) => {
		onSettingsChange({
			...settings,
			provider: agentId,
			customPath: undefined,
			customArgs: undefined,
			customEnvVars: undefined,
		});
		setCustomPath('');
		setCustomArgs('');
		setCustomEnvVars({});
		setAgentConfig({});
		agentConfigRef.current = {};
		if (isConfigExpanded) {
			window.maestro.agents.getConfig(agentId).then((config) => {
				setAgentConfig(config || {});
				agentConfigRef.current = config || {};
			});
			const agent = detectedAgents.find((a) => a.id === agentId);
			if (agent?.capabilities?.supportsModelSelection) {
				setLoadingModels(true);
				window.maestro.agents
					.getModels(agentId)
					.then((models) => {
						setAvailableModels(models);
					})
					.catch(() => {})
					.finally(() => setLoadingModels(false));
			}
		}
	};

	const handleRefreshAgent = async () => {
		setRefreshingAgent(true);
		try {
			const agents = await window.maestro.agents.detect();
			const available = agents.filter((a: AgentConfig) => a.available && !a.hidden);
			setDetectedAgents(available);
		} finally {
			setRefreshingAgent(false);
		}
	};

	const handleRefreshModels = async () => {
		if (!settings.provider) return;
		setLoadingModels(true);
		try {
			const models = await window.maestro.agents.getModels(settings.provider, true);
			setAvailableModels(models);
		} catch (err) {
			console.error('Failed to refresh models:', err);
		} finally {
			setLoadingModels(false);
		}
	};

	const persistCustomConfig = () => {
		onSettingsChange({
			...settings,
			customPath: customPath || undefined,
			customArgs: customArgs || undefined,
			customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
		});
	};

	return (
		<div
			className="px-4 pb-4 space-y-6 border-t"
			style={{ borderColor: theme.colors.border }}
		>
			{/* Provider Selection */}
			<div className="pt-4">
				<label
					className="block text-xs font-bold opacity-70 uppercase mb-2"
					style={{ color: theme.colors.textMain }}
				>
					Synopsis Provider
				</label>

				{isDetecting ? (
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
				) : availableTiles.length === 0 ? (
					<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
						No agents available. Please install Claude Code, OpenCode, Codex, or
						Factory Droid.
					</div>
				) : (
					<div className="flex items-center gap-2">
						<div className="relative flex-1">
							<select
								value={settings.provider}
								onChange={(e) => handleAgentChange(e.target.value as ToolType)}
								className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								aria-label="Select synopsis provider agent"
							>
								{availableTiles.map((tile) => {
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
							onClick={() => setIsConfigExpanded((prev) => !prev)}
							className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-colors hover:bg-white/5"
							style={{
								borderColor: isConfigExpanded
									? theme.colors.accent
									: theme.colors.border,
								color: isConfigExpanded
									? theme.colors.accent
									: theme.colors.textDim,
								backgroundColor: isConfigExpanded
									? `${theme.colors.accent}10`
									: 'transparent',
							}}
							title="Customize provider settings"
						>
							<Settings className="w-4 h-4" />
							<span className="text-sm">Customize</span>
							{hasCustomization && (
								<span
									className="w-2 h-2 rounded-full"
									style={{ backgroundColor: theme.colors.accent }}
								/>
							)}
						</button>
					</div>
				)}

				{isConfigExpanded && selectedAgentConfig && selectedTile && (
					<div
						className="mt-3 p-4 rounded-lg border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						<div className="flex items-center justify-between mb-3">
							<span
								className="text-xs font-medium"
								style={{ color: theme.colors.textDim }}
							>
								{selectedTile.name} Configuration
							</span>
							{hasCustomization && (
								<div className="flex items-center gap-1">
									<Check
										className="w-3 h-3"
										style={{ color: theme.colors.success }}
									/>
									<span
										className="text-xs"
										style={{ color: theme.colors.success }}
									>
										Customized
									</span>
								</div>
							)}
						</div>
						<AgentConfigPanel
							theme={theme}
							agent={selectedAgentConfig}
							customPath={customPath}
							onCustomPathChange={setCustomPath}
							onCustomPathBlur={persistCustomConfig}
							onCustomPathClear={() => {
								setCustomPath('');
								onSettingsChange({
									...settings,
									customPath: undefined,
								});
							}}
							customArgs={customArgs}
							onCustomArgsChange={setCustomArgs}
							onCustomArgsBlur={persistCustomConfig}
							onCustomArgsClear={() => {
								setCustomArgs('');
								onSettingsChange({
									...settings,
									customArgs: undefined,
								});
							}}
							customEnvVars={customEnvVars}
							onEnvVarKeyChange={(oldKey, newKey, value) => {
								const newVars = { ...customEnvVars };
								delete newVars[oldKey];
								newVars[newKey] = value;
								setCustomEnvVars(newVars);
							}}
							onEnvVarValueChange={(key, value) => {
								setCustomEnvVars({ ...customEnvVars, [key]: value });
							}}
							onEnvVarRemove={(key) => {
								const newVars = { ...customEnvVars };
								delete newVars[key];
								setCustomEnvVars(newVars);
							}}
							onEnvVarAdd={() => {
								let newKey = 'NEW_VAR';
								let counter = 1;
								while (customEnvVars[newKey]) {
									newKey = `NEW_VAR_${counter}`;
									counter++;
								}
								setCustomEnvVars({ ...customEnvVars, [newKey]: '' });
							}}
							onEnvVarsBlur={persistCustomConfig}
							agentConfig={agentConfig}
							onConfigChange={(key, value) => {
								const newConfig = { ...agentConfig, [key]: value };
								setAgentConfig(newConfig);
								agentConfigRef.current = newConfig;
							}}
							onConfigBlur={async () => {
								if (settings.provider) {
									await window.maestro.agents.setConfig(
										settings.provider,
										agentConfigRef.current
									);
								}
							}}
							availableModels={availableModels}
							loadingModels={loadingModels}
							onRefreshModels={handleRefreshModels}
							onRefreshAgent={handleRefreshAgent}
							refreshingAgent={refreshingAgent}
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
				<label
					className="block text-xs font-bold mb-2"
					style={{ color: theme.colors.textMain }}
				>
					Default Lookback Period: {settings.defaultLookbackDays} days
				</label>
				<input
					type="range"
					min={1}
					max={90}
					value={settings.defaultLookbackDays}
					onChange={(e) =>
						onSettingsChange({
							...settings,
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
	);
}
