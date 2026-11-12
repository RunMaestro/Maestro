/**
 * Tests for isExpectedSessionReadError.
 *
 * Guards the boundary that keeps environmental transcript-read failures out of
 * Sentry (MAESTRO-W9, MAESTRO-YG/YH/YJ) without swallowing genuine faults.
 */

import { describe, it, expect } from 'vitest';
import { isExpectedSessionReadError } from '../../../main/utils/session-read-errors';
import { isExpectedSessionReadError as reExported } from '../../../main/ipc/handlers/agentSessions';

const errno = (code: string) =>
	Object.assign(new Error(`${code}: failed, open '/x.jsonl'`), { code });

describe('isExpectedSessionReadError', () => {
	it.each(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EBUSY'])(
		'treats %s as an expected transcript-read failure',
		(code) => {
			expect(isExpectedSessionReadError(errno(code))).toBe(true);
		}
	);

	it('reports genuine faults', () => {
		expect(isExpectedSessionReadError(new Error('Unexpected token in JSON'))).toBe(false);
		expect(isExpectedSessionReadError(new RangeError('Invalid string length'))).toBe(false);
		// EMFILE means we leaked descriptors - that is our bug, keep reporting it.
		expect(isExpectedSessionReadError(errno('EMFILE'))).toBe(false);
	});

	it('requires a string code on an object, not a bare value', () => {
		expect(isExpectedSessionReadError(undefined)).toBe(false);
		expect(isExpectedSessionReadError(null)).toBe(false);
		expect(isExpectedSessionReadError('EACCES')).toBe(false);
	});

	it('stays re-exported from agentSessions for existing importers', () => {
		expect(reExported).toBe(isExpectedSessionReadError);
	});
});
