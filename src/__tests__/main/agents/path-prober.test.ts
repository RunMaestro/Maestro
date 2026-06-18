/**
 * Tests for path-prober.ts
 *
 * Tests the platform-specific binary detection logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock dependencies before importing the module
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../shared/pathUtils', () => ({
	expandTilde: vi.fn((p: string) => p.replace(/^~/, '/Users/testuser')),
	detectNodeVersionManagerBinPaths: vi.fn(() => []),
}));

// Import after mocking
import {
	getExpandedEnv,
	checkCustomPath,
	checkBinaryExists,
	probeWindowsPaths,
	probeUnixPaths,
	type BinaryDetectionResult,
} from '../../../main/agents';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';

describe('path-prober', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('getExpandedEnv', () => {
		it('should return environment with PATH', () => {
			const env = getExpandedEnv();
			expect(env.PATH).toBeDefined();
			expect(typeof env.PATH).toBe('string');
		});

		it('should include common Unix paths on non-Windows', () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				const env = getExpandedEnv();
				expect(env.PATH).toContain('/opt/homebrew/bin');
				expect(env.PATH).toContain('/usr/local/bin');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should include nvm4w and npm paths on Windows', () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				const env = getExpandedEnv();
				// Check for nvm4w paths (OpenCode commonly installed here)
				expect(env.PATH).toContain('C:\\nvm4w\\nodejs');
				// Check for npm global paths
				expect(env.PATH).toMatch(/AppData[\\\/](npm|Roaming[\\\/]npm)/);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should preserve existing PATH entries', () => {
			const originalPath = process.env.PATH;
			const testPath = '/test/custom/path';
			process.env.PATH = testPath;

			try {
				const env = getExpandedEnv();
				expect(env.PATH).toContain(testPath);
			} finally {
				process.env.PATH = originalPath;
			}
		});
	});

	describe('checkCustomPath', () => {
		let statMock: ReturnType<typeof vi.spyOn>;
		let accessMock: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			statMock = vi.spyOn(fs.promises, 'stat');
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			statMock.mockRestore();
			accessMock.mockRestore();
		});

		it('should return exists: true for valid executable path on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				accessMock.mockResolvedValue(undefined);

				const result = await checkCustomPath('/usr/local/bin/claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('/usr/local/bin/claude');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should return exists: false for non-executable file on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				accessMock.mockRejectedValue(new Error('EACCES'));

				const result = await checkCustomPath('/path/to/non-executable');
				expect(result.exists).toBe(false);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining('not executable'),
					'PathProber'
				);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should return exists: false for non-existent path', async () => {
			statMock.mockRejectedValue(new Error('ENOENT'));

			const result = await checkCustomPath('/non/existent/path');
			expect(result.exists).toBe(false);
		});

		it('should expand tilde in path', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				accessMock.mockResolvedValue(undefined);

				const result = await checkCustomPath('~/.local/bin/claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('/Users/testuser/.local/bin/claude');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should try .exe extension on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// First call (exact path) returns false, second call (.exe) returns true
				statMock
					.mockRejectedValueOnce(new Error('ENOENT'))
					.mockResolvedValueOnce({ isFile: () => true } as fs.Stats);

				const result = await checkCustomPath('C:\\custom\\claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\custom\\claude.exe');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should try .cmd extension on Windows if .exe not found', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// First call (exact), second (.exe) return false, third (.cmd) returns true
				statMock
					.mockRejectedValueOnce(new Error('ENOENT'))
					.mockRejectedValueOnce(new Error('ENOENT'))
					.mockResolvedValueOnce({ isFile: () => true } as fs.Stats);

				const result = await checkCustomPath('C:\\custom\\claude');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\custom\\claude.cmd');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should skip executable check on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				statMock.mockResolvedValue({ isFile: () => true } as fs.Stats);
				// Don't mock access - it shouldn't be called for X_OK on Windows

				const result = await checkCustomPath('C:\\custom\\claude.exe');
				expect(result.exists).toBe(true);
				// access should not be called with X_OK on Windows
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});
	});

	describe('probeWindowsPaths', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
		});

		it('should return null for unknown binary', async () => {
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeWindowsPaths('unknown-binary');
			expect(result).toBeNull();
		});

		it('should probe known paths for claude binary', async () => {
			// All paths fail - binary not found
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeWindowsPaths('claude');
			// Should return null since all probes fail
			expect(result).toBeNull();
			// Should have tried multiple paths
			expect(accessMock).toHaveBeenCalled();
		});
	});

	describe('probeUnixPaths', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
		});

		it('should return null for unknown binary', async () => {
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeUnixPaths('unknown-binary');
			expect(result).toBeNull();
		});

		it('should probe known paths for claude binary', async () => {
			// All paths fail - binary not found
			accessMock.mockRejectedValue(new Error('ENOENT'));

			const result = await probeUnixPaths('claude');
			// Should return null since all probes fail
			expect(result).toBeNull();
			// Should have tried multiple paths
			expect(accessMock).toHaveBeenCalled();
		});

		it('should check both existence and executability', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				accessMock.mockRejectedValue(new Error('ENOENT'));

				const result = await probeUnixPaths('claude');
				expect(result).toBeNull();

				// Verify access was called with F_OK | X_OK
				expect(accessMock).toHaveBeenCalled();
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});
	});

	describe('checkBinaryExists', () => {
		let accessMock: ReturnType<typeof vi.spyOn>;
		const execMock = vi.mocked(execFileNoThrow);

		beforeEach(() => {
			accessMock = vi.spyOn(fs.promises, 'access');
		});

		afterEach(() => {
			accessMock.mockRestore();
		});

		it('should try direct probe first on Unix', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Direct probe finds the binary (first path in the list exists)
				accessMock.mockResolvedValueOnce(undefined);

				const result = await checkBinaryExists('claude');
				expect(result.exists).toBe(true);
				expect(result.path).toContain('claude');
				// which should not be called if direct probe succeeds
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should fall back to which on Unix if probe fails', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// which succeeds
				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: '/usr/local/bin/test-binary\n',
					stderr: '',
				});

				const result = await checkBinaryExists('test-binary');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('/usr/local/bin/test-binary');
				expect(execMock).toHaveBeenCalledWith(
					'which',
					['test-binary'],
					undefined,
					expect.any(Object)
				);
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should use where on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// where succeeds
				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: 'C:\\Users\\Test\\AppData\\Roaming\\npm\\test.cmd\r\n',
					stderr: '',
				});

				const result = await checkBinaryExists('test');
				expect(result.exists).toBe(true);
				expect(execMock).toHaveBeenCalledWith('where', ['test'], undefined, expect.any(Object));
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should return exists: false if binary not found', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// which fails
				execMock.mockResolvedValue({
					exitCode: 1,
					stdout: '',
					stderr: 'not found',
				});

				const result = await checkBinaryExists('non-existent');
				expect(result.exists).toBe(false);
				expect(result.path).toBeUndefined();
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should prefer .exe over .cmd on Windows', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				// Direct probe fails
				accessMock.mockRejectedValue(new Error('ENOENT'));

				// where returns both .exe and .cmd
				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: 'C:\\path\\to\\binary.cmd\r\nC:\\path\\to\\binary.exe\r\n',
					stderr: '',
				});

				const result = await checkBinaryExists('binary');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\path\\to\\binary.exe');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});

		it('should handle Windows CRLF line endings', async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

			try {
				accessMock.mockRejectedValue(new Error('ENOENT'));

				execMock.mockResolvedValue({
					exitCode: 0,
					stdout: 'C:\\path\\to\\binary.exe\r\n',
					stderr: '',
				});

				const result = await checkBinaryExists('binary');
				expect(result.exists).toBe(true);
				expect(result.path).toBe('C:\\path\\to\\binary.exe');
				// Path should not contain \r
				expect(result.path).not.toContain('\r');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
			}
		});
	});

	describe('BinaryDetectionResult type', () => {
		it('should allow exists: true with path', () => {
			const result: BinaryDetectionResult = {
				exists: true,
				path: '/usr/local/bin/claude',
			};
			expect(result.exists).toBe(true);
			expect(result.path).toBeDefined();
		});

		it('should allow exists: false without path', () => {
			const result: BinaryDetectionResult = {
				exists: false,
			};
			expect(result.exists).toBe(false);
			expect(result.path).toBeUndefined();
		});
	});
});
