/**
 * Account Usage Tracking Operations
 *
 * Handles windowed usage aggregation per account and throttle event recording
 * for capacity planning and account multiplexing.
 */

import type Database from 'better-sqlite3';
import { generateId, LOG_CONTEXT } from './utils';
import { StatementCache } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

// ============================================================================
// Account Usage Windows
// ============================================================================

export interface AccountUsageTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
}

export interface AccountUsageSummary {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	queryCount: number;
}

export interface ThrottleEvent {
	id: string;
	accountId: string;
	sessionId: string | null;
	timestamp: number;
	reason: string;
	tokensAtThrottle: number;
}

const UPSERT_CHECK_SQL = `
  SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, query_count
  FROM account_usage_windows WHERE account_id = ? AND window_start = ?
`;

const UPDATE_WINDOW_SQL = `
  UPDATE account_usage_windows SET
    input_tokens = input_tokens + ?,
    output_tokens = output_tokens + ?,
    cache_read_tokens = cache_read_tokens + ?,
    cache_creation_tokens = cache_creation_tokens + ?,
    cost_usd = cost_usd + ?,
    query_count = query_count + 1
  WHERE id = ?
`;

const INSERT_WINDOW_SQL = `
  INSERT INTO account_usage_windows (id, account_id, window_start, window_end, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, query_count, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
`;

const GET_USAGE_SQL = `
  SELECT
    COALESCE(SUM(input_tokens), 0) as inputTokens,
    COALESCE(SUM(output_tokens), 0) as outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
    COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
    COALESCE(SUM(cost_usd), 0) as costUsd,
    COALESCE(SUM(query_count), 0) as queryCount
  FROM account_usage_windows
  WHERE account_id = ? AND window_start >= ? AND window_end <= ?
`;

const INSERT_THROTTLE_SQL = `
  INSERT INTO account_throttle_events (id, account_id, session_id, timestamp, reason, tokens_at_throttle, window_start, window_end)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Record or update a usage window for an account.
 * If a window with the same account_id and window_start exists, increments the totals.
 * Otherwise, inserts a new window record.
 */
export function upsertAccountUsageWindow(
	db: Database.Database,
	accountId: string,
	windowStart: number,
	windowEnd: number,
	tokens: AccountUsageTokens
): void {
	const existing = stmtCache.get(db, UPSERT_CHECK_SQL).get(accountId, windowStart) as
		| { id: string }
		| undefined;

	if (existing) {
		stmtCache.get(db, UPDATE_WINDOW_SQL).run(
			tokens.inputTokens,
			tokens.outputTokens,
			tokens.cacheReadTokens,
			tokens.cacheCreationTokens,
			tokens.costUsd,
			existing.id
		);
		logger.debug(`Updated usage window ${existing.id} for account ${accountId}`, LOG_CONTEXT);
	} else {
		const id = generateId();
		stmtCache.get(db, INSERT_WINDOW_SQL).run(
			id,
			accountId,
			windowStart,
			windowEnd,
			tokens.inputTokens,
			tokens.outputTokens,
			tokens.cacheReadTokens,
			tokens.cacheCreationTokens,
			tokens.costUsd,
			Date.now()
		);
		logger.debug(`Inserted usage window ${id} for account ${accountId}`, LOG_CONTEXT);
	}
}

/**
 * Get usage for an account within a specific time window.
 */
export function getAccountUsageInWindow(
	db: Database.Database,
	accountId: string,
	windowStart: number,
	windowEnd: number
): AccountUsageSummary {
	const result = stmtCache.get(db, GET_USAGE_SQL).get(accountId, windowStart, windowEnd) as AccountUsageSummary;
	return result;
}

// ============================================================================
// Throttle Events
// ============================================================================

/**
 * Record a throttle event for capacity planning.
 */
export function insertThrottleEvent(
	db: Database.Database,
	accountId: string,
	sessionId: string | null,
	reason: string,
	tokensAtThrottle: number,
	windowStart?: number,
	windowEnd?: number
): string {
	const id = generateId();
	stmtCache.get(db, INSERT_THROTTLE_SQL).run(
		id,
		accountId,
		sessionId,
		Date.now(),
		reason,
		tokensAtThrottle,
		windowStart ?? null,
		windowEnd ?? null
	);
	logger.debug(`Inserted throttle event ${id} for account ${accountId}`, LOG_CONTEXT);
	return id;
}

/**
 * Get throttle events for capacity planning, optionally filtered by account and time.
 */
export function getThrottleEvents(
	db: Database.Database,
	accountId?: string,
	since?: number
): ThrottleEvent[] {
	let sql = 'SELECT * FROM account_throttle_events WHERE 1=1';
	const params: (string | number)[] = [];

	if (accountId) {
		sql += ' AND account_id = ?';
		params.push(accountId);
	}
	if (since) {
		sql += ' AND timestamp >= ?';
		params.push(since);
	}
	sql += ' ORDER BY timestamp DESC';

	const rows = db.prepare(sql).all(...params) as Array<{
		id: string;
		account_id: string;
		session_id: string | null;
		timestamp: number;
		reason: string;
		tokens_at_throttle: number;
	}>;

	return rows.map((row) => ({
		id: row.id,
		accountId: row.account_id,
		sessionId: row.session_id,
		timestamp: row.timestamp,
		reason: row.reason,
		tokensAtThrottle: row.tokens_at_throttle,
	}));
}

// ============================================================================
// Historical Aggregations
// ============================================================================

export interface AccountDailyUsage {
	date: string; // YYYY-MM-DD
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUsd: number;
	queryCount: number;
}

export interface AccountMonthlyUsage {
	month: string; // YYYY-MM
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number;
	costUsd: number;
	queryCount: number;
	daysActive: number;
}

const DAILY_USAGE_SQL = `
  SELECT
    date(window_start / 1000, 'unixepoch', 'localtime') as date,
    COALESCE(SUM(input_tokens), 0) as inputTokens,
    COALESCE(SUM(output_tokens), 0) as outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
    COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
    COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as totalTokens,
    COALESCE(SUM(cost_usd), 0) as costUsd,
    COALESCE(SUM(query_count), 0) as queryCount
  FROM account_usage_windows
  WHERE account_id = ? AND window_start >= ? AND window_start < ?
  GROUP BY date
  ORDER BY date ASC
