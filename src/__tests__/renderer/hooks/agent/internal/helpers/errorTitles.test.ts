import { describe, it, expect } from 'vitest';
import { getErrorTitleForType } from '../../../../../../renderer/hooks/agent/internal/helpers/errorTitles';

describe('getErrorTitleForType', () => {
	it.each([
		['auth_expired', 'Authentication Required'],
		['token_exhaustion', 'Context Limit Reached'],
		['rate_limited', 'Rate Limit Exceeded'],
		['network_error', 'Connection Error'],
		['agent_crashed', 'Agent Error'],
		['permission_denied', 'Permission Denied'],
		['session_not_found', 'Session Not Found'],
	] as const)('maps %s to %s', (type, expected) => {
		expect(getErrorTitleForType(type as any)).toBe(expected);
	});

	it('returns generic "Error" for unknown types', () => {
		expect(getErrorTitleForType('something_new' as any)).toBe('Error');
	});
});
