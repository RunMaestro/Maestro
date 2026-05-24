import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../main/utils/logger';
import {
	clearSessionLifecycleCache,
	getSessionLifecycleEvents,
	recordSessionClosed,
	recordSessionCreated,
} from '../../../main/stats/session-lifecycle';

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
	},
}));

type MockStatement = {
	run: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	all: ReturnType<typeof vi.fn>;
};

function createStatement(): MockStatement {
	return {
		run: vi.fn(() => ({ changes: 1 })),
		get: vi.fn(() => undefined),
		all: vi.fn(() => []),
	};
}

function createMockDb(statementForSql?: (sql: string) => MockStatement): {
	db: Database.Database;
	prepare: ReturnType<typeof vi.fn>;
	preparedSql: string[];
} {
	const preparedSql: string[] = [];
	const prepare = vi.fn((sql: string) => {
		preparedSql.push(sql);
		return statementForSql?.(sql) ?? createStatement();
	});

	return {
		db: { prepare } as unknown as Database.Database,
		prepare,
		preparedSql,
	};
}

describe('session lifecycle stats operations', () => {
	beforeEach(() => {
		clearSessionLifecycleCache();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
		let randomValue = 0.1;
		vi.spyOn(Math, 'random').mockImplementation(() => {
			randomValue += 0.1;
			return randomValue;
		});
		vi.mocked(logger.debug).mockClear();
	});

	afterEach(() => {
		clearSessionLifecycleCache();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('records session creation with normalized project path and remote flag variants', () => {
		const insert = createStatement();
		const { db, prepare } = createMockDb(() => insert);

		const remoteId = recordSessionCreated(db, {
			sessionId: 'remote-session',
			agentType: 'claude-code',
			projectPath: 'C:\\Users\\jeff\\repo',
			createdAt: 1000,
			isRemote: true,
		});
		const localId = recordSessionCreated(db, {
			sessionId: 'local-session',
			agentType: 'codex',
			projectPath: '/Users/jeff/repo',
			createdAt: 2000,
			isRemote: false,
		});
		const unknownRemoteId = recordSessionCreated(db, {
			sessionId: 'unknown-remote-session',
			agentType: 'opencode',
			projectPath: undefined,
			createdAt: 3000,
		});

		expect(prepare).toHaveBeenCalledTimes(1);
		expect(insert.run).toHaveBeenNthCalledWith(
			1,
			remoteId,
			'remote-session',
			'claude-code',
			'C:/Users/jeff/repo',
			1000,
			1
		);
		expect(insert.run).toHaveBeenNthCalledWith(
			2,
			localId,
			'local-session',
			'codex',
			'/Users/jeff/repo',
			2000,
			0
		);
		expect(insert.run).toHaveBeenNthCalledWith(
			3,
			unknownRemoteId,
			'unknown-remote-session',
			'opencode',
			null,
			3000,
			null
		);
		expect(logger.debug).toHaveBeenCalledWith(
			'Recorded session created: unknown-remote-session',
			'[StatsDB]'
		);
	});

	it('propagates insert failures without logging a successful creation', () => {
		const insert = createStatement();
		insert.run.mockImplementationOnce(() => {
			throw new Error('database locked');
		});
		const { db } = createMockDb(() => insert);

		expect(() =>
			recordSessionCreated(db, {
				sessionId: 'failed-session',
				agentType: 'claude-code',
				projectPath: '/repo',
				createdAt: 1000,
			})
		).toThrow('database locked');
		expect(logger.debug).not.toHaveBeenCalled();
	});

	it('returns false when closing a session that was never recorded', () => {
		const select = createStatement();
		select.get.mockReturnValue(undefined);
		const { db, preparedSql } = createMockDb(() => select);

		expect(recordSessionClosed(db, 'missing-session', 2000)).toBe(false);

		expect(preparedSql).toHaveLength(1);
		expect(select.get).toHaveBeenCalledWith('missing-session');
		expect(select.run).not.toHaveBeenCalled();
		expect(logger.debug).toHaveBeenCalledWith(
			'Session not found for closure: missing-session',
			'[StatsDB]'
		);
	});

	it('records closure duration and reports whether a row changed', () => {
		const select = createStatement();
		select.get.mockReturnValue({ created_at: 1000 });
		const update = createStatement();
		update.run.mockReturnValueOnce({ changes: 1 }).mockReturnValueOnce({ changes: 0 });
		const { db } = createMockDb((sql) => (sql.includes('SELECT created_at') ? select : update));

		expect(recordSessionClosed(db, 'session-1', 2750)).toBe(true);
		expect(recordSessionClosed(db, 'session-1', 3000)).toBe(false);

		expect(update.run).toHaveBeenNthCalledWith(1, 2750, 1750, 'session-1');
		expect(update.run).toHaveBeenNthCalledWith(2, 3000, 2000, 'session-1');
		expect(logger.debug).toHaveBeenLastCalledWith(
			'Recorded session closed: session-1, duration: 2000ms',
			'[StatsDB]'
		);
	});

	it('maps lifecycle rows in descending created-at query results', () => {
		const query = createStatement();
		query.all.mockReturnValue([
			{
				id: 'remote-event',
				session_id: 'remote-session',
				agent_type: 'claude-code',
				project_path: '/repo',
				created_at: 3000,
				closed_at: 5000,
				duration: 2000,
				is_remote: 1,
			},
			{
				id: 'local-event',
				session_id: 'local-session',
				agent_type: 'codex',
				project_path: null,
				created_at: 2000,
				closed_at: null,
				duration: null,
				is_remote: 0,
			},
			{
				id: 'unknown-remote-event',
				session_id: 'unknown-remote-session',
				agent_type: 'opencode',
				project_path: '/other',
				created_at: 1000,
				closed_at: null,
				duration: null,
				is_remote: null,
			},
		]);
		const { db, preparedSql } = createMockDb(() => query);

		expect(getSessionLifecycleEvents(db, 'week')).toEqual([
			{
				id: 'remote-event',
				sessionId: 'remote-session',
				agentType: 'claude-code',
				projectPath: '/repo',
				createdAt: 3000,
				closedAt: 5000,
				duration: 2000,
				isRemote: true,
			},
			{
				id: 'local-event',
				sessionId: 'local-session',
				agentType: 'codex',
				projectPath: undefined,
				createdAt: 2000,
				closedAt: undefined,
				duration: undefined,
				isRemote: false,
			},
			{
				id: 'unknown-remote-event',
				sessionId: 'unknown-remote-session',
				agentType: 'opencode',
				projectPath: '/other',
				createdAt: 1000,
				closedAt: undefined,
				duration: undefined,
				isRemote: undefined,
			},
		]);
		expect(preparedSql[0]).toContain('ORDER BY created_at DESC');
		expect(query.all).toHaveBeenCalledWith(Date.now() - 7 * 24 * 60 * 60 * 1000);
	});

	it('returns an empty list when no lifecycle rows match the range', () => {
		const query = createStatement();
		query.all.mockReturnValue([]);
		const { db } = createMockDb(() => query);

		expect(getSessionLifecycleEvents(db, 'all')).toEqual([]);
		expect(query.all).toHaveBeenCalledWith(0);
	});

	it('clears cached statements so a reopened database prepares fresh statements', () => {
		const firstInsert = createStatement();
		const secondInsert = createStatement();
		let prepareCount = 0;
		const { db, prepare } = createMockDb(() => {
			prepareCount++;
			return prepareCount === 1 ? firstInsert : secondInsert;
		});

		recordSessionCreated(db, {
			sessionId: 'first-session',
			agentType: 'claude-code',
			projectPath: '/repo',
			createdAt: 1000,
		});
		recordSessionCreated(db, {
			sessionId: 'cached-session',
			agentType: 'claude-code',
			projectPath: '/repo',
			createdAt: 2000,
		});
		clearSessionLifecycleCache();
		recordSessionCreated(db, {
			sessionId: 'second-session',
			agentType: 'claude-code',
			projectPath: '/repo',
			createdAt: 3000,
		});

		expect(prepare).toHaveBeenCalledTimes(2);
		expect(firstInsert.run).toHaveBeenCalledTimes(2);
		expect(secondInsert.run).toHaveBeenCalledTimes(1);
	});
});
