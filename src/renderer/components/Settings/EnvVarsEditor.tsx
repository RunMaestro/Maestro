/**
 * EnvVarsEditor - Editor for shell environment variables
 *
 * Provides a UI for adding, editing, and removing environment variables
 * with validation for variable names and values. Uses stable indices
 * to prevent focus loss during key editing.
 *
 * Usage:
 * ```tsx
 * <EnvVarsEditor envVars={shellEnvVars} setEnvVars={setShellEnvVars} theme={theme} />
 * ```
 */

import { useState, useEffect } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import { isAbsolutePath } from '../../../shared/formatters';
import type { Theme } from '../../types';
import { AuthPathValueInput } from '../shared/AuthPathValueInput';
import { EMPTY_KNOWN_AUTH_DIRS, type KnownAuthDirs } from '../../../shared/authPaths';

/**
 * Variable names whose values MUST be absolute filesystem paths. A relative
 * value (e.g. `sm/Users/me/.claude-smash` - a real typo we shipped through)
 * gets `path.resolve()`'d against the main-process cwd at sample time, which
 * silently points the variable at a non-existent directory and produces
 * confusing dashboard tabs. Validating here rejects the bad value at write
 * time so the typo never lands on disk.
 */
const ABSOLUTE_PATH_KEYS: Record<string, true> = {
	CLAUDE_CONFIG_DIR: true,
	CODEX_HOME: true,
};

export interface EnvVarEntry {
	id: number;
	key: string;
	value: string;
	/**
	 * `false` means the variable is parked: still listed and editable, but kept
	 * out of `envVars` so it is never spliced into a spawned process.
	 */
	enabled: boolean;
}

/**
 * Flatten the active and parked records into one editable list. Parked
 * variables sort to the bottom on a fresh build because a plain record cannot
 * remember where they sat; while the editor is open, the local order is what
 * the user sees, and toggling a row never moves it.
 */
function buildEntries(
	enabledVars: Record<string, string>,
	disabledVars?: Record<string, string>
): EnvVarEntry[] {
	const rows = [
		...Object.entries(enabledVars).map(([key, value]) => ({ key, value, enabled: true })),
		...Object.entries(disabledVars ?? {}).map(([key, value]) => ({ key, value, enabled: false })),
	];
	return rows.map((row, index) => ({ id: index, ...row }));
}

/**
 * Order-insensitive fingerprint of a variable list. The `#` marks a parked row
 * so that flipping the eye registers as a change against the parent, and so a
 * flip that merely moves a variable between the two records is NOT read as an
 * external edit that would rebuild (and reorder) the list under the user.
 */
function fingerprint(rows: Array<{ key: string; value: string; enabled: boolean }>): string {
	return rows
		.filter((row) => row.key.trim())
		.map((row) => `${row.enabled ? '' : '#'}${row.key}=${row.value}`)
		.sort()
		.join(',');
}

export interface EnvVarsEditorProps {
	envVars: Record<string, string>;
	setEnvVars: (vars: Record<string, string>) => void;
	theme: Theme;
	/** Optional label displayed above the editor. Pass null to hide. */
	label?: string | null;
	/** Optional description displayed below the editor. Pass null to hide. */
	description?: string | null;
	/** Local account directories previously configured for Claude and Codex. */
	knownAuthDirs?: KnownAuthDirs;
	/**
	 * Parked variables: same shape as `envVars`, but switched off. Pass this
	 * together with `setDisabledEnvVars` to get the per-row eye toggle; omit
	 * both and the editor behaves exactly as before (every row is active).
	 *
	 * The split is deliberate: a parked variable never appears in `envVars`, so
	 * every consumer of the effective environment - spawners, SSH wrapping,
	 * `resolveAgentEnvironment` - keeps reading one record and needs no filter.
	 */
	disabledEnvVars?: Record<string, string>;
	setDisabledEnvVars?: (vars: Record<string, string>) => void;
}

