/**
 * TokenSeriesContext
 *
 * Shares one lazily-fetched {@link TokenSeries} across every Usage Dashboard
 * chart that offers a "Tokens" metric mode.
 *
 * Why lazy: the series is derived by parsing each agent's on-disk transcripts,
 * which is slow the first time on a machine with a large history. Fetching it
 * eagerly would make simply *opening* the dashboard slow for everyone, including
 * users who never touch a Tokens toggle. Instead each chart passes
 * `enabled = (metricMode === 'tokens')` and the fetch fires on the first chart
 * that asks. Because the state lives here rather than in each chart, six charts
 * asking still produce one IPC round trip.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react';
import type { StatsTimeRange } from '../../../shared/stats-types';
import type { TokenSeries, TokenUsageQuery } from '../../../shared/tokenUsage';
import { captureException } from '../../utils/sentry';

interface TokenSeriesState {
	series: TokenSeries | null;
	loading: boolean;
	error: string | null;
	/** Called by charts to signal they need the series now. */
	request: () => void;
}

const TokenSeriesContext = createContext<TokenSeriesState | null>(null);

/** Lookback per dashboard range, mirroring `getTimeRangeStart` in main. */
const RANGE_DAYS: Record<Exclude<StatsTimeRange, 'all'>, number> = {
	day: 1,
	week: 7,
	month: 30,
	quarter: 90,
	year: 365,
};

function toQuery(range: StatsTimeRange): TokenUsageQuery {
	if (range === 'all') return { granularity: 'month' };
	return { sinceMs: Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000, granularity: 'day' };
}

export function TokenSeriesProvider({
	timeRange,
	children,
}: {
	timeRange: StatsTimeRange;
	children: ReactNode;
}) {
	const [series, setSeries] = useState<TokenSeries | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Sticky across time-range changes: once the user has opted into a Tokens
	// view we keep refetching for the new range instead of making them re-click.
	const [requested, setRequested] = useState(false);
	const requestedRef = useRef(false);

	const request = useCallback(() => {
		if (requestedRef.current) return;
		requestedRef.current = true;
		setRequested(true);
	}, []);

	useEffect(() => {
		if (!requested) return;
		// Guard the bridge call: a renderer running against an older preload (or a
		// test harness with a partial `window.maestro` mock) would otherwise throw
		// inside an effect and unmount the whole dashboard. Charts fall back to
		// showing no token data, which is the correct degraded behavior.
		const getTokenUsage = window.maestro?.stats?.getTokenUsage;
		if (typeof getTokenUsage !== 'function') {
			setError('Token usage is unavailable in this build.');
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError(null);
		getTokenUsage(toQuery(timeRange))
			.then((agg) => {
				if (!cancelled) setSeries(agg.series);
			})
			.catch((err) => {
				captureException(err);
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [requested, timeRange]);

	const value = useMemo<TokenSeriesState>(
		() => ({ series, loading, error, request }),
		[series, loading, error, request]
	);

	return <TokenSeriesContext.Provider value={value}>{children}</TokenSeriesContext.Provider>;
}

/**
 * Read the shared token series. Pass `enabled` true (i.e. this chart is showing
 * its Tokens mode) to trigger the lazy fetch.
 *
 * Safe outside a provider - returns an inert state so a chart rendered
 * standalone (e.g. in a unit test) simply never offers token data.
 */
export function useTokenSeries(enabled: boolean): Omit<TokenSeriesState, 'request'> {
	const ctx = useContext(TokenSeriesContext);
	const request = ctx?.request;

	useEffect(() => {
		if (enabled && request) request();
	}, [enabled, request]);

	return {
		series: ctx?.series ?? null,
		loading: ctx?.loading ?? false,
		error: ctx?.error ?? null,
	};
}
