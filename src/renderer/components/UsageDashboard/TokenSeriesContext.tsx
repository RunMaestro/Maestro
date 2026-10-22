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
 *
 * The payload itself is the shared `useTokenUsage` cache entry, so when the
 * Overview speed cards or the Tokens tab have already loaded the range, a chart
 * flipping to Tokens has its series on the first frame.
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
import type { TokenSeries } from '../../../shared/tokenUsage';
import { useTokenUsage } from './useTokenUsage';

interface TokenSeriesState {
	series: TokenSeries | null;
	loading: boolean;
	error: string | null;
	/** Called by charts to signal they need the series now. */
	request: () => void;
}

const TokenSeriesContext = createContext<TokenSeriesState | null>(null);

export function TokenSeriesProvider({
	timeRange,
	children,
}: {
	timeRange: StatsTimeRange;
	children: ReactNode;
}) {
	// Sticky across time-range changes: once the user has opted into a Tokens
	// view we keep refetching for the new range instead of making them re-click.
	const [requested, setRequested] = useState(false);
	const requestedRef = useRef(false);

	const request = useCallback(() => {
		if (requestedRef.current) return;
		requestedRef.current = true;
		setRequested(true);
	}, []);

	// Reads the cache entry the Tokens tab and the Overview speed cards share, so
	// a series one of them already loaded is available without asking.
	const { data, loading, error } = useTokenUsage(timeRange, requested);

	const value = useMemo<TokenSeriesState>(
		() => ({
			series: data?.series ?? null,
			loading: requested && loading,
			error: data ? null : error,
			request,
		}),
		[data, loading, error, requested, request]
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
