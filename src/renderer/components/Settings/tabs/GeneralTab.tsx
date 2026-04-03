/**
 * GeneralTab - General settings tab for SettingsModal
 *
 * Contains: About Me, Shell, Log Level, GitHub CLI, Input Behavior,
 * History, Thinking Mode, Tab Naming, Auto-scroll, Power, Rendering,
 * Updates, Pre-release, Privacy, Storage Location.
 */

import { useState, useEffect, useCallback } from 'react';
import {
	X,
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
	Battery,
	Monitor,
	PartyPopper,
	Tag,
	User,
	ArrowDownToLine,
	ExternalLink,
	Keyboard,
	Trash2,
	AlertTriangle,
} from 'lucide-react';
import { useSettings } from '../../../hooks';
import type { Theme, ShellInfo } from '../../../types';
import {
	formatMetaKey,
	formatEnterToSend,
	formatShortcutKeys,
} from '../../../utils/shortcutFormatter';
import { ForcedParallelWarningModal } from '../../ForcedParallelWarningModal';
import { getOpenInLabel, isLinuxPlatform } from '../../../utils/platformUtils';
import { ToggleButtonGroup } from '../../ToggleButtonGroup';
import { SettingCheckbox } from '../../SettingCheckbox';

export interface GeneralTabProps {
	theme: Theme;
	isOpen: boolean;
}

