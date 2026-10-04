import { describe, it, expect } from 'vitest';
import { syncPathRejection } from '../syncPath';

describe('syncPathRejection', () => {
	describe('posix', () => {
		const reject = (p: string) => syncPathRejection(p, 'darwin');

		it('accepts an ordinary absolute path', () => {
			expect(reject('/Users/someone/Dropbox/Maestro')).toBeNull();
		});

		it('rejects a relative path', () => {
			expect(reject('sync/maestro')).toBe('Custom sync path must be absolute: sync/maestro');
		});

		it('rejects a null byte', () => {
			expect(reject('/Users/a\0b')).toBe('Custom sync path contains null bytes: /Users/a\0b');
		});

		it('rejects traversal before normalization can hide it', () => {
			expect(reject('/Users/someone/../../etc')).toBe(
				'Custom sync path contains traversal sequences: /Users/someone/../../etc'
			);
		});

		it('rejects a path too short to be anything but a system directory', () => {
			expect(reject('/a')).toBe('Custom sync path is too short: /a');
		});

		it('rejects sensitive roots and their children, but not look-alike names', () => {
			expect(reject('/usr/bin')).toBe(
				'Custom sync path cannot be in sensitive system directory: /usr/bin'
			);
			expect(reject('/tmp/maestro')).toBe(
				'Custom sync path cannot be in sensitive system directory: /tmp/maestro'
			);
			expect(reject('/etcetera/maestro')).toBeNull();
		});
	});

	describe('windows', () => {
		const reject = (p: string) => syncPathRejection(p, 'win32');

		it('accepts an ordinary drive path', () => {
			expect(reject('D:\\Sync\\Maestro')).toBeNull();
		});

		it('rejects a path with no drive or root', () => {
			expect(reject('Sync\\Maestro')).toBe('Custom sync path must be absolute: Sync\\Maestro');
		});

		it('rejects reserved device names, with or without an extension', () => {
			expect(reject('C:\\Sync\\con')).toBe(
				'Custom sync path contains Windows reserved name: C:\\Sync\\con'
			);
			expect(reject('C:\\Sync\\LPT1.txt\\x')).toBe(
				'Custom sync path contains Windows reserved name: C:\\Sync\\LPT1.txt\\x'
			);
		});

		it('rejects a sensitive root on any drive letter', () => {
			expect(reject('D:\\Windows\\Maestro')).toBe(
				'Custom sync path cannot be in sensitive system directory: D:\\Windows\\Maestro'
			);
			expect(reject('C:\\Program Files')).toBe(
				'Custom sync path cannot be in sensitive system directory: C:\\Program Files'
			);
			expect(reject('C:\\Windowsill\\Maestro')).toBeNull();
		});
	});
});
