/**
 * KeyValueRows - a compact list of editable `key = value` pairs.
 *
 * The plain form of this control: a row per pair, a monospace input on each
 * side, and a trash button. Used for a remote's environment variables and for
 * its extra `ssh -o` options, which are the same widget with different labels.
 *
 * Rows carry a stable `id` rather than being keyed by their key text, because a
 * list keyed by the editable field remounts the input on every keystroke and
 * the caret jumps out after one character.
 *
 * Distinct from `Settings/EnvVarsEditor`, which is the shell-environment editor
 * and owns things this deliberately has no concept of: the parked/disabled
 * second record, secret masking, and absolute-path validation. Pick by whether
 * those behaviours are wanted; do not add a mode to either to cover the other.
 */

import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { GhostIconButton } from './GhostIconButton';
import type { Theme } from '../../types';

/** One editable pair. `id` is stable for the row's lifetime. */
export interface KeyValueRow {
	id: number;
	key: string;
	value: string;
}

export interface KeyValueRowsProps {
	theme: Theme;
	/** Section heading, rendered in the small uppercase style. */
	label: string;
	rows: KeyValueRow[];
	onChangeRow: (id: number, field: 'key' | 'value', value: string) => void;
	onRemoveRow: (id: number) => void;
	onAddRow: () => void;
	/** Label for the add button, e.g. "Add Variable". */
	addLabel: string;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	/** Explanatory line under the rows. */
	helperText?: React.ReactNode;
	/** Hide the rows without discarding them (collapsed section). */
	collapsed?: boolean;
	/** Accessible name prefix for the per-row remove button. */
	removeLabel?: string;
	testId?: string;
}

/**
 * Convert a record into rows with stable ids. Index order is the record's own
 * insertion order, which is what the user last saved.
 */
export function recordToKeyValueRows(record?: Record<string, string>): KeyValueRow[] {
	if (!record) return [];
	return Object.entries(record).map(([key, value], index) => ({ id: index, key, value }));
}

/**
 * Collapse rows back into a record, dropping blank keys.
 *
 * @returns `undefined` when nothing survives, so a section the user emptied
 * stores no key at all rather than an empty object.
 */
export function keyValueRowsToRecord(rows: KeyValueRow[]): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const row of rows) {
		if (row.key.trim()) result[row.key.trim()] = row.value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function KeyValueRows({
	theme,
	label,
	rows,
	onChangeRow,
	onRemoveRow,
	onAddRow,
	addLabel,
	keyPlaceholder = 'KEY',
	valuePlaceholder = 'value',
	helperText,
	collapsed = false,
	removeLabel = 'Remove entry',
	testId,
}: KeyValueRowsProps) {
	return (
		<div data-testid={testId}>
			<div className="flex items-center justify-between mb-2">
				<div
					className="text-xs font-bold opacity-70 uppercase"
					style={{ color: theme.colors.textMain }}
				>
					{label}
				</div>
				<button
					type="button"
					onClick={onAddRow}
					className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.accent }}
				>
					<Plus className="w-3 h-3" />
					{addLabel}
				</button>
			</div>

			{!collapsed && rows.length > 0 && (
				<div className="space-y-2 mb-2">
					{rows.map((row) => (
						<div key={row.id} className="flex items-center gap-2">
							<input
								type="text"
								value={row.key}
								onChange={(e) => onChangeRow(row.id, 'key', e.target.value)}
								placeholder={keyPlaceholder}
								className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								=
							</span>
							<input
								type="text"
								value={row.value}
								onChange={(e) => onChangeRow(row.id, 'value', e.target.value)}
								placeholder={valuePlaceholder}
								className="flex-[2] p-2 rounded border bg-transparent outline-none text-xs font-mono"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<GhostIconButton
								onClick={() => onRemoveRow(row.id)}
								padding="p-2"
								title={removeLabel}
								ariaLabel={removeLabel}
								color={theme.colors.textDim}
							>
								<Trash2 className="w-3 h-3" />
							</GhostIconButton>
						</div>
					))}
				</div>
			)}

			{helperText && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{helperText}
				</p>
			)}
		</div>
	);
}
