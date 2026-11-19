/**
 * SqliteCellEditor - the text box the table view draws over one grid cell
 * while it is edited (see SqliteTableView and src/main/sqlite/sqlite-row-edit.ts).
 *
 * Enter or Tab saves, Escape cancels, and leaving the box saves, as in a
 * spreadsheet, except when the whole window lost focus (switching apps is not
 * a decision about the cell; the draft waits). The draft lives in the parent,
 * so a row scrolled out of the virtualized grid and back keeps it. While the
 * save is in flight the box is read-only.
 */

import { useRef } from 'react';

import type { Theme } from '../../types';
import { useFocusOnMount } from '../../hooks/utils/useFocusAfterRender';
import { isImeComposing } from '../../utils/ime';

interface SqliteCellEditorProps {
	/** The column being edited, for the box's accessible name. */
	column: string;
	draft: string;
	onDraftChange: (draft: string) => void;
	onCommit: () => void;
	onCancel: () => void;
	/** A save is in flight. */
	saving: boolean;
	theme: Theme;
}

export function SqliteCellEditor({
	column,
	draft,
	onDraftChange,
	onCommit,
	onCancel,
	saving,
	theme,
}: SqliteCellEditorProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	useFocusOnMount(inputRef, 0);

	return (
		<input
			ref={inputRef}
			type="text"
			value={draft}
			readOnly={saving}
			aria-label={`Edit ${column}`}
			spellCheck={false}
			className="w-full h-full px-2 text-xs outline-none select-text"
			style={{
				backgroundColor: theme.colors.bgMain,
				color: theme.colors.textMain,
				boxShadow: `inset 0 0 0 2px ${theme.colors.accent}`,
				fontVariantNumeric: 'tabular-nums',
				opacity: saving ? 0.6 : 1,
			}}
			onChange={(event) => onDraftChange(event.target.value)}
			// The grid row reads a double-click as "open this row" and blocks the
			// browser's word selection on it; inside the box both belong to the text.
			onMouseDown={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
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
				}
			}}
			onBlur={() => {
				if (saving || !document.hasFocus()) return;
				onCommit();
			}}
			data-testid="sqlite-cell-editor"
		/>
	);
}
