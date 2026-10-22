import { describe, it, expect, vi } from 'vitest';
import { isValidSyncPath } from '../../../syncPath';
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

	describe('parity with the shared rule', () => {
		it('names a reason for exactly the paths isValidSyncPath refuses, on this platform', () => {
			// `isValidSyncPath` decides; this only explains. A path one refuses and the other
			// accepts would be a fallback `doctor` cannot explain, or an explanation of nothing.
			const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const samples = [
				'/Users/someone/Dropbox/Maestro',
				'/Users/someone/./Sync//Maestro',
				'sync/maestro',
				'',
				'/Users/a\0b',
				'/Users/someone/../../etc',
				'/a',
				'/a/b',
				'/usr/bin',
				'/USR/BIN/x',
				'/tmp/maestro',
				'/var',
				'/variable/maestro',
				'/etcetera/maestro',
				'/Users/someone/con',
				'D:\\Sync\\Maestro',
				'Sync\\Maestro',
				'C:\\a',
				'C:\\Sync\\con',
				'C:\\Sync\\LPT1.txt\\x',
				'D:\\Windows\\Maestro',
				'C:\\Program Files',
				'C:\\Windowsill\\Maestro',
			];
			for (const sample of samples) {
				const reason = syncPathRejection(sample);
				expect(reason === null, JSON.stringify(sample)).toBe(isValidSyncPath(sample));
				// The shared rule logs the same sentence this returns.
				if (reason !== null) expect(logged).toHaveBeenLastCalledWith(reason);
			}
			logged.mockRestore();
		});
	});
});
