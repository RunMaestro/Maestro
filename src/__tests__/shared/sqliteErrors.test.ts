import { describe, expect, it } from 'vitest';
import { isSqliteCorruptionError } from '../../shared/sqliteErrors';

function sqliteError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

describe('isSqliteCorruptionError', () => {
	it('classifies SQLITE_CORRUPT, its extended codes and SQLITE_NOTADB as corruption', () => {
		expect(isSqliteCorruptionError(sqliteError('SQLITE_CORRUPT'))).toBe(true);
		expect(isSqliteCorruptionError(sqliteError('SQLITE_CORRUPT_INDEX'))).toBe(true);
		expect(isSqliteCorruptionError(sqliteError('SQLITE_NOTADB'))).toBe(true);
	});

	it('does not classify lock, I/O or plain errors as corruption', () => {
		expect(isSqliteCorruptionError(sqliteError('SQLITE_BUSY'))).toBe(false);
		expect(isSqliteCorruptionError(sqliteError('SQLITE_IOERR'))).toBe(false);
		expect(isSqliteCorruptionError(new Error('database disk image is malformed'))).toBe(false);
		expect(isSqliteCorruptionError(null)).toBe(false);
		expect(isSqliteCorruptionError('SQLITE_CORRUPT')).toBe(false);
	});

	it('does not classify a native addon that failed to load as corruption', () => {
		const dlopen = Object.assign(
			new Error(
				'was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 145.'
			),
			{ code: 'ERR_DLOPEN_FAILED' }
		);
		expect(isSqliteCorruptionError(dlopen)).toBe(false);
	});
});
