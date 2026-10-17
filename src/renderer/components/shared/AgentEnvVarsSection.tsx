/**
 * AgentEnvVarsSection.tsx
 *
 * The per-agent environment variable editor: the user's own rows (with the
 * optional park/unpark eye), the "Add Variable" button, and, when asked, the
 * read-only list of variables Maestro sets itself. `AgentConfigPanel` renders
 * it in place by default; a tabbed agent form sets `hideEnvVars` on the panel
 * and mounts this section on its own Environment tab instead.
 *
 * Why this is not `Settings/EnvVarsEditor.tsx`: the two edit the same shape
 * but hand changes back differently, and swapping one for the other would
 * change behavior in all six composers of `AgentConfigPanel`.
 * - EnvVarsEditor owns a local row list and pushes WHOLE records back
 *   (`setEnvVars(record)`) on every keystroke. This section owns no rows: it
 *   reports each edit through per-row callbacks (`onEnvVarKeyChange`,
 *   `onEnvVarValueChange`, `onEnvVarRemove`, `onEnvVarToggle`), and the parent
 *   writes its own records (keyed by provider in New Agent, flat in Edit Agent,
 *   through `useAgentConfiguration` in Group Chat).
 * - A key rename here is deferred to blur, then committed with `onEnvVarsBlur`
 *   so the parent can persist; EnvVarsEditor commits on change and has no blur.
 * - "Add Variable" here asks the parent to insert the blank row
 *   (`onEnvVarAdd`); EnvVarsEditor inserts it locally.
 * - EnvVarsEditor validates names and values and drops invalid rows from the
 *   record it emits. This section does not validate, so a value an agent
 *   already stores (for example one containing `$`) is never silently dropped.
 * - This section offers the provider's own variable names (`toolType`) and
 *   stops click propagation, because it sits inside the clickable provider
 *   cards of the New Agent picker grid.
 */

import { useState, useRef, useMemo } from 'react';
import { Plus, Trash2, HelpCircle, Eye, EyeOff } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { Theme } from '../../types';
import { useKnownAuthDirs } from '../../hooks/agent/useKnownAuthDirs';
import { useKnownEnvVarKeys } from '../../hooks/agent/useKnownEnvVarKeys';
import { AuthPathValueInput } from './AuthPathValueInput';
import { EnvVarKeyInput } from './EnvVarKeyInput';
import { BLANK_ENV_VAR_KEY } from '../../../shared/envVarCatalog';

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

export interface AgentEnvVarsSectionProps {
	theme: Theme;
	/** Provider id, so the name field can offer that provider's own variables. */
	toolType?: string;
	customEnvVars: Record<string, string>;
	/**
	 * Parked env vars: same shape as `customEnvVars`, but switched off. Pass this
	 * together with `onEnvVarToggle` to get the per-row eye button; omit both and
	 * the section behaves exactly as before (every row is active, no eye).
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
	/** Show the read-only list of variables Maestro sets itself (MAESTRO_SESSION_RESUMED). */
	showBuiltInEnvVars?: boolean;
	/** Less padding, for the wizard. */
	compact?: boolean;
	/** Local account directories mean nothing on an SSH remote, so they are not offered there. */
	isSshEnabled?: boolean;
}

export function AgentEnvVarsSection({
	theme,
	toolType,
	customEnvVars,
	customEnvVarsDisabled,
	onEnvVarToggle,
	onEnvVarKeyChange,
	onEnvVarValueChange,
	onEnvVarRemove,
	onEnvVarAdd,
	onEnvVarsBlur,
	showBuiltInEnvVars = false,
	compact = false,
	isSshEnabled = false,
}: AgentEnvVarsSectionProps): JSX.Element {
	const padding = compact ? 'p-2' : 'p-3';
	const knownAuthDirs = useKnownAuthDirs(!isSshEnabled);
	const knownEnvVarKeys = useKnownEnvVarKeys();
	// Set when the user presses "Add Variable", cleared once the new unnamed row
	// has taken the caret. Not derived from "is this row blank": a blank row can
	// also arrive from disk, and that one must not steal focus on modal open.
	const [focusNewEnvVarRow, setFocusNewEnvVarRow] = useState(false);
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

	return (
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
				{envVarRows.map(({ key, value, enabled, id }) => {
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
								toolType={toolType}
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
							<span className="flex items-center text-xs" style={{ color: theme.colors.textDim }}>
								=
							</span>
							<AuthPathValueInput
								envVarKey={key}
								value={value}
								knownAuthDirs={knownAuthDirs}
								onChange={(updatedValue) => onEnvVarValueChange(key, updatedValue, enabled)}
								onBlur={onEnvVarsBlur}
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
			</div>
			<p className="text-xs opacity-50 mt-2">
				Agent-specific environment variables (overrides global environment variables from Settings).
				These are passed to all calls to this agent.
			</p>
		</div>
	);
}
