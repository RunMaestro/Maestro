/**
 * SqliteStatementLogRail - the viewer's Log: every write made to this
 * database, newest first, beside the content pane in Browse and Query mode
 * alike. It answers "what did I just do to this database".
 *
 * The log is kept by the main process per database file and recorded by each
 * write path itself (src/main/sqlite/sqlite-statement-log.ts): this tab's cell
 * edits, inserts, deletes, and Undo, its Query-mode writes, its explicit
 * transactions, and the same from another tab, another window, or
 * `maestro-cli`. The rail reads it over `sqlite:readStatementLog` when it
 * mounts, and again whenever main announces a change to this file's log
 * (`onStatementLogged`), so a write shows here as it lands, whoever made it.
 *
 * Each row says what kind of write it was, when, what it changed, and, for
 * a write inside a transaction, whether that transaction was committed: a
 * write in one that was rolled back is in the log and NOT in the file, and
 * the row says so. Opening a row shows its whole statement (row edits are
 * spelled out with their values), its parameter values, its error, how its
 * transaction ended, and the backup it took. Clear forgets the whole log.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';

import { formatRelativeTime } from '../../../shared/formatters';
import { sqliteQueryHistoryLine } from '../../../shared/sqlite/history';
import {
	SQLITE_STATEMENT_LOG_KIND_LABELS,
	formatSqliteParameterValue,
	formatSqliteStatementLogOutcome,
	sqliteStatementLogStanding,
	sqliteStatementLogStandingText,
	sqliteStatementLogTransactionEnds,
} from '../../../shared/sqlite/statementLog';
import type { SqliteStatementLogEntry } from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';

interface SqliteStatementLogRailProps {
	handle: string;
	/** The database's path as `open` reported it: main announces changes by it. */
	databasePath: string;
	theme: Theme;
}

export const SqliteStatementLogRail = memo(function SqliteStatementLogRail({
	handle,
	databasePath,
	theme,
}: SqliteStatementLogRailProps) {
	const [entries, setEntries] = useState<SqliteStatementLogEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	/** Bumped when main says this file's log changed, so the rail reads it again. */
	const [stamp, setStamp] = useState(0);

	useEffect(
		() =>
			window.maestro.sqlite.onStatementLogged((changedPath) => {
				if (changedPath === databasePath) setStamp((value) => value + 1);
			}),
		[databasePath]
	);

	useEffect(() => {
		let cancelled = false;
		window.maestro.sqlite
			.readStatementLog(handle)
			.then((log) => {
				if (cancelled) return;
				setEntries(log.entries);
				setError(null);
			})
			.catch((failure: unknown) => {
				if (!cancelled) setError(ipcErrorMessage(failure));
			});
		return () => {
			cancelled = true;
		};
	}, [handle, stamp]);

	const clear = useCallback(() => {
		window.maestro.sqlite
			.clearStatementLog(handle)
			.then((log) => {
				setEntries(log.entries);
				setError(null);
			})
			.catch((failure: unknown) => setError(ipcErrorMessage(failure)));
	}, [handle]);

	const ends = useMemo(() => sqliteStatementLogTransactionEnds(entries ?? []), [entries]);

	return (
		<div
			className="shrink-0 w-72 flex flex-col min-h-0 select-none"
			style={{ borderLeft: `1px solid ${theme.colors.border}` }}
			data-testid="sqlite-statement-log"
		>
			<div
				className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs-plus font-medium"
				style={{ borderBottom: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
			>
				Log
				{entries && entries.length > 0 && (
					<button
						type="button"
						onClick={clear}
						className="ml-auto flex items-center gap-1 font-normal px-1.5 py-0.5 rounded"
						style={{ color: theme.colors.textDim }}
						title="Forget every write logged for this database (the database itself is not changed)"
						data-testid="sqlite-statement-log-clear"
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
						data-testid="sqlite-statement-log-error"
					>
						The log could not be read: {error}
					</div>
				)}
				{!entries && !error ? (
					<div
						className="flex items-center gap-2 px-3 py-2 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<Spinner size={10} decorative />
						Reading the log...
					</div>
				) : entries && entries.length === 0 ? (
					<div
						className="px-3 py-2 text-xs"
						style={{ color: theme.colors.textDim }}
						data-testid="sqlite-statement-log-empty"
					>
						Every change made to this database through Maestro appears here, newest first: cell
						edits, inserts, deletes, Undo, Query-mode writes, and transactions, from this viewer and
						from maestro-cli.
					</div>
				) : (
					entries?.map((entry) => {
						const standing = sqliteStatementLogStanding(entry, ends);
						const standingText = sqliteStatementLogStandingText(standing);
						const open = openId === entry.id;
						const notInFile = standing === 'rolled-back' || standing === 'failed';
						return (
							<div
								key={entry.id}
								style={{ borderBottom: `1px solid ${theme.colors.border}` }}
								data-testid="sqlite-statement-log-entry"
								data-standing={standing}
							>
								<button
									type="button"
									onClick={() => setOpenId(open ? null : entry.id)}
									className="w-full text-left px-3 py-1.5 flex flex-col gap-0.5"
									style={{ opacity: notInFile ? 0.6 : 1 }}
									aria-expanded={open}
									title={open ? 'Hide the details' : 'Show the whole statement and what it did'}
									data-testid="sqlite-statement-log-toggle"
								>
									<span
										className="flex items-center gap-1.5 text-2xs"
										style={{ color: theme.colors.textDim }}
									>
										<MiniBadge
											label={SQLITE_STATEMENT_LOG_KIND_LABELS[entry.kind]}
											theme={theme}
											color={entry.outcome.ok ? undefined : theme.colors.error}
										/>
										<span>{formatRelativeTime(entry.at)}</span>
										<span
											className="truncate"
											style={{ color: entry.outcome.ok ? undefined : theme.colors.error }}
										>
											{formatSqliteStatementLogOutcome(entry)}
										</span>
									</span>
									<span
										className="font-mono text-xs truncate"
										style={{
											color: theme.colors.textMain,
											textDecoration: standing === 'rolled-back' ? 'line-through' : undefined,
										}}
									>
										{sqliteQueryHistoryLine(entry.sql)}
									</span>
									{standingText && (
										<span
											className="text-2xs"
											style={{ color: theme.colors.warning }}
											data-testid="sqlite-statement-log-standing"
										>
											{standingText}
										</span>
									)}
								</button>
								{open && (
									<div
										className="px-3 pb-2 flex flex-col gap-1 text-xs select-text"
										style={{ color: theme.colors.textDim }}
										data-testid="sqlite-statement-log-detail"
									>
										<pre
											className="font-mono whitespace-pre-wrap break-words m-0"
											style={{ color: theme.colors.textMain }}
										>
											{entry.sql}
										</pre>
										{Object.entries(entry.params).map(([label, value]) => (
											<span key={label} className="font-mono">
												{label} = {formatSqliteParameterValue(value)}
											</span>
										))}
										{!entry.outcome.ok && (
											<span style={{ color: theme.colors.error }}>{entry.outcome.error}</span>
										)}
										{entry.note && <span>{entry.note}</span>}
										{entry.backupPath && (
											<span className="break-all">
												Backed the file up first to {entry.backupPath}
											</span>
										)}
										<span>{new Date(entry.at).toLocaleString()}</span>
									</div>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
});
