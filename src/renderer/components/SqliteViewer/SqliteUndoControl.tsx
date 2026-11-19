/**
 * SqliteUndoControl - Undo for the tab's last write, beside the "Enable
 * editing" switch in the viewer's summary strip.
 *
 * It sits in the strip, not the table view's footer, because the last write
 * belongs to the tab's editing session, not to one table: an edit to one
 * table can still be undone after switching to another. The state (the last
 * write's `undo` step, the outcome) lives in SqliteViewer; this only draws it.
 * A write that cannot be undone (its triggers or foreign-key actions changed
 * other rows) says so instead of offering a button.
 */

import { Undo2 } from 'lucide-react';

import { sqliteUndoLabel, sqliteUndoUnavailableMessage } from '../../../shared/sqlite/undo';
import type { Theme } from '../../types';
import { shortcutSuffix } from '../ui/ShortcutHint';
import { Spinner } from '../ui/Spinner';
import { SQLITE_UNDO_KEYS, type SqliteLastWrite } from './sqliteUndo';

/** An undo's outcome or refusal, for the strip. */
export interface SqliteUndoStatus {
	text: string;
	error: boolean;
}

interface SqliteUndoControlProps {
	/** The tab's last write, or null when there is nothing to undo. */
	lastWrite: SqliteLastWrite | null;
	/** An undo is in flight. */
	undoing: boolean;
	/** The last undo's outcome or refusal. */
	status: SqliteUndoStatus | null;
	onUndo: () => void;
	theme: Theme;
}

export function SqliteUndoControl({
	lastWrite,
	undoing,
	status,
	onUndo,
	theme,
}: SqliteUndoControlProps): JSX.Element | null {
	if (!lastWrite && !status) return null;
	const step = lastWrite?.undo ?? null;

	return (
		<span className="flex items-center gap-2 text-xs-plus" data-testid="sqlite-undo-control">
			{step && (
				<button
					type="button"
					className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-50 select-none"
					style={{ color: theme.colors.accentText }}
					onClick={onUndo}
					disabled={undoing}
					title={`Undo ${sqliteUndoLabel(step)}${shortcutSuffix(SQLITE_UNDO_KEYS)}. Refused if the row changed since.`}
					data-testid="sqlite-undo"
				>
					{undoing ? <Spinner size={10} decorative /> : <Undo2 className="w-3 h-3" />}
					Undo
				</button>
			)}
			{lastWrite && !step && (
				<span
					className="select-none"
					style={{ color: theme.colors.textDim }}
					title={sqliteUndoUnavailableMessage(lastWrite.otherChanges)}
					data-testid="sqlite-undo-unavailable"
				>
					cannot undo
				</span>
			)}
			{status && (
				<span
					className="select-text"
					style={{ color: status.error ? theme.colors.warning : theme.colors.textDim }}
					data-testid="sqlite-undo-status"
				>
					{status.text}
				</span>
			)}
		</span>
	);
}
