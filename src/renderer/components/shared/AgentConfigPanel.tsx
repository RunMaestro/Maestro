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
import type { Theme, AgentConfig, AgentConfigOption } from '../../types';

// Counter for generating stable IDs for env vars
let envVarIdCounter = 0;

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
	onBlur: () => void;
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
								setShowDropdown(false);
								if (isFiltering) {
									// If user was filtering but didn't select, keep the filter text as the value
									// (they might have typed a custom model name)
									if (filterText && filterText !== committedValueRef.current) {
										onChange(filterText);
										committedValueRef.current = filterText;
									}
									setIsFiltering(false);
									setFilterText('');
								}
								onBlur();
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
										onChange(model);
										committedValueRef.current = model;
										setShowDropdown(false);
										setFilterText('');
										setIsFiltering(false);
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
	onCustomPathClear: () => void;
	// Custom arguments
	customArgs: string;
	onCustomArgsChange: (value: string) => void;
	onCustomArgsBlur: () => void;
	onCustomArgsClear: () => void;
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
	onConfigBlur: () => void;
	// Model selection (if supported)
	availableModels?: string[];
	loadingModels?: boolean;
	onRefreshModels?: () => void;
	// Agent refresh
	onRefreshAgent?: () => void;
	refreshingAgent?: boolean;
	// Optional: compact mode for wizard (less padding)
	compact?: boolean;
	// Show built-in environment variables section
	showBuiltInEnvVars?: boolean;
}

export function AgentConfigPanel({
	theme,
	agent,
	customPath,
	onCustomPathChange,
	onCustomPathBlur,
	onCustomPathClear,
	customArgs,
	onCustomArgsChange,
	onCustomArgsBlur,
	onCustomArgsClear,
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
	onRefreshAgent,
	refreshingAgent = false,
	compact = false,
	showBuiltInEnvVars = false,
}: AgentConfigPanelProps): JSX.Element {
	const padding = compact ? 'p-2' : 'p-3';
	const spacing = compact ? 'space-y-2' : 'space-y-3';
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
			<div
				className={`${padding} rounded border`}
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<label
					className="block text-xs font-medium mb-2 flex items-center justify-between"
					style={{ color: theme.colors.textDim }}
				>
					<span>Path</span>
					{onRefreshAgent && (
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
						value={customPath || agent.path || ''}
						onChange={(e) => onCustomPathChange(e.target.value)}
						onBlur={onCustomPathBlur}
						onClick={(e) => e.stopPropagation()}
						placeholder={`/path/to/${agent.binaryName}`}
						className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					{customPath && customPath !== agent.path && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onCustomPathClear();
							}}
							className="px-2 py-1.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
							title="Reset to detected path"
						>
							Reset
						</button>
					)}
				</div>
				<p className="text-xs opacity-50 mt-2">
					Path to the {agent.binaryName} binary. Edit to override the auto-detected path.
				</p>
			</div>

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
					{customArgs && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onCustomArgsClear();
							}}
							className="px-2 py-1.5 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							Clear
						</button>
					)}
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
							<button
								onClick={(e) => {
									e.stopPropagation();
									onEnvVarRemove(key);
								}}
								className="p-2 rounded hover:bg-white/10 transition-colors"
								title="Remove variable"
								style={{ color: theme.colors.textDim }}
							>
								<Trash2 className="w-3 h-3" />
							</button>
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
					Environment variables passed to all calls to this agent
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
								onBlur={onConfigBlur}
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
								onBlur={onConfigBlur}
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
										onConfigBlur();
									}}
									className="w-4 h-4"
									style={{ accentColor: theme.colors.accent }}
								/>
								<span className="text-xs" style={{ color: theme.colors.textMain }}>
									Enabled
								</span>
							</label>
						)}
						<p className="text-xs opacity-50 mt-2">{option.description}</p>
					</div>
				))}
		</div>
	);
}
