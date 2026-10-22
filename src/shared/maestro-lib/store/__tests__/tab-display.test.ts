import { describe, expect, it } from 'vitest';
import { formatSessionId, getTabDisplayName } from '../tab-display';

describe('formatSessionId', () => {
	it('shortens each provider id form', () => {
		expect(formatSessionId('8535e0e3-aaaa-bbbb-cccc-dddddddddddd')).toBe('8535E0E3');
		expect(formatSessionId('ses_4bcdXYZ')).toBe('SES_4BCD');
		expect(formatSessionId('thread_abc123')).toBe('THR_ABC1');
		expect(formatSessionId('plainsessionid')).toBe('PLAINSES');
	});
});

describe('getTabDisplayName', () => {
	it('prefers the name, then the formatted session id, then "New Session"', () => {
		expect(getTabDisplayName({ name: 'lib-audit', agentSessionId: 'ses_4bcd' })).toBe('lib-audit');
		expect(getTabDisplayName({ name: null, agentSessionId: 'ses_4bcd' })).toBe('SES_4BCD');
		expect(getTabDisplayName({ name: '' })).toBe('New Session');
	});
});
