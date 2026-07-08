/**
 * AgentConfigPanel.tsx
 *
 * Shared component for agent configuration settings.
 * Used by both NewInstanceModal and the Wizard's AgentSelectionScreen.
 *
 * Displays:
 * - Detected path (read-only)
 * - Custom path input
 * - Custom arguments input
 * - Environment variables (key-value pairs)
 * - Built-in environment variables (MAESTRO_SESSION_RESUMED)
 * - Agent-specific config options (contextWindow, model, etc.)
 */

import { useState, useRef, useMemo, useEffect } from 'react';
import { RefreshCw, Plus, Trash2, HelpCircle, ChevronDown } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { ToggleButtonGroup } from '../ToggleButtonGroup';
import type { Theme, AgentConfig, AgentConfigOption } from '../../types';
import {
	getClaudeTokenMode,
	toClaudeTokenModeSource,
	type ClaudeTokenMode,
} from '../../../shared/claudeTokenMode';
import { useRemoteMaestroPAvailable } from '../../hooks/agent/useRemoteMaestroPAvailable';
import { openUrl } from '../../utils/openUrl';
import { logger } from '../../utils/logger';

const MAESTRO_P_INSTALL_URL = 'https://runmaestro.ai/maestro-p/';

// Counter for generating stable IDs for env vars
let envVarIdCounter = 0;

// Claude token-source selector (claude-code only). Maps the tri-state
// ClaudeTokenMode onto the segmented control labels plus a one-line hint each.
const CLAUDE_TOKEN_MODE_OPTIONS: { value: ClaudeTokenMode; label: string }[] = [
	{ value: 'api', label: 'claude -p' },
	{ value: 'interactive', label: 'TUI Wrapper' },
	{ value: 'dynamic', label: 'Dynamic' },
];

const CLAUDE_TOKEN_MODE_HINTS: Record<ClaudeTokenMode, string> = {
	api: 'Always use claude --print (per-token API credit).',
	interactive: 'Always drive the maestro-p TUI against your Max plan quota.',
	dynamic: 'Start on the Max plan TUI, then auto-switch to API when the quota is near exhaustion.',
};

// Built-in environment variables that Maestro sets automatically
const BUILT_IN_ENV_VARS: { key: string; description: string; value: string }[] = [
	{
		key: 'MAESTRO_SESSION_RESUMED',
		description:
			'Set to "1" when resuming an existing session. Not set for new sessions. Use this in your agent hooks to skip initialization on resumed sessions.',
		value: '1 (when resuming)',
	},
];

// Separate component for text input with optional model dropdown
// This avoids the browser's native datalist styling issues
interface ModelTextInputProps {
	theme: Theme;
	option: { key: string; default?: string };
	value: string;
	onChange: (value: string) => void;
	onBlur: (committedValue: string) => void;
	availableModels: string[];
	loadingModels: boolean;
	onRefreshModels?: () => void;
}

