/**
 * SqliteCellEditor - the text box the table view draws over one grid cell
 * while it is edited (see SqliteTableView and src/main/sqlite/sqlite-row-edit.ts).
 *
 * Enter or Tab saves, Escape cancels, and leaving the box saves, as in a
 * spreadsheet, except when the whole window lost focus (switching apps is not
 * a decision about the cell; the draft waits). The draft lives in the parent,
 * so a row scrolled out of the virtualized grid and back keeps it. While the
 * save is in flight the box is read-only.
 *
 * NULL is a state of the editor, not an empty box. A NULL cell opens as NULL
 * (the box reads a dimmed `NULL`), and the NULL button beside the text, or
 * Alt+Cmd+Backspace, sets it. Typing leaves NULL; clearing the text leaves an
 * empty string, and the box then reads `empty string` so the two never look
 * alike. Turning NULL off brings back what was typed before it was set.
 *
 * The box's tooltip names the column's declared type and affinity, and what
 * that means for the text typed (`sqliteCellEditTypeHint()`).
 */

import { useRef } from 'react';

import type { Theme } from '../../types';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import { isImeComposing } from '../../utils/ime';
import { shortcutSuffix } from '../ui/ShortcutHint';
import {
	isSqliteCellNullChord,
	SQLITE_CELL_NULL_KEYS,
	type SqliteCellDraft,
} from './sqliteCellEdit';

interface SqliteCellEditorProps {
	/** The column being edited, for the box's accessible name. */
	column: string;
	/** The column's type and what its affinity does to a value, as the box's tooltip. */
	typeHint?: string;
	draft: SqliteCellDraft;
	onDraftChange: (draft: SqliteCellDraft) => void;
	onCommit: () => void;
	onCancel: () => void;
	/** A save is in flight. */
	saving: boolean;
	theme: Theme;
}

export function SqliteCellEditor({
	column,
	typeHint,
	draft,
	onDraftChange,
	onCommit,
	onCancel,
	saving,
	theme,
}: SqliteCellEditorProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	useFocusOnMount(inputRef, 0);

	const setNull = (isNull: boolean) => {
		if (saving || draft.isNull === isNull) return;
		onDraftChange({ ...draft, isNull });
	};

	return (
		<div
			className="flex w-full h-full items-stretch"
			style={{
				backgroundColor: theme.colors.bgMain,
				boxShadow: `inset 0 0 0 2px ${theme.colors.accent}`,
				opacity: saving ? 0.6 : 1,
			}}
			// The grid row reads a double-click as "open this row" and blocks the
			// browser's word selection on it; inside the editor both belong to it.
			onMouseDown={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
			// Leaving the editor saves, but moving between its own box and its
			// NULL button does not leave it.
			onBlur={(event) => {
				if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
				if (saving || !document.hasFocus()) return;
				onCommit();
			}}
			data-testid="sqlite-cell-editor-frame"
		>
			<input
				ref={inputRef}
				type="text"
				value={draft.isNull ? '' : draft.text}
				readOnly={saving}
				placeholder={draft.isNull ? 'NULL' : 'empty string'}
				aria-label={`Edit ${column}${draft.isNull ? ' (NULL)' : ''}`}
				title={typeHint}
				spellCheck={false}
				className={`flex-1 min-w-0 h-full px-2 text-xs outline-none select-text bg-transparent ${
					draft.isNull ? 'placeholder:italic' : ''
				}`}
				style={{
					color: theme.colors.textMain,
					fontVariantNumeric: 'tabular-nums',
				}}
				// Typing into a NULL replaces it: the box was showing nothing.
				onChange={(event) => onDraftChange({ text: event.target.value, isNull: false })}
				onKeyDown={(event) => {
					if (isImeComposing(event)) return;
					if (event.key === 'Enter' || event.key === 'Tab') {
						event.preventDefault();
						event.stopPropagation();
						onCommit();
					} else if (event.key === 'Escape') {
						// Escape belongs to the cell, not to the tab or a modal behind it.
						event.preventDefault();
						event.stopPropagation();
						onCancel();
					} else if (isSqliteCellNullChord(event)) {
						event.preventDefault();
						event.stopPropagation();
						setNull(true);
					}
				}}
				data-testid="sqlite-cell-editor"
			/>
			<button
				type="button"
				aria-pressed={draft.isNull}
				disabled={saving}
				className="shrink-0 my-1 mr-1 px-1.5 rounded text-2xs font-semibold tracking-wide outline-none focus-visible:ring-1"
				style={{
					backgroundColor: draft.isNull ? theme.colors.accent : 'transparent',
					color: draft.isNull ? theme.colors.accentForeground : theme.colors.textDim,
					border: `1px solid ${draft.isNull ? theme.colors.accent : theme.colors.border}`,
				}}
				title={
					draft.isNull
						? 'The cell will be NULL. Click to type a value instead.'
						: `Set the cell to NULL, not an empty string${shortcutSuffix(SQLITE_CELL_NULL_KEYS)}`
				}
				// Keep the focus in the box, so pressing the button is not leaving the cell.
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					setNull(!draft.isNull);
					inputRef.current?.focus();
				}}
				data-testid="sqlite-cell-editor-null"
			>
				NULL
			</button>
		</div>
	);
}
