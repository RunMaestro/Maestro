/**
 * SqliteDatabaseFacts - the database-wide half of the SQLite viewer's summary
 * strip: page size and count, free pages, encoding, journal mode,
 * user_version, application_id, and the integrity flag.
 *
 * The header facts are pragmas, read once per open (`sqlite:readSummary`).
 * The integrity flag is a check that reads every page, run on a worker thread
 * in the main process (`sqlite:checkIntegrity`): a quick check starts on its
 * own for a database up to `SQLITE_AUTO_INTEGRITY_MAX_BYTES`, and a larger one
 * waits for the user to ask. After a quick check, a full check (indexes
 * against their tables) is one click away.
 *
 * Renders as items of the strip's wrapping flex row; a failed check's problem
 * list takes a line of its own below them.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import {
	SQLITE_AUTO_INTEGRITY_MAX_BYTES,
	SQLITE_INTEGRITY_MODE_LABELS,
	formatSqliteIntegrity,
	sqliteSummaryFacts,
} from '../../../shared/sqlite/summary';
import type {
	SqliteDatabaseSummary,
	SqliteIntegrityMode,
	SqliteIntegrityResult,
} from '../../../shared/sqlite/types';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { Spinner } from '../ui/Spinner';

interface SqliteDatabaseFactsProps {
	handle: string;
	/** Size of the file at open; decides whether a quick check starts on its own. */
	fileBytes: number;
	theme: Theme;
}

type IntegrityState =
	| { status: 'idle' }
	| { status: 'running'; mode: SqliteIntegrityMode }
	| { status: 'done'; result: SqliteIntegrityResult }
	| { status: 'error'; mode: SqliteIntegrityMode; message: string };

export function SqliteDatabaseFacts({ handle, fileBytes, theme }: SqliteDatabaseFactsProps) {
	const [summary, setSummary] = useState<SqliteDatabaseSummary | null>(null);
	const [summaryError, setSummaryError] = useState<string | null>(null);
	const [integrity, setIntegrity] = useState<IntegrityState>({ status: 'idle' });
	const [showProblems, setShowProblems] = useState(false);
	/**
	 * The check this mount wants. A fresh object per request, so asking for
	 * the same mode again (Retry) still runs; a reply for an older request is
	 * dropped.
	 */
	const [requested, setRequested] = useState<{ mode: SqliteIntegrityMode } | null>(() =>
		fileBytes <= SQLITE_AUTO_INTEGRITY_MAX_BYTES ? { mode: 'quick' } : null
	);

	useEffect(() => {
		let cancelled = false;
		setSummary(null);
		setSummaryError(null);
		window.maestro.sqlite
			.readSummary(handle)
			.then((next) => {
				if (!cancelled) setSummary(next);
			})
			.catch((error: unknown) => {
				if (!cancelled) setSummaryError(ipcErrorMessage(error));
			});
		return () => {
			cancelled = true;
		};
	}, [handle]);

	useEffect(() => {
		if (!requested) return;
		const { mode } = requested;
		let cancelled = false;
		setIntegrity({ status: 'running', mode });
		setShowProblems(false);
		window.maestro.sqlite
			.checkIntegrity(handle, mode)
			.then((result) => {
				if (cancelled) return;
				setIntegrity({ status: 'done', result });
				setShowProblems(!result.ok);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setIntegrity({ status: 'error', mode, message: ipcErrorMessage(error) });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [handle, requested]);

	const runCheck = useCallback((mode: SqliteIntegrityMode) => setRequested({ mode }), []);

	const linkButton = (label: string, mode: SqliteIntegrityMode, title: string, testId: string) => (
		<button
			type="button"
			className="underline"
			onClick={() => runCheck(mode)}
			style={{ color: theme.colors.accentText }}
			title={title}
			data-testid={testId}
		>
			{label}
		</button>
	);

	return (
		<>
			{summary &&
				sqliteSummaryFacts(summary).map((fact) => (
					<span
						key={fact.key}
						className="text-xs-plus"
						title={fact.title}
						data-testid={`sqlite-fact-${fact.key}`}
					>
						<span style={{ color: theme.colors.textDim }}>{fact.label} </span>
						<span style={{ color: theme.colors.textMain }}>{fact.value}</span>
					</span>
				))}
			{summaryError && (
				<span
					className="text-xs-plus"
					style={{ color: theme.colors.warning }}
					data-testid="sqlite-summary-error"
				>
					{summaryError}
				</span>
			)}

			<span
				className="text-xs-plus flex items-center gap-1.5"
				style={{ color: theme.colors.textDim }}
				data-testid="sqlite-integrity"
			>
				{integrity.status === 'idle' &&
					linkButton(
						'Check integrity',
						'quick',
						'Run PRAGMA quick_check. It reads every page of the file, off the main thread.',
						'sqlite-integrity-check'
					)}
				{integrity.status === 'running' && (
					<>
						<Spinner size={10} decorative />
						Running {SQLITE_INTEGRITY_MODE_LABELS[integrity.mode]}...
					</>
				)}
				{integrity.status === 'done' && integrity.result.ok && (
					<>
						<span
							className="flex items-center gap-1"
							style={{ color: theme.colors.success }}
							title={`Integrity ${formatSqliteIntegrity(integrity.result)}`}
							data-testid="sqlite-integrity-ok"
						>
							<CheckCircle2 className="w-3 h-3" />
							Integrity ok
						</span>
						{integrity.result.mode === 'quick' &&
							linkButton(
								'Full check',
								'full',
								'Run PRAGMA integrity_check: also verifies every index against its table. Slower than the quick check.',
								'sqlite-integrity-full'
							)}
					</>
				)}
				{integrity.status === 'done' && !integrity.result.ok && (
					<button
						type="button"
						className="flex items-center gap-1"
						style={{ color: theme.colors.warning }}
						onClick={() => setShowProblems((shown) => !shown)}
						title={showProblems ? 'Hide the problems' : 'Show the problems'}
						aria-expanded={showProblems}
						data-testid="sqlite-integrity-failed"
					>
						<AlertTriangle className="w-3 h-3" />
						Integrity: {formatSqliteIntegrity(integrity.result)}
					</button>
				)}
				{integrity.status === 'error' && (
					<>
						<span style={{ color: theme.colors.warning }} data-testid="sqlite-integrity-error">
							Integrity check failed: {integrity.message}
						</span>
						{linkButton(
							'Retry',
							integrity.mode,
							`Run the ${SQLITE_INTEGRITY_MODE_LABELS[integrity.mode]} again`,
							'sqlite-integrity-retry'
						)}
					</>
				)}
			</span>

			{integrity.status === 'done' && !integrity.result.ok && showProblems && (
				<ul
					className="basis-full text-xs font-mono whitespace-pre-wrap select-text max-h-32 overflow-y-auto pl-7"
					style={{ color: theme.colors.warning }}
					data-testid="sqlite-integrity-problems"
				>
					{integrity.result.problems.map((problem, index) => (
						<li key={index}>{problem}</li>
					))}
					{integrity.result.truncated && (
						<li style={{ color: theme.colors.textDim }}>More problems are not listed.</li>
					)}
				</ul>
			)}
		</>
	);
}
