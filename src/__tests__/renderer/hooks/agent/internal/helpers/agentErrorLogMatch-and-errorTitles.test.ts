// Source: src/__tests__/renderer/hooks/agent/internal/helpers/agentErrorLogMatch.test.ts
// Source: src/__tests__/renderer/hooks/agent/internal/helpers/errorTitles.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { isMatchingAgentErrorLog } from '../../../../../../renderer/hooks/agent/internal/helpers/agentErrorLogMatch';
import { removeMatchingAgentErrorLog } from '../../../../../../renderer/hooks/agent/internal/helpers/agentErrorLogMatch';
import type { LogEntry } from '../../../../../../renderer/types';
import type { AgentError } from '../../../../../../renderer/types';
import { getErrorTitleForType } from '../../../../../../renderer/hooks/agent/internal/helpers/errorTitles';
describeSourceSuite('agentErrorLogMatch', () => {
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
});
describeSourceSuite('errorTitles', () => {
	describe('getErrorTitleForType', () => {
		it.each([
			['auth_expired', 'Authentication Required'],
			['token_exhaustion', 'Context Limit Reached'],
			['rate_limited', 'Rate Limit Exceeded'],
			['network_error', 'Connection Error'],
			['agent_crashed', 'Agent Error'],
			['agent_not_installed', 'Provider CLI Not Installed'],
			['permission_denied', 'Permission Denied'],
			['session_not_found', 'Session Not Found'],
		] as const)('maps %s to %s', (type, expected) => {
			expect(getErrorTitleForType(type as any)).toBe(expected);
		});

		it('returns generic "Error" for unknown types', () => {
			expect(getErrorTitleForType('something_new' as any)).toBe('Error');
		});
	});
});
