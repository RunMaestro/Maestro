import { describe, it, expect } from 'vitest';
import { isLimitError } from '../../shared/types';
import type { AgentError, AgentErrorType } from '../../shared/types';

function makeError(type: AgentErrorType): AgentError {
	return {
		type,
		message: 'boom',
		recoverable: true,
		agentId: 'claude-code',
		timestamp: 0,
	};
}

describe('isLimitError', () => {
	it('returns true for the two limit-pause error types', () => {
		expect(isLimitError(makeError('rate_limited'))).toBe(true);
		expect(isLimitError(makeError('token_exhaustion'))).toBe(true);
	});

	it('returns false for every non-limit error type', () => {
		const nonLimit: AgentErrorType[] = [
			'auth_expired',
			'network_error',
			'agent_crashed',
			'permission_denied',
			'session_not_found',
			'hitl_gate',
			'unknown',
		];
		for (const type of nonLimit) {
			expect(isLimitError(makeError(type))).toBe(false);
		}
	});
});
