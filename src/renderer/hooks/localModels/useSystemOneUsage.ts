/**
 * useSystemOneUsage - what agents' own System One requests came to, per agent,
 * with today's spend against the budget.
 *
 * Read on mount, whenever the window changes, whenever main says the settings
 * changed (a budget set here or with `maestro-cli s1 set budget` moves the
 * numbers), and whenever `refresh()` is called. A request an agent sends is not
 * pushed, for the reason the ledger is not: a long `rank` records one every few
 * hundred milliseconds, and a settings pane that re-read the stats database on
 * each would be doing it for a table nobody is watching.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SystemOneUsageReport } from '../../../shared/local-models/system-one-spend';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export interface SystemOneUsageState {
	/** Null until the first read answers. */
	report: SystemOneUsageReport | null;
	loading: boolean;
	/** Why the last read failed, or null. */
	error: string | null;
	refresh: () => Promise<void>;
}

/** `since` is epoch ms, or undefined for everything the ledger keeps. */
export function useSystemOneUsage(since?: number): SystemOneUsageState {
	const [report, setReport] = useState<SystemOneUsageReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	// Only the newest read may answer: a slow read must not overwrite a newer one.
	const latestRef = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRef.current;
		setLoading(true);
		try {
			const next = await window.maestro.localModels.systemOne.usage(
				since !== undefined ? { since } : undefined
			);
			if (!mountedRef.current || request !== latestRef.current) return;
			setReport(next);
			setError(null);
		} catch (err) {
			if (!mountedRef.current || request !== latestRef.current) return;
			setError(ipcErrorMessage(err));
		} finally {
			if (mountedRef.current && request === latestRef.current) setLoading(false);
		}
	}, [since]);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		const offChanged = window.maestro.localModels.systemOne.onChanged(() => void refresh());
		return () => {
			mountedRef.current = false;
			offChanged();
		};
	}, [refresh]);

	return { report, loading, error, refresh };
}