`;

const MONTHLY_USAGE_SQL = `
  SELECT
    strftime('%Y-%m', window_start / 1000, 'unixepoch', 'localtime') as month,
    COALESCE(SUM(input_tokens), 0) as inputTokens,
    COALESCE(SUM(output_tokens), 0) as outputTokens,
    COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
    COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
    COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as totalTokens,
    COALESCE(SUM(cost_usd), 0) as costUsd,
    COALESCE(SUM(query_count), 0) as queryCount,
    COUNT(DISTINCT date(window_start / 1000, 'unixepoch', 'localtime')) as daysActive
  FROM account_usage_windows
  WHERE account_id = ? AND window_start >= ? AND window_start < ?
  GROUP BY month
  ORDER BY month ASC
`;

/**
 * Get daily token usage for an account over a date range.
 * Returns one row per day with non-zero usage.
 */
export function getAccountDailyUsage(
	db: Database.Database,
	accountId: string,
	sinceMs: number,
	untilMs: number
): AccountDailyUsage[] {
	return stmtCache.get(db, DAILY_USAGE_SQL).all(accountId, sinceMs, untilMs) as AccountDailyUsage[];
}

/**
 * Get monthly token usage for an account over a date range.
 * Returns one row per month with non-zero usage.
 */
export function getAccountMonthlyUsage(
	db: Database.Database,
	accountId: string,
	sinceMs: number,
	untilMs: number
): AccountMonthlyUsage[] {
	return stmtCache.get(db, MONTHLY_USAGE_SQL).all(accountId, sinceMs, untilMs) as AccountMonthlyUsage[];
}

/**
 * Get the 5-hour window usage history for an account (last N windows).
 * Used for billing-window analysis and P90 prediction.
 */
export function getAccountWindowHistory(
	db: Database.Database,
	accountId: string,
	windowCount: number = 40 // ~8 days of 5-hour windows
): Array<{
	windowStart: number;
	windowEnd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	costUsd: number;
	queryCount: number;
}> {
	const sql = `
		SELECT window_start as windowStart, window_end as windowEnd,
			input_tokens as inputTokens, output_tokens as outputTokens,
			cache_read_tokens as cacheReadTokens, cache_creation_tokens as cacheCreationTokens,
			cost_usd as costUsd, query_count as queryCount
		FROM account_usage_windows
		WHERE account_id = ?
		ORDER BY window_start DESC
		LIMIT ?
	`;
	const rows = db.prepare(sql).all(accountId, windowCount) as Array<{
		windowStart: number; windowEnd: number;
		inputTokens: number; outputTokens: number;
		cacheReadTokens: number; cacheCreationTokens: number;
		costUsd: number; queryCount: number;
	}>;
	return rows.reverse(); // Return chronological order
}

/**
 * Clear the statement cache (call when database is closed)
 */
export function clearAccountUsageCache(): void {
	stmtCache.clear();
}