function ModelTextInput({
	theme,
	option,
	value,
	onChange,
	onBlur,
	availableModels,
	loadingModels,
	onRefreshModels,
}: ModelTextInputProps): JSX.Element {
	const [showDropdown, setShowDropdown] = useState(false);
	const [filterText, setFilterText] = useState('');
	// Track whether we're in filter mode (typing to filter dropdown vs direct input)
	const [isFiltering, setIsFiltering] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	// Keep track of the committed value (what was actually selected/saved)
	const committedValueRef = useRef(value);
	// Track whether a dropdown selection was just made (to prevent blur from overwriting it)
	const selectionMadeRef = useRef(false);

	// Update committed value when value prop changes from outside
	useEffect(() => {
		committedValueRef.current = value;
	}, [value]);

	// Filter models based on input
	const filteredModels = useMemo(() => {
		if (!filterText) return availableModels;
		const lower = filterText.toLowerCase();
		return availableModels.filter((m) => m.toLowerCase().includes(lower));
	}, [availableModels, filterText]);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setShowDropdown(false);
				// Reset to committed value if we were filtering
				if (isFiltering) {
					setFilterText('');
					setIsFiltering(false);
				}
			}
		};
		if (showDropdown) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [showDropdown, isFiltering]);

	const isModelField = option.key === 'model';
	const hasModels = availableModels.length > 0;

	// Display value: when filtering, show filter text; otherwise show actual value
	const displayValue = isFiltering ? filterText : value;

	return (
		<>
			<div className="flex gap-2" ref={containerRef}>
				<div className="relative flex-1">
					<input
						ref={inputRef}
						type="text"
						value={displayValue}
						onChange={(e) => {
							if (isModelField && hasModels) {
								// When typing with dropdown available, we're in filter mode
								// Don't update the actual value until selection or explicit blur
								setFilterText(e.target.value);
								setIsFiltering(true);
								setShowDropdown(true);
							} else {
								// No dropdown - direct text input
								onChange(e.target.value);
							}
						}}
						onFocus={() => {
							if (isModelField && hasModels) {
								setFilterText(value);
								setShowDropdown(true);
							}
						}}
						onBlur={() => {
							// Delay to allow click on dropdown item
							setTimeout(() => {
								// If a dropdown item was clicked, skip blur logic - the click handler already committed the value
								if (selectionMadeRef.current) {
									selectionMadeRef.current = false;
									return;
								}
								setShowDropdown(false);
								if (isFiltering) {
									// If user was filtering but didn't select, keep the filter text as the value
									// (they might have typed a custom model name)
									if (filterText !== committedValueRef.current) {
										onChange(filterText);
										committedValueRef.current = filterText;
										setIsFiltering(false);
										setFilterText('');
										// Pass the newly committed value so the consumer can save it
										// without relying on stale React state
										onBlur(filterText);
										return;
									}
									setIsFiltering(false);
									setFilterText('');
								}
								onBlur(committedValueRef.current);
							}, 150);
						}}
						onClick={(e) => e.stopPropagation()}
						placeholder={option.default || ''}
						className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono pr-8"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					{isModelField && hasModels && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setShowDropdown(!showDropdown);
								inputRef.current?.focus();
							}}
							className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
							style={{ color: theme.colors.textDim }}
						>
							<ChevronDown
								className={`w-3 h-3 transition-transform ${showDropdown ? 'rotate-180' : ''}`}
							/>
						</button>
					)}
					{/* Custom dropdown */}
					{isModelField && showDropdown && filteredModels.length > 0 && (
						<div
							className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded border shadow-lg"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							{filteredModels.map((model) => (
								<button
									key={model}
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										selectionMadeRef.current = true;
										onChange(model);
										committedValueRef.current = model;
										setShowDropdown(false);
										setFilterText('');
										setIsFiltering(false);
										onBlur(model);
									}}
									className="w-full text-left px-3 py-2 text-xs font-mono hover:bg-white/10 transition-colors"
									style={{
										color: model === value ? theme.colors.accent : theme.colors.textMain,
										backgroundColor: model === value ? 'rgba(255,255,255,0.05)' : undefined,
									}}
								>
									{model}
								</button>
							))}
						</div>
					)}
				</div>
				{isModelField && value && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							selectionMadeRef.current = true;
							onChange('');
							committedValueRef.current = '';
							setShowDropdown(false);
							setFilterText('');
							setIsFiltering(false);
							onBlur('');
						}}
						className="px-2 py-1.5 rounded text-xs whitespace-nowrap"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						title="Reset to default model"
					>
						Clear
					</button>
				)}
				{isModelField && onRefreshModels && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onRefreshModels();
						}}
						className="p-2 rounded border hover:bg-white/10 transition-colors"
						title="Refresh available models"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} />
					</button>
				)}
			</div>
			{isModelField && loadingModels && (
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					Loading available models...
				</p>
			)}
			{isModelField && !loadingModels && hasModels && (
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					{availableModels.length} model{availableModels.length !== 1 ? 's' : ''} available
				</p>
			)}
		</>
	);
}

