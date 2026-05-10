import { describe, it, expect } from 'vitest';
import {
	isMatchingAgentErrorLog,
	removeMatchingAgentErrorLog,
} from '../../../../../../renderer/hooks/agent/internal/helpers/agentErrorLogMatch';
import type { LogEntry, AgentError } from '../../../../../../renderer/types';

const baseError: AgentError = {
	timestamp: 1700000000000,
	type: 'auth_expired',
	message: 'token expired',
	agentId: 'claude-code',
} as unknown as AgentError;

function errorLog(agentError: AgentError): LogEntry {
	return {
		id: 'err-1',
		timestamp: agentError.timestamp,
		source: 'error',
		text: agentError.message,
		agentError,
	} as LogEntry;
}

describe('isMatchingAgentErrorLog', () => {
	it('returns true on full tuple match', () => {
		expect(isMatchingAgentErrorLog(errorLog(baseError), baseError)).toBe(true);
	});

	it('returns false when source is not error', () => {
		const log = { ...errorLog(baseError), source: 'ai' as const };
		expect(isMatchingAgentErrorLog(log, baseError)).toBe(false);
	});

	it('returns false when any tuple field differs', () => {
		const log = errorLog({ ...baseError, message: 'different' });
		expect(isMatchingAgentErrorLog(log, baseError)).toBe(false);
	});
});

describe('removeMatchingAgentErrorLog', () => {
	it('removes the most recent matching entry', () => {
		const olderMatch = errorLog(baseError);
		const newerMatch = { ...errorLog(baseError), id: 'err-2' };
		const logs: LogEntry[] = [
			olderMatch,
			{ id: 'a', timestamp: 0, source: 'ai', text: '' },
			newerMatch,
		];
		const out = removeMatchingAgentErrorLog(logs, baseError);
		expect(out.find((l) => l.id === 'err-2')).toBeUndefined();
		expect(out.find((l) => l.id === 'err-1')).toBeDefined();
	});

	it('returns the same array reference when no match exists', () => {
		const logs: LogEntry[] = [{ id: 'a', timestamp: 0, source: 'ai', text: '' }];
		const out = removeMatchingAgentErrorLog(logs, baseError);
		expect(out).toBe(logs);
	});
});
