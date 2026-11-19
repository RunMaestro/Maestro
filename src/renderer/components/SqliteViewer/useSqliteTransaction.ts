/**
 * useSqliteTransaction - the tab's explicit transaction in Query mode, as
 * the viewer keeps it: open or not, how the last one ended, and Begin,
 * Commit, and Roll back.
 *
 * The transaction itself lives in the main process
 * (src/main/sqlite/sqlite-transaction.ts), tied to the tab's editing grant,
 * so this only mirrors it. It belongs to the grant: a new grant (Lock, then
 * Enable editing; another file) starts with none, and main rolls back the
 * one the old grant held. Main can also end it without being asked (idle
 * for `SQLITE_TRANSACTION_IDLE_MS`, SQLite rolling it back after a failed
 * statement), so the mirror re-reads main's status when a statement in it
 * fails and when its idle deadline passes, and shows how it ended.
 *
 * Kept by the viewer rather than the Query panel, because the panel unmounts
 * in Browse, and an open transaction (holding the file's write lock) must
 * stay visible there too.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
	SqliteEditingGrant,
	SqliteTransactionEnd,
	SqliteTransactionState,
	SqliteTransactionStep,
} from '../../../shared/sqlite/types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { announceSqliteBackup } from './sqliteWriteNotice';

/** A delay past the idle deadline before asking main, so its own timer has fired. */
const EXPIRY_SLACK_MS = 1_000;

export interface SqliteTransactionControl {
	/** The open transaction, or null. */
	state: SqliteTransactionState | null;
	/** How the last one ended, shown until the next Begin. */
	lastEnd: SqliteTransactionEnd | null;
	/** Begin, Commit, or Roll back in flight. */
	pending: 'begin' | 'commit' | 'rollback' | null;
	/** Why the last Begin, Commit, or Roll back failed, verbatim. */
	error: string | null;
	begin: () => void;
	commit: () => void;
	rollBack: () => void;
	/** A statement ran in the transaction: its state after it. */
	noteStep: (step: SqliteTransactionStep) => void;
	/** A statement in it failed, or its deadline passed: ask main whether it is still open. */
	resync: () => void;
}

/**
 * The transaction of the tab holding `grant`. `onCommitted` hears each
 * Commit, so the viewer can re-read the table on screen.
 */
export function useSqliteTransaction(
	grant: SqliteEditingGrant | null,
	onCommitted: (end: SqliteTransactionEnd) => void
): SqliteTransactionControl {
	const [state, setState] = useState<SqliteTransactionState | null>(null);
	const [lastEnd, setLastEnd] = useState<SqliteTransactionEnd | null>(null);
	const [pending, setPending] = useState<SqliteTransactionControl['pending']>(null);
	const [error, setError] = useState<string | null>(null);
	/** The grant replies are for; a reply for another is dropped. */
	const grantRef = useRef(grant);
	grantRef.current = grant;
	const onCommittedRef = useRef(onCommitted);
	onCommittedRef.current = onCommitted;

	// A new grant starts with no transaction; main rolled back the old one.
	useEffect(() => {
		setState(null);
		setLastEnd(null);
		setPending(null);
		setError(null);
	}, [grant]);

	const resync = useCallback(() => {
		const asked = grantRef.current;
		if (!asked) return;
		window.maestro.sqlite
			.readTransaction(asked)
			.then((status) => {
				if (grantRef.current !== asked) return;
				setState(status.transaction);
				if (!status.transaction && status.lastEnd) setLastEnd(status.lastEnd);
			})
			.catch((failure: unknown) => {
				if (grantRef.current === asked) setError(ipcErrorMessage(failure));
			});
	}, []);

	// Main rolls an idle transaction back on its own; find out when it should have.
	const expiresAt = state?.expiresAt ?? null;
	useEffect(() => {
		if (expiresAt === null) return;
		const timer = setTimeout(resync, Math.max(0, expiresAt - Date.now()) + EXPIRY_SLACK_MS);
		return () => clearTimeout(timer);
	}, [expiresAt, resync]);

	const begin = useCallback(() => {
		const asked = grantRef.current;
		if (!asked || pending) return;
		setPending('begin');
		setError(null);
		window.maestro.sqlite
			.beginTransaction(asked)
			.then((begun) => {
				if (grantRef.current !== asked) return;
				// Begin may be the session's first write: it took the backup.
				announceSqliteBackup(begun.backup);
				setState(begun);
				setLastEnd(null);
			})
			.catch((failure: unknown) => {
				if (grantRef.current === asked) setError(ipcErrorMessage(failure));
			})
			.finally(() => {
				if (grantRef.current === asked) setPending(null);
			});
	}, [pending]);

	const end = useCallback(
		(action: 'commit' | 'rollback') => {
			const asked = grantRef.current;
			if (!asked || !state || pending) return;
			setPending(action);
			setError(null);
			window.maestro.sqlite
				.endTransaction({ ...asked, transactionId: state.transactionId, action })
				.then((ended) => {
					if (grantRef.current !== asked) return;
					setState(null);
					setLastEnd(ended);
					if (ended.outcome === 'committed') onCommittedRef.current(ended);
				})
				.catch((failure: unknown) => {
					if (grantRef.current !== asked) return;
					setError(ipcErrorMessage(failure));
					// A refused Commit may have kept the transaction, or not.
					resync();
				})
				.finally(() => {
					if (grantRef.current === asked) setPending(null);
				});
		},
		[state, pending, resync]
	);

	const commit = useCallback(() => end('commit'), [end]);
	const rollBack = useCallback(() => end('rollback'), [end]);
	const noteStep = useCallback((step: SqliteTransactionStep) => {
		setState((current) =>
			current?.transactionId === step.transaction.transactionId ? step.transaction : current
		);
	}, []);

	return { state, lastEnd, pending, error, begin, commit, rollBack, noteStep, resync };
}
