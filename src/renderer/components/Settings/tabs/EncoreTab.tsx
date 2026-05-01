/**
 * EncoreTab - Encore Features settings tab for SettingsModal
 *
 * Contains: Feature flags for optional/experimental Maestro capabilities,
 * Director's Notes configuration (provider selection, agent config, lookback period),
 * Usage & Stats configuration (stats collection, time ranges, WakaTime integration).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
	Clapperboard,
	ChevronDown,
	Settings,
	Check,
	Database,
	Music,
	Lock,
	Plus,
	X,
	Zap,
	Timer,
	Key,
	Server,
	ScrollText,
	GitBranch,
	FileText,
} from 'lucide-react';
import { useSettings } from '../../../hooks';
import { useAgentConfiguration } from '../../../hooks/agent/useAgentConfiguration';
import { captureException } from '../../../utils/sentry';
import type { Theme, AgentConfig, ToolType } from '../../../types';
import { AgentConfigPanel } from '../../shared/AgentConfigPanel';
import { AGENT_TILES } from '../../Wizard/screens/AgentSelectionScreen';
import { isBetaAgent } from '../../../../shared/agentMetadata';
import { SYMPHONY_REGISTRY_URL } from '../../../../shared/symphony-constants';

export interface EncoreTabProps {
	theme: Theme;
	isOpen: boolean;
}

export function EncoreTab({ theme, isOpen }: EncoreTabProps) {
	const {
		encoreFeatures,
		setEncoreFeatures,
		directorNotesSettings,
		setDirectorNotesSettings,
		symphonyRegistryUrls,
		setSymphonyRegistryUrls,
		setStatsCollectionEnabled,
		defaultStatsTimeRange,
		setDefaultStatsTimeRange,
		// WakaTime
		wakatimeEnabled,
		setWakatimeEnabled,
		wakatimeApiKey,
		setWakatimeApiKey,
		wakatimeDetailedTracking,
		setWakatimeDetailedTracking,
	} = useSettings();

	// WakaTime CLI check and API key validation state
	const [wakatimeCliStatus, setWakatimeCliStatus] = useState<{
		available: boolean;
		version?: string;
	} | null>(null);
	const [wakatimeKeyValid, setWakatimeKeyValid] = useState<boolean | null>(null);
	const [wakatimeKeyValidating, setWakatimeKeyValidating] = useState(false);
	const wakatimeApiKeyRef = useRef(wakatimeApiKey);
	wakatimeApiKeyRef.current = wakatimeApiKey;
	const handleWakatimeApiKeyChange = useCallback(
		(value: string) => {
			setWakatimeApiKey(value);
			setWakatimeKeyValid(null);
			setWakatimeKeyValidating(false);
		},
		[setWakatimeApiKey]
	);

	// Check WakaTime CLI availability when section renders or toggle is enabled
	useEffect(() => {
		if (!isOpen || !wakatimeEnabled) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

		const handleCliError = (err: unknown) => {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'WakaTime CLI check' },
			});
			if (!cancelled) setWakatimeCliStatus({ available: false });
		};

		window.maestro.wakatime
			.checkCli()
			.then((status) => {
				if (cancelled) return;
				setWakatimeCliStatus(status);
				if (!status.available) {
					retryTimer = setTimeout(() => {
						if (!cancelled) {
							window.maestro.wakatime
								.checkCli()
								.then((retryStatus) => {
									if (!cancelled) setWakatimeCliStatus(retryStatus);
								})
								.catch(handleCliError);
						}
					}, 3000);
				}
			})
			.catch((err) => {
				if (cancelled) return;
				handleCliError(err);
				retryTimer = setTimeout(() => {
					if (!cancelled) {
						window.maestro.wakatime
							.checkCli()
							.then((retryStatus) => {
								if (!cancelled) setWakatimeCliStatus(retryStatus);
							})
							.catch(handleCliError);
					}
				}, 3000);
			});

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
			setWakatimeCliStatus(null);
		};
	}, [isOpen, wakatimeEnabled]);

	// Symphony registry URL management
	const [newRegistryUrl, setNewRegistryUrl] = useState('');
	const [registryUrlError, setRegistryUrlError] = useState<string | null>(null);

	const canonicalizeUrl = (raw: string): string => {
		const u = new URL(raw.trim());
		u.hash = '';
		return u.href;
	};

	const handleAddRegistryUrl = () => {
		const trimmed = newRegistryUrl.trim();
		if (!trimmed) {
			setRegistryUrlError('URL cannot be empty');
			return;
		}
		let canonical: string;
		try {
			const parsed = new URL(trimmed);
			if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
				setRegistryUrlError('URL must use HTTP or HTTPS');
				return;
			}
			canonical = canonicalizeUrl(trimmed);
		} catch {
			setRegistryUrlError('Invalid URL format');
			return;
		}
		try {
			if (canonical === canonicalizeUrl(SYMPHONY_REGISTRY_URL)) {
				setRegistryUrlError('This is the default registry URL');
				return;
			}
		} catch {
			/* default URL should always parse */
		}
		const existing = new Set(
			symphonyRegistryUrls.map((u) => {
				try {
					return canonicalizeUrl(u);
				} catch {
					return u.trim();
				}
			})
		);
		if (existing.has(canonical)) {
			setRegistryUrlError('URL already added');
			return;
		}
		setSymphonyRegistryUrls([...symphonyRegistryUrls, canonical]);
		setNewRegistryUrl('');
		setRegistryUrlError(null);
	};

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
					Encore Features
				</h3>
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Optional features that extend Maestro's capabilities. Enable the ones you want. Disabled
					features are completely hidden from shortcuts, menus, and the command palette.
					Contributors building new features should consider gating them here to keep the core
					experience focused.
				</p>
			</div>

			{/* Usage & Stats Feature Section */}
			<div
				data-setting-id="encore-usage-stats"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.usageStats ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.usageStats ? `${theme.colors.accent}08` : 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() => {
						const newValue = !encoreFeatures.usageStats;
						setEncoreFeatures({
							...encoreFeatures,
							usageStats: newValue,
						});
						setStatsCollectionEnabled(newValue);
					}}
				>
					<div className="flex items-center gap-3">
						<Database
							className="w-5 h-5"
							style={{
								color: encoreFeatures.usageStats ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								Usage & Stats
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Track queries, Auto Run sessions, and view the Usage Dashboard
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.usageStats ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.usageStats
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.usageStats ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>

				{encoreFeatures.usageStats && (
					<div
						className="px-4 pb-4 space-y-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center justify-between pt-3">
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								Default lookback window
							</p>
							<div className="relative">
								<select
									value={defaultStatsTimeRange}
									onChange={(e) =>
										setDefaultStatsTimeRange(
											e.target.value as 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'
										)
									}
									className="appearance-none text-sm px-3 py-1.5 pr-8 rounded-lg border cursor-pointer"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									aria-label="Select default lookback window"
								>
									<option value="day">Today</option>
									<option value="week">This Week</option>
									<option value="month">This Month</option>
									<option value="quarter">This Quarter</option>
									<option value="year">This Year</option>
									<option value="all">All Time</option>
								</select>
								<ChevronDown
									className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								/>
							</div>
						</div>

						<div className="border-t" style={{ borderColor: theme.colors.border }} />

						{/* WakaTime Integration */}
						<div className="flex items-center justify-between">
							<div>
								<p
									className="text-sm flex items-center gap-2"
									style={{ color: theme.colors.textMain }}
								>
									<Timer className="w-3.5 h-3.5 opacity-60" />
									Enable WakaTime tracking
								</p>
								<p className="text-xs opacity-50 mt-0.5">
									Track coding activity in Maestro sessions via WakaTime.
								</p>
							</div>
							<button
								onClick={() => setWakatimeEnabled(!wakatimeEnabled)}
								className="relative w-10 h-5 rounded-full transition-colors"
								style={{
									backgroundColor: wakatimeEnabled ? theme.colors.accent : theme.colors.bgActivity,
								}}
								role="switch"
								aria-checked={wakatimeEnabled}
								aria-label="Enable WakaTime tracking"
							>
								<span
									className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
										wakatimeEnabled ? 'translate-x-5' : 'translate-x-0.5'
									}`}
								/>
							</button>
						</div>

						{/* CLI not found warning */}
						{wakatimeEnabled && wakatimeCliStatus && !wakatimeCliStatus.available && (
							<p className="text-xs mt-1" style={{ color: theme.colors.warning }}>
								WakaTime CLI is being installed automatically...
							</p>
						)}

						{/* Detailed file tracking toggle (only shown when enabled) */}
						{wakatimeEnabled && (
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm" style={{ color: theme.colors.textMain }}>
										Detailed file tracking
									</p>
									<p className="text-xs opacity-50 mt-0.5">
										Track per-file write activity. Sends file paths (not content) to WakaTime.
									</p>
								</div>
								<button
									onClick={() => setWakatimeDetailedTracking(!wakatimeDetailedTracking)}
									className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 outline-none"
									tabIndex={0}
									style={{
										backgroundColor: wakatimeDetailedTracking
											? theme.colors.accent
											: theme.colors.bgActivity,
									}}
									role="switch"
									aria-checked={wakatimeDetailedTracking}
									aria-label="Detailed file tracking"
								>
									<span
										className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
											wakatimeDetailedTracking ? 'translate-x-5' : 'translate-x-0.5'
										}`}
									/>
								</button>
							</div>
						)}

						{/* API Key Input (only shown when enabled) */}
						{wakatimeEnabled && (
							<div>
								<label htmlFor="wakatime-api-key" className="block text-xs opacity-60 mb-1">
									API Key
								</label>
								<div
									className="flex items-center border rounded px-3 py-2"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
									}}
								>
									<Key className="w-4 h-4 mr-2 opacity-50" />
									<input
										id="wakatime-api-key"
										type="password"
										value={wakatimeApiKey}
										onChange={(e) => handleWakatimeApiKeyChange(e.target.value)}
										onBlur={() => {
											const keyAtBlur = wakatimeApiKey;
											if (keyAtBlur) {
												setWakatimeKeyValidating(true);
												setWakatimeKeyValid(null);
												window.maestro.wakatime
													.validateApiKey(keyAtBlur)
													.then((result) => {
														if (wakatimeApiKeyRef.current === keyAtBlur) {
															setWakatimeKeyValid(result.valid);
														}
													})
													.catch((err) => {
														captureException(err instanceof Error ? err : new Error(String(err)), {
															extra: {
																context: 'WakaTime API key validation',
															},
														});
														if (wakatimeApiKeyRef.current === keyAtBlur) {
															setWakatimeKeyValid(false);
														}
													})
													.finally(() => {
														if (wakatimeApiKeyRef.current === keyAtBlur) {
															setWakatimeKeyValidating(false);
														}
													});
											}
										}}
										className="bg-transparent flex-1 text-sm outline-none"
										style={{ color: theme.colors.textMain }}
										placeholder="waka_..."
									/>
									{wakatimeKeyValidating && <span className="ml-2 text-xs opacity-50">...</span>}
									{!wakatimeKeyValidating && wakatimeKeyValid === true && (
										<Check className="w-4 h-4 ml-2" style={{ color: theme.colors.success }} />
									)}
									{wakatimeApiKey && (
										<button
											type="button"
											aria-label="Clear WakaTime API key"
											onClick={() => handleWakatimeApiKeyChange('')}
											className="ml-2 opacity-50 hover:opacity-100"
											title="Clear API key"
											style={
												!wakatimeKeyValidating && wakatimeKeyValid === false
													? { color: theme.colors.error, opacity: 1 }
													: undefined
											}
										>
											<X className="w-3 h-3" />
										</button>
									)}
								</div>
								<p className="text-[10px] mt-1.5 opacity-50">
									Get your API key from wakatime.com/settings/api-key. Keys are stored locally in
									~/.maestro/settings.json.
								</p>
							</div>
						)}
					</div>
				)}
			</div>

			{/* Maestro Symphony Feature Section */}
			<div
				data-setting-id="encore-symphony"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.symphony ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.symphony ? `${theme.colors.accent}08` : 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							symphony: !encoreFeatures.symphony,
						})
					}
				>
					<div className="flex items-center gap-3">
						<Music
							className="w-5 h-5"
							style={{
								color: encoreFeatures.symphony ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								Maestro Symphony
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Contribute to open source projects through curated repositories
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.symphony ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.symphony ? theme.colors.accent : theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.symphony ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>

				{encoreFeatures.symphony && (
					<div
						className="px-4 pb-4 space-y-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="pt-3">
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Registry Sources
							</label>
							<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
								Repositories are loaded from all configured registry URLs. The default registry
								cannot be removed.
							</p>

							{/* Default URL (immutable) */}
							<div
								className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono mb-2"
								style={{
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<Lock className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
								<span className="truncate flex-1" style={{ color: theme.colors.textMain }}>
									{SYMPHONY_REGISTRY_URL}
								</span>
								<span
									className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
									style={{
										color: theme.colors.textDim,
										backgroundColor: theme.colors.border,
									}}
								>
									default
								</span>
							</div>

							{/* Custom URLs list */}
							{symphonyRegistryUrls.map((url) => (
								<div
									key={url}
									className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono mb-1"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<span className="truncate flex-1" style={{ color: theme.colors.textMain }}>
										{url}
									</span>
									<button
										type="button"
										onClick={() =>
											setSymphonyRegistryUrls(symphonyRegistryUrls.filter((u) => u !== url))
										}
										className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
										style={{ color: theme.colors.error }}
										title="Remove registry URL"
									>
										<X className="w-3 h-3" />
									</button>
								</div>
							))}

							{/* Add new URL input */}
							<div className="flex items-center gap-2 mt-3">
								<div className="flex-1 relative">
									<input
										type="text"
										value={newRegistryUrl}
										onChange={(e) => {
											setNewRegistryUrl(e.target.value);
											setRegistryUrlError(null);
										}}
										onKeyDown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												handleAddRegistryUrl();
											}
										}}
										placeholder="https://example.com/registry.json"
										className="w-full px-3 py-2 rounded text-sm font-mono outline-none"
										style={{
											backgroundColor: theme.colors.bgActivity,
											borderColor: registryUrlError ? theme.colors.error : theme.colors.border,
											border: '1px solid',
											color: theme.colors.textMain,
										}}
									/>
									{registryUrlError && (
										<p
											className="absolute -bottom-4 left-0 text-[10px]"
											style={{ color: theme.colors.error }}
										>
											{registryUrlError}
										</p>
									)}
								</div>
								<button
									type="button"
									onClick={handleAddRegistryUrl}
									disabled={!newRegistryUrl.trim()}
									className="flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.bgMain,
									}}
								>
									<Plus className="w-4 h-4" /> Add
								</button>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Maestro Cue Feature Section */}
			<div
				data-setting-id="encore-cue"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.maestroCue ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.maestroCue ? `${theme.colors.accent}08` : 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							maestroCue: !encoreFeatures.maestroCue,
						})
					}
				>
					<div className="flex items-center gap-3">
						<Zap
							className="w-5 h-5"
							style={{
								color: encoreFeatures.maestroCue ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div
								className="text-sm font-bold flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								Maestro Cue
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
								Event-driven automation — trigger agent prompts on timers, file changes, and agent
								completions
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.maestroCue ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.maestroCue
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.maestroCue ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>
			</div>

			{/* Director's Notes Feature Section */}
			<div
				data-setting-id="encore-director-notes"
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
												const isBeta = isBetaAgent(tile.id);
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
										onClick={ac.toggleConfigExpanded}
										className="flex items-center gap-1.5 px-3 py-2 rounded-lg border transition-colors hover:bg-white/5"
										style={{
											borderColor: ac.isConfigExpanded ? theme.colors.accent : theme.colors.border,
											color: ac.isConfigExpanded ? theme.colors.accent : theme.colors.textDim,
											backgroundColor: ac.isConfigExpanded
												? `${theme.colors.accent}10`
												: 'transparent',
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
											{dnSelectedTile.name} Configuration
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
										agent={dnSelectedAgentConfig}
										customPath={ac.customPath}
										onCustomPathChange={ac.setCustomPath}
										onCustomPathBlur={persistDnCustomConfig}
										customArgs={ac.customArgs}
										onCustomArgsChange={ac.setCustomArgs}
										onCustomArgsBlur={persistDnCustomConfig}
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

			{/* Agent Dispatch Feature Section */}
			<div
				data-setting-id="encore-agent-dispatch"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.agentDispatch ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.agentDispatch
						? `${theme.colors.accent}08`
						: 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							agentDispatch: !encoreFeatures.agentDispatch,
						})
					}
				>
					<div className="flex items-center gap-3">
						<Server
							className="w-5 h-5"
							style={{
								color: encoreFeatures.agentDispatch ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div
								className="text-sm font-bold flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								Agent Dispatch
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
								Fleet view and Kanban work board for dispatching tasks across agents
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.agentDispatch ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.agentDispatch
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.agentDispatch ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>
			</div>

			{/* Delivery Planner Feature Section */}
			<div
				data-setting-id="encore-delivery-planner"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.deliveryPlanner ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.deliveryPlanner
						? `${theme.colors.accent}08`
						: 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							deliveryPlanner: !encoreFeatures.deliveryPlanner,
						})
					}
				>
					<div className="flex items-center gap-3">
						<ScrollText
							className="w-5 h-5"
							style={{
								color: encoreFeatures.deliveryPlanner ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div
								className="text-sm font-bold flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								Delivery Planner
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
								PRD → Epic → Tasks → GitHub sync with external mirror
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.deliveryPlanner ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.deliveryPlanner
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.deliveryPlanner ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>
			</div>

			{/* Planning Pipeline Feature Section */}
			<div
				data-setting-id="encore-planning-pipeline"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.planningPipeline ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.planningPipeline
						? `${theme.colors.accent}08`
						: 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							planningPipeline: !encoreFeatures.planningPipeline,
						})
					}
				>
					<div className="flex items-center gap-3">
						<GitBranch
							className="w-5 h-5"
							style={{
								color: encoreFeatures.planningPipeline ? theme.colors.accent : theme.colors.textDim,
							}}
						/>
						<div>
							<div
								className="text-sm font-bold flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								Planning Pipeline
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
								Column-per-stage dashboard from idea through fork-merged
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.planningPipeline ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.planningPipeline
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.planningPipeline ? 'translateX(22px)' : 'translateX(2px)',
							}}
						/>
					</div>
				</button>
			</div>

			{/* Conversational PRD Feature Section */}
			<div
				data-setting-id="encore-conversational-prd"
				className="rounded-lg border"
				style={{
					borderColor: encoreFeatures.conversationalPrd ? theme.colors.accent : theme.colors.border,
					backgroundColor: encoreFeatures.conversationalPrd
						? `${theme.colors.accent}08`
						: 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between p-4 text-left"
					onClick={() =>
						setEncoreFeatures({
							...encoreFeatures,
							conversationalPrd: !encoreFeatures.conversationalPrd,
						})
					}
				>
					<div className="flex items-center gap-3">
						<FileText
							className="w-5 h-5"
							style={{
								color: encoreFeatures.conversationalPrd
									? theme.colors.accent
									: theme.colors.textDim,
							}}
						/>
						<div>
							<div
								className="text-sm font-bold flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								Conversational PRD
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
								Plan features via AI-guided conversation, then commit as a PRD item
							</div>
						</div>
					</div>
					<div
						className={`relative w-10 h-5 rounded-full transition-colors ${encoreFeatures.conversationalPrd ? '' : 'opacity-50'}`}
						style={{
							backgroundColor: encoreFeatures.conversationalPrd
								? theme.colors.accent
								: theme.colors.border,
						}}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: encoreFeatures.conversationalPrd
									? 'translateX(22px)'
									: 'translateX(2px)',
							}}
						/>
					</div>
				</button>
			</div>
		</div>
	);
}
