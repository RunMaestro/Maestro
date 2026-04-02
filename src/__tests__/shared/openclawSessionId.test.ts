import { describe, expect, it } from 'vitest';
import {
	buildOpenClawSessionId,
	extractOpenClawRawSessionId,
	isCanonicalOpenClawSessionId,
	normalizeOpenClawSessionId,
	parseOpenClawSessionId,
} from '../../shared/openclawSessionId';

describe('openclawSessionId', () => {
	it('builds the canonical composite ID shape', () => {
		expect(buildOpenClawSessionId('main', '1234-uuid')).toBe('main:1234-uuid');
	});

	it('parses a canonical composite ID', () => {
		expect(parseOpenClawSessionId('main:1234-uuid')).toEqual({
			agentName: 'main',
			rawSessionId: '1234-uuid',
			compositeId: 'main:1234-uuid',
		});
	});

	it('normalizes raw IDs to composite when agent name is known', () => {
		expect(normalizeOpenClawSessionId('1234-uuid', { agentName: 'main' })).toBe('main:1234-uuid');
	});

	it('preserves raw IDs when agent name is unknown', () => {
		expect(normalizeOpenClawSessionId('1234-uuid')).toBe('1234-uuid');
	});

	it('extracts the raw session ID from either shape', () => {
		expect(extractOpenClawRawSessionId('main:1234-uuid')).toBe('1234-uuid');
		expect(extractOpenClawRawSessionId('1234-uuid')).toBe('1234-uuid');
	});

	it('detects canonical IDs only for composite values', () => {
		expect(isCanonicalOpenClawSessionId('main:1234-uuid')).toBe(true);
		expect(isCanonicalOpenClawSessionId('1234-uuid')).toBe(false);
	});

	it('rejects invalid colon-delimited values', () => {
		expect(parseOpenClawSessionId('main:sub:1234')).toBeNull();
		expect(normalizeOpenClawSessionId('main:sub:1234')).toBeNull();
	});
});
