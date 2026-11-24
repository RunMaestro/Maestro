/**
 * SqliteInsertRowModal - the table view's Insert row form: one field per
 * column, each left to its DEFAULT, given a value, or set to NULL, sent as one
 * INSERT (`insertSqliteRow()` in src/main/sqlite/sqlite-row-edit.ts).
 *
 * Default is the starting state, so the smallest insert names no column at
 * all and SQLite fills every one in (the rowid column takes the next rowid).
 * Typing into a field switches it to a value, as typing in the cell editor
 * leaves NULL. A value binds by the column's affinity, the cell editor's rule
 * (src/renderer/components/SqliteViewer/sqliteRowInsert.ts); a value that
 * would be refused, or SQLite's own refusal of the row (a NOT NULL, UNIQUE,
 * CHECK, or FOREIGN KEY constraint, verbatim), shows above the buttons with
 * the form still filled, so it can be fixed. Generated columns are listed but
 * cannot be set. Enter in a field inserts.
 */

import { useCallback, useMemo, useRef } from 'react';

import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { sqliteColumnAffinity } from '../../../shared/sqlite/schema';
import type { Theme } from '../../types';
import { Modal, ModalFooter } from '../ui/Modal';
import { SegmentedControl } from '../ui/SegmentedControl';
import { sqliteCellEditTypeHint } from './sqliteCellEdit';
import {
	sqliteInsertField,
	type SqliteInsertColumn,
	type SqliteInsertDraft,
	type SqliteInsertFieldMode,
} from './sqliteRowInsert';
import { isImeComposing } from '../../utils/ime';

const MODE_OPTIONS = [
	{
		value: 'default' as const,
		label: 'Default',
		title: 'Leave the column out, so SQLite applies its DEFAULT (NULL when it has none)',
	},
	{ value: 'value' as const, label: 'Value', title: 'Store the value typed' },
	{ value: 'null' as const, label: 'NULL', title: 'Store NULL' },
];

interface SqliteInsertRowModalProps {
	/** The table the row goes into. */
	table: string;
	columns: readonly SqliteInsertColumn[];
	/** Whether the table is STRICT, which changes a declared type's affinity. */
	strict: boolean;
	draft: SqliteInsertDraft;
	onDraftChange: (draft: SqliteInsertDraft) => void;
	onInsert: () => void;
	onClose: () => void;
	/** The insert is in flight; the button waits. */
	saving: boolean;
	/** Why the last insert was refused, by the form or by SQLite. */
	problem: string | null;
	theme: Theme;
}

export function SqliteInsertRowModal({
	table,
	columns,
	strict,
	draft,
	onDraftChange,
	onInsert,
	onClose,
	saving,
	problem,
	theme,
}: SqliteInsertRowModalProps) {
	const listRef = useRef<HTMLDivElement>(null);

	const setField = useCallback(
		(column: string, mode: SqliteInsertFieldMode, text: string) => {
			onDraftChange({ ...draft, [column]: { mode, text } });
		},
		[draft, onDraftChange]
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) return;
			event.preventDefault();
			if (!saving) onInsert();
		},
		[onInsert, saving]
	);

	const given = useMemo(
		() => columns.filter((column) => sqliteInsertField(draft, column.name).mode !== 'default'),
		[columns, draft]
	);

	return (
		<Modal
			theme={theme}
			title={`Insert a row into ${table}`}
			priority={MODAL_PRIORITIES.TABLE_ROW_DETAIL}
			onClose={onClose}
			portal
			resizeKey="sqlite-insert-row"
			defaultSize={{ width: 720, height: 560 }}
			minSize={{ width: 420, height: 260 }}
			initialFocusRef={listRef}
			contentClassName="flex flex-col flex-1 min-h-0"
			testId="sqlite-insert-row-modal"
			footer={
				<div className="flex flex-col gap-2 w-full">
					{problem && (
						<div
							className="text-xs select-text"
							style={{ color: theme.colors.error }}
							data-testid="sqlite-insert-row-problem"
						>
							{problem}
						</div>
					)}
					<div className="flex items-center gap-3">
						<span className="flex-1 text-xs" style={{ color: theme.colors.textDim }}>
							{given.length === 0
								? 'Every column takes its default.'
								: `${given.length} of ${columns.length} columns given; the rest take their default.`}
						</span>
						<ModalFooter
							theme={theme}
							onCancel={onClose}
							onConfirm={onInsert}
							confirmLabel={saving ? 'Inserting...' : 'Insert row'}
							confirmDisabled={saving}
						/>
					</div>
				</div>
			}
		>
			<div
				ref={listRef}
				tabIndex={-1}
				className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-1.5 text-xs outline-none"
				data-testid="sqlite-insert-row-fields"
			>
				{columns.map((column) => {
					const field = sqliteInsertField(draft, column.name);
					const affinity = sqliteColumnAffinity(column.declaredType ?? '', strict);
					const inputId = `sqlite-insert-row-input-${column.name}`;
					return (
						<div
							key={column.name}
							className="flex items-center gap-2 min-w-0"
							data-testid={`sqlite-insert-row-field-${column.name}`}
						>
							<label
								htmlFor={inputId}
								className="shrink-0 w-40 min-w-0 flex flex-col select-none"
								title={sqliteCellEditTypeHint(column.name, column.declaredType, affinity)}
							>
								<span className="truncate font-mono" style={{ color: theme.colors.accent }}>
									{column.name}
								</span>
								<span className="truncate" style={{ color: theme.colors.textDim }}>
									{column.declaredType || 'no type'}
									{column.isRowid ? ', rowid' : ''}
								</span>
							</label>
							{column.readOnlyReason ? (
								<span
									className="flex-1 min-w-0 truncate italic"
									style={{ color: theme.colors.textDim }}
									title={column.readOnlyReason}
								>
									generated: SQLite computes it
								</span>
							) : (
								<>
									<input
										id={inputId}
										type="text"
										value={field.text}
										disabled={saving}
										onChange={(event) => setField(column.name, 'value', event.target.value)}
										onKeyDown={handleKeyDown}
										placeholder={
											field.mode === 'null'
												? 'NULL'
												: field.mode === 'default'
													? column.isRowid
														? 'next rowid'
														: 'default'
													: 'empty string'
										}
										spellCheck={false}
										autoComplete="off"
										className="flex-1 min-w-0 px-2 py-1 rounded outline-none"
										style={{
											backgroundColor: theme.colors.bgMain,
											border: `1px solid ${theme.colors.border}`,
											color: theme.colors.textMain,
											fontFamily:
												'var(--maestro-font-mono, ui-monospace, SFMono-Regular, monospace)',
											fontStyle: field.mode === 'value' ? undefined : 'italic',
											opacity: field.mode === 'value' ? 1 : 0.6,
										}}
										data-testid={inputId}
									/>
									<div className="shrink-0">
										<SegmentedControl<SqliteInsertFieldMode>
											value={field.mode}
											onChange={(mode) => setField(column.name, mode, field.text)}
											options={MODE_OPTIONS}
											theme={theme}
											ariaLabel={`How ${column.name} is filled`}
											testId={`sqlite-insert-row-mode-${column.name}`}
										/>
									</div>
								</>
							)}
						</div>
					);
				})}
			</div>
		</Modal>
	);
}
