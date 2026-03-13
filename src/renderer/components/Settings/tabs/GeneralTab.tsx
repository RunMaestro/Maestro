/**
 * GeneralTab - General settings tab for SettingsModal
 *
 * Contains: About Me, Language, Shell, Log Level, GitHub CLI, Input Behavior,
 * History, Thinking Mode, Tab Naming, Auto-scroll, Power, Rendering,
 * Updates, Pre-release, Privacy, Stats & WakaTime, Storage Location.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
	X,
	Key,
	Check,
	Terminal,
	History,
	Download,
	Bug,
	Cloud,
	FolderSync,
	RotateCcw,
	Folder,
	ChevronDown,
	Brain,
	FlaskConical,
	Database,
	Battery,
	Monitor,
	PartyPopper,
	Tag,
	Timer,
	User,
	ArrowDownToLine,
	HelpCircle,
	ExternalLink,
	Keyboard,
	Trash2,
	Globe,
} from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme, ShellInfo } from '../../../types';
import { SUPPORTED_LANGUAGES, LANGUAGE_NATIVE_NAMES } from '../../../../shared/i18n/config';
import { formatMetaKey, formatEnterToSend } from '../../../utils/shortcutFormatter';
import { getOpenInLabel, isLinuxPlatform } from '../../../utils/platformUtils';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { SettingCheckbox } from '../../SettingCheckbox';
import { EnvVarsEditor } from '../EnvVarsEditor';

export interface GeneralTabProps {
	theme: Theme;
	isOpen: boolean;
}

export function GeneralTab({ theme, isOpen }: GeneralTabProps) {
	const {
		// Language
		language,
		setLanguage,
		// Conductor Profile
		conductorProfile,
		setConductorProfile,
		// Shell settings
		defaultShell,
		setDefaultShell,
		customShellPath,
		setCustomShellPath,
		shellArgs,
		setShellArgs,
		shellEnvVars,
		setShellEnvVars,
		ghPath,
		setGhPath,
		// Log level
		logLevel,
		setLogLevel,
		// Input settings
		enterToSendAI,
		setEnterToSendAI,
		enterToSendTerminal,
		setEnterToSendTerminal,
		defaultSaveToHistory,
		setDefaultSaveToHistory,
		defaultShowThinking,
		setDefaultShowThinking,
		autoScrollAiMode,
		setAutoScrollAiMode,
		// Tab naming
		automaticTabNamingEnabled,
		setAutomaticTabNamingEnabled,
		// Power management
		preventSleepEnabled,
		setPreventSleepEnabled,
		// Rendering
		disableGpuAcceleration,
		setDisableGpuAcceleration,
		disableConfetti,
		setDisableConfetti,
		// Updates
		checkForUpdatesOnStartup,
		setCheckForUpdatesOnStartup,
		enableBetaUpdates,
		setEnableBetaUpdates,
		crashReportingEnabled,
		setCrashReportingEnabled,
		// Stats
		statsCollectionEnabled,
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
	const { t } = useTranslation('settings');

	// Shell state
	const [shells, setShells] = useState<ShellInfo[]>([]);
	const [shellsLoading, setShellsLoading] = useState(false);
	const [shellsLoaded, setShellsLoaded] = useState(false);
	const [shellConfigExpanded, setShellConfigExpanded] = useState(false);

	// Sync/storage location state
	const [defaultStoragePath, setDefaultStoragePath] = useState<string>('');
	const [_currentStoragePath, setCurrentStoragePath] = useState<string>('');
	const [customSyncPath, setCustomSyncPath] = useState<string | undefined>(undefined);
	const [syncRestartRequired, setSyncRestartRequired] = useState(false);
	const [syncMigrating, setSyncMigrating] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [syncMigratedCount, setSyncMigratedCount] = useState<number | null>(null);

	// Stats data management state
	const [statsDbSize, setStatsDbSize] = useState<number | null>(null);
	const [statsEarliestDate, setStatsEarliestDate] = useState<string | null>(null);
	const [statsClearing, setStatsClearing] = useState(false);
	const [statsClearResult, setStatsClearResult] = useState<{
		success: boolean;
		deletedQueryEvents: number;
		deletedAutoRunSessions: number;
		deletedAutoRunTasks: number;
		error?: string;
	} | null>(null);

	// WakaTime CLI check and API key validation state
	const [wakatimeCliStatus, setWakatimeCliStatus] = useState<{
		available: boolean;
		version?: string;
	} | null>(null);
	const [wakatimeKeyValid, setWakatimeKeyValid] = useState<boolean | null>(null);
	const [wakatimeKeyValidating, setWakatimeKeyValidating] = useState(false);
	const handleWakatimeApiKeyChange = useCallback(
		(value: string) => {
			setWakatimeApiKey(value);
			setWakatimeKeyValid(null);
		},
		[setWakatimeApiKey]
	);

	// Check WakaTime CLI availability when section renders or toggle is enabled
	useEffect(() => {
		if (!isOpen || !wakatimeEnabled) return;
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
								.catch(() => {
									if (!cancelled) setWakatimeCliStatus({ available: false });
								});
						}
					}, 3000);
				}
			})
			.catch(() => {
				if (cancelled) return;
				setWakatimeCliStatus({ available: false });
				retryTimer = setTimeout(() => {
					if (!cancelled) {
						window.maestro.wakatime
							.checkCli()
							.then((retryStatus) => {
								if (!cancelled) setWakatimeCliStatus(retryStatus);
							})
							.catch(() => {
								if (!cancelled) setWakatimeCliStatus({ available: false });
							});
					}
				}, 3000);
			});

		return () => {
			cancelled = true;
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [isOpen, wakatimeEnabled]);

	// Load sync settings and stats data when modal opens
	useEffect(() => {
		if (!isOpen) return;

		// Load sync settings
		Promise.all([
			window.maestro.sync.getDefaultPath(),
			window.maestro.sync.getSettings(),
			window.maestro.sync.getCurrentStoragePath(),
		])
			.then(([defaultPath, settings, currentPath]) => {
				setDefaultStoragePath(defaultPath);
				setCustomSyncPath(settings.customSyncPath);
				setCurrentStoragePath(currentPath);
				setSyncRestartRequired(false);
				setSyncError(null);
				setSyncMigratedCount(null);
			})
			.catch((err) => {
				console.error('Failed to load sync settings:', err);
				setSyncError(t('general.storage_failed_load'));
			});

		// Load stats database size and earliest timestamp
		window.maestro.stats
			.getDatabaseSize()
			.then((size) => {
				setStatsDbSize(size);
			})
			.catch((err) => {
				console.error('Failed to load stats database size:', err);
			});

		window.maestro.stats
			.getEarliestTimestamp()
			.then((timestamp) => {
				if (timestamp) {
					const date = new Date(timestamp);
					const formatted = date.toISOString().split('T')[0]; // YYYY-MM-DD
					setStatsEarliestDate(formatted);
				} else {
					setStatsEarliestDate(null);
				}
			})
			.catch((err) => {
				console.error('Failed to load earliest stats timestamp:', err);
			});

		// Reset stats clear state
		setStatsClearResult(null);
	}, [isOpen]);

	const loadShells = async () => {
		if (shellsLoaded) return;
		setShellsLoading(true);
		try {
			const detected = await window.maestro.shells.detect();
			setShells(detected);
			if (detected && detected.length > 0) {
				setShellsLoaded(true);
			}
		} catch (error) {
			console.error('Failed to load shells:', error);
		} finally {
			setShellsLoading(false);
		}
	};

	const handleShellInteraction = () => {
		if (!shellsLoaded && !shellsLoading) {
			loadShells();
		}
	};

	return (
		<div className="space-y-5">
			{/* About Me (Conductor Profile) */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
					<User className="w-3 h-3" />
					{t('general.conductor_profile_header')}
				</div>
				<p className="text-xs opacity-50 mb-2">{t('general.conductor_profile_description')}</p>
				<div className="relative">
					<textarea
						value={conductorProfile}
						onChange={(e) => setConductorProfile(e.target.value)}
						placeholder={t('general.conductor_profile_placeholder')}
						className="w-full p-3 rounded border bg-transparent outline-none text-sm resize-none"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							minHeight: '100px',
						}}
						maxLength={1000}
					/>
					<div
						className="absolute bottom-2 right-2 text-xs"
						style={{
							color: conductorProfile.length > 900 ? theme.colors.warning : theme.colors.textDim,
						}}
					>
						{conductorProfile.length}/1000
					</div>
				</div>
			</div>

			{/* Language */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
					<Globe className="w-3 h-3" />
					{t('general.language_label')}
				</div>
				<p className="text-xs opacity-50 mb-2">{t('general.language_description')}</p>
				<select
					value={language}
					onChange={(e) => setLanguage(e.target.value)}
					aria-label={t('general.language_label')}
					className="w-full p-2 rounded border bg-transparent outline-none text-sm"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
				>
					{SUPPORTED_LANGUAGES.map((code) => (
						<option key={code} value={code}>
							{LANGUAGE_NATIVE_NAMES[code]}
						</option>
					))}
				</select>
				<p className="text-xs opacity-40 mt-1">{t('general.language_help')}</p>
			</div>

			{/* Default Shell */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
					<Terminal className="w-3 h-3" />
					{t('general.shell_header')}
				</div>
				<p className="text-xs opacity-50 mb-2">{t('general.shell_description')}</p>
				{shellsLoading ? (
					<div className="text-sm opacity-50 p-2">{t('general.shell_loading')}</div>
				) : (
					<div className="space-y-2">
						{shellsLoaded && shells.length > 0 ? (
							shells.map((shell) => (
								<button
									key={shell.id}
									onClick={() => {
										setDefaultShell(shell.id);
										if (!shell.available) {
											setShellConfigExpanded(true);
										}
									}}
									onMouseEnter={handleShellInteraction}
									onFocus={handleShellInteraction}
									className={`w-full text-left p-3 rounded border transition-all ${
										defaultShell === shell.id ? 'ring-2' : ''
									} hover:bg-opacity-10`}
									style={
										{
											borderColor: theme.colors.border,
											backgroundColor:
												defaultShell === shell.id ? theme.colors.accentDim : theme.colors.bgMain,
											'--tw-ring-color': theme.colors.accent,
											color: theme.colors.textMain,
										} as React.CSSProperties
									}
								>
									<div className="flex items-center justify-between">
										<div>
											<div className="font-medium">{shell.name}</div>
											{shell.path && (
												<div className="text-xs opacity-50 font-mono mt-1">{shell.path}</div>
											)}
										</div>
										{shell.available ? (
											defaultShell === shell.id ? (
												<Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
											) : (
												<span
													className="text-xs px-2 py-0.5 rounded"
													style={{
														backgroundColor: theme.colors.success + '20',
														color: theme.colors.success,
													}}
												>
													{t('general.shell_available')}
												</span>
											)
										) : defaultShell === shell.id ? (
											<div className="flex items-center gap-2">
												<span
													className="text-xs px-2 py-0.5 rounded"
													style={{
														backgroundColor: theme.colors.warning + '20',
														color: theme.colors.warning,
													}}
												>
													{t('general.shell_custom_path_required')}
												</span>
												<Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
											</div>
										) : (
											<span
												className="text-xs px-2 py-0.5 rounded"
												style={{
													backgroundColor: theme.colors.warning + '20',
													color: theme.colors.warning,
												}}
											>
												{t('general.shell_not_found')}
											</span>
										)}
									</div>
								</button>
							))
						) : (
							/* Show current default shell before detection runs */
							<div className="space-y-2">
								<button
									className="w-full text-left p-3 rounded border ring-2"
									style={
										{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.accentDim,
											'--tw-ring-color': theme.colors.accent,
											color: theme.colors.textMain,
										} as React.CSSProperties
									}
								>
									<div className="flex items-center justify-between">
										<div>
											<div className="font-medium">
												{defaultShell.charAt(0).toUpperCase() + defaultShell.slice(1)}
											</div>
											<div className="text-xs opacity-50 font-mono mt-1">
												{t('general.shell_current_default')}
											</div>
										</div>
										<Check className="w-4 h-4" style={{ color: theme.colors.accent }} />
									</div>
								</button>
								<button
									onClick={handleShellInteraction}
									className="w-full text-left p-3 rounded border hover:bg-white/5 transition-colors"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgMain,
										color: theme.colors.textDim,
									}}
								>
									<div className="flex items-center gap-2">
										<Terminal className="w-4 h-4" />
										<span>{t('general.shell_detect_others')}</span>
									</div>
								</button>
							</div>
						)}
					</div>
				)}

				{/* Shell Configuration Expandable Section */}
				<button
					onClick={() => setShellConfigExpanded(!shellConfigExpanded)}
					className="w-full flex items-center justify-between p-3 rounded border mt-3 hover:bg-white/5 transition-colors"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{t('general.shell_configuration')}
					</span>
					<ChevronDown
						className={`w-4 h-4 transition-transform ${shellConfigExpanded ? 'rotate-180' : ''}`}
						style={{ color: theme.colors.textDim }}
					/>
				</button>

				{shellConfigExpanded && (
					<div
						className="mt-2 space-y-3 p-3 rounded border"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						{/* Custom Shell Path */}
						<div>
							<div className="block text-xs opacity-60 mb-1">
								{t('general.shell_custom_path_label')}
							</div>
							<div className="flex gap-2">
								<input
									type="text"
									value={customShellPath}
									onChange={(e) => setCustomShellPath(e.target.value)}
									placeholder={t('general.shell_custom_path_placeholder')}
									className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								/>
								{customShellPath && (
									<button
										onClick={() => setCustomShellPath('')}
										className="px-2 py-1.5 rounded text-xs"
										style={{
											backgroundColor: theme.colors.bgMain,
											color: theme.colors.textDim,
										}}
									>
										{t('general.clear_button')}
									</button>
								)}
							</div>
							<p className="text-xs opacity-50 mt-1">{t('general.shell_custom_path_help')}</p>
						</div>

						{/* Shell Arguments */}
						<div>
							<div className="block text-xs opacity-60 mb-1">{t('general.shell_args_label')}</div>
							<div className="flex gap-2">
								<input
									type="text"
									value={shellArgs}
									onChange={(e) => setShellArgs(e.target.value)}
									placeholder={t('general.shell_args_placeholder')}
									className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								/>
								{shellArgs && (
									<button
										onClick={() => setShellArgs('')}
										className="px-2 py-1.5 rounded text-xs"
										style={{
											backgroundColor: theme.colors.bgMain,
											color: theme.colors.textDim,
										}}
									>
										{t('general.clear_button')}
									</button>
								)}
							</div>
							<p className="text-xs opacity-50 mt-1">{t('general.shell_args_help')}</p>
						</div>

						{/* Global Environment Variables */}
						<div className="flex items-start gap-2 mb-2">
							<div className="flex-1">
								<p className="text-xs opacity-50">
									<strong>{t('general.env_vars_header')}</strong>{' '}
									{t('general.env_vars_description')}
								</p>
							</div>
							<div
								className="group relative flex-shrink-0 mt-0.5 outline-none"
								tabIndex={0}
								aria-describedby="env-vars-help-tooltip"
								title={t('general.env_vars_tooltip_full')}
							>
								<HelpCircle
									className="w-4 h-4 cursor-help"
									style={{ color: theme.colors.textDim }}
								/>
								<div
									id="env-vars-help-tooltip"
									role="tooltip"
									className="absolute hidden group-hover:block group-focus-visible:block bg-black/80 text-white text-xs rounded p-2 z-50 w-60 -right-2 top-5 whitespace-normal"
								>
									<p className="mb-1 font-semibold">{t('general.env_vars_tooltip_header')}</p>
									<ul className="list-disc list-inside space-y-0.5">
										<li>{t('general.env_vars_tooltip_terminals')}</li>
										<li>{t('general.env_vars_tooltip_agents')}</li>
										<li>{t('general.env_vars_tooltip_children')}</li>
									</ul>
									<p className="mt-1">{t('general.env_vars_tooltip_override')}</p>
								</div>
							</div>
						</div>
						<EnvVarsEditor envVars={shellEnvVars} setEnvVars={setShellEnvVars} theme={theme} />
					</div>
				)}
			</div>

			{/* System Log Level */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2">
					{t('general.log_level_header')}
				</div>
				<ToggleButtonGroup
					options={[
						{ value: 'debug', label: t('general.log_level_debug'), activeColor: '#6366f1' },
						{ value: 'info', label: t('general.log_level_info'), activeColor: '#3b82f6' },
						{ value: 'warn', label: t('general.log_level_warn'), activeColor: '#f59e0b' },
						{ value: 'error', label: t('general.log_level_error'), activeColor: '#ef4444' },
					]}
					value={logLevel}
					onChange={setLogLevel}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">{t('general.log_level_help')}</p>
			</div>

			{/* GitHub CLI Path */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Terminal className="w-3 h-3" />
					{t('general.gh_path_header')}
				</div>
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="block text-xs opacity-60 mb-1">{t('general.gh_path_label')}</div>
					<div className="flex gap-2">
						<input
							type="text"
							value={ghPath}
							onChange={(e) => setGhPath(e.target.value)}
							placeholder={t('general.gh_path_placeholder')}
							className="flex-1 p-1.5 rounded border bg-transparent outline-none text-xs font-mono"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
						{ghPath && (
							<button
								onClick={() => setGhPath('')}
								className="px-2 py-1 rounded text-xs"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textDim,
								}}
							>
								{t('general.clear_button')}
							</button>
						)}
					</div>
					<p className="text-xs opacity-40 mt-2">
						Specify the full path to the{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							gh
						</code>{' '}
						binary if it's not in your PATH. Used for Auto Run worktree features.
					</p>
				</div>
			</div>

			{/* Input Behavior Settings */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Keyboard className="w-3 h-3" />
					{t('general.input_behavior_header')}
				</div>
				<p className="text-xs opacity-50 mb-3">
					{t('general.input_behavior_description', { metaKey: formatMetaKey() })}
				</p>

				{/* AI Mode Setting */}
				<div
					className="mb-4 p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex items-center justify-between mb-2">
						<div className="text-sm font-medium">{t('general.input_ai_mode')}</div>
						<button
							onClick={() => setEnterToSendAI(!enterToSendAI)}
							className="px-3 py-1.5 rounded text-xs font-mono transition-all"
							style={{
								backgroundColor: enterToSendAI ? theme.colors.accentDim : theme.colors.bgActivity,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							{formatEnterToSend(enterToSendAI)}
						</button>
					</div>
					<p className="text-xs opacity-50">
						{enterToSendAI
							? t('general.input_enter_to_send')
							: t('general.input_meta_to_send', { metaKey: formatMetaKey() })}
					</p>
				</div>

				{/* Terminal Mode Setting */}
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex items-center justify-between mb-2">
						<div className="text-sm font-medium">{t('general.input_terminal_mode')}</div>
						<button
							onClick={() => setEnterToSendTerminal(!enterToSendTerminal)}
							className="px-3 py-1.5 rounded text-xs font-mono transition-all"
							style={{
								backgroundColor: enterToSendTerminal
									? theme.colors.accentDim
									: theme.colors.bgActivity,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							{formatEnterToSend(enterToSendTerminal)}
						</button>
					</div>
					<p className="text-xs opacity-50">
						{enterToSendTerminal
							? t('general.input_enter_to_send')
							: t('general.input_meta_to_send', { metaKey: formatMetaKey() })}
					</p>
				</div>
			</div>

			{/* Default History Toggle */}
			<SettingCheckbox
				icon={History}
				sectionLabel={t('general.history_toggle_header')}
				title={t('general.history_toggle_title')}
				description={t('general.history_toggle_description')}
				checked={defaultSaveToHistory}
				onChange={setDefaultSaveToHistory}
				theme={theme}
			/>

			{/* Default Thinking Toggle - Three states: Off, On, Sticky */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Brain className="w-3 h-3" />
					{t('general.thinking_mode_header')}
				</div>
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="font-medium mb-1" style={{ color: theme.colors.textMain }}>
						{t('general.thinking_mode_title')}
					</div>
					<div className="text-sm opacity-60 mb-3" style={{ color: theme.colors.textDim }}>
						{defaultShowThinking === 'off' && t('general.thinking_mode_off')}
						{defaultShowThinking === 'on' && t('general.thinking_mode_on')}
						{defaultShowThinking === 'sticky' && t('general.thinking_mode_sticky')}
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'off' as const, label: t('general.thinking_mode_label_off') },
							{ value: 'on' as const, label: t('general.thinking_mode_label_on') },
							{ value: 'sticky' as const, label: t('general.thinking_mode_label_sticky') },
						]}
						value={defaultShowThinking}
						onChange={setDefaultShowThinking}
						theme={theme}
					/>
				</div>
			</div>

			{/* Automatic Tab Naming */}
			<SettingCheckbox
				icon={Tag}
				sectionLabel={t('general.tab_naming_header')}
				title={t('general.tab_naming_title')}
				description={t('general.tab_naming_description')}
				checked={automaticTabNamingEnabled}
				onChange={setAutomaticTabNamingEnabled}
				theme={theme}
			/>

			{/* Auto-scroll AI Output */}
			<SettingCheckbox
				icon={ArrowDownToLine}
				sectionLabel={t('general.auto_scroll_header')}
				title={t('general.auto_scroll_title')}
				description={t('general.auto_scroll_description')}
				checked={autoScrollAiMode}
				onChange={setAutoScrollAiMode}
				theme={theme}
			/>

			{/* Sleep Prevention */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Battery className="w-3 h-3" />
					{t('general.power_header')}
				</div>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div
						className="flex items-center justify-between cursor-pointer"
						onClick={() => setPreventSleepEnabled(!preventSleepEnabled)}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setPreventSleepEnabled(!preventSleepEnabled);
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div className="font-medium" style={{ color: theme.colors.textMain }}>
								{t('general.power_prevent_sleep_title')}
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								{t('general.power_prevent_sleep_description')}
							</div>
						</div>
						<button
							onClick={(e) => {
								e.stopPropagation();
								setPreventSleepEnabled(!preventSleepEnabled);
							}}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: preventSleepEnabled
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={preventSleepEnabled}
							aria-label={t('general.power_prevent_sleep_title')}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									preventSleepEnabled ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Linux note */}
					{isLinuxPlatform() && (
						<div
							className="text-xs p-2 rounded"
							style={{
								backgroundColor: theme.colors.warning + '15',
								color: theme.colors.warning,
							}}
						>
							{t('general.power_linux_note')}
						</div>
					)}
				</div>
			</div>

			{/* Rendering Options */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Monitor className="w-3 h-3" />
					{t('general.rendering_header')}
				</div>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					{/* GPU Acceleration Toggle */}
					<div
						className="flex items-center justify-between cursor-pointer"
						onClick={() => setDisableGpuAcceleration(!disableGpuAcceleration)}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setDisableGpuAcceleration(!disableGpuAcceleration);
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div className="font-medium" style={{ color: theme.colors.textMain }}>
								{t('general.rendering_gpu_title')}
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								{t('general.rendering_gpu_description')}
							</div>
						</div>
						<button
							onClick={(e) => {
								e.stopPropagation();
								setDisableGpuAcceleration(!disableGpuAcceleration);
							}}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: disableGpuAcceleration
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={disableGpuAcceleration}
							aria-label={t('general.rendering_gpu_title')}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									disableGpuAcceleration ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Confetti Toggle */}
					<div
						className="flex items-center justify-between cursor-pointer pt-3 border-t"
						style={{ borderColor: theme.colors.border }}
						onClick={() => setDisableConfetti(!disableConfetti)}
						role="button"
						tabIndex={0}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setDisableConfetti(!disableConfetti);
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div
								className="font-medium flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								<PartyPopper className="w-4 h-4" />
								{t('general.rendering_confetti_title')}
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								{t('general.rendering_confetti_description')}
							</div>
						</div>
						<button
							onClick={(e) => {
								e.stopPropagation();
								setDisableConfetti(!disableConfetti);
							}}
							className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
							style={{
								backgroundColor: disableConfetti ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={disableConfetti}
							aria-label={t('general.rendering_confetti_title')}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									disableConfetti ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>
				</div>
			</div>

			{/* Check for Updates on Startup */}
			<SettingCheckbox
				icon={Download}
				sectionLabel={t('general.updates_header')}
				title={t('general.updates_title')}
				description={t('general.updates_description')}
				checked={checkForUpdatesOnStartup}
				onChange={setCheckForUpdatesOnStartup}
				theme={theme}
			/>

			{/* Beta Updates */}
			<SettingCheckbox
				icon={FlaskConical}
				sectionLabel={t('general.beta_header')}
				title={t('general.beta_title')}
				description={t('general.beta_description')}
				checked={enableBetaUpdates}
				onChange={setEnableBetaUpdates}
				theme={theme}
			/>

			{/* Crash Reporting */}
			<SettingCheckbox
				icon={Bug}
				sectionLabel={t('general.privacy_header')}
				title={t('general.privacy_title')}
				description={t('general.privacy_description')}
				checked={crashReportingEnabled}
				onChange={setCrashReportingEnabled}
				theme={theme}
			/>

			{/* Stats Data Management */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Database className="w-3 h-3" />
					{t('general.stats_header')}
					<span
						className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
						style={{
							backgroundColor: theme.colors.warning + '30',
							color: theme.colors.warning,
						}}
					>
						{t('general.stats_badge_beta')}
					</span>
				</div>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					{/* Enable/Disable Stats Collection */}
					<div className="flex items-center justify-between">
						<div>
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								{t('general.stats_enable_title')}
							</p>
							<p className="text-xs opacity-50 mt-0.5">{t('general.stats_enable_description')}</p>
						</div>
						<button
							onClick={() => setStatsCollectionEnabled(!statsCollectionEnabled)}
							className={`relative w-10 h-5 rounded-full transition-colors ${
								statsCollectionEnabled ? '' : ''
							}`}
							style={{
								backgroundColor: statsCollectionEnabled
									? theme.colors.accent
									: theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={statsCollectionEnabled}
							aria-label={t('general.stats_enable_title')}
						>
							<span
								className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
									statsCollectionEnabled ? 'translate-x-5' : 'translate-x-0.5'
								}`}
							/>
						</button>
					</div>

					{/* Default Time Range */}
					<div>
						<div className="block text-xs opacity-60 mb-2">
							{t('general.stats_time_range_label')}
						</div>
						<select
							value={defaultStatsTimeRange}
							onChange={(e) =>
								setDefaultStatsTimeRange(
									e.target.value as 'day' | 'week' | 'month' | 'year' | 'all'
								)
							}
							className="w-full p-2 rounded border bg-transparent outline-none text-sm"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<option value="day">{t('general.stats_time_range_day')}</option>
							<option value="week">{t('general.stats_time_range_week')}</option>
							<option value="month">{t('general.stats_time_range_month')}</option>
							<option value="year">{t('general.stats_time_range_year')}</option>
							<option value="all">{t('general.stats_time_range_all')}</option>
						</select>
						<p className="text-xs opacity-50 mt-1">{t('general.stats_time_range_help')}</p>
					</div>

					{/* Divider */}
					<div className="border-t" style={{ borderColor: theme.colors.border }} />

					{/* Database Size Display */}
					<div className="flex items-center justify-between">
						<span className="text-sm" style={{ color: theme.colors.textDim }}>
							{t('general.stats_db_size')}
						</span>
						<span className="text-sm font-mono" style={{ color: theme.colors.textMain }}>
							{statsDbSize !== null
								? t('general.stats_mb', { size: (statsDbSize / 1024 / 1024).toFixed(2) })
								: t('general.stats_db_loading')}
							{statsEarliestDate && (
								<span style={{ color: theme.colors.textDim }}>
									{' '}
									{t('general.stats_db_since', { date: statsEarliestDate })}
								</span>
							)}
						</span>
					</div>

					{/* Clear Old Data Dropdown */}
					<div>
						<div className="block text-xs opacity-60 mb-2">{t('general.stats_clear_label')}</div>
						<div className="flex items-center gap-2">
							<select
								id="clear-stats-period"
								className="flex-1 p-2 rounded border bg-transparent outline-none text-sm"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								defaultValue=""
								disabled={statsClearing}
							>
								<option value="" disabled>
									{t('general.stats_clear_select_period')}
								</option>
								<option value="7">{t('general.stats_clear_7_days')}</option>
								<option value="30">{t('general.stats_clear_30_days')}</option>
								<option value="90">{t('general.stats_clear_90_days')}</option>
								<option value="180">{t('general.stats_clear_6_months')}</option>
								<option value="365">{t('general.stats_clear_1_year')}</option>
							</select>
							<button
								onClick={async () => {
									const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
									const days = parseInt(select.value, 10);
									if (!days || isNaN(days)) {
										return; // No selection
									}
									setStatsClearing(true);
									setStatsClearResult(null);
									try {
										const result = await window.maestro.stats.clearOldData(days);
										setStatsClearResult(result);
										if (result.success) {
											// Refresh database size
											const newSize = await window.maestro.stats.getDatabaseSize();
											setStatsDbSize(newSize);
										}
									} catch (err) {
										console.error('Failed to clear old stats:', err);
										setStatsClearResult({
											success: false,
											deletedQueryEvents: 0,
											deletedAutoRunSessions: 0,
											deletedAutoRunTasks: 0,
											error: err instanceof Error ? err.message : 'Unknown error',
										});
									} finally {
										setStatsClearing(false);
									}
								}}
								disabled={statsClearing}
								className="px-3 py-2 rounded text-xs font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
								style={{
									backgroundColor: theme.colors.error + '20',
									color: theme.colors.error,
									border: `1px solid ${theme.colors.error}40`,
								}}
							>
								<Trash2 className="w-3 h-3" />
								{statsClearing ? t('general.stats_clearing') : t('general.stats_clear_button')}
							</button>
						</div>
						<p className="text-xs opacity-50 mt-2">{t('general.stats_clear_help')}</p>
					</div>

					{/* Clear Result Feedback */}
					{statsClearResult && (
						<div
							className="p-2 rounded text-xs flex items-start gap-2"
							style={{
								backgroundColor: statsClearResult.success
									? theme.colors.success + '20'
									: theme.colors.error + '20',
								color: statsClearResult.success ? theme.colors.success : theme.colors.error,
							}}
						>
							{statsClearResult.success ? (
								<>
									<Check className="w-3 h-3 flex-shrink-0 mt-0.5" />
									<span>
										{t('general.stats_clear_success', {
											total:
												statsClearResult.deletedQueryEvents +
												statsClearResult.deletedAutoRunSessions +
												statsClearResult.deletedAutoRunTasks,
											queries: statsClearResult.deletedQueryEvents,
											sessions: statsClearResult.deletedAutoRunSessions,
											tasks: statsClearResult.deletedAutoRunTasks,
										})}
									</span>
								</>
							) : (
								<>
									<X className="w-3 h-3 flex-shrink-0 mt-0.5" />
									<span>{statsClearResult.error || t('general.stats_clear_failed')}</span>
								</>
							)}
						</div>
					)}

					{/* Divider */}
					<div className="border-t" style={{ borderColor: theme.colors.border }} />

					{/* WakaTime Integration */}
					<div className="flex items-center justify-between">
						<div>
							<p
								className="text-sm flex items-center gap-2"
								style={{ color: theme.colors.textMain }}
							>
								<Timer className="w-3.5 h-3.5 opacity-60" />
								{t('general.wakatime_title')}
							</p>
							<p className="text-xs opacity-50 mt-0.5">{t('general.wakatime_description')}</p>
						</div>
						<button
							onClick={() => setWakatimeEnabled(!wakatimeEnabled)}
							className="relative w-10 h-5 rounded-full transition-colors"
							style={{
								backgroundColor: wakatimeEnabled ? theme.colors.accent : theme.colors.bgActivity,
							}}
							role="switch"
							aria-checked={wakatimeEnabled}
							aria-label={t('general.wakatime_title')}
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
							{t('general.wakatime_cli_installing')}
						</p>
					)}

					{/* Detailed file tracking toggle (only shown when enabled) */}
					{wakatimeEnabled && (
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm" style={{ color: theme.colors.textMain }}>
									{t('general.wakatime_detailed_title')}
								</p>
								<p className="text-xs opacity-50 mt-0.5">
									{t('general.wakatime_detailed_description')}
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
								aria-label={t('general.wakatime_detailed_title')}
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
							<div className="block text-xs opacity-60 mb-1">
								{t('general.wakatime_api_key_label')}
							</div>
							<div
								className="flex items-center border rounded px-3 py-2"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
								}}
							>
								<Key className="w-4 h-4 mr-2 opacity-50" />
								<input
									type="password"
									value={wakatimeApiKey}
									onChange={(e) => handleWakatimeApiKeyChange(e.target.value)}
									onBlur={() => {
										if (wakatimeApiKey) {
											setWakatimeKeyValidating(true);
											setWakatimeKeyValid(null);
											window.maestro.wakatime
												.validateApiKey(wakatimeApiKey)
												.then((result) => setWakatimeKeyValid(result.valid))
												.catch(() => setWakatimeKeyValid(false))
												.finally(() => setWakatimeKeyValidating(false));
										}
									}}
									className="bg-transparent flex-1 text-sm outline-none"
									style={{ color: theme.colors.textMain }}
									placeholder={t('general.wakatime_api_key_placeholder')}
								/>
								{wakatimeKeyValidating && <span className="ml-2 text-xs opacity-50">...</span>}
								{!wakatimeKeyValidating && wakatimeKeyValid === true && (
									<Check className="w-4 h-4 ml-2" style={{ color: theme.colors.success }} />
								)}
								{!wakatimeKeyValidating && wakatimeKeyValid === false && wakatimeApiKey && (
									<X className="w-4 h-4 ml-2" style={{ color: theme.colors.error }} />
								)}
								{wakatimeApiKey && (
									<button
										onClick={() => handleWakatimeApiKeyChange('')}
										className="ml-2 opacity-50 hover:opacity-100"
										title={t('general.wakatime_clear_api_key')}
									>
										<X className="w-3 h-3" />
									</button>
								)}
							</div>
							<p className="text-[10px] mt-1.5 opacity-50">{t('general.wakatime_api_key_help')}</p>
						</div>
					)}
				</div>
			</div>

			{/* Settings Storage Location */}
			<div>
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<FolderSync className="w-3 h-3" />
					{t('general.storage_header')}
					<span
						className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
						style={{
							backgroundColor: theme.colors.warning + '30',
							color: theme.colors.warning,
						}}
					>
						{t('general.storage_badge_beta')}
					</span>
				</div>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					{/* Settings folder header */}
					<div>
						<p className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							{t('general.storage_settings_folder')}
						</p>
						<p className="text-xs opacity-60 mt-0.5">{t('general.storage_description')}</p>
						<p className="text-xs opacity-50 mt-1 italic">{t('general.storage_sync_note')}</p>
					</div>

					{/* Default Location */}
					<div>
						<div className="block text-xs opacity-60 mb-1">
							{t('general.storage_default_location')}
						</div>
						<div
							className="text-xs p-2 rounded font-mono truncate"
							style={{ backgroundColor: theme.colors.bgActivity }}
							title={defaultStoragePath}
						>
							{defaultStoragePath || t('general.stats_db_loading')}
						</div>
					</div>

					{/* Current Location (if different) */}
					{customSyncPath && (
						<div>
							<div className="block text-xs opacity-60 mb-1">
								{t('general.storage_current_location')}
							</div>
							<div
								className="text-xs p-2 rounded font-mono truncate flex items-center gap-2"
								style={{
									backgroundColor: theme.colors.accent + '15',
									border: `1px solid ${theme.colors.accent}40`,
								}}
								title={customSyncPath}
							>
								<Cloud className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.accent }} />
								<span className="truncate">{customSyncPath}</span>
							</div>
						</div>
					)}

					{/* Action Buttons */}
					<div className="flex items-center gap-2 flex-wrap">
						<button
							onClick={async () => {
								try {
									const folder = await window.maestro.sync.selectSyncFolder();
									if (folder) {
										setSyncMigrating(true);
										setSyncError(null);
										setSyncMigratedCount(null);
										try {
											const result = await window.maestro.sync.setCustomPath(folder);
											if (result.success) {
												setCustomSyncPath(folder);
												setCurrentStoragePath(folder);
												setSyncRestartRequired(true);
												if (result.migrated !== undefined) {
													setSyncMigratedCount(result.migrated);
												}
											} else {
												setSyncError(
													result.errors?.join(', ') ||
														result.error ||
														t('general.storage_failed_change')
												);
											}
											if (result.errors && result.errors.length > 0) {
												setSyncError(result.errors.join(', '));
											}
										} catch (error) {
											setSyncError(error instanceof Error ? error.message : String(error));
										} finally {
											setSyncMigrating(false);
										}
									}
								} catch (error) {
									setSyncError(error instanceof Error ? error.message : String(error));
								}
							}}
							disabled={syncMigrating}
							className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.bgMain,
							}}
						>
							<Folder className="w-3 h-3" />
							{syncMigrating
								? t('general.storage_migrating')
								: customSyncPath
									? t('general.storage_change_folder')
									: t('general.storage_choose_folder')}
						</button>

						{customSyncPath && (
							<button
								onClick={async () => {
									setSyncMigrating(true);
									setSyncError(null);
									setSyncMigratedCount(null);
									try {
										const result = await window.maestro.sync.setCustomPath(null);
										if (result.success) {
											setCustomSyncPath(undefined);
											setCurrentStoragePath(defaultStoragePath);
											setSyncRestartRequired(true);
											if (result.migrated !== undefined) {
												setSyncMigratedCount(result.migrated);
											}
										} else {
											setSyncError(
												result.errors?.join(', ') ||
													result.error ||
													t('general.storage_failed_reset')
											);
										}
									} catch (error) {
										setSyncError(error instanceof Error ? error.message : String(error));
									} finally {
										setSyncMigrating(false);
									}
								}}
								disabled={syncMigrating}
								className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50"
								style={{
									backgroundColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								title={t('general.storage_reset_to_default')}
							>
								<RotateCcw className="w-3 h-3" />
								{t('general.storage_use_default')}
							</button>
						)}
					</div>

					{/* Success Message */}
					{syncMigratedCount !== null && syncMigratedCount > 0 && !syncError && (
						<div
							className="p-2 rounded text-xs flex items-center gap-2"
							style={{
								backgroundColor: theme.colors.success + '20',
								color: theme.colors.success,
							}}
						>
							<Check className="w-3 h-3" />
							{syncMigratedCount !== 1
								? t('general.storage_migrated_plural', { count: syncMigratedCount })
								: t('general.storage_migrated', { count: syncMigratedCount })}
						</div>
					)}

					{/* Error Message */}
					{syncError && (
						<div
							className="p-2 rounded text-xs flex items-start gap-2"
							style={{
								backgroundColor: theme.colors.error + '20',
								color: theme.colors.error,
							}}
						>
							<X className="w-3 h-3 flex-shrink-0 mt-0.5" />
							<span>{syncError}</span>
						</div>
					)}

					{/* Restart Required Warning */}
					{syncRestartRequired && !syncError && (
						<div
							className="p-2 rounded text-xs flex items-center gap-2"
							style={{
								backgroundColor: theme.colors.warning + '20',
								color: theme.colors.warning,
							}}
						>
							<RotateCcw className="w-3 h-3" />
							{t('general.storage_restart_required')}
						</div>
					)}

					{/* Open in File Manager */}
					<div className="flex justify-end">
						<button
							onClick={() => {
								const folderPath = customSyncPath || defaultStoragePath;
								if (folderPath) {
									window.maestro?.shell?.openPath(folderPath);
								}
							}}
							disabled={!defaultStoragePath && !customSyncPath}
							className="flex items-center gap-1.5 text-[11px] opacity-60 hover:opacity-100 transition-opacity disabled:opacity-30"
							style={{ color: theme.colors.textMain }}
							title={customSyncPath || defaultStoragePath}
						>
							<ExternalLink className="w-3 h-3" />
							{getOpenInLabel(window.maestro?.platform || 'darwin')}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