export function GeneralTab({ theme, isOpen }: GeneralTabProps) {
	const {
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
		// Forced Parallel Execution
		forcedParallelExecution,
		setForcedParallelExecution,
		forcedParallelAcknowledged,
		setForcedParallelAcknowledged,
		// Shortcuts
		shortcuts,
	} = useSettings();

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

	// Forced Parallel Execution modal state
	const [showForcedParallelWarning, setShowForcedParallelWarning] = useState(false);

	const handleForcedParallelToggle = useCallback(() => {
		if (!forcedParallelExecution && !forcedParallelAcknowledged) {
			// First time enabling — show warning modal
			setShowForcedParallelWarning(true);
		} else {
			// Already acknowledged or turning off
			setForcedParallelExecution(!forcedParallelExecution);
		}
	}, [forcedParallelExecution, forcedParallelAcknowledged, setForcedParallelExecution]);

	const handleForcedParallelConfirm = useCallback(() => {
		setForcedParallelAcknowledged(true);
		setForcedParallelExecution(true);
		setShowForcedParallelWarning(false);
	}, [setForcedParallelAcknowledged, setForcedParallelExecution]);

	const handleForcedParallelCancel = useCallback(() => {
		setShowForcedParallelWarning(false);
	}, []);

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
				setSyncError('Failed to load storage settings');
			});
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
			<div data-setting-id="general-conductor-profile">
				<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
					<User className="w-3 h-3" />
					Conductor Profile (aka, About Me)
				</div>
				<p className="text-xs opacity-50 mb-2">
					Tell us a little about yourself so that agents created under Maestro know how to work and
					communicate with you. As the conductor, you orchestrate the symphony of AI agents.
					(Optional, max 1000 characters)
				</p>
				<div className="relative">
					<textarea
						value={conductorProfile}
						onChange={(e) => setConductorProfile(e.target.value)}
						placeholder="e.g., I'm a senior developer working on a React/TypeScript project. I prefer concise explanations and clean code patterns..."
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

			{/* Default Shell */}
			<div data-setting-id="general-default-shell">
				<div className="block text-xs font-bold opacity-70 uppercase mb-1 flex items-center gap-2">
					<Terminal className="w-3 h-3" />
					Default Terminal Shell
				</div>
				<p className="text-xs opacity-50 mb-2">
					Choose which shell to use for terminal sessions. Select any shell and configure a custom
					path if needed.
				</p>
				{shellsLoading ? (
					<div className="text-sm opacity-50 p-2">Loading shells...</div>
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
													Available
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
													Custom Path Required
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
												Not Found
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
											<div className="text-xs opacity-50 font-mono mt-1">Current default</div>
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
										<span>Detect other available shells...</span>
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
						Shell Configuration
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
							<div className="block text-xs opacity-60 mb-1">Custom Path (optional)</div>
							<div className="flex gap-2">
								<input
									type="text"
									value={customShellPath}
									onChange={(e) => setCustomShellPath(e.target.value)}
									placeholder="/path/to/shell"
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
										Clear
									</button>
								)}
							</div>
							<p className="text-xs opacity-50 mt-1">
								Override the auto-detected shell path. Leave empty to use the detected path.
							</p>
						</div>

						{/* Shell Arguments */}
						<div>
							<div className="block text-xs opacity-60 mb-1">Additional Arguments (optional)</div>
							<div className="flex gap-2">
								<input
									type="text"
									value={shellArgs}
									onChange={(e) => setShellArgs(e.target.value)}
									placeholder="--flag value"
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
										Clear
									</button>
								)}
							</div>
							<p className="text-xs opacity-50 mt-1">
								Additional CLI arguments passed to every shell session (e.g., --login, -c).
							</p>
						</div>
					</div>
				)}
			</div>

			{/* System Log Level */}
			<div data-setting-id="general-log-level">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2">System Log Level</div>
				<ToggleButtonGroup
					options={[
						{ value: 'debug', label: 'Debug', activeColor: '#6366f1' },
						{ value: 'info', label: 'Info', activeColor: '#3b82f6' },
						{ value: 'warn', label: 'Warn', activeColor: '#f59e0b' },
						{ value: 'error', label: 'Error', activeColor: '#ef4444' },
					]}
					value={logLevel}
					onChange={setLogLevel}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Higher levels show fewer logs. Debug shows all logs, Error shows only errors.
				</p>
			</div>

			{/* GitHub CLI Path */}
			<div data-setting-id="general-gh-path">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Terminal className="w-3 h-3" />
					GitHub CLI (gh) Path
				</div>
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="block text-xs opacity-60 mb-1">Custom Path (optional)</div>
					<div className="flex gap-2">
						<input
							type="text"
							value={ghPath}
							onChange={(e) => setGhPath(e.target.value)}
							placeholder="/opt/homebrew/bin/gh"
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
								Clear
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
			<div data-setting-id="general-input-behavior">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Keyboard className="w-3 h-3" />
					Input Send Behavior
				</div>
				<p className="text-xs opacity-50 mb-3">
					Configure how to send messages in each mode. Choose between Enter or {formatMetaKey()}
					+Enter for each input type.
				</p>

				{/* AI Mode Setting */}
				<div
					className="mb-4 p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex items-center justify-between mb-2">
						<div className="text-sm font-medium">AI Interaction Mode</div>
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
							? 'Press Enter to send. Use Shift+Enter for new line.'
							: `Press ${formatMetaKey()}+Enter to send. Enter creates new line.`}
					</p>
				</div>

				{/* Terminal Mode Setting */}
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex items-center justify-between mb-2">
						<div className="text-sm font-medium">Terminal Mode</div>
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
							? 'Press Enter to send. Use Shift+Enter for new line.'
							: `Press ${formatMetaKey()}+Enter to send. Enter creates new line.`}
					</p>
				</div>

				{/* Forced Parallel Execution */}
				<div
					className="mt-4 p-3 rounded border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
						opacity: forcedParallelExecution ? 1 : 0.7,
					}}
				>
					<div className="flex items-center justify-between mb-2">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Forced Parallel Execution
						</div>
						<div className="flex items-center gap-2">
							<span
								className="px-2 py-0.5 rounded text-xs font-mono"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
									opacity: forcedParallelExecution ? 1 : 0.5,
								}}
							>
								{shortcuts?.forcedParallelSend
									? formatShortcutKeys(shortcuts.forcedParallelSend.keys)
									: '⌘ ⇧ ↩'}
							</span>
							<button
								onClick={handleForcedParallelToggle}
								className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
								style={{
									backgroundColor: forcedParallelExecution
										? theme.colors.accent
										: theme.colors.bgActivity,
								}}
								role="switch"
								aria-checked={forcedParallelExecution}
								aria-label="Forced Parallel Execution"
							>
								<span
									className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
										forcedParallelExecution ? 'translate-x-5' : 'translate-x-0.5'
									}`}
								/>
							</button>
						</div>
					</div>
					<div
						className="flex items-start gap-1.5 text-xs"
						style={{
							color: theme.colors.warning,
							opacity: forcedParallelExecution ? 1 : 0.5,
						}}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>
							When enabled, use{' '}
							<strong>
								{shortcuts?.forcedParallelSend
									? formatShortcutKeys(shortcuts.forcedParallelSend.keys)
									: '⌘ ⇧ ↩'}
							</strong>{' '}
							to send messages even while the agent is busy. Parallel writes to the same files may
							cause one to overwrite the other.
						</span>
					</div>
				</div>

				<ForcedParallelWarningModal
					isOpen={showForcedParallelWarning}
					onConfirm={handleForcedParallelConfirm}
					onCancel={handleForcedParallelCancel}
					theme={theme}
				/>
			</div>

			{/* Default History Toggle */}
			<div data-setting-id="general-history">
				<SettingCheckbox
					icon={History}
					sectionLabel="Default History Toggle"
					title='Enable "History" by default for new tabs'
					description='When enabled, new AI tabs will have the "History" toggle on by default, saving a synopsis after each completion'
					checked={defaultSaveToHistory}
					onChange={setDefaultSaveToHistory}
					theme={theme}
				/>
			</div>

			{/* Default Thinking Toggle - Three states: Off, On, Sticky */}
			<div data-setting-id="general-thinking-mode">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Brain className="w-3 h-3" />
					Default Thinking Mode
				</div>
				<div
					className="p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="font-medium mb-1" style={{ color: theme.colors.textMain }}>
						Show AI thinking/reasoning content for new tabs
					</div>
					<div className="text-sm opacity-60 mb-3" style={{ color: theme.colors.textDim }}>
						{defaultShowThinking === 'off' && 'Thinking hidden, only final responses shown'}
						{defaultShowThinking === 'on' && 'Thinking streams live, clears on completion'}
						{defaultShowThinking === 'sticky' && 'Thinking streams live and stays visible'}
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'off' as const, label: 'Off' },
							{ value: 'on' as const, label: 'On' },
							{ value: 'sticky' as const, label: 'Sticky' },
						]}
						value={defaultShowThinking}
						onChange={setDefaultShowThinking}
						theme={theme}
					/>
				</div>
			</div>

			{/* Automatic Tab Naming */}
			<div data-setting-id="general-tab-naming">
				<SettingCheckbox
					icon={Tag}
					sectionLabel="Automatic Tab Naming"
					title="Automatically name tabs based on first message"
					description="When you send your first message to a new tab, an AI will analyze it and generate a descriptive tab name. The naming request runs in parallel and leaves no history."
					checked={automaticTabNamingEnabled}
					onChange={setAutomaticTabNamingEnabled}
					theme={theme}
				/>
			</div>

			{/* Auto-scroll AI Output */}
			<div data-setting-id="general-auto-scroll">
				<SettingCheckbox
					icon={ArrowDownToLine}
					sectionLabel="Auto-scroll AI Output"
					title="Auto-scroll AI output"
					description="Automatically scroll to the bottom when new AI output arrives. When disabled, a floating button appears for new messages."
					checked={autoScrollAiMode}
					onChange={setAutoScrollAiMode}
					theme={theme}
				/>
			</div>

			{/* Sleep Prevention */}
			<div data-setting-id="general-power">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Battery className="w-3 h-3" />
					Power
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
								Prevent sleep while working
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								Keeps your computer awake when AI agents are busy, Auto Run is active, or Cue
								pipelines are scheduled
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
							aria-label="Prevent sleep while working"
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
							Note: May have limited support on some Linux desktop environments.
						</div>
					)}
				</div>
			</div>

			{/* Rendering Options */}
			<div data-setting-id="general-rendering">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Monitor className="w-3 h-3" />
					Rendering Options
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
								Disable GPU acceleration
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								Use software rendering instead of GPU. Requires restart to take effect.
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
							aria-label="Disable GPU acceleration"
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
								Disable confetti animations
							</div>
							<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
								Skip celebratory confetti effects on achievements and milestones
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
							aria-label="Disable confetti animations"
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
			<div data-setting-id="general-updates">
				<SettingCheckbox
					icon={Download}
					sectionLabel="Updates"
					title="Check for updates on startup"
					description="Automatically check for new Maestro versions when the app starts"
					checked={checkForUpdatesOnStartup}
					onChange={setCheckForUpdatesOnStartup}
					theme={theme}
				/>
			</div>

			{/* Beta Updates */}
			<div data-setting-id="general-beta-updates">
				<SettingCheckbox
					icon={FlaskConical}
					sectionLabel="Pre-release Channel"
					title="Include beta and release candidate updates"
					description="Opt-in to receive pre-release versions (e.g., v0.11.1-rc, v0.12.0-beta). These may contain experimental features and bugs."
					checked={enableBetaUpdates}
					onChange={setEnableBetaUpdates}
					theme={theme}
				/>
			</div>

			{/* Crash Reporting */}
			<div data-setting-id="general-crash-reporting">
				<SettingCheckbox
					icon={Bug}
					sectionLabel="Privacy"
					title="Send anonymous crash reports"
					description="Help improve Maestro by automatically sending crash reports. No personal data is collected. Changes take effect after restart."
					checked={crashReportingEnabled}
					onChange={setCrashReportingEnabled}
					theme={theme}
				/>
			</div>

			{/* Settings Storage Location */}
			<div data-setting-id="general-storage">
				<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<FolderSync className="w-3 h-3" />
					Storage Location
				</div>
				<div
					className="p-3 rounded border space-y-3"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					{/* Settings folder header */}
					<div>
						<p className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
							Settings folder
						</p>
						<p className="text-xs opacity-60 mt-0.5">
							Choose where Maestro stores settings, sessions, and groups (including global
							environment variables, agents, and configurations). Use a synced folder (iCloud Drive,
							Dropbox, OneDrive) to share across devices.
						</p>
						<p className="text-xs opacity-50 mt-1 italic">
							Note: Only run Maestro on one device at a time to avoid sync conflicts.
						</p>
					</div>

					{/* Default Location */}
					<div>
						<div className="block text-xs opacity-60 mb-1">Default Location</div>
						<div
							className="text-xs p-2 rounded font-mono truncate"
							style={{ backgroundColor: theme.colors.bgActivity }}
							title={defaultStoragePath}
						>
							{defaultStoragePath || 'Loading...'}
						</div>
					</div>

					{/* Current Location (if different) */}
					{customSyncPath && (
						<div>
							<div className="block text-xs opacity-60 mb-1">Current Location (Custom)</div>
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
														'Failed to change storage location'
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
								? 'Migrating...'
								: customSyncPath
									? 'Change Folder...'
									: 'Choose Folder...'}
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
													'Failed to reset storage location'
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
								title="Reset to default location"
							>
								<RotateCcw className="w-3 h-3" />
								Use Default
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
							Migrated {syncMigratedCount} settings file{syncMigratedCount !== 1 ? 's' : ''}
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
							Restart Maestro for changes to take effect
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
