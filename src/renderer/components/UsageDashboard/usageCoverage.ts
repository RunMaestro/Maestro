/**
 * How much of a range's activity a token or cost figure actually covers.
 *
 * `query_events` only gained token and cost columns partway through its life,
 * so a range can hold far more queries than priced ones. A cost shown without
 * this note reads as the whole range when it may cover a fraction of it. One
 * wording for every Usage Dashboard surface, so a tile, its detail modal, and
 * an agent's detail cannot contradict each other.
 */

import { formatNumber } from '../../../shared/formatters';

export function usageCoverageNote(pricedQueries: number, queries: number): string {
	if (pricedQueries === 0) {
		return 'No token usage recorded yet. Cost tracking covers turns recorded after the stats database gained token columns.';
	}
	if (pricedQueries >= queries) {
		return `Covers all ${formatNumber(queries)} recorded ${queries === 1 ? 'query' : 'queries'}.`;
	}
	return `Covers ${formatNumber(pricedQueries)} of ${formatNumber(queries)} queries - earlier turns report no usage.`;
}
