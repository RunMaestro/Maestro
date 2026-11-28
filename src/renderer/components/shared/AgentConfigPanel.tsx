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
import { RefreshCw, Plus, Trash2, HelpCircle, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { ToggleButtonGroup } from '../ToggleButtonGroup';
import type { Theme, AgentConfig, AgentConfigOption } from '../../types';
import {
	getClaudeTokenMode,
	toClaudeTokenModeSource,
	type ClaudeTokenMode,
} from '../../../shared/claudeTokenMode';
import {
	CODEX_DEFAULT_TRANSPORT,
	CODEX_TRANSPORTS,
	type CodexTransport,
} from '../../../shared/codexTransport';
import { readOpenCodeAgentArg, writeOpenCodeAgentArg } from '../../../shared/opencodeAgentArg';
import {
	supportsNativeControl,
	type HarnessControlMode,
} from '../../../shared/maestro-lib/providers/native-control';
import { useRemoteMaestroPAvailable } from '../../hooks/agent/useRemoteMaestroPAvailable';
import { useRemoteAgentDetection } from '../../hooks/agent/useRemoteAgentDetection';
import { openUrl } from '../../utils/openUrl';
import { logger } from '../../utils/logger';
import { useKnownAuthDirs } from '../../hooks/agent/useKnownAuthDirs';
import { AuthPathValueInput } from './AuthPathValueInput';
import { EnvVarKeyInput } from './EnvVarKeyInput';
import {
	ENV_VARS_ADVANCED_MODE_STORAGE_KEY,
	EnvVarsDotEnvInput,
	EnvVarsModeToggle,
} from './EnvVarsDotEnvInput';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { BLANK_ENV_VAR_KEY } from '../../../shared/envVarCatalog';
import { useKnownEnvVarKeys } from '../../hooks/agent/useKnownEnvVarKeys';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import { getAgentDisplayName, getPermissionModeTooltip } from '../../../shared/agentMetadata';

const MAESTRO_P_INSTALL_URL = 'https://runmaestro.ai/maestro-p/';

// Sentinel value for the installation chooser's "Custom" entry, used when the
// active path was typed by hand and isn't one of the auto-detected locations.
const CUSTOM_PATH_OPTION = '__custom__';

// Counter for generating stable IDs for env vars
let envVarIdCounter = 0;

// Claude token-source selector (claude-code only). Maps the tri-state
// ClaudeTokenMode onto the segmented control labels plus a one-line hint each.
const CLAUDE_TOKEN_MODE_OPTIONS: { value: ClaudeTokenMode; label: string }[] = [
	{ value: 'api', label: 'claude -p' },
	{ value: 'interactive', label: 'TUI Wrapper' },
	{ value: 'dynamic', label: 'Dynamic' },
];

/**
 * Why a token source cannot run for this agent, shown when it is chosen (and
 * while a stored choice falls back to claude -p). The options stay in the list
 * in every mode; only the machine the turns run on decides what works.
 */
const CLAUDE_TOKEN_MODE_REFUSALS = {
	dynamic:
		'Dynamic is not available for this agent: it switches on the plan-limit usage this computer reads, and this agent runs on another computer, whose account that usage does not describe. Turns use claude -p.',
	interactive:
		'TUI Wrapper is not available for this agent: maestro-p was not found on the PATH of the computer this agent runs on. Turns use claude -p.',
} as const;

const CLAUDE_TOKEN_MODE_HINTS: Record<ClaudeTokenMode, string> = {
	api: 'Run every turn through claude --print. Signed in with a Claude plan, it draws from your plan limits; with an API key set, it bills that key.',
	interactive:
		'Run every turn through the Claude TUI via maestro-p. Signed in with a Claude plan, it draws from your plan limits.',
	dynamic:
		'Start on the TUI, switch to claude --print near a plan limit. The switch only helps with an API key set: signed in with a plan alone, both draw from the same limits.',
};

// Codex transport selector (codex only). Labels follow CODEX_TRANSPORTS order,
// so the default (`exec`) is always the first segment.
const CODEX_TRANSPORT_LABELS: Record<CodexTransport, string> = {
	exec: 'codex exec',
	'app-server': 'codex app-server',
};

const CODEX_TRANSPORT_OPTIONS: { value: CodexTransport; label: string }[] = CODEX_TRANSPORTS.map(
	(value) => ({ value, label: CODEX_TRANSPORT_LABELS[value] })
);

const HARNESS_CONTROL_OPTIONS: { value: HarnessControlMode; label: string }[] = [
	{ value: 'current', label: 'current (default)' },
	{ value: 'native', label: 'native control' },
];

// Built-in environment variables that Maestro sets automatically
const BUILT_IN_ENV_VARS: { key: string; description: string; value: string }[] = [
	{
		key: 'MAESTRO_SESSION_RESUMED',
		description:
			'Set to "1" when resuming an existing session. Not set for new sessions. Use this in your agent hooks to skip initialization on resumed sessions.',
		value: '1 (when resuming)',
	},
];

// Separate component for text input with optional discovered options
// This avoids the browser's native datalist styling issues
interface ModelTextInputProps {
	theme: Theme;
	option: { key: string; label: string; default?: string };
	disabled?: boolean;
	value: string;
	onChange: (value: string) => void;
	onBlur: (committedValue: string) => void;
	availableOptions: string[];
	loadingOptions: boolean;
	onRefreshModels?: () => void;
}

function ModelTextInput({
	theme,
	option,
	disabled = false,
	value,
	onChange,
	onBlur,
	availableOptions,
	loadingOptions,
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

	// Filter the supplied options without adding unadvertised effort levels.
	const filteredOptions = useMemo(() => {
		if (!filterText) return availableOptions;
		const lower = filterText.toLowerCase();
		return availableOptions.filter((m) => m.toLowerCase().includes(lower));
	}, [availableOptions, filterText]);

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
	const hasOptions = !disabled && availableOptions.length > 0;
	const isEffortField = option.key === 'effort' || option.key === 'reasoningEffort';

	// Display value: when filtering, show filter text; otherwise show actual value
	const displayValue = isFiltering ? filterText : value;

	return (
		<>
			<div className="flex gap-2" ref={containerRef}>
				<div className="relative flex-1">
					<input
						ref={inputRef}
						type="text"
						aria-label={option.label}
						disabled={disabled}
						value={displayValue}
						onChange={(e) => {
							if (hasOptions) {
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
							if (hasOptions) {
								setFilterText(value);
								setShowDropdown(true);
							}
						}}
						onBlur={() => {
							// Delay to allow click on dropdown item
							setTimeout(() => {
								// A policy or capability may disable the input while blur is queued.
								if (!inputRef.current || inputRef.current.matches(':disabled')) return;
								// If a dropdown item was clicked, skip blur logic - the click handler already committed the value
								if (selectionMadeRef.current) {
									selectionMadeRef.current = false;
									return;
								}
								setShowDropdown(false);
								if (isFiltering) {
									// If user was filtering but didn't select, keep the filter text as the value
									// (explicit values remain valid inputs when discovery is unavailable)
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
					{hasOptions && (
						<button
							type="button"
							aria-label={`Show ${option.label.toLowerCase()} options`}
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
					{hasOptions && showDropdown && filteredOptions.length > 0 && (
						<div
							className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded"
							style={{
								...elevatedSurfaceStyle(theme),
							}}
						>
							{filteredOptions.map((model) => (
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
				{(isModelField || isEffortField) && value && (
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
						disabled={disabled}
						aria-label={`Clear ${option.label.toLowerCase()} override`}
						title={isModelField ? 'Reset to default model' : 'Inherit the selected model default'}
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
						disabled={disabled}
						title="Refresh available models"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					>
						<RefreshCw className={`w-3 h-3 ${loadingOptions ? 'animate-spin' : ''}`} />
					</button>
				)}
			</div>
			{loadingOptions && (
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					{isModelField ? 'Loading available models...' : 'Loading effort options...'}
				</p>
			)}
			{isModelField && !loadingOptions && hasOptions && (
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					{availableOptions.length} model{availableOptions.length !== 1 ? 's' : ''} available
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
	/**
	 * Called to persist the path. Optionally receives the value to persist -
	 * the chooser below passes its selection directly, since onCustomPathChange
	 * and this call happen back to back in the same handler and React batches
	 * state updates, so a blur handler reading customPath back out of its own
	 * closure would still see the PREVIOUS value at that point. Plain blur
	 * (typing then tabbing away) calls this with no argument, since the input
	 * is already controlled and current by the time it fires.
	 */
	onCustomPathBlur: (value?: string) => void;
	// Custom arguments
	customArgs: string;
	onCustomArgsChange: (value: string) => void;
	onCustomArgsBlur: () => void;
	// Environment variables
	customEnvVars: Record<string, string>;
	/**
	 * Parked env vars: same shape as `customEnvVars`, but switched off. Pass this
	 * together with `onEnvVarToggle` to get the per-row eye button; omit both and
	 * the panel behaves exactly as before (every row is active, no eye).
	 *
	 * A parked var is kept OUT of `customEnvVars` on purpose - that is what lets
	 * every spawn path keep reading one record with no filter.
	 */
	customEnvVarsDisabled?: Record<string, string>;
	/** Move a var between the active and parked records. `nextEnabled` is the state being switched TO. */
	onEnvVarToggle?: (key: string, nextEnabled: boolean) => void;
	/**
	 * The trailing `enabled` argument on these four says WHICH record the row
	 * being edited lives in, so the parent knows where to write. It is always
	 * `true` when the toggle props are omitted, which is why the existing
	 * two-argument handlers in non-toggling consumers keep working untouched.
	 */
	onEnvVarKeyChange: (oldKey: string, newKey: string, value: string, enabled?: boolean) => void;
	onEnvVarValueChange: (key: string, value: string, enabled?: boolean) => void;
	onEnvVarRemove: (key: string, enabled?: boolean) => void;
	onEnvVarAdd: () => void;
	onEnvVarsBlur: () => void;
	/**
	 * Replace both records whole. Pass it to get the Basic / Advanced toggle,
	 * where Advanced edits every variable as `.env` text; omit it and the panel
	 * is rows only. It exists because the row callbacks above cannot express a
	 * paste: several of them fired in one tick each rebuild the record from the
	 * same stale copy, so only the last would survive. `disabledVars` is always
	 * `{}` for a consumer that does not pass `customEnvVarsDisabled`.
	 */
	onEnvVarsReplace?: (vars: Record<string, string>, disabledVars: Record<string, string>) => void;
	// Agent-specific config options
	agentConfig: Record<string, any>;
	/**
	 * Per-option advisory notes, keyed by `AgentConfigOption.key`, rendered under
	 * the matching control above its description.
	 *
	 * Opt-in on purpose (#1370): only the Edit Agent surface can populate this,
	 * because deciding whether a stored value is currently overridden needs the
	 * session AND its live usage stats, neither of which this panel receives. The
	 * create surfaces (New Agent, the Wizard, AgentCreationDialog) have no session
	 * to override and write a materialization by design, so they pass nothing.
	 */
	configOptionNotes?: Record<string, React.ReactNode>;
	onConfigChange: (key: string, value: any) => void;
	/** Called when a config field blurs. For text fields, `committedValue` is the value that was just saved. */
	onConfigBlur: (key: string, committedValue: any) => void | Promise<void>;
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
	// === Codex usage resets (codex agent only) ===
	/**
	 * Spend a rate-limit reset credit automatically when this agent hits a
	 * plan-quota wall. Off by default. Rendered directly under Reasoning Effort,
	 * because that is where the Codex-specific settings end and this is the last
	 * of them.
	 */
	codexAutoResetOnExhaustion?: boolean;
	onCodexAutoResetChange?: (value: boolean) => void;
	/**
	 * How this agent's chat turns reach Codex. `undefined` means `exec`, the
	 * default. Rendered beside the Claude Token Source slot (the two are never
	 * shown together) and only when the handler is supplied.
	 */
	codexTransport?: CodexTransport;
	onCodexTransportChange?: (transport: CodexTransport) => void;
	/** Optional native protocol mode for providers with a qualified native adapter. */
	harnessControlMode?: HarnessControlMode;
	onHarnessControlModeChange?: (mode: HarnessControlMode) => void;
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
	customEnvVarsDisabled,
	onEnvVarToggle,
	onEnvVarKeyChange,
	onEnvVarValueChange,
	onEnvVarRemove,
	onEnvVarAdd,
	onEnvVarsBlur,
	onEnvVarsReplace,
	agentConfig,
	configOptionNotes,
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
	codexAutoResetOnExhaustion = false,
	onCodexAutoResetChange,
	codexTransport = CODEX_DEFAULT_TRANSPORT,
	onCodexTransportChange,
	harnessControlMode = 'current',
	onHarnessControlModeChange,
}: AgentConfigPanelProps): JSX.Element {
	const callOnConfigBlurSafely = (key: string, committedValue: any) => {
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
	// run the TUI, so choosing it is refused and the agent runs claude -p
	// (mirrors resolveClaudeSpawnMode, which falls a remote TUI spawn back to api).
	// undefined = unknown (not SSH, still probing, or unreachable): stay optimistic.
	const {
		available: remoteMaestroPAvailable,
		isProbing: remoteMaestroPProbing,
		refresh: refreshRemoteMaestroP,
	} = useRemoteMaestroPAvailable(isSshEnabled ? sshRemoteId : undefined);
	const remoteMaestroPMissing = isSshEnabled && remoteMaestroPAvailable === false;
	// Detection runs where the agent runs: this computer for a local agent, the
	// SSH remote (over SSH) for a remote or hosted one. The Path field and the
	// Detect button read and act on that one answer in every mode.
	const remoteDetection = useRemoteAgentDetection(agent.id, isSshEnabled ? sshRemoteId : undefined);
	const detectedPath = isSshEnabled ? remoteDetection.path : agent.path;
	const redetectAgent = isSshEnabled
		? () => {
				remoteDetection.redetect();
				refreshRemoteMaestroP();
			}
		: onRefreshAgent;
	const redetectingAgent = isSshEnabled
		? remoteDetection.detecting || remoteMaestroPProbing
		: refreshingAgent;
	const knownAuthDirs = useKnownAuthDirs(!isSshEnabled);
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
	// Every agent is offered the same three sources. A source that cannot run
	// where this agent runs is refused with its reason when chosen: Dynamic reads
	// a LOCAL usage snapshot that says nothing about a remote account's quota,
	// and the TUI needs maestro-p on the remote's PATH. A stored choice that
	// cannot run displays (and behaves) as claude -p, mirroring
	// resolveClaudeSpawnMode, and says why; the stored preference is left
	// untouched so disabling SSH restores it.
	const claudeTokenModeRefusal = (mode: ClaudeTokenMode): string | null =>
		isSshEnabled && mode === 'dynamic'
			? CLAUDE_TOKEN_MODE_REFUSALS.dynamic
			: remoteMaestroPMissing && mode === 'interactive'
				? CLAUDE_TOKEN_MODE_REFUSALS.interactive
				: null;
	const [refusedClaudeTokenMode, setRefusedClaudeTokenMode] = useState<ClaudeTokenMode | null>(
		null
	);
	const shownClaudeTokenModeRefusal = claudeTokenModeRefusal(
		refusedClaudeTokenMode ?? claudeTokenMode
	);
	const displayClaudeTokenMode: ClaudeTokenMode = claudeTokenModeRefusal(claudeTokenMode)
		? 'api'
		: claudeTokenMode;
	const showMaestroPDetails = displayClaudeTokenMode !== 'api';
	// The Maestro-P Path field is the same field in every mode. An agent on a
	// remote runs maestro-p from that computer's PATH (REMOTE_MAESTRO_P_COMMAND),
	// so an override, a path on this computer, is refused there with its reason.
	const maestroPPathField = isSshEnabled
		? {
				value: '',
				disabled: true,
				placeholder: 'maestro-p',
				hint: 'This agent runs maestro-p from the PATH of the computer it runs on, so it cannot be overridden here.',
			}
		: {
				value: maestroPPath,
				disabled: false,
				placeholder: detectedMaestroPPath ?? '/path/to/maestro-p',
				hint: detectedMaestroPPath
					? `Auto-detected: ${detectedMaestroPPath}. Override only if you want a different build.`
					: 'No bundled maestro-p found. Point this at a built copy or rebuild Maestro.',
			};
	// Track which built-in env var tooltip is showing
	const knownEnvVarKeys = useKnownEnvVarKeys();
	// Set when the user presses "Add Variable", cleared once the new unnamed row
	// has taken the caret. Not derived from "is this row blank": a blank row can
	// also arrive from disk, and that one must not steal focus on modal open.
	const [focusNewEnvVarRow, setFocusNewEnvVarRow] = useState(false);
	const { value: envVarsAdvancedPreferred, setValue: setEnvVarsAdvanced } = usePersistedToggle(
		ENV_VARS_ADVANCED_MODE_STORAGE_KEY
	);
	// A consumer that cannot take a whole-record replace stays on rows, whatever
	// the remembered preference says.
	const envVarsAdvanced = envVarsAdvancedPreferred && Boolean(onEnvVarsReplace);
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

	// Clean up stale IDs when env vars change (only if not currently being edited).
	// Parked keys count as current: a toggle only moves a var between the two
	// records, and dropping its ID there would remount the row mid-click.
	useMemo(() => {
		const currentKeys = new Set([
			...Object.keys(customEnvVars),
			...Object.keys(customEnvVarsDisabled ?? {}),
		]);
		for (const key of envVarIdsRef.current.keys()) {
			if (!currentKeys.has(key) && !pendingKeyEditsRef.current.has(key)) {
				envVarIdsRef.current.delete(key);
				pendingKeyEditsRef.current.delete(key);
			}
		}
	}, [customEnvVars, customEnvVarsDisabled]);

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
	const handleKeyBlur = (originalKey: string, currentValue: string, enabled: boolean) => {
		const pendingKey = pendingKeyEditsRef.current.get(originalKey);
		pendingKeyEditsRef.current.delete(originalKey);

		// Update the ID map if key changed
		if (pendingKey !== undefined && pendingKey !== originalKey) {
			const id = envVarIdsRef.current.get(originalKey);
			if (id !== undefined) {
				envVarIdsRef.current.delete(originalKey);
				envVarIdsRef.current.set(pendingKey, id);
			}
			onEnvVarKeyChange(originalKey, pendingKey, currentValue, enabled);
		}
		onEnvVarsBlur();
	};

	// The toggle needs both halves to round-trip a parked var; with only one,
	// switching a row off would drop its value on the floor.
	const canToggleEnvVars = Boolean(customEnvVarsDisabled && onEnvVarToggle);

	// One list over both records. Sorting by the stable ID (assigned in first-seen
	// order and preserved across a toggle) is what keeps a row where it is when
	// the user switches it off, instead of letting it jump to the parked group.
	const envVarRows = [
		...Object.entries(customEnvVars).map(([key, value]) => ({ key, value, enabled: true })),
		...Object.entries(customEnvVarsDisabled ?? {}).map(([key, value]) => ({
			key,
			value,
			enabled: false,
		})),
	]
		// Resolve every ID up front: `sort` visits pairs in an engine-defined order,
		// so minting IDs inside the comparator would number the rows by comparison
		// order rather than by list order.
		.map((row) => ({ ...row, id: getEnvVarId(row.key) }))
		.sort((a, b) => a.id - b.id);
	const envVarKeys = envVarRows.map((row) => row.key);

	// Multi-install chooser state. `activePath` is whatever the Path field
	// currently resolves to; it may be a hand-typed wrapper (or a tilde path
	// that detection reports in expanded form), in which case it won't match
	// any detected option and we surface it as an explicit "Custom" entry
	// rather than letting the <select> silently display the first option.
	// Detection lists every installation where the agent runs (the SSH remote
	// for a remote or hosted agent), so the chooser shows in every mode.
	const detectedPaths = isSshEnabled ? remoteDetection.allPaths : (agent.allPaths ?? []);
	const activePath = customPath || detectedPath || '';
	const activePathIsDetected = detectedPaths.includes(activePath);

	return (
		<div className={spacing}>
			{agent.id === 'grok' && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Full Access uses headless streaming. {getPermissionModeTooltip('standard', agent.id)}{' '}
					{getPermissionModeTooltip('readonly', agent.id)} Select the account through the
					environment variables below; model and effort discovery follows that selection.
				</p>
			)}
			{/* Path input - pre-filled with the path detected where the agent runs, editable to override */}
			<div
				className={`${padding} rounded border`}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<label
					className="block text-xs font-medium mb-2 flex items-center justify-between"
					style={{ color: theme.colors.textDim }}
				>
					<span>Path</span>
					{onRefreshAgent && redetectAgent && (
						<button
							onClick={redetectAgent}
							className="p-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1"
							title="Re-detect agent path"
							style={{ color: theme.colors.textDim }}
						>
							<RefreshCw className={`w-3 h-3 ${redetectingAgent ? 'animate-spin' : ''}`} />
							<span className="text-xs">Detect</span>
						</button>
					)}
				</label>
				<div className="flex gap-2">
					<input
						type="text"
						// Pre-fills with the path detected where the agent runs, so it can be
						// overridden (an empty customPath means "use the detected binary").
						aria-label="Path"
						value={customPath || detectedPath || ''}
						onChange={(e) => onCustomPathChange(e.target.value)}
						onBlur={() => onCustomPathBlur()}
						onClick={(e) => e.stopPropagation()}
						placeholder={`/path/to/${agent.binaryName}`}
						className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				</div>
				{/*
				 * Multi-install chooser (e.g. nvm-managed codex alongside a
				 * codex-multi-auth-codex wrapper). Shown whenever detection found
				 * more than one valid binary.
				 */}
				{detectedPaths.length > 1 && (
					<div className="mt-2">
						<label
							className="block text-xs font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Detected installations ({detectedPaths.length})
						</label>
						<select
							value={activePathIsDetected ? activePath : CUSTOM_PATH_OPTION}
							onChange={(e) => {
								const next = e.target.value;
								if (next === CUSTOM_PATH_OPTION) return;
								onCustomPathChange(next);
								// Persist immediately - selecting from the chooser is an explicit commit.
								// Pass the value directly rather than relying on onCustomPathBlur to read
								// it back out of state: onCustomPathChange above only schedules a state
								// update, so a blur handler reading its own closure would still see the
								// path from before this click, not the one just selected.
								onCustomPathBlur(next);
							}}
							onClick={(e) => e.stopPropagation()}
							className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono cursor-pointer"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								backgroundColor: theme.colors.bgMain,
							}}
						>
							{!activePathIsDetected && (
								<option value={CUSTOM_PATH_OPTION} style={{ backgroundColor: theme.colors.bgMain }}>
									{activePath ? `Custom: ${activePath}` : 'Custom path'}
								</option>
							)}
							{detectedPaths.map((p) => (
								<option key={p} value={p} style={{ backgroundColor: theme.colors.bgMain }}>
									{p}
								</option>
							))}
						</select>
						<p className="text-xs opacity-50 mt-1">
							Multiple {agent.binaryName} binaries were found. Your selection is saved as the
							default for future agents.
						</p>
					</div>
				)}
				<p className="text-xs opacity-50 mt-2">
					{`Path to the ${agent.binaryName} binary. Edit to override the auto-detected path.`}
				</p>
			</div>

			{/* Claude Token Source selector - Claude Code only. Picks how this agent
			    runs a turn: claude --print, the Claude TUI via maestro-p, or Dynamic
			    (start on the TUI, switch to claude --print when the 5-hour or weekly
			    window is near its limit, then snap back once both windows reset).
			    The mode does not pick the bill: signed in with a plan, both draw
			    from the same plan limits; an API key in the env bills that key. Every
			    agent is offered the same three sources; one that cannot run where the
			    agent runs (Dynamic, or the TUI without maestro-p, on a remote) is
			    refused with its reason when chosen. */}
			{agent.id === 'claude-code' && onEnableMaestroPChange && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<div className="flex items-center gap-2 min-w-0 mb-2">
						<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
							Claude Token Source
						</span>
					</div>
					<ToggleButtonGroup
						options={CLAUDE_TOKEN_MODE_OPTIONS}
						value={displayClaudeTokenMode}
						onChange={(mode) => {
							if (claudeTokenModeRefusal(mode)) {
								setRefusedClaudeTokenMode(mode);
								return;
							}
							setRefusedClaudeTokenMode(null);
							const src = toClaudeTokenModeSource(mode);
							onEnableMaestroPChange(src.enableMaestroP);
							onMaestroPModeChange?.(src.maestroPMode);
						}}
						theme={theme}
					/>
					<p className="text-xs opacity-50 mt-2">
						{CLAUDE_TOKEN_MODE_HINTS[displayClaudeTokenMode]}
					</p>
					{shownClaudeTokenModeRefusal && (
						<p
							className="text-xs mt-2"
							role="status"
							style={{ color: theme.colors.warning ?? theme.colors.accent }}
						>
							{shownClaudeTokenModeRefusal}
							{shownClaudeTokenModeRefusal === CLAUDE_TOKEN_MODE_REFUSALS.interactive && (
								<>
									{' '}
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
									</button>
								</>
							)}
						</p>
					)}
					{showMaestroPDetails && (
						<div className="mt-3">
							<label
								className="block text-xs font-medium mb-2"
								style={{ color: theme.colors.textDim }}
							>
								Maestro-P Path (optional)
							</label>
							<input
								type="text"
								aria-label="Maestro-P Path (optional)"
								value={maestroPPathField.value}
								disabled={maestroPPathField.disabled}
								onChange={(e) => onMaestroPPathChange?.(e.target.value)}
								onBlur={() => onMaestroPPathBlur?.()}
								onClick={(e) => e.stopPropagation()}
								placeholder={maestroPPathField.placeholder}
								className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono disabled:opacity-50"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<p className="text-xs opacity-50 mt-2">{maestroPPathField.hint}</p>
						</div>
					)}
				</div>
			)}

			{/* Codex Transport selector - Codex only, in the same slot the Claude
			    Token Source occupies for Claude. App server is an opt-in preference,
			    not a guarantee: turns the app-server spawner cannot carry (SSH,
			    images, Auto Run, Cue) still run on codex exec. Gated on the handler
			    so a surface that does not persist the field shows nothing. */}
			{agent.id === 'codex' && onCodexTransportChange && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					data-testid="codex-transport-option"
				>
					<span className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
						Codex Transport
					</span>
					<ToggleButtonGroup
						options={CODEX_TRANSPORT_OPTIONS}
						value={codexTransport}
						onChange={onCodexTransportChange}
						theme={theme}
					/>
					<p className="text-xs opacity-50 mt-2">
						codex app-server is the default: it streams reasoning and runs local interactive chat
						turns so a queued message can steer a turn that is already running. codex exec is the
						explicit alternative and never shows reasoning. Image, Auto Run, and Cue turns use codex
						exec on either setting.
					</p>
				</div>
			)}

			{supportsNativeControl(agent.id) && onHarnessControlModeChange && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					data-testid="harness-control-mode-option"
				>
					<span className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
						Control Mode
					</span>
					<ToggleButtonGroup
						options={HARNESS_CONTROL_OPTIONS}
						value={harnessControlMode}
						onChange={onHarnessControlModeChange}
						theme={theme}
					/>
					<p className="text-xs opacity-50 mt-2">
						current is the default and preserves the existing CLI flow. native control opts into a
						provider protocol with streaming events and native approval prompts where supported.
						Steering semantics vary by provider. SSH turns are not supported in native mode.
					</p>
				</div>
			)}

			{/* OpenCode primary-agent selection, shared with its forks (Kilo).
			    Backed by Custom Arguments (`--agent <name>`) rather than a config
			    option, because Custom Arguments are per-agent while config options
			    are shared by every agent on the provider. */}
			{(agent.id === 'opencode' || agent.id === 'kilo') && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<label
						className="block text-xs font-medium mb-2"
						style={{ color: theme.colors.textDim }}
						htmlFor={`${agent.id}-agent-input`}
					>
						{getAgentDisplayName(agent.id)} Agent (optional)
					</label>
					<input
						id={`${agent.id}-agent-input`}
						type="text"
						value={readOpenCodeAgentArg(customArgs)}
						onChange={(e) => onCustomArgsChange(writeOpenCodeAgentArg(customArgs, e.target.value))}
						onBlur={() => onCustomArgsBlur()}
						onClick={(e) => e.stopPropagation()}
						placeholder="build"
						className="w-full p-2 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					<p className="text-xs opacity-50 mt-2">
						Runs as <span className="font-mono">{agent.command} run --agent &lt;name&gt;</span> so
						this Maestro agent keeps that {getAgentDisplayName(agent.id)} agent&apos;s persona,
						model, and instructions. Accepts plugin-provided agents (oh-my-opencode and friends),
						which are resolved at run time even when{' '}
						<span className="font-mono">{agent.command} agent list</span> does not show them. The
						value is stored in Custom Arguments below. Plan mode still forces{' '}
						<span className="font-mono">--agent plan</span>.
					</p>
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
						aria-label="Custom Arguments"
						value={customArgs}
						onChange={(e) => onCustomArgsChange(e.target.value)}
						// Called with no arguments, never handed the FocusEvent: a parent that
						// shares one persist function across these blur props (Director's Notes)
						// would store the event and fail the settings IPC write (MAESTRO-11C).
						onBlur={() => onCustomArgsBlur()}
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
				<div className="flex items-center justify-between gap-2 mb-2">
					<label className="block text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Environment Variables (optional)
					</label>
					{onEnvVarsReplace && (
						<div onClick={(e) => e.stopPropagation()}>
							<EnvVarsModeToggle
								advanced={envVarsAdvanced}
								onChange={setEnvVarsAdvanced}
								theme={theme}
							/>
						</div>
					)}
				</div>
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
												className="absolute left-1/2 bottom-full mb-1 z-50 p-3 rounded text-xs whitespace-normal leading-relaxed"
												style={{
													...elevatedSurfaceStyle(theme),
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
					{/* User-defined env vars, as `.env` text */}
					{envVarsAdvanced && onEnvVarsReplace && (
						<div onClick={(e) => e.stopPropagation()}>
							<EnvVarsDotEnvInput
								theme={theme}
								envVars={customEnvVars}
								disabledEnvVars={canToggleEnvVars ? customEnvVarsDisabled : undefined}
								onChange={onEnvVarsReplace}
								onBlur={onEnvVarsBlur}
							/>
						</div>
					)}
					{/* User-defined env vars, a row each */}
					{!envVarsAdvanced &&
						envVarRows.map(({ key, value, enabled, id }) => {
							const off = !enabled;
							return (
								<div key={`env-var-${id}`} className="flex gap-2 items-center">
									{canToggleEnvVars && (
										<GhostIconButton
											onClick={(e) => {
												e.stopPropagation();
												onEnvVarToggle?.(key, off);
											}}
											padding="p-2"
											title={
												off
													? `Enable ${key || 'variable'} (currently not passed to this agent)`
													: `Disable ${key || 'variable'} (keeps the value, stops passing it to this agent)`
											}
											color={off ? theme.colors.textDim : theme.colors.accent}
										>
											{off ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
										</GhostIconButton>
									)}
									<EnvVarKeyInput
										theme={theme}
										value={getKeyDisplayValue(key)}
										onChange={(nextKey) => handleKeyInputChange(key, nextKey)}
										onBlur={() => handleKeyBlur(key, value, enabled)}
										toolType={agent.id}
										knownEnvVarKeys={knownEnvVarKeys}
										usedKeys={envVarKeys}
										autoFocus={focusNewEnvVarRow && key === BLANK_ENV_VAR_KEY}
										onAutoFocused={() => setFocusNewEnvVarRow(false)}
										className="p-2 rounded border bg-transparent outline-none text-xs font-mono"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
											opacity: off ? 0.45 : 1,
											textDecoration: off ? 'line-through' : undefined,
										}}
									/>
									<span
										className="flex items-center text-xs"
										style={{ color: theme.colors.textDim }}
									>
										=
									</span>
									<AuthPathValueInput
										envVarKey={key}
										value={value}
										knownAuthDirs={knownAuthDirs}
										onChange={(updatedValue) => onEnvVarValueChange(key, updatedValue, enabled)}
										onBlur={() => onEnvVarsBlur()}
										className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
										containerClassName="flex-[2] min-w-0"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
											opacity: off ? 0.45 : 1,
											textDecoration: off ? 'line-through' : undefined,
										}}
									/>
									<GhostIconButton
										onClick={(e) => {
											e.stopPropagation();
											onEnvVarRemove(key, enabled);
										}}
										padding="p-2"
										title="Remove variable"
										color={theme.colors.textDim}
									>
										<Trash2 className="w-3 h-3" />
									</GhostIconButton>
								</div>
							);
						})}
					{/* Add new env var button */}
					{!envVarsAdvanced && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								setFocusNewEnvVarRow(true);
								onEnvVarAdd();
							}}
							className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							<Plus className="w-3 h-3" />
							Add Variable
						</button>
					)}
				</div>
				<p className="text-xs opacity-50 mt-2">
					Agent-specific environment variables (overrides global environment variables from
					Settings). These are passed to all calls to this agent.
				</p>
			</div>

			{/* Agent-specific configuration options (contextWindow, model, etc.) */}
			{agent.configOptions &&
				agent.configOptions.length > 0 &&
				agent.configOptions.map((option: AgentConfigOption) => {
					return (
						<fieldset
							key={option.key}
							disabled={option.key === 'model' && !agent.capabilities?.supportsModelSelection}
							className={`${padding} min-w-0 rounded border`}
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
									aria-label={option.label}
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
									availableOptions={
										option.key === 'model' ? availableModels : (dynamicOptions[option.key] ?? [])
									}
									loadingOptions={option.key === 'model' ? loadingModels : loadingDynamicOptions}
									disabled={option.key === 'model' && !agent.capabilities?.supportsModelSelection}
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
											aria-label={option.label}
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
							{option.key === 'model' && !agent.capabilities?.supportsModelSelection && (
								<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
									Model selection is unavailable for this provider.
								</p>
							)}
							{configOptionNotes?.[option.key] && (
								<p
									className="text-xs mt-2"
									style={{ color: theme.colors.warning }}
									data-testid={`config-option-note-${option.key}`}
								>
									{configOptionNotes[option.key]}
								</p>
							)}
							<p className="text-xs opacity-50 mt-2">{option.description}</p>
						</fieldset>
					);
				})}

			{/* Automatic usage resets - Codex only, and last, so it sits directly
			    under Reasoning Effort where the Codex settings end.

			    Gated on the handler as well as the provider: the panel is shared
			    with surfaces that do not persist this flag, and a checkbox whose
			    change goes nowhere is worse than no checkbox. */}
			{agent.id === 'codex' && onCodexAutoResetChange && (
				<div
					className={`${padding} rounded border`}
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					data-testid="codex-auto-reset-option"
				>
					<label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
						Automatic Usage Resets
					</label>
					<label
						className="flex items-center gap-2 cursor-pointer"
						onClick={(e) => e.stopPropagation()}
					>
						<input
							type="checkbox"
							checked={codexAutoResetOnExhaustion}
							onChange={(e) => onCodexAutoResetChange(e.target.checked)}
							className="w-4 h-4"
							style={{ accentColor: theme.colors.accent }}
							aria-label="Automatically redeem a reset credit when usage limits are hit"
						/>
						<span className="text-xs" style={{ color: theme.colors.textMain }}>
							Redeem a reset credit when this agent hits its usage limit
						</span>
					</label>
					<p className="text-xs opacity-50 mt-2">
						Off by default. Reset credits are granted by OpenAI, are limited, expire, and cannot be
						refunded - so Maestro only spends one when the account is actually blocked and the reset
						would take effect. Manage them under Usage Dashboard - OpenAI Usage.
					</p>
				</div>
			)}
		</div>
	);
}
