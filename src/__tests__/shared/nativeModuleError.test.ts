/**
 * A native addon built for the other runtime must surface as ONE line naming
 * the cause and the remedy, never the multi-line dlopen dump - and an error
 * that is not a load failure must not be misattributed to the build.
 */

import { describe, it, expect } from 'vitest';
import { describeNativeModuleLoadError } from '../../shared/nativeModuleError';

function dlopenError(message: string): Error {
	return Object.assign(new Error(message), { code: 'ERR_DLOPEN_FAILED' });
}

describe('describeNativeModuleLoadError', () => {
	it('names both ABIs for a NODE_MODULE_VERSION mismatch, in one line', () => {
		const diagnosis = describeNativeModuleLoadError(
			dlopenError(
				"The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
					'was compiled against a different Node.js version using\n' +
					'NODE_MODULE_VERSION 145. This version of Node.js requires\n' +
					'NODE_MODULE_VERSION 127. Please try re-compiling or re-installing\n' +
					'the module (for instance, using `npm rebuild` or `npm install`).'
			)
		);
		expect(diagnosis?.problem).toBe('abi-mismatch');
		expect(diagnosis?.message).not.toContain('\n');
		expect(diagnosis?.message).toContain('module ABI 145');
		expect(diagnosis?.message).toContain('needs 127');
		expect(diagnosis?.message).toContain('MAESTRO_SERVER_INSTALL=1');
	});

	it('recognizes a missing compiled binary', () => {
		const diagnosis = describeNativeModuleLoadError(
			new Error('Could not locate the bindings file. Tried:\n → /a\n → /b')
		);
		expect(diagnosis?.problem).toBe('binary-missing');
		expect(diagnosis?.message).not.toContain('\n');
	});

	it('falls back to the first line for any other dlopen failure', () => {
		const diagnosis = describeNativeModuleLoadError(
			dlopenError('/x/better_sqlite3.node: invalid ELF header\nmore detail')
		);
		expect(diagnosis?.problem).toBe('dlopen-failed');
		expect(diagnosis?.message).toContain('invalid ELF header');
		expect(diagnosis?.message).not.toContain('more detail');
	});

	it('returns null for an unrelated error', () => {
		expect(
			describeNativeModuleLoadError(new Error('SQLITE_CORRUPT: database disk image is malformed'))
		).toBeNull();
		expect(describeNativeModuleLoadError(undefined)).toBeNull();
	});
});
