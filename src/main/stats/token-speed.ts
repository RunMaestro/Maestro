/**
 * Token speed timed off the live stream, stored per local clock hour.
 *
 * The main process times each model call as the provider's stream events
 * arrive (`StreamCallTimer`, fed by `AgentOutputParser.extractCallTiming`) and
 * folds every call into `token_speed_hourly`. Reads return the rows in the same
 * `TokenSpeedBucket` shape the transcript path builds, so the Tokens tab merges
 * both into one summary.
 */

import type Database from 'better-sqlite3';
import {
	localHourStart,
	type TokenSpeedBucket,
	type TokenSpeedSample,
	type TokenSpeedSource,
} from '../../shared/tokenSpeed';
import { StatementCache } from './utils';

const stmtCache = new StatementCache();

const UPSERT_SQL = `
  INSERT INTO token_speed_hourly (hour_start, agent_type, model, calls, input_tokens, output_tokens, duration_ms)
  VALUES (?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(hour_start, agent_type, model) DO UPDATE SET
    calls = calls + 1,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    duration_ms = duration_ms + excluded.duration_ms
`;

const SELECT_SINCE_SQL = `
  SELECT hour_start, agent_type, model, calls, input_tokens, output_tokens, duration_ms
  FROM token_speed_hourly
  WHERE hour_start >= ?
  ORDER BY agent_type ASC, hour_start ASC, model ASC
`;

/** Add one timed call to its provider's model-hour. */
export function recordTokenSpeedSample(
	db: Database.Database,
	agentType: string,
	sample: TokenSpeedSample
): void {
	stmtCache
		.get(db, UPSERT_SQL)
		.run(
			localHourStart(sample.endMs),
			agentType,
			sample.model,
			Math.round(sample.inputTokens),
			Math.round(sample.outputTokens),
			Math.round(sample.durationMs)
		);
}

/**
 * Stream-timed buckets whose hour could fall in a window starting at
 * `sinceMs` (0 or omitted for all time), one source per provider. The summary
 * applies the exact window bounds itself.
 */
export function getTokenSpeedSources(db: Database.Database, sinceMs = 0): TokenSpeedSource[] {
	const rows = stmtCache
		.get(db, SELECT_SINCE_SQL)
		.all(localHourStart(Math.max(0, sinceMs))) as Array<{
		hour_start: number;
		agent_type: string;
		model: string;
		calls: number;
		input_tokens: number;
		output_tokens: number;
		duration_ms: number;
	}>;
	const byAgent = new Map<string, TokenSpeedBucket[]>();
	for (const row of rows) {
		let buckets = byAgent.get(row.agent_type);
		if (!buckets) {
			buckets = [];
			byAgent.set(row.agent_type, buckets);
		}
		buckets.push({
			startMs: row.hour_start,
			model: row.model,
			calls: row.calls,
			inputTokens: row.input_tokens,
			outputTokens: row.output_tokens,
			durationMs: row.duration_ms,
		});
	}
	return [...byAgent].map(([agentType, buckets]) => ({ agentType, buckets }));
}

/** Clear the statement cache (call when the database is closed). */
export function clearTokenSpeedCache(): void {
	stmtCache.clear();
}
