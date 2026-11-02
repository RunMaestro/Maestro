import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
}));

import {
	resolveSyncDir,
	isValidSyncPath,
	isInsideInstallDir,
	BOOTSTRAP_STORE_FILE,
} from '../../shared/syncPath';

const USER_DATA = '/Users/test/Library/Application Support/maestro';
const SYNC_DIR = '/Users/test/iCloud/Maestro';
const BOOTSTRAP_PATH = path.join(USER_DATA, BOOTSTRAP_STORE_FILE);

function enoent(): NodeJS.ErrnoException {
	const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}

/** Serve `content` as the bootstrap file; every other read is a missing file. */
function mockBootstrap(content: string | undefined): void {
	vi.mocked(fs.readFileSync).mockImplementation((file) => {
		if (file === BOOTSTRAP_PATH && content !== undefined) return content;
		throw enoent();
	});
}

describe('shared/syncPath', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	describe('resolveSyncDir', () => {
		it('returns the custom sync path recorded in the bootstrap store', () => {
			mockBootstrap(JSON.stringify({ customSyncPath: SYNC_DIR }));

			expect(resolveSyncDir(USER_DATA)).toBe(SYNC_DIR);
		});

		it('reads the bootstrap store from the user-data directory it was handed', () => {
			mockBootstrap(JSON.stringify({ customSyncPath: SYNC_DIR }));

			resolveSyncDir(USER_DATA);

			expect(fs.readFileSync).toHaveBeenCalledWith(BOOTSTRAP_PATH, 'utf-8');
		});

		it('falls back to the user-data directory when there is no bootstrap store', () => {
			mockBootstrap(undefined);

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
		});

		it('falls back when no custom path is configured', () => {
			mockBootstrap(JSON.stringify({}));

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
		});

		it('tolerates a UTF-8 BOM in the bootstrap store', () => {
			mockBootstrap('\uFEFF' + JSON.stringify({ customSyncPath: SYNC_DIR }));

			expect(resolveSyncDir(USER_DATA)).toBe(SYNC_DIR);
		});

		it('falls back when the bootstrap store is not JSON', () => {
			mockBootstrap('{ "customSyncPath": ');

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
		});

		it('falls back when the bootstrap store holds something other than an object', () => {
			mockBootstrap('null');

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
		});

		it('falls back when the configured value is not a string', () => {
			mockBootstrap(JSON.stringify({ customSyncPath: 42 }));

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
		});

		it('falls back when the app would reject the path', () => {
			mockBootstrap(JSON.stringify({ customSyncPath: 'relative/path' }));

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
		});

		it('falls back, without creating it, when the directory does not exist', () => {
			mockBootstrap(JSON.stringify({ customSyncPath: SYNC_DIR }));
			vi.mocked(fs.existsSync).mockReturnValue(false);

			expect(resolveSyncDir(USER_DATA)).toBe(USER_DATA);
			expect(fs.existsSync).toHaveBeenCalledWith(SYNC_DIR);
		});

		it('rethrows a read failure that is not a missing file', () => {
			const denied = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
			denied.code = 'EACCES';
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw denied;
			});

			expect(() => resolveSyncDir(USER_DATA)).toThrow('EACCES');
		});
	});

	describe('isValidSyncPath', () => {
		it('accepts an absolute path outside the system directories', () => {
			expect(isValidSyncPath(SYNC_DIR)).toBe(true);
		});

		it('rejects a relative path', () => {
			expect(isValidSyncPath('relative/path')).toBe(false);
		});

		it('rejects a path with a traversal segment', () => {
			expect(isValidSyncPath('/Users/test/../../etc/passwd')).toBe(false);
		});

		it('rejects a sensitive system directory', () => {
			const sensitive = process.platform === 'win32' ? 'C:\\Windows\\maestro' : '/etc/maestro';

			expect(isValidSyncPath(sensitive)).toBe(false);
		});
	});

	describe('isInsideInstallDir', () => {
		const INSTALL_DIR = path.resolve('/apps/Maestro');

		it('flags the install directory itself and anything under it', () => {
			expect(isInsideInstallDir(INSTALL_DIR, INSTALL_DIR)).toBe(true);
			expect(isInsideInstallDir(path.join(INSTALL_DIR, 'storage'), INSTALL_DIR)).toBe(true);
			expect(isInsideInstallDir(path.join(INSTALL_DIR, 'a', 'b'), INSTALL_DIR)).toBe(true);
		});

		it('allows a sibling whose name starts with the install directory name', () => {
			expect(isInsideInstallDir(path.resolve('/apps/Maestro-Data'), INSTALL_DIR)).toBe(false);
		});

		it('allows the parent and unrelated folders', () => {
			expect(isInsideInstallDir(path.resolve('/apps'), INSTALL_DIR)).toBe(false);
			expect(isInsideInstallDir(SYNC_DIR, INSTALL_DIR)).toBe(false);
		});

		it.runIf(process.platform === 'win32')('ignores case on Windows', () => {
			expect(isInsideInstallDir('d:\\apps\\maestro\\storage', 'D:\\Apps\\Maestro')).toBe(true);
		});
	});
});
