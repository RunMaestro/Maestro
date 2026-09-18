/**
 * KeyValueRows - a compact list of editable `key = value` pairs.
 *
 * The plain form of this control: a row per pair, a monospace input on each
 * side, an optional eye that parks the row, and a trash button. Used for a
 * remote's environment variables and for its extra `ssh -o` options, which are
 * the same widget with different labels.
 *
 * Rows carry a stable `id` rather than being keyed by their key text, because a
 * list keyed by the editable field remounts the input on every keystroke and
 * the caret jumps out after one character.
 *
 * A parked row (`enabled: false`) is kept and editable but sorted into a SECOND
 * record on save - see `src/shared/parkedRecords.ts` for why that is two
 * records rather than one flag. The eye is opt-in: pass `onToggleRow` and it
 * renders, omit it and every row is simply live.
 *
 * Distinct from `Settings/EnvVarsEditor`, which is the shell-environment editor
 * and owns what this deliberately has no concept of: secret masking, known-auth
 * path completion, and absolute-path validation. Pick by whether those
 * behaviours are wanted; do not add a mode to either to cover the other.
 */

import React from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { GhostIconButton } from './GhostIconButton';
import { splitParkedEntries, type ParkedRecordPair } from '../../../shared/parkedRecords';
import type { Theme } from '../../types';

/** One editable pair. `id` is stable for the row's lifetime. */
export interface KeyValueRow {
	id: number;
	key: string;
	value: string;
	/** `false` parks the row: still listed and editable, but not live. */
	enabled: boolean;
}

export interface KeyValueRowsProps {
	theme: Theme;
	/** Section heading, rendered in the small uppercase style. */
	label: string;
	rows: KeyValueRow[];
	onChangeRow: (id: number, field: 'key' | 'value', value: string) => void;
	onRemoveRow: (id: number) => void;
	onAddRow: () => void;
	/**
	 * Park or unpark a row. Supplying it is what makes the eye appear; without
	 * it there is nowhere to keep a parked value, so the control is hidden
	 * rather than rendered dead.
	 */
	onToggleRow?: (id: number) => void;
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
	/** Noun used in the eye's tooltip, e.g. "variable" or "option". */
	entryNoun?: string;
	testId?: string;
}

/**
 * Build rows from the active record followed by the parked one.
 *
 * Parked rows sort to the bottom because a plain record cannot remember where
 * they sat; while the editor is open the local order is what the user sees, and
 * toggling a row never moves it.
 */
export function recordToKeyValueRows(
	record?: Record<string, string>,
	parkedRecord?: Record<string, string>
): KeyValueRow[] {
	const rows = [
		...Object.entries(record ?? {}).map(([key, value]) => ({ key, value, enabled: true })),
		...Object.entries(parkedRecord ?? {}).map(([key, value]) => ({ key, value, enabled: false })),
	];
	return rows.map((row, index) => ({ id: index, ...row }));
}

/**
 * Collapse rows back into the active and parked records, dropping blank keys.
 *
 * Returns both halves together rather than one function per record: a caller
 * that writes only the half it remembered would silently drop the other, which
 * for the parked half means losing exactly the values parking exists to keep.
 */
export function keyValueRowsToRecords(rows: KeyValueRow[]): ParkedRecordPair {
	return splitParkedEntries(rows);
}

export function KeyValueRows({
	theme,
	label,
	rows,
	onChangeRow,
	onRemoveRow,
	onAddRow,
	onToggleRow,
	addLabel,
	keyPlaceholder = 'KEY',
	valuePlaceholder = 'value',
	helperText,
	collapsed = false,
	removeLabel = 'Remove entry',
	entryNoun = 'entry',
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
					{rows.map((row) => {
						const off = !row.enabled;
						// Dim and strike a parked row so its state is readable without
						// hovering the eye, matching the shell environment editor.
						const offStyle = {
							opacity: off ? 0.45 : 1,
							textDecoration: off ? ('line-through' as const) : undefined,
						};
						const named = row.key.trim() || entryNoun;
						const toggleLabel = off
							? `Enable ${named} (currently not passed to ssh)`
							: `Disable ${named} (keeps the value, stops passing it to ssh)`;
						return (
							<div key={row.id} className="flex items-center gap-2">
								{onToggleRow && (
									<GhostIconButton
										onClick={() => onToggleRow(row.id)}
										padding="p-2"
										title={toggleLabel}
										ariaLabel={toggleLabel}
										color={off ? theme.colors.textDim : theme.colors.accent}
									>
										{off ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
									</GhostIconButton>
								)}
								<input
									type="text"
									value={row.key}
									onChange={(e) => onChangeRow(row.id, 'key', e.target.value)}
									placeholder={keyPlaceholder}
									className="flex-1 p-2 rounded border bg-transparent outline-none text-xs font-mono"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										...offStyle,
									}}
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
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										...offStyle,
									}}
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
						);
					})}
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
