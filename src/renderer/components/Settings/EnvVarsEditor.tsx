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
import { Plus, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';

export interface EnvVarEntry {
	id: number;
	key: string;
	value: string;
}

export interface EnvVarsEditorProps {
	envVars: Record<string, string>;
	setEnvVars: (vars: Record<string, string>) => void;
	theme: Theme;
}

export function EnvVarsEditor({ envVars, setEnvVars, theme }: EnvVarsEditorProps) {
	// Convert object to array with stable IDs for editing
	const [entries, setEntries] = useState<EnvVarEntry[]>(() => {
		return Object.entries(envVars).map(([key, value], index) => ({
			id: index,
			key,
			value,
		}));
	});
	const [nextId, setNextId] = useState(Object.keys(envVars).length);
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
		return null;
	};

	// Sync entries back to parent when they change (but debounced to avoid focus issues)
	const commitChanges = (newEntries: EnvVarEntry[]) => {
		const newEnvVars: Record<string, string> = {};
		const errors: Record<number, string> = {};

		// Collect all errors first
		newEntries.forEach((entry) => {
			const error = validateEntry(entry);
			if (error) {
				errors[entry.id] = error;
			}
		});

		// Only add valid entries to newEnvVars
		newEntries.forEach((entry) => {
			if (!errors[entry.id] && entry.key.trim()) {
				newEnvVars[entry.key] = entry.value;
			}
		});

		setValidationErrors(errors);
		setEnvVars(newEnvVars);
	};

	// Sync from parent when envVars changes externally (e.g., on modal open)
	useEffect(() => {
		const parentEntries = Object.entries(envVars);
		// Only reset if the keys/values actually differ
		const currentKeys = entries
			.filter((e) => e.key.trim())
			.map((e) => `${e.key}=${e.value}`)
			.sort()
			.join(',');
		const parentKeys = parentEntries
			.map(([k, v]) => `${k}=${v}`)
			.sort()
			.join(',');
		if (currentKeys !== parentKeys) {
			setEntries(
				parentEntries.map(([key, value], index) => ({
					id: index,
					key,
					value,
				}))
			);
			setNextId(parentEntries.length);
		}
	}, [envVars]);

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
		setEntries((prev) => [...prev, { id: nextId, key: newKey, value: '' }]);
		setNextId((prev) => prev + 1);
	};

	return (
		<div>
			<div className="block text-xs opacity-60 mb-1">Environment Variables (optional)</div>
			<div className="space-y-2">
				{entries.map((entry) => {
					const error = validationErrors[entry.id];
					return (
						<div key={entry.id}>
							<div className="flex gap-2 items-center">
								<input
									type="text"
									value={entry.key}
									onChange={(e) => updateEntry(entry.id, 'key', e.target.value)}
									placeholder="VARIABLE"
									className={`flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono ${
										entry.key.trim() &&
										!validateEntry({ id: entry.id, key: entry.key, value: entry.value })
											? ''
											: ''
									}`}
									style={{
										borderColor: error ? '#ef4444' : theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									=
								</span>
								<input
									type="text"
									value={entry.value}
									onChange={(e) => updateEntry(entry.id, 'value', e.target.value)}
									placeholder="value"
									className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								/>
								<button
									onClick={() => removeEntry(entry.id)}
									className="p-2 rounded hover:bg-white/10 transition-colors"
									title="Remove variable"
									style={{ color: theme.colors.textDim }}
								>
									<Trash2 className="w-3 h-3" />
								</button>
							</div>
							{error && (
								<p className="text-xs mt-1 px-2" style={{ color: '#ef4444' }}>
									⚠ {error}
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
			<div className="mt-2 space-y-1">
				<p className="text-xs opacity-50">
					Environment variables passed to all terminal sessions and AI agent processes.
				</p>
				{Object.keys(envVars).length > 0 && (
					<p className="text-xs opacity-60">
						✓ Valid ({Object.keys(envVars).length} variables loaded)
					</p>
				)}
			</div>
		</div>
	);
}
