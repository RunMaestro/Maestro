/**
 * useSystemOneLedger - the System One decision ledger for a surface: the newest
 * records that match a task and an outcome.
 *
 * Read on mount, whenever a filter changes, and whenever `refresh()` is called.
 * Nothing is pushed: a gate can decide every few seconds while automation runs,
 * and a settings pane that re-rendered on each one would be reading the stats
 * database on a timer for a list nobody is watching.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
	SystemOneLedgerOutcomeFilter,
	SystemOneLedgerPage,
} from '../../../shared/local-models/system-one-ledger';
import type { LocalModelTaskId } from '../../../shared/local-models/tasks';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

/** What the ledger is narrowed to. An absent field is "all". */
export interface SystemOneLedgerFilters {
	taskId?: LocalModelTaskId;
	outcome?: SystemOneLedgerOutcomeFilter;
}

export interface SystemOneLedgerState {
	/** Null until the first read answers. */
	page: SystemOneLedgerPage | null;
	loading: boolean;
	/** Why the last read failed, or null. */
	error: string | null;
	refresh: () => Promise<void>;
}

export function useSystemOneLedger(filters: SystemOneLedgerFilters): SystemOneLedgerState {
	const { taskId, outcome } = filters;
	const [page, setPage] = useState<SystemOneLedgerPage | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	// Only the newest read may answer: a slow read must not overwrite the one a
	// filter change started after it.
	const latestRef = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRef.current;
		setLoading(true);
		try {
			const next = await window.maestro.localModels.systemOne.ledger({
				...(taskId !== undefined ? { taskId } : {}),
				...(outcome !== undefined ? { outcome } : {}),
			});
			if (!mountedRef.current || request !== latestRef.current) return;
			setPage(next);
			setError(null);
		} catch (err) {
			if (!mountedRef.current || request !== latestRef.current) return;
			setError(ipcErrorMessage(err));
		} finally {
			if (mountedRef.current && request === latestRef.current) setLoading(false);
		}
	}, [taskId, outcome]);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		return () => {
			mountedRef.current = false;
		};
	}, [refresh]);

	return { page, loading, error, refresh };
}
