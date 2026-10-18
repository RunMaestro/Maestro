/**
 * The query-event insert definition moved into the library, where the headless runtime
 * writes the same row (`src/shared/maestro-lib/stats/query-event-insert.ts`). This file keeps
 * the old import path working.
 */

export {
	INSERT_QUERY_EVENT_SQL,
	QUERY_EVENT_COLUMNS,
	bindQueryEvent,
} from '../../shared/maestro-lib/stats/query-event-insert';
