/**
 * useTokenProxyReport - the Maestro token proxy's report for a surface: the
 * listener, the agents on it, what it carried, and what it last shortened.
 *
 * Read on mount and whenever `refresh()` is called. Nothing is pushed: the
 * proxy handles a request every few seconds while an agent works, and a
 * settings pane that re-rendered on each one would be reading the stats
 * database on a timer for a number nobody is watching.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { TokenProxyReport } from '../../../shared/local-models/token-proxy';

export interface TokenProxyReportState {
	/** Null until the first read answers. */
	report: TokenProxyReport | null;
	loading: boolean;
	/** Why the last read failed, or null. */
	error: string | null;
	refresh: () => Promise<void>;
}

export function useTokenProxyReport(): TokenProxyReportState {
	const [report, setReport] = useState<TokenProxyReport | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	// Only the newest read may answer: a slow first read must not overwrite the
	// refresh that followed a mode change.
	const latestRef = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRef.current;
		setLoading(true);
		try {
			const next = await window.maestro.localModels.proxy.report();
			if (!mountedRef.current || request !== latestRef.current) return;
			setReport(next);
			setError(null);
		} catch (err) {
			if (!mountedRef.current || request !== latestRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (mountedRef.current && request === latestRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		return () => {
			mountedRef.current = false;
		};
	}, [refresh]);

	return { report, loading, error, refresh };
}
