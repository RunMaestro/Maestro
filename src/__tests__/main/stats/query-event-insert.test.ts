/**
 * Tests for the shared query-event insert definition.
 *
 * This module exists because the buffered and direct insert paths had already
 * drifted - the buffered statement, the one production actually uses, omitted
 * `is_worktree`, so every interactive turn wrote NULL there. These tests pin
 * the two properties that prevent a repeat: both paths use one statement, and
 * the bind order matches the column order exactly.
 */

import { describe, it, expect } from 'vitest';
import { INSERT_QUERY_EVENT_SQL, bindQueryEvent } from '../../../main/stats/query-event-insert';
import type { QueryEvent } from '../../../shared/stats-types';

/** Column names from the generated INSERT, in declared order. */
function insertColumns(): string[] {
	const match = INSERT_QUERY_EVENT_SQL.match(/\(([^)]*)\)\s*VALUES/);
	if (!match) throw new Error('INSERT_QUERY_EVENT_SQL is not shaped as expected');
	return match[1].split(',').map((c) => c.trim());
}

const FULL_EVENT: Omit<QueryEvent, 'id'> = {
	sessionId: 'session-1',
	agentType: 'claude-code',
	source: 'user',
	startTime: 1_700_000_000_000,
	duration: 4200,
	projectPath: 'C:\\Users\\test\\proj',
	tabId: 'tab-1',
	isRemote: true,
	isWorktree: true,
	inputTokens: 1000,
	outputTokens: 250,
	cacheReadTokens: 900,
	cacheCreationTokens: 80,
	costUsd: 0.42,
};

describe('INSERT_QUERY_EVENT_SQL', () => {
	it('binds exactly one placeholder per column', () => {
		const columns = insertColumns();
		const placeholders = INSERT_QUERY_EVENT_SQL.match(/VALUES\s*\(([^)]*)\)/)?.[1]
			.split(',')
			.map((p) => p.trim());

		expect(placeholders).toHaveLength(columns.length);
		expect(new Set(placeholders)).toEqual(new Set(['?']));
	});

	it('includes the columns that were lost to drift', () => {
		expect(insertColumns()).toEqual(
			expect.arrayContaining([
				'is_worktree',
				'input_tokens',
				'output_tokens',
				'cache_read_tokens',
				'cache_creation_tokens',
				'cost_usd',
			])
		);
	});

	it('produces a bind array the same length as the column list', () => {
		expect(bindQueryEvent('id-1', FULL_EVENT)).toHaveLength(insertColumns().length);
	});
});

describe('bindQueryEvent', () => {
	it('binds every value in column order', () => {
		const columns = insertColumns();
		const values = bindQueryEvent('id-1', FULL_EVENT);
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row).toEqual({
			id: 'id-1',
			session_id: 'session-1',
			agent_type: 'claude-code',
			source: 'user',
			start_time: 1_700_000_000_000,
			duration: 4200,
			// Backslashes are normalized so a Windows path groups with its
			// posix-recorded twin.
			project_path: 'C:/Users/test/proj',
			tab_id: 'tab-1',
			is_remote: 1,
			is_worktree: 1,
			input_tokens: 1000,
			output_tokens: 250,
			cache_read_tokens: 900,
			cache_creation_tokens: 80,
			cost_usd: 0.42,
		});
	});

	it('writes NULL, not 0, for a turn that reported no usage', () => {
		// A turn whose provider said nothing is not a free turn. The aggregation
		// counts priced queries by testing for NULL, so a zero here would make
		// every historical row look like a recorded $0.00.
		const columns = insertColumns();
		const values = bindQueryEvent('id-2', {
			sessionId: 'session-2',
			agentType: 'codex',
			source: 'auto',
			startTime: 1,
			duration: 2,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.input_tokens).toBeNull();
		expect(row.output_tokens).toBeNull();
		expect(row.cache_read_tokens).toBeNull();
		expect(row.cache_creation_tokens).toBeNull();
		expect(row.cost_usd).toBeNull();
	});

	it('writes a real zero when the provider reported zero', () => {
		const columns = insertColumns();
		const values = bindQueryEvent('id-3', {
			sessionId: 'session-3',
			agentType: 'codex',
			source: 'user',
			startTime: 1,
			duration: 2,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.input_tokens).toBe(0);
		expect(row.cost_usd).toBe(0);
	});

	it('distinguishes an absent boolean flag from false', () => {
		const columns = insertColumns();
		const absent = Object.fromEntries(
			columns.map((c, i) => [
				c,
				bindQueryEvent('id-4', {
					sessionId: 's',
					agentType: 'codex',
					source: 'user',
					startTime: 1,
					duration: 2,
				})[i],
			])
		);
		const explicit = Object.fromEntries(
			columns.map((c, i) => [
				c,
				bindQueryEvent('id-5', {
					sessionId: 's',
					agentType: 'codex',
					source: 'user',
					startTime: 1,
					duration: 2,
					isRemote: false,
					isWorktree: false,
				})[i],
			])
		);

		expect(absent.is_remote).toBeNull();
		expect(absent.is_worktree).toBeNull();
		expect(explicit.is_remote).toBe(0);
		expect(explicit.is_worktree).toBe(0);
	});

	it('nulls an omitted project path and tab id', () => {
		const columns = insertColumns();
		const values = bindQueryEvent('id-6', {
			sessionId: 's',
			agentType: 'codex',
			source: 'user',
			startTime: 1,
			duration: 2,
		});
		const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));

		expect(row.project_path).toBeNull();
		expect(row.tab_id).toBeNull();
	});
});