export interface AgentConfigPanelProps {
	theme: Theme;
	agent: AgentConfig;
	// Custom path
	customPath: string;
	onCustomPathChange: (value: string) => void;
	onCustomPathBlur: () => void;
	// Custom arguments
	customArgs: string;
	onCustomArgsChange: (value: string) => void;
	onCustomArgsBlur: () => void;
	// Environment variables
	customEnvVars: Record<string, string>;
	onEnvVarKeyChange: (oldKey: string, newKey: string, value: string) => void;
	onEnvVarValueChange: (key: string, value: string) => void;
	onEnvVarRemove: (key: string) => void;
	onEnvVarAdd: () => void;
	onEnvVarsBlur: () => void;
	// Agent-specific config options
	agentConfig: Record<string, any>;
	onConfigChange: (key: string, value: any) => void;
	/** Called when a config field blurs. For text fields, `committedValue` is the value that was just saved. */
	onConfigBlur?: (key: string, committedValue: any) => void | Promise<void>;
	// Model selection (if supported)
	availableModels?: string[];
	loadingModels?: boolean;
	onRefreshModels?: () => void;
	// Dynamic config options (for select fields with dynamic: true)
	dynamicOptions?: Record<string, string[]>;
	loadingDynamicOptions?: boolean;
	// Agent refresh
	onRefreshAgent?: () => void;
	refreshingAgent?: boolean;
	// Optional: compact mode for wizard (less padding)
	compact?: boolean;
	// Show built-in environment variables section
	showBuiltInEnvVars?: boolean;
	// SSH remote execution enabled for this session
	isSshEnabled?: boolean;
	/**
	 * SSH remote id for this session. When set (and SSH enabled), the panel
	 * probes the remote for `maestro-p` and disables the TUI token-source option
	 * when it's absent there. Omit for local agents.
	 */
	sshRemoteId?: string;
	// === Claude Code Batch Mode (claude-code agent only) ===
	// When true, the spawner auto-switches between maestro-p (Time Limits) and
	// `claude --print` (API Limits) based on the latest usage snapshot. Off by default.
	enableMaestroP?: boolean;
	onEnableMaestroPChange?: (value: boolean) => void;
	/** Refinement of the maestro-p opt-in: always-TUI ('interactive') vs auto-switch ('dynamic'). */
	maestroPMode?: 'interactive' | 'dynamic';
	onMaestroPModeChange?: (mode: 'interactive' | 'dynamic') => void;
	maestroPPath?: string;
	onMaestroPPathChange?: (value: string) => void;
	onMaestroPPathBlur?: () => void;
	/** Auto-detected maestro-p path shown as helper text when `maestroPPath` is empty. */
	detectedMaestroPPath?: string;
	/** Last resolved Claude headless-mode state for this session. When provided and Adaptive Mode is on,
	 *  the panel renders a small pill next to the toggle so the user can see whether the spawner is
	 *  currently on Time Limits (Max plan) or has fallen back to API Limits. */
	claudeInteractive?: {
		mode: 'interactive' | 'api';
		modeReason: 'auto' | 'limit';
	};
}

