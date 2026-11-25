/**
 * SqliteQueryHistoryRail - Query mode's History: the statements run against
 * this database, newest first, beside the editor.
 *
 * The history is kept by the main process per database file and recorded by
 * the run itself (src/main/sqlite/sqlite-query-history.ts), so it lists runs
 * from this viewer, from another tab on the same file, and from
 * `maestro-cli sqlite query` alike, and it survives closing the file. The
 * rail reads it over `sqlite:readQueryHistory` when it mounts and again each
 * time `refreshKey` changes (the panel bumps it when a run settles).
 *
 * Picking an entry puts its statement, its parameter values, and its Rows /
 * Plan mode back in the editor without running it. An entry can be forgotten
 * on its own, or the whole history cleared; both answer with the history
 * left, which the rail shows.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';

import { formatRelativeTime } from '../../../shared/formatters';
import {
	formatSqliteQueryHistoryOutcome,
	sqliteQueryHistoryLine,
} from '../../../shared/sqlite/history';
import type { SqliteQueryHistoryEntry } from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { isCoarsePointer } from '../../utils/touch';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';

interface SqliteQueryHistoryRailProps {
	handle: string;
	/** Changes whenever the history may have grown, so the rail reads it again. */
	refreshKey: number;
	/** Put an entry back in the editor. */
	onPick: (entry: SqliteQueryHistoryEntry) => void;
	theme: Theme;
}

export const SqliteQueryHistoryRail = memo(function SqliteQueryHistoryRail({
	handle,
	refreshKey,
	onPick,
	theme,
}: SqliteQueryHistoryRailProps) {
	const [entries, setEntries] = useState<SqliteQueryHistoryEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const coarsePointer = isCoarsePointer();

	useEffect(() => {
		let cancelled = false;
		window.maestro.sqlite
			.readQueryHistory(handle)
			.then((history) => {
				if (cancelled) return;
				setEntries(history.entries);
				setError(null);
			})
			.catch((failure: unknown) => {
				if (!cancelled) setError(ipcErrorMessage(failure));
			});
		return () => {
			cancelled = true;
		};
	}, [handle, refreshKey]);

	const forget = useCallback(
		(entryId: string | null) => {
			window.maestro.sqlite
				.forgetQueryHistory(handle, entryId)
				.then((history) => {
					setEntries(history.entries);
					setError(null);
				})
				.catch((failure: unknown) => setError(ipcErrorMessage(failure)));
		},
		[handle]
	);

	return (
		<div
			className="shrink-0 w-64 flex flex-col min-h-0 select-none"
			style={{ borderLeft: `1px solid ${theme.colors.border}` }}
			data-testid="sqlite-query-history"
		>
			<div
				className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs-plus font-medium"
				style={{ borderBottom: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
			>
				History
				{entries && entries.length > 0 && (
					<button
						type="button"
						onClick={() => forget(null)}
						className="ml-auto flex items-center gap-1 font-normal px-1.5 py-0.5 rounded"
						style={{ color: theme.colors.textDim }}
						title="Forget every statement run against this database"
						data-testid="sqlite-query-history-clear"
					>
						<Trash2 className="w-3 h-3" />
						Clear
					</button>
				)}
			</div>
			<div className="flex-1 min-h-0 overflow-y-auto">
				{error && (
					<div
						className="px-3 py-2 text-xs select-text"
						style={{ color: theme.colors.error }}
						data-testid="sqlite-query-history-error"
					>
						The history could not be read: {error}
					</div>
				)}
				{!entries && !error ? (
					<div
						className="flex items-center gap-2 px-3 py-2 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<Spinner size={10} decorative />
						Reading the history...
					</div>
				) : entries && entries.length === 0 ? (
					<div
						className="px-3 py-2 text-xs"
						style={{ color: theme.colors.textDim }}
						data-testid="sqlite-query-history-empty"
					>
						Statements run against this database appear here, newest first.
					</div>
				) : (
					entries?.map((entry) => (
						<div
							key={entry.id}
							className="group relative"
							style={{ borderBottom: `1px solid ${theme.colors.border}` }}
							data-testid="sqlite-query-history-entry"
						>
							<button
								type="button"
								onClick={() => onPick(entry)}
								className="w-full text-left px-3 py-1.5 pr-7 flex flex-col gap-0.5"
								title={`${entry.sql}\n\nPut this statement back in the editor`}
								data-testid="sqlite-query-history-pick"
							>
								<span
									className="font-mono text-xs truncate"
									style={{ color: theme.colors.textMain }}
								>
									{sqliteQueryHistoryLine(entry.sql)}
								</span>
								<span
									className="flex items-center gap-1.5 text-2xs"
									style={{ color: theme.colors.textDim }}
								>
									<span>{formatRelativeTime(entry.ranAt)}</span>
									<span
										style={{ color: entry.outcome.ok ? undefined : theme.colors.error }}
										title={entry.outcome.ok ? undefined : entry.outcome.error}
									>
										{formatSqliteQueryHistoryOutcome(entry.outcome)}
									</span>
									{entry.plan && <MiniBadge label="plan" theme={theme} />}
									{entry.runs > 1 && <span>x{entry.runs}</span>}
								</span>
							</button>
							<button
								type="button"
								onClick={() => forget(entry.id)}
								// A finger cannot hover, so under one the button always shows.
								className={`absolute top-1.5 right-1.5 p-0.5 rounded ${
									coarsePointer ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
								}`}
								style={{ color: theme.colors.textDim }}
								title="Forget this statement"
								aria-label="Forget this statement"
								data-testid="sqlite-query-history-forget"
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					))
				)}
			</div>
		</div>
	);
});
