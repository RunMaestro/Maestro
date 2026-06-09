import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_LOGS, LOG_LEVEL_PRIORITY, shouldLogLevel } from '../../shared/logger-types';

describe('logger-types', () => {
	it('defines stable priorities for base and extended log levels', () => {
		expect(LOG_LEVEL_PRIORITY).toEqual({
			debug: 0,
			info: 1,
			warn: 2,
			error: 3,
			toast: 1,
			autorun: 1,
		});
		expect(DEFAULT_MAX_LOGS).toBe(1000);
	});

	it('filters base log levels by minimum severity', () => {
		expect(shouldLogLevel('debug', 'debug')).toBe(true);
		expect(shouldLogLevel('info', 'debug')).toBe(true);
		expect(shouldLogLevel('warn', 'info')).toBe(true);
		expect(shouldLogLevel('error', 'warn')).toBe(true);

		expect(shouldLogLevel('debug', 'info')).toBe(false);
		expect(shouldLogLevel('info', 'warn')).toBe(false);
		expect(shouldLogLevel('warn', 'error')).toBe(false);
	});

	it('treats toast and autorun as info-priority logs', () => {
		expect(shouldLogLevel('toast', 'debug')).toBe(true);
		expect(shouldLogLevel('toast', 'info')).toBe(true);
		expect(shouldLogLevel('toast', 'warn')).toBe(false);

		expect(shouldLogLevel('autorun', 'debug')).toBe(true);
		expect(shouldLogLevel('autorun', 'info')).toBe(true);
		expect(shouldLogLevel('autorun', 'error')).toBe(false);
	});
});
