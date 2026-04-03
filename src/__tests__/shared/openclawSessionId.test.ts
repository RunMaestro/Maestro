import { describe, expect, it } from 'vitest';
import {
	buildOpenClawSessionId,
	extractOpenClawAgentNameFromJson,
	extractOpenClawRawSessionId,
	extractOpenClawSessionIdFromJson,
	isCanonicalOpenClawSessionId,
	normalizeOpenClawSessionId,
	parseOpenClawSessionId,
	resolveCanonicalOpenClawSessionId,
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

	it('trims whitespace while normalizing raw and composite IDs', () => {
		expect(normalizeOpenClawSessionId(' 1234-uuid ', { agentName: ' main ' })).toBe(
			'main:1234-uuid'
		);
		expect(normalizeOpenClawSessionId(' main:1234-uuid ')).toBe('main:1234-uuid');
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

	it('resolves canonical matches after trimming whitespace', () => {
		expect(resolveCanonicalOpenClawSessionId(' abc-123 ', ['main:abc-123'])).toBe('main:abc-123');
	});

	it('extracts agent names from wrapped OpenClaw payloads', () => {
		expect(
			extractOpenClawAgentNameFromJson({
				status: 'error',
				result: {
					meta: {
						agentMeta: {
							agentName: 'ops',
						},
					},
				},
			})
		).toBe('ops');
	});

	it('extracts canonical session IDs from wrapped OpenClaw payloads', () => {
		expect(
			extractOpenClawSessionIdFromJson({
				status: 'ok',
				result: {
					meta: {
						agentMeta: {
							agentId: 'main',
							sessionId: '1234-uuid',
						},
					},
				},
			})
		).toBe('main:1234-uuid');
	});

	it('accepts already canonical values when rebuilding a session ID', () => {
		expect(buildOpenClawSessionId('main', ' main:1234-uuid ')).toBe('main:1234-uuid');
	});
});