export function AgentConfigPanel({
	theme,
	agent,
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
	availableModels = [],
	loadingModels = false,
	onRefreshModels,
	dynamicOptions = {},
	loadingDynamicOptions = false,
	onRefreshAgent,
	refreshingAgent = false,
	compact = false,
	showBuiltInEnvVars = false,
	isSshEnabled = false,
	sshRemoteId,
	// Left undefined when never configured (NOT coerced to false): getClaudeTokenMode
	// reads that "unset" state to default an SSH agent to the TUI. An explicit
	// false (user picked API) collapses to api as usual.
	enableMaestroP,
	onEnableMaestroPChange,
	maestroPMode,
	onMaestroPModeChange,
	maestroPPath = '',
	onMaestroPPathChange,
	onMaestroPPathBlur,
	detectedMaestroPPath,
	claudeInteractive,
}: AgentConfigPanelProps): JSX.Element {
	const callOnConfigBlurSafely = (key: string, committedValue: any) => {
		if (!onConfigBlur) {
			return;
		}
		const maybePromise = onConfigBlur(key, committedValue);
		if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
			void (maybePromise as Promise<void>).catch((error: unknown) => {
				logger.error(`Failed to persist config field "${key}":`, undefined, error);
			});
		}
	};
	const padding = compact ? 'p-2' : 'p-3';
	const spacing = compact ? 'space-y-2' : 'space-y-3';
	// Probe the SSH remote for maestro-p. When it's known-absent the remote can't
	// run the TUI, so the TUI option is disabled and the agent defaults to API
	// (mirrors resolveClaudeSpawnMode, which falls a remote TUI spawn back to api).
	// undefined = unknown (not SSH, still probing, or unreachable): stay optimistic.
	const {
		available: remoteMaestroPAvailable,
		isProbing: remoteMaestroPProbing,
		refresh: refreshRemoteMaestroP,
	} = useRemoteMaestroPAvailable(isSshEnabled ? sshRemoteId : undefined);
	const remoteMaestroPMissing = isSshEnabled && remoteMaestroPAvailable === false;
	// Collapse the stored (enableMaestroP, maestroPMode) pair into the tri-state the
	// segmented "Claude Token Source" selector renders. Source not API => show the
	// maestro-p path input and the live Time/API-limits pill.
	// Over SSH an unconfigured agent defaults to the TUI (Max plan), so pass the
	// SSH flag through - getClaudeTokenMode flips the unset default from api to
	// interactive for remote, except when the remote has no maestro-p.
	const claudeTokenMode = getClaudeTokenMode(
		{ enableMaestroP, maestroPMode },
		{ sshEnabled: isSshEnabled, sshMaestroPAvailable: remoteMaestroPAvailable }
	);
	// SSH-remote agents only offer TUI / API, never Dynamic: the auto-switch
	// reads a LOCAL usage snapshot that says nothing about the remote account's
	// quota, so there's no honest signal to switch on. Drop the Dynamic segment
	// and, when a stored Dynamic value meets SSH, display (and behave) as API -
	// mirroring resolveClaudeSpawnMode, which falls a dynamic+SSH spawn back to
	// api. Also drop TUI when the remote has no maestro-p to run it. The stored
	// preference is left untouched so disabling SSH restores it.
	const claudeTokenModeOptions = isSshEnabled
		? CLAUDE_TOKEN_MODE_OPTIONS.filter(
				(o) => o.value !== 'dynamic' && !(remoteMaestroPMissing && o.value === 'interactive')
			)
		: CLAUDE_TOKEN_MODE_OPTIONS;
	const displayClaudeTokenMode: ClaudeTokenMode =
		isSshEnabled &&
		(claudeTokenMode === 'dynamic' || (remoteMaestroPMissing && claudeTokenMode === 'interactive'))
			? 'api'
			: claudeTokenMode;
	const showMaestroPDetails = displayClaudeTokenMode !== 'api';
	// Track which built-in env var tooltip is showing
	const [showingTooltip, setShowingTooltip] = useState<string | null>(null);

	// Track stable IDs for env var entries to prevent focus loss when keys change
	// Only key edits are deferred to blur - value edits update immediately
	const envVarIdsRef = useRef<Map<string, number>>(new Map());
	const pendingKeyEditsRef = useRef<Map<string, string>>(new Map());
	// Force re-render when pending key edits change
	const [, forceUpdate] = useState(0);

	// Get or create stable ID for an env var key
	const getEnvVarId = (key: string): number => {
		if (!envVarIdsRef.current.has(key)) {
			envVarIdsRef.current.set(key, ++envVarIdCounter);
		}
		return envVarIdsRef.current.get(key)!;
	};

	// Clean up stale IDs when env vars change (only if not currently being edited)
	useMemo(() => {
		const currentKeys = new Set(Object.keys(customEnvVars));
		for (const key of envVarIdsRef.current.keys()) {
			if (!currentKeys.has(key) && !pendingKeyEditsRef.current.has(key)) {
				envVarIdsRef.current.delete(key);
				pendingKeyEditsRef.current.delete(key);
			}
		}
	}, [customEnvVars]);

	// Get current display value for env var key (pending edit or actual)
	const getKeyDisplayValue = (originalKey: string): string => {
		return pendingKeyEditsRef.current.get(originalKey) ?? originalKey;
	};

	// Handle key input change (local only, deferred to blur)
	const handleKeyInputChange = (originalKey: string, newKey: string) => {
		pendingKeyEditsRef.current.set(originalKey, newKey);
		forceUpdate((n) => n + 1);
	};

	// Commit pending key edit on blur
	const handleKeyBlur = (originalKey: string, currentValue: string) => {
		const pendingKey = pendingKeyEditsRef.current.get(originalKey);
		pendingKeyEditsRef.current.delete(originalKey);

		// Update the ID map if key changed
		if (pendingKey !== undefined && pendingKey !== originalKey) {
			const id = envVarIdsRef.current.get(originalKey);
			if (id !== undefined) {
				envVarIdsRef.current.delete(originalKey);
				envVarIdsRef.current.set(pendingKey, id);
			}
			onEnvVarKeyChange(originalKey, pendingKey, currentValue);
		}
		onEnvVarsBlur();
	};

	return (
		<div className={spacing}>
			{/* Path input - pre-filled with detected path, editable to override */}
			{/* When SSH is enabled and no custom path is set, show the remote binary name instead of local path */}
			<div
				className={`${padding} rounded border`}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<label
					className="block text-xs font-medium mb-2 flex items-center justify-between"
					style={{ color: theme.colors.textDim }}
				>
					<span>{isSshEnabled ? 'Remote Command' : 'Path'}</span>
					{onRefreshAgent && !isSshEnabled && (
						<button
							onClick={onRefreshAgent}
							className="p-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1"
							title="Re-detect agent path"
							style={{ color: theme.colors.textDim }}
						>
							<RefreshCw className={`w-3 h-3 ${refreshingAgent ? 'animate-spin' : ''}`} />
							<span className="text-xs">Detect</span>
						</button>
					)}
				</label>
				<div className="flex gap-2">
					<input
						type="text"
						// Over SSH the default is the remote binary name, shown as a placeholder so
						// the field stays editable (an empty customPath means "use the default").
						// Locally the field pre-fills with the detected path so it can be overridden.
						value={customPath || (isSshEnabled ? '' : agent.path) || ''}
						onChange={(e) => onCustomPathChange(e.target.value)}
						onBlur={onCustomPathBlur}
						onClick={(e) => e.stopPropagation()}
						placeholder={isSshEnabled ? agent.binaryName : `/path/to/${agent.binaryName}`}
						className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				</div>
				<p className="text-xs opacity-50 mt-2">
					{isSshEnabled
						? `Remote command/binary for ${agent.binaryName}. Leave empty to use default.`
						: `Path to the ${agent.binaryName} binary. Edit to override the auto-detected path.`}
				</p>
			</div>

			{/* Claude Token Source selector - Claude Code only. Picks how this agent
			    spends Claude quota: API (claude --print, per-token), TUI (maestro-p
			    driving the Claude TUI against the Max plan), or Dynamic (start on the
			    TUI, fall back to API when the 5-hour or weekly window is near
			    exhaustion, then snap back once both windows reset). Over SSH only
			    API / TUI are offered (Dynamic needs a local quota snapshot that
			    doesn't reflect the remote account) and maestro-p runs on the remote
			    host's PATH, so the local Maestro-P Path override is hidden. */}
			{agent.id === 'claude-code' && onEnableMaestroPChange && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex items-center gap-2 min-w-0 mb-2">
						<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
							Claude Token Source
						</span>
						{isSshEnabled && (
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									refreshRemoteMaestroP();
								}}
								disabled={remoteMaestroPProbing}
								title="Re-check whether maestro-p is installed on the remote host"
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border disabled:opacity-50"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								<RefreshCw className={`w-3 h-3 ${remoteMaestroPProbing ? 'animate-spin' : ''}`} />
								Re-check
							</button>
						)}
						{showMaestroPDetails && claudeInteractive && (
							<span
								className="text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color:
										claudeInteractive.mode === 'interactive'
											? theme.colors.accent
											: (theme.colors.warning ?? theme.colors.accent),
								}}
								title={
									claudeInteractive.modeReason === 'limit'
										? 'Forced fallback: Max plan 5-hour or weekly quota is exhausted.'
										: 'Selected automatically based on current usage.'
								}
							>
								{claudeInteractive.mode === 'interactive' ? 'Time Limits' : 'API Limits'}
							</span>
						)}
					</div>
					<ToggleButtonGroup
						options={claudeTokenModeOptions}
						value={displayClaudeTokenMode}
						onChange={(mode) => {
							const src = toClaudeTokenModeSource(mode);
							onEnableMaestroPChange(src.enableMaestroP);
							onMaestroPModeChange?.(src.maestroPMode);
						}}
						theme={theme}
					/>
					<p className="text-xs opacity-50 mt-2">
						{CLAUDE_TOKEN_MODE_HINTS[displayClaudeTokenMode]}
						{isSshEnabled && displayClaudeTokenMode === 'interactive'
							? ' Runs maestro-p on the remote host (must be on its PATH).'
							: ''}
					</p>
					{remoteMaestroPMissing && (
						<p
							className="text-xs mt-2"
							style={{ color: theme.colors.warning ?? theme.colors.accent }}
						>
							TUI (Max plan) is unavailable: maestro-p was not found on the remote host&apos;s PATH.{' '}
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									openUrl(MAESTRO_P_INSTALL_URL, { ctrlKey: e.ctrlKey || e.metaKey });
								}}
								className="underline hover:no-underline"
								style={{ color: 'inherit' }}
							>
								Install maestro-p
							</button>{' '}
							there to drive the Claude TUI, or use API.
						</p>
					)}
					{/* Local Maestro-P Path override is local-only: over SSH maestro-p
					    is resolved as a bare command on the remote PATH, so hide it. */}
					{showMaestroPDetails && !isSshEnabled && (
						<div className="mt-3">
							<label
								className="block text-xs font-medium mb-2"
								style={{ color: theme.colors.textDim }}
							>
								Maestro-P Path (optional)
							</label>
							<input
								type="text"
								value={maestroPPath}
								onChange={(e) => onMaestroPPathChange?.(e.target.value)}
								onBlur={onMaestroPPathBlur}
								onClick={(e) => e.stopPropagation()}
								placeholder={detectedMaestroPPath ?? '/path/to/maestro-p'}
								className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<p className="text-xs opacity-50 mt-2">
								{detectedMaestroPPath
									? `Auto-detected: ${detectedMaestroPPath}. Override only if you want a different build.`
									: 'No bundled maestro-p found. Point this at a built copy or rebuild Maestro.'}
							</p>
						</div>
					)}
				</div>
			)}

			{/* Custom CLI arguments input */}
			<div
				className={`${padding} rounded border`}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
					Custom Arguments (optional)
				</label>
				<div className="flex gap-2">
					<input
						type="text"
						value={customArgs}
						onChange={(e) => onCustomArgsChange(e.target.value)}
						onBlur={onCustomArgsBlur}
						onClick={(e) => e.stopPropagation()}
						placeholder="--flag value --another-flag"
						className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
				</div>
				<p className="text-xs opacity-50 mt-2">
					Additional CLI arguments appended to all calls to this agent
				</p>
			</div>

			{/* Custom environment variables input */}
			<div
				className={`${padding} rounded border`}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
					Environment Variables (optional)
				</label>
				<div className="space-y-2">
					{/* Built-in env vars (read-only, shown when showBuiltInEnvVars is true) */}
					{showBuiltInEnvVars &&
						BUILT_IN_ENV_VARS.map((envVar) => (
							<div
								key={envVar.key}
								className="flex gap-2 items-center rounded px-2 py-1.5"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								<div
									className="p-2 rounded text-xs font-mono flex items-center gap-1 whitespace-nowrap"
									style={{ color: theme.colors.textDim }}
								>
									<span>{envVar.key}</span>
									<div className="relative inline-block">
										<button
											onClick={(e) => {
												e.stopPropagation();
												setShowingTooltip(showingTooltip === envVar.key ? null : envVar.key);
											}}
											onBlur={() => setTimeout(() => setShowingTooltip(null), 150)}
											className="p-0.5 rounded hover:bg-white/10 transition-colors"
											title="What is this?"
											style={{ color: theme.colors.accent }}
										>
											<HelpCircle className="w-3 h-3" />
										</button>
										{/* Tooltip */}
										{showingTooltip === envVar.key && (
											<div
												className="absolute left-1/2 bottom-full mb-1 z-50 p-3 rounded shadow-lg text-xs whitespace-normal leading-relaxed"
												style={{
													backgroundColor: theme.colors.bgMain,
													border: `1px solid ${theme.colors.border}`,
													color: theme.colors.textMain,
													width: '320px',
													transform: 'translateX(-50%)',
												}}
											>
												{envVar.description}
											</div>
										)}
									</div>
								</div>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									=
								</span>
								<div
									className="p-2 rounded text-xs font-mono italic whitespace-nowrap"
									style={{ color: theme.colors.textDim }}
								>
									{envVar.value}
								</div>
							</div>
						))}
					{/* User-defined env vars */}
					{Object.entries(customEnvVars).map(([key, value]) => (
						<div key={`env-var-${getEnvVarId(key)}`} className="flex gap-2">
							<input
								type="text"
								value={getKeyDisplayValue(key)}
								onChange={(e) => handleKeyInputChange(key, e.target.value)}
								onBlur={() => handleKeyBlur(key, value)}
								onClick={(e) => e.stopPropagation()}
								placeholder="VARIABLE_NAME"
								className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<span className="flex items-center text-xs" style={{ color: theme.colors.textDim }}>
								=
							</span>
							<input
								type="text"
								value={value}
								onChange={(e) => onEnvVarValueChange(key, e.target.value)}
								onBlur={onEnvVarsBlur}
								onClick={(e) => e.stopPropagation()}
								placeholder="value"
								className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<GhostIconButton
								onClick={(e) => {
									e.stopPropagation();
									onEnvVarRemove(key);
								}}
								padding="p-2"
								title="Remove variable"
								color={theme.colors.textDim}
							>
								<Trash2 className="w-3 h-3" />
							</GhostIconButton>
						</div>
					))}
					{/* Add new env var button */}
					<button
						onClick={(e) => {
							e.stopPropagation();
							onEnvVarAdd();
						}}
						className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
					>
						<Plus className="w-3 h-3" />
						Add Variable
					</button>
				</div>
				<p className="text-xs opacity-50 mt-2">
					Agent-specific environment variables (overrides global environment variables from
					Settings). These are passed to all calls to this agent.
				</p>
			</div>

			{/* Agent-specific configuration options (contextWindow, model, etc.) */}
			{agent.configOptions &&
				agent.configOptions.length > 0 &&
				agent.configOptions.map((option: AgentConfigOption) => (
					<div
						key={option.key}
						className={`${padding} rounded border`}
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<label
							className="block text-xs font-medium mb-2"
							style={{ color: theme.colors.textDim }}
						>
							{option.label}
						</label>
						{option.type === 'number' && (
							<input
								type="number"
								value={agentConfig[option.key] ?? option.default}
								onChange={(e) => {
									const value = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
									onConfigChange(option.key, isNaN(value) ? 0 : value);
								}}
								onBlur={(e) => {
									const value = e.target.value === '' ? 0 : parseInt(e.target.value, 10);
									callOnConfigBlurSafely(option.key, isNaN(value) ? 0 : value);
								}}
								onClick={(e) => e.stopPropagation()}
								placeholder={option.default?.toString() || '0'}
								min={0}
								className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
						)}
						{option.type === 'text' && (
							<ModelTextInput
								theme={theme}
								option={option}
								value={agentConfig[option.key] ?? option.default}
								onChange={(value) => onConfigChange(option.key, value)}
								onBlur={(committedValue) => callOnConfigBlurSafely(option.key, committedValue)}
								availableModels={option.key === 'model' ? availableModels : []}
								loadingModels={option.key === 'model' ? loadingModels : false}
								onRefreshModels={
									option.key === 'model' && agent.capabilities?.supportsModelSelection
										? onRefreshModels
										: undefined
								}
							/>
						)}
						{option.type === 'checkbox' && (
							<label
								className="flex items-center gap-2 cursor-pointer"
								onClick={(e) => e.stopPropagation()}
							>
								<input
									type="checkbox"
									checked={agentConfig[option.key] ?? option.default}
									onChange={(e) => {
										onConfigChange(option.key, e.target.checked);
										// Immediately persist checkbox changes
										callOnConfigBlurSafely(option.key, e.target.checked);
									}}
									className="w-4 h-4"
									style={{ accentColor: theme.colors.accent }}
								/>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									Enabled
								</span>
							</label>
						)}
						{option.type === 'select' &&
							(() => {
								// Dynamic selects get their options from IPC discovery
								const opts =
									option.dynamic && dynamicOptions[option.key]?.length
										? dynamicOptions[option.key]
										: option.options;
								if (!opts || opts.length === 0) {
									if (option.dynamic && loadingDynamicOptions) {
										return (
											<p className="text-xs" style={{ color: theme.colors.textDim }}>
												Loading options...
											</p>
										);
									}
									return null;
								}
								return (
									<select
										value={agentConfig[option.key] ?? option.default ?? ''}
										onChange={(e) => {
											onConfigChange(option.key, e.target.value);
											callOnConfigBlurSafely(option.key, e.target.value);
										}}
										onClick={(e) => e.stopPropagation()}
										className="w-full p-2 rounded border bg-transparent outline-none text-xs cursor-pointer"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
											backgroundColor: theme.colors.bgMain,
										}}
									>
										{opts.map((opt) => (
											<option
												key={opt}
												value={opt}
												style={{ backgroundColor: theme.colors.bgMain }}
											>
												{opt || '(default)'}
											</option>
										))}
									</select>
								);
							})()}
						<p className="text-xs opacity-50 mt-2">{option.description}</p>
					</div>
				))}
		</div>
	);
}