export function EnvVarsEditor({
	envVars,
	setEnvVars,
	theme,
	label = 'Environment Variables (optional)',
	description = 'Environment variables passed to all terminal sessions and AI agent processes.',
	knownAuthDirs = EMPTY_KNOWN_AUTH_DIRS,
	disabledEnvVars,
	setDisabledEnvVars,
}: EnvVarsEditorProps) {
	// The toggle needs both halves to round-trip a parked variable; with only
	// one, switching a row off would drop its value on the floor.
	const canToggle = Boolean(disabledEnvVars && setDisabledEnvVars);
	// Convert object to array with stable IDs for editing
	const [entries, setEntries] = useState<EnvVarEntry[]>(() =>
		buildEntries(envVars, disabledEnvVars)
	);
	const [nextId, setNextId] = useState(
		Object.keys(envVars).length + Object.keys(disabledEnvVars ?? {}).length
	);
	const [validationErrors, setValidationErrors] = useState<Record<number, string>>({});

	// Validate environment variable format
	const validateEntry = (entry: EnvVarEntry): string | null => {
		if (!entry.key.trim()) {
			return null; // Empty keys are OK (will be ignored)
		}
		// Check for valid variable name format (alphanumeric and underscore)
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key)) {
			return `Invalid variable name: only letters, numbers, and underscores allowed and must not start with a number.`;
		}
		// Check if value contains special characters that might need quoting
		if (
			entry.value &&
			/[&|;`$<>()]/.test(entry.value) &&
			!entry.value.startsWith('"') &&
			!entry.value.startsWith("'")
		) {
			return `Invalid value: contains disallowed special characters; quote or escape them if you intend to include them.`;
		}
		// Variables that are consumed as filesystem paths must be absolute -
		// relative values get resolved against the main-process cwd at runtime
		// (often `/`) and silently point at a non-existent directory.
		if (ABSOLUTE_PATH_KEYS[entry.key] && entry.value && !isAbsolutePath(entry.value)) {
			return `${entry.key} must be an absolute path (starting with /).`;
		}
		return null;
	};

	// Sync entries back to parent when they change (but debounced to avoid focus issues)
	const commitChanges = (newEntries: EnvVarEntry[]) => {
		const newEnvVars: Record<string, string> = {};
		const newDisabledEnvVars: Record<string, string> = {};
		const errors: Record<number, string> = {};

		// Collect all errors first
		newEntries.forEach((entry) => {
			const error = validateEntry(entry);
			if (error) {
				errors[entry.id] = error;
			}
		});

		// Only add valid entries, and only ACTIVE ones reach the effective env
		newEntries.forEach((entry) => {
			if (!errors[entry.id] && entry.key.trim()) {
				if (entry.enabled) {
					newEnvVars[entry.key] = entry.value;
				} else {
					newDisabledEnvVars[entry.key] = entry.value;
				}
			}
		});

		setValidationErrors(errors);
		setEnvVars(newEnvVars);
		setDisabledEnvVars?.(newDisabledEnvVars);
	};

	// Sync from parent when envVars changes externally (e.g., on modal open)
	useEffect(() => {
		const parentRows = buildEntries(envVars, disabledEnvVars);
		// Only reset if the keys/values/enabled states actually differ
		if (fingerprint(entries) !== fingerprint(parentRows)) {
			setEntries(parentRows);
			setNextId(parentRows.length);
		}
	}, [envVars, disabledEnvVars]);

	const updateEntry = (id: number, field: 'key' | 'value', newValue: string) => {
		setEntries((prev) => {
			const updated = prev.map((entry) =>
				entry.id === id ? { ...entry, [field]: newValue } : entry
			);
			// Commit changes on every update for value field, but for key field
			// only commit valid keys to avoid issues with empty keys
			commitChanges(updated);
			return updated;
		});
	};

	const toggleEntry = (id: number) => {
		setEntries((prev) => {
			const updated = prev.map((entry) =>
				entry.id === id ? { ...entry, enabled: !entry.enabled } : entry
			);
			commitChanges(updated);
			return updated;
		});
	};

	const removeEntry = (id: number) => {
		setEntries((prev) => {
			const updated = prev.filter((entry) => entry.id !== id);
			commitChanges(updated);
			return updated;
		});
	};

	const addEntry = () => {
		// Generate a unique default key name
		let newKey = 'VAR';
		let counter = 1;
		const existingKeys = new Set(entries.map((e) => e.key));
		while (existingKeys.has(newKey)) {
			newKey = `VAR_${counter}`;
			counter++;
		}
		setEntries((prev) => [...prev, { id: nextId, key: newKey, value: '', enabled: true }]);
		setNextId((prev) => prev + 1);
	};

	return (
		<div
			className="p-3 rounded border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			{label !== null && (
				<label className="block text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
					{label}
				</label>
			)}
			<div className="space-y-2">
				{entries.map((entry) => {
					const error = validationErrors[entry.id];
					const off = !entry.enabled;
					return (
						<div key={entry.id}>
							<div className="flex gap-2 items-center">
								{canToggle && (
									<GhostIconButton
										onClick={() => toggleEntry(entry.id)}
										padding="p-2"
										title={
											off
												? `Enable ${entry.key || 'variable'} (currently not passed to any process)`
												: `Disable ${entry.key || 'variable'} (keeps the value, stops passing it to processes)`
										}
										color={off ? theme.colors.textDim : theme.colors.accent}
									>
										{off ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
									</GhostIconButton>
								)}
								<input
									type="text"
									value={entry.key}
									onChange={(e) => updateEntry(entry.id, 'key', e.target.value)}
									placeholder="VARIABLE_NAME"
									className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
									style={{
										borderColor: error ? '#ef4444' : theme.colors.border,
										color: theme.colors.textMain,
										opacity: off ? 0.45 : 1,
										textDecoration: off ? 'line-through' : undefined,
									}}
								/>
								<span className="flex items-center text-xs" style={{ color: theme.colors.textDim }}>
									=
								</span>
								<AuthPathValueInput
									envVarKey={entry.key}
									value={entry.value}
									knownAuthDirs={knownAuthDirs}
									onChange={(value) => updateEntry(entry.id, 'value', value)}
									className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
									containerClassName="flex-1 min-w-0"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										opacity: off ? 0.45 : 1,
										textDecoration: off ? 'line-through' : undefined,
									}}
								/>
								<GhostIconButton
									onClick={() => removeEntry(entry.id)}
									padding="p-2"
									title="Remove variable"
									color={theme.colors.textDim}
								>
									<Trash2 className="w-3 h-3" />
								</GhostIconButton>
							</div>
							{error && (
								<p className="text-xs mt-1 px-2" style={{ color: '#ef4444' }}>
									{error}
								</p>
							)}
						</div>
					);
				})}
				<button
					onClick={addEntry}
					className="flex items-center gap-1 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					<Plus className="w-3 h-3" />
					Add Variable
				</button>
			</div>
			{description !== null && <p className="text-xs opacity-70 mt-2">{description}</p>}
		</div>
	);
}
